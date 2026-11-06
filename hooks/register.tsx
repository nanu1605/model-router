import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Routed, Tier } from '../types'

// The policy the main model reads wherever it is offered the Agent tool.
const POLICY = `## Model routing (orchestrator rules)
You are the orchestrator. Split work into tasks and hand each to a subagent with the Agent tool. Every Agent call MUST set \`model\` to haiku, sonnet or opus; a call without one is refused. Pick the agent type that fits, then the cheapest model that can do the task well:
- haiku: lookup and mechanical work. Finding files or symbols, grepping, listing, reading and summarizing, renames, formatting, simple fetches, yes/no checks.
- sonnet: the default. Writing or editing code to a clear spec, bug fixes with a known cause, tests, docs, routine reviews, moderate research.
- opus: hard thinking. Architecture and design, root-causing unclear bugs, security review, cross-cutting refactors, ambiguous or high-stakes decisions, final synthesis.
Agent types: Explore to search and read, Plan to design, general-purpose to edit, a specialised type when one fits.
A subagent sees none of this conversation: give it the goal, the paths, the constraints and what to report back. Keep for yourself work that needs this conversation's context or takes one or two tool calls.
Fan independent tasks out as parallel Agent calls, each with its own model. When unsure between two tiers take the cheaper one; if its result is weak, re-run the task one tier up and pass on what the first attempt found.`

const DENY = `model-router: this Agent call has no model. Set \`model\` to haiku (lookup, mechanical work), sonnet (code to a clear spec; the default) or opus (design, unclear bugs, high stakes), then call Agent again.`

const PANE = 'model-router'
const TIERS: Tier[] = ['haiku', 'sonnet', 'opus']

// Classifies, never rewrites: `opus[1m]` or a pinned `claude-sonnet-4-5` goes on as given.
const tierOf = (m?: string): Tier | undefined => TIERS.find(t => m?.toLowerCase().includes(t))

const log = atom({ plugin: 'model-router', key: 'log' } as const, [] as Routed[], {
  shape: 'log-2',
})

const running = (list: Routed[]) => {
  const live = list.filter(r => r.status === 'running')
  return live.length ? `route: ${live.length} running (${live.map(r => r.asked).join(', ')})` : undefined
}

const kTok = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`)
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const tierLabel = (r: Routed) => {
  const ran = tierOf(r.ran) ?? r.ran
  return ran && ran !== r.asked ? `${r.asked}->${ran}` : r.asked
}
const row = (r: Routed) =>
  `${tierLabel(r).padEnd(12)} ${r.status.padEnd(7)} ${`${kTok(r.tokIn)}/${kTok(r.tokOut)}`.padStart(11)} ${secs(r.ms).padStart(7)}  ${r.type}: ${r.task}`

const summary = (list: Routed[]) =>
  TIERS.map(t => {
    const of = list.filter(r => r.asked === t)
    const ended = of.filter(r => r.status !== 'running')
    const failed = ended.filter(r => r.status !== 'done').length
    const sum = (n: (r: Routed) => number) => of.reduce((total, r) => total + n(r), 0)
    const avg = ended.length ? secs(ended.reduce((total, r) => total + r.ms, 0) / ended.length) : '-'
    return `${t.padEnd(6)} ${of.length} runs, ${failed} failed, ${kTok(sum(r => r.tokIn))} in / ${kTok(sum(r => r.tokOut))} out, avg ${avg}`
  })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Show which model each delegated task ran on; /route pane opens a live view',
      argumentHint: '[pane]',
    })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // A prompt whose request offers no Agent tool cannot delegate: skip the rules.
    if (!e.tools.includes('Agent')) return composed
    return {
      sections: [...composed.sections, { id: 'model-router:policy', text: POLICY, scope: 'session' }],
    }
  })

  on('agent.spawn', async ($, e, next) => {
    // Forks inherit the parent model, a resume keeps its content, a workflow script chose for itself.
    if (e.fork || e.resume || e.workflow) return next(e)

    const asked = tierOf(e.model)
    // The main model's own calls are held to the rule; another plugin's spawn is that plugin's business.
    if (!asked && next.origin.plugin === 'engine') return { deny: DENY }

    const ran = await next(e)
    if (!asked || ran.deny !== undefined || !ran.agentId) return ran

    const routed: Routed = {
      id: ran.agentId,
      type: e.subagentType,
      task: (e.description || e.prompt).slice(0, 60),
      asked,
      ran: ran.model,
      status: 'running',
      ms: 0,
      tokIn: 0,
      tokOut: 0,
    }
    const list = await update($, log, l => [...l, routed].slice(-50))
    if (ran.model && tierOf(ran.model) !== asked) {
      $.ui.toast(`model-router: asked ${asked}, runs ${ran.model}. A setting may force the subagent model.`)
    }
    $.ui.status(running(list))
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId
    if (!id || !(await read($, log)).some(r => r.id === id)) return done

    const u = e.usage
    const list = await update($, log, l =>
      l.map(r =>
        r.id !== id
          ? r
          : {
              ...r,
              status: e.reason === 'answer' ? 'done' : e.reason,
              ran: u?.model ?? r.ran,
              // A resumed agent completes again: its runs add up.
              ms: r.ms + e.durationMs,
              tokIn: r.tokIn + (u ? u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens : 0),
              tokOut: r.tokOut + (u?.output_tokens ?? 0),
            },
      ),
    )
    $.ui.status(running(list))
    return done
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    if (e.args.trim() === 'pane') {
      await $.ui.open({ id: PANE, title: 'Model routing' })
      return { text: 'Model routing pane opened.' }
    }
    const list = await read($, log)
    if (list.length === 0) return { text: 'No tasks routed yet.' }
    return { text: [...summary(list), '', ...list.slice(-10).map(row)].join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, log)
    const fit = (s: string) => s.slice(0, Math.max(10, e.props.bodyColumns))
    // ponytail: newest rows that fit the terminal's height; scroll if longer history matters.
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)

    if (list.length === 0) return <Text dimColor>No tasks routed yet. Agent calls show here as they run.</Text>

    return (
      <Box flexDirection="column">
        {summary(list).map(line => (
          <Text weight="semibold">{fit(line)}</Text>
        ))}
        <Text> </Text>
        {list
          .slice(-room)
          .reverse()
          .map(r => (
            <Text
              dimColor={r.status === 'done' && tierLabel(r) === r.asked}
              color={r.status === 'running' || r.status === 'done' ? (tierLabel(r) === r.asked ? undefined : 'warning') : 'error'}
            >
              {fit(row(r))}
            </Text>
          ))}
      </Box>
    )
  })
}
