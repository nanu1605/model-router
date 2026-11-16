import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnCompleteInput } from 'claude-code'

import type { Cache, Routed, Tier } from '../types'
import { mayWrite } from './shell'
import type { Shell } from './shell'

// The policy the main model reads wherever it is offered the Agent tool.
const POLICY = `## Model routing (orchestrator rules)
You are the orchestrator. Split work into tasks and hand each to a subagent with the Agent tool. Every Agent call MUST set \`model\` to haiku, sonnet or opus; a call without one is refused. Pick the agent type that fits, then the cheapest model that can do the task well:
- haiku: lookup and mechanical reading. Finding files or symbols, grepping, listing, reading and summarizing, simple fetches, yes/no checks.
- sonnet: reasoning that changes no file. Reviews, research, debugging by reading, comparing options, planning a change.
- opus: every task that writes or edits code or files, or runs any shell command beyond reading and searching (tests, builds, installs, scripts, git commits); also architecture and design, root-causing unclear bugs, security review, high-stakes decisions, final synthesis.
Only the latest opus writes files or runs such commands. An agent on any other model that tries is stopped and switched to opus, so give any task that ends in an edit or a test run to opus from the start.
Agent types: Explore to search and read, Plan to design, general-purpose to edit, a specialised type when one fits.
A subagent sees none of this conversation: give it the goal, the paths, the constraints and what to report back. Keep for yourself work that needs this conversation's context or takes one or two tool calls.
Fan independent tasks out as parallel Agent calls, each with its own model. When unsure between two tiers take the cheaper one; if its result is weak, re-run the task one tier up and pass on what the first attempt found.`

const DENY = `model-router: this Agent call has no model. Set \`model\` to haiku (lookup, reading), sonnet (reasoning that changes no file) or opus (anything that edits or runs tests and builds, design, high stakes), then call Agent again.`

// Opus writes the change itself: the refused call was drafted on another model.
const WRITE_DENY = (who: string) =>
  `model-router: only the latest opus writes files or runs commands that may change them. ${who} now continues on opus. The call above was not run: an older or cheaper model drafted it. For an edit, re-read what it touches and write the change your own way rather than copying its arguments. A command that only checks something (a test run, a build) you may run as it is.`

// Picks the model for one turn of the main loop from the person's message.
const PICK = `You route one turn of a coding assistant to a model. Reply with one word: haiku, sonnet or opus.
haiku: the answer comes from the conversation so far or from reading and searching files. Status, what is done or left, summaries, explaining code, finding where something is, listing, short factual questions.
sonnet: real reasoning that changes no file and runs nothing. Reviewing, comparing options, debugging by reading, planning, research.
opus: anything that writes or edits code or files, or runs a command beyond reading and searching (tests, builds, installs, scripts, commits); designing a system, root-causing a hard bug, a high-stakes call. A short reply that agrees to a proposed change ("yes", "do it", "go ahead") is opus. When unsure, opus.`

type AgentRecord = {
  status?: string
  agentId?: string
  resolvedModel?: string
  totalDurationMs?: number
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number | null
    cache_read_input_tokens: number | null
  }
}

const PANE = 'model-router'
const MAIN = 'main'
const TIERS: Tier[] = ['haiku', 'sonnet', 'opus']
const WRITERS = ['Edit', 'Write', 'NotebookEdit']
// Tools that run a shell command, and the shell whose rules read it.
const SHELLS: Record<string, Shell> = {
  Bash: 'bash',
  Monitor: 'bash',
  PowerShell: 'pwsh',
  mcp__terminal__run_in_terminal: 'pwsh',
}

// Classifies, never rewrites: the model's pick goes on to the Agent tool as given.
const tierOf = (m?: string): Tier | undefined => TIERS.find(t => m?.toLowerCase().includes(t))

// The newest opus this build knows, as [major, minor]; an 'opus' alias resolved later raises it.
let latest: [number, number] = [5, 5]
// claude-opus-5-5, claude-opus-5.5, claude-opus-5-20261101 and the old claude-3-opus-<date>.
const opusVersion = (m: string): [number, number] | undefined => {
  const old = /claude-(\d)(?:[-.](\d))?-opus/i.exec(m)
  if (old) return [Number(old[1]), Number(old[2] ?? 0)]
  const v = /opus-(\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/i.exec(m)
  return v ? [Number(v[1]), Number(v[2] ?? 0)] : undefined
}
const newer = (a: [number, number], b: [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1])
// An alias or an id with no version (a profile ARN) is taken as the latest.
const isLatestOpus = (m: string) => {
  if (tierOf(m) !== 'opus') return false
  const v = opusVersion(m)
  return !v || newer(v, latest)
}

const log = atom({ plugin: 'model-router', key: 'log' } as const, [] as Routed[], {
  shape: 'log-2',
})
// Session state, so a reload of this module does not take a warm cache for a cold one.
const cache = atom({ plugin: 'model-router', key: 'cache' } as const, { ttl: '1h', sentAt: {} } as Cache, {
  shape: 'cache-1',
})

// The last 25 turns and 50 agents; a running row is never dropped, so its run still lands.
const cap = (l: Routed[]) => {
  const keep = new Set([
    ...l.filter(r => r.type === MAIN).slice(-25),
    ...l.filter(r => r.type !== MAIN).slice(-50),
    ...l.filter(r => r.status === 'running'),
  ])
  return l.filter(r => keep.has(r))
}

const writes = (e: { tool: string; command?: unknown; action?: unknown }) => {
  const shell = SHELLS[e.tool]
  return (
    WRITERS.includes(e.tool) ||
    (e.tool === 'ExitWorktree' && e.action === 'remove') ||
    (shell !== undefined && typeof e.command === 'string' && mayWrite(e.command, shell))
  )
}

// The model each loop's last request went out on, by agent id or MAIN.
const lastModel = new Map<string, string>()
// Agents moved to opus because they wrote: they stay there, on every later turn.
const raised = new Set<string>()
// The main loop's turn: its id, prompt, picked tier, whether a write moved it to opus, and
// whether the person typed into it, which ends its pick.
type Turn = { id: string; text: string; pick?: Tier; raised: boolean; dropped?: boolean }
let turn: Turn | undefined
// The main loop's last answer, the reply the next message usually answers.
let lastAnswer: string | undefined

const opusFor = (model: string) => (isLatestOpus(model) || tierOf(model) === undefined ? model : 'opus')

// The model a write call came from when it is not the latest opus; undefined lets the call run.
// A loop whose requests this mod never saw (loaded mid-agent), or whose model names no tier, is
// left as it is.
const offOpus = (e: { tool: string; command?: unknown; action?: unknown; agentId?: string }) => {
  if (!writes(e)) return undefined
  const model = lastModel.get(e.agentId ?? MAIN)
  return model === undefined || tierOf(model) === undefined || isLatestOpus(model) ? undefined : model
}
const writeDeny = (e: { agentId?: string }) => ({ deny: WRITE_DENY(e.agentId === undefined ? 'This turn' : 'This agent') })

// Per million tokens: input, output, cache read. Haiku's price rises past 100K tokens of prompt.
const PRICE: Record<Tier, readonly [number, number, number]> = {
  haiku: [0.1, 0.5, 0.01],
  sonnet: [2, 10, 0.1],
  opus: [4, 20, 0.2],
}
const price = (t: Tier, tokens: number) => (t === 'haiku' && tokens > 100_000 ? ([0.5, 2.5, 0.05] as const) : PRICE[t])
// A rough turn's output, thinking included: enough to weigh a switch.
const TURN_OUT = 3000
// A cache entry's lifetime and its write price as a multiple of input, by the main loop's TTL.
const TTL = { '5m': { ms: 5 * 60_000, write: 1.25 }, '1h': { ms: 60 * 60_000, write: 2 } } as const
// Enough cached tokens to tell a cache hit from the few a request always writes.
const SEEN = 1024

// Caches are kept per model: a cheaper model pays to write the whole conversation into its own
// cache, while staying reads it from the current one when that is still warm. Move down a tier
// only when that costs less; moving up is for quality and always allowed.
const worth = (from: Tier, to: Tier, tokens: number, warm: boolean, write: number) => {
  if (TIERS.indexOf(to) >= TIERS.indexOf(from)) return true
  const [fromIn, fromOut, fromRead] = price(from, tokens)
  const [toIn, toOut] = price(to, tokens)
  return tokens * toIn * write + TURN_OUT * toOut < tokens * (warm ? fromRead : fromIn * write) + TURN_OUT * fromOut
}

const running = (list: Routed[]) => {
  const main = list.find(r => r.type === MAIN && r.status === 'running')
  const live = list.filter(r => r.status === 'running' && r.type !== MAIN)
  const parts = [
    ...(main ? [`turn on ${tierLabel(main)}`] : []),
    ...(live.length ? [`${live.length} running (${live.map(r => r.asked).join(', ')})`] : []),
  ]
  return parts.length ? `route: ${parts.join(' · ')}` : undefined
}

const kTok = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`)
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
// A model id with no tier word (a Bedrock ARN, a gateway alias) is no mismatch: only a known other tier is.
const tierLabel = (r: Routed) => {
  const ran = tierOf(r.ran)
  return ran && ran !== r.asked ? `${r.asked}->${ran}` : r.asked
}

// What one run of a subagent's loop adds to its row: its outcome, time, summed tokens and answering model.
type Run = Pick<Routed, 'status' | 'ms' | 'tokIn' | 'tokOut'> & { ran?: string }
const runOf = (e: TurnCompleteInput): Run => {
  const u = e.usage
  return {
    status: e.reason === 'answer' ? 'done' : e.reason,
    ms: e.durationMs,
    tokIn: u ? u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens : 0,
    tokOut: u?.output_tokens ?? 0,
    ...(u ? { ran: u.model } : {}),
  }
}
// A foreground agent's run ends before its Agent call returns, so before its row exists: it waits here.
// ponytail: module memory, lost on a reload mid-agent; the row then falls back to the record's last response.
const early = new Map<string, Run>()
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

// Main-turn routing is on unless the person turned it off with /route auto off.
const autoOn = async ($: EngineInterface) => (await $.store.get('auto')) !== false

// One cheap call: the person's message, and the reply it answers, to a tier. A long message
// keeps its head and its tail, where the request usually is.
const pick = async ($: EngineInterface, text: string, signal: AbortSignal): Promise<Tier | undefined> => {
  const said =
    lastAnswer ?? (await $.session.messages()).filter(m => m.role === 'assistant' && m.text).pop()?.text ?? ''
  const body = text.length > 4000 ? `${text.slice(0, 1500)}\n[...]\n${text.slice(-2500)}` : text
  const prompt = `${said ? `<previous-reply>\n${said.slice(-1500)}\n</previous-reply>\n` : ''}<message>\n${body}\n</message>`
  const r = await $.model.complete({ model: 'haiku', system: PICK, prompt, maxTokens: 1024, effort: 'low', timeoutMs: 5000 }, { signal })
  return r.isAnswered ? tierOf(r.text.trim().split(/\s+/)[0]) : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Show which model each turn and delegated task ran on; /route pane opens a live view',
      argumentHint: '[pane | auto on | auto off]',
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

  // A message the person types into a running turn changes what the turn is for: its later
  // requests go out on the session's model, not on the tier picked for the first message.
  // A background task's notice or another session's message delivered into it does not.
  on('prompt.submit', async ($, e, next) => {
    const submitted = await next(e)
    const typed = (e.origin.kind === 'composer' || e.origin.kind === 'bridge') && !e.isMeta && !e.command
    if (typed && submitted.drop === undefined && e.turnId !== undefined && e.turnId === turn?.id) {
      turn.pick = undefined
      turn.dropped = true
    }
    return submitted
  })

  // A cleared or resumed conversation is another prefix: no cache of it is warm, no reply stands.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      turn = undefined
      lastAnswer = undefined
      await update($, cache, c => ({ ...c, sentAt: {} }))
    }
    return next(e)
  })

  // The model's own Agent calls only: agents a workflow script or another plugin starts are
  // left alone, and a fork always inherits the parent model.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.subagent_type === 'fork' || next.origin.plugin !== 'engine') return next(e)

    const asked = tierOf(e.model)
    if (!asked) return { deny: DENY }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const base = {
      type: e.subagent_type ?? 'general-purpose',
      task: e.description.slice(0, 60),
      asked,
      ms: 0,
      tokIn: 0,
      tokOut: 0,
    }
    // Every arm of the Agent tool's record, read through the fields this mod uses.
    const r: AgentRecord | undefined = ran.isError ? undefined : ran.result
    let routed: Routed
    if (ran.isError) {
      routed = { ...base, id: e.tool_use_id, status: 'error' }
    } else if (r?.agentId) {
      // Background, foreground or teammate; a remote launch has no local agent and no id.
      const run = early.get(r.agentId)
      early.delete(r.agentId)
      const u = r.usage
      const record: Run | undefined =
        r.status === 'completed' && u
          ? {
              status: 'done',
              ms: r.totalDurationMs ?? 0,
              tokIn: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
              tokOut: u.output_tokens,
            }
          : undefined
      routed = { ...base, id: r.agentId, ran: r.resolvedModel, status: 'running', ...(run ?? record) }
    } else {
      return ran
    }

    // What the 'opus' alias resolves to is the newest opus there is.
    const seen = e.model?.toLowerCase() === 'opus' && routed.ran ? opusVersion(routed.ran) : undefined
    if (seen && newer(seen, latest)) latest = seen

    const list = await update($, log, l => cap([...l, routed]))
    const ranTier = tierOf(routed.ran)
    if (ranTier && ranTier !== asked) {
      $.ui.toast(`model-router: asked ${asked}, ran ${routed.ran}. A setting may force the subagent model.`)
    }
    $.ui.status(running(list))
    return ran
  }).catch(($, e, next) =>
    next.called || e.subagent_type === 'fork' || next.origin.plugin !== 'engine' || tierOf(e.model) ? next(e) : { deny: DENY },
  )

  // Only the latest opus writes: a write the model makes on any other model is refused once,
  // and the loop that made it goes on on opus, which makes the change itself.
  on('tool.call', async ($, e, next) => {
    const model = next.origin.plugin === 'engine' ? offOpus(e) : undefined
    if (model === undefined) return next(e)

    let list: Routed[]
    if (e.agentId === undefined) {
      if (!turn) return next(e)
      turn.raised = true
      const id = turn.id
      list = await update($, log, l => l.map(r => (r.id === id ? { ...r, ran: 'opus' } : r)))
      $.ui.toast(`model-router: this turn changes files, so it moves from ${model} to the latest opus.`)
    } else {
      raised.add(e.agentId)
      if (raised.size > 200) raised.delete(raised.values().next().value as string)
      const id = e.agentId
      list = await update($, log, l => l.map(r => (r.id === id ? { ...r, ran: 'opus' } : r)))
      $.ui.toast(`model-router: an agent on ${model} tried to change files; it moves to the latest opus.`)
    }
    $.ui.status(running(list))
    return writeDeny(e)
  }).catch(($, e, next) => (next.called || next.origin.plugin !== 'engine' || offOpus(e) === undefined ? next(e) : writeDeny(e)))

  // Every model request: the main loop's goes to the tier picked for its turn, and any loop
  // a write moved to opus stays there.
  on('turn.step', async function* ($, e, next) {
    let model = e.model
    if (e.agentId !== undefined) {
      if (raised.has(e.agentId)) model = opusFor(e.model)
    } else {
      // A turn whose start this module missed (it loaded mid-turn) is adopted without a pick.
      if (turn?.id !== e.turnId) turn = { id: e.turnId, text: '', raised: false }
      const t = turn
      const from = tierOf(e.model)
      // A session model that names no tier is left to the person: no pick for it.
      if (e.index === 0 && t.text && !t.dropped && from && (await autoOn($))) {
        const picked = await pick($, t.text, next.signal).catch(() => undefined)
        // The turn may have ended, or the person typed into it, while the pick ran.
        if (picked && turn === t && !t.dropped) {
          const c = await read($, cache)
          const tokens = (await $.session.usage()).context.tokens ?? 0
          const last = c.sentAt[e.model]
          // With no record of this model (a resumed session), a conversation with tokens may
          // well be cached: guessing warm keeps the stronger model, guessing cold can cost 12x.
          const warm = last === undefined ? tokens > 0 : (await $.clock.now()) - last < TTL[c.ttl].ms
          t.pick = worth(from, picked, tokens, warm, TTL[c.ttl].write) ? picked : from
          const routed: Routed = {
            id: t.id,
            type: MAIN,
            task: t.text.replace(/\s+/g, ' ').slice(0, 60),
            asked: t.pick,
            status: 'running',
            ms: 0,
            tokIn: 0,
            tokOut: 0,
          }
          const list = await update($, log, l => cap([...l, routed]))
          $.ui.status(running(list))
        }
      }
      if (t.raised) model = opusFor(e.model)
      else if (t.pick && t.pick !== from) model = t.pick
    }
    lastModel.set(e.agentId ?? MAIN, model)
    if (e.agentId !== undefined) return yield* next(model === e.model ? e : { ...e, model })

    // The main loop: note when this model was last used, and learn the cache's lifetime from
    // what a request sent after a gap found still cached.
    const now = await $.clock.now()
    const before = (await read($, cache)).sentAt[model]
    await update($, cache, c => ({ ...c, sentAt: { ...c.sentAt, [model]: now } }))
    const result = yield* next(model === e.model ? e : { ...e, model })
    const gap = before === undefined ? 0 : now - before
    const u = result.usage
    if (u && gap > TTL['5m'].ms) {
      const hit = u.cache_read_input_tokens > SEEN
      const ttl: Cache['ttl'] | undefined = hit ? '1h' : gap < TTL['1h'].ms && u.cache_creation_input_tokens > SEEN ? '5m' : undefined
      if (ttl) await update($, cache, (c): Cache => ({ ...c, ttl }))
    }
    return result
  })

  // A resumed agent or a teammate taking its next turn is running again.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    const id = e.agentId
    if (id === undefined) {
      turn = { id: e.turnId, text: e.text, raised: false }
      return started
    }
    if (!(await read($, log)).some(r => r.id === id && r.status !== 'running')) return started

    const list = await update($, log, l => l.map(r => (r.id === id ? { ...r, status: 'running' } : r)))
    $.ui.status(running(list))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // The main loop's turn has its turn id for a row id; an agent's, its agent id.
    const id = e.agentId ?? e.turnId
    if (e.agentId === undefined) {
      if (turn?.id === e.turnId) turn = undefined
      // An empty answer (a turn that only thought) leaves the transcript to say what was last said.
      lastAnswer = e.answer || undefined
    }

    const run = runOf(e)
    if (!(await read($, log)).some(r => r.id === id)) {
      if (e.agentId === undefined) return done
      early.set(id, run)
      if (early.size > 50) early.delete(early.keys().next().value as string)
      return done
    }

    const list = await update($, log, l =>
      l.map(r =>
        r.id !== id
          ? r
          : {
              ...r,
              status: run.status,
              ran: run.ran ?? r.ran,
              // A resumed agent or a teammate completes again: its runs add up.
              ms: r.ms + run.ms,
              tokIn: r.tokIn + run.tokIn,
              tokOut: r.tokOut + run.tokOut,
            },
      ),
    )
    $.ui.status(running(list))
    return done
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    if (args === 'pane') {
      await $.ui.open({ id: PANE, title: 'Model routing' })
      return { text: 'Model routing pane opened.' }
    }
    if (args === 'auto on' || args === 'auto off') {
      await $.store.set('auto', args === 'auto on')
      return {
        text:
          args === 'auto on'
            ? 'Each turn now runs on the model its message needs. Writes still run on opus.'
            : 'Turns now run on the model you picked. Writes still run on opus.',
      }
    }
    const list = await read($, log)
    const auto = `Turn routing ${(await autoOn($)) ? 'on' : 'off'}; only the latest opus writes files.`
    if (list.length === 0) return { text: `${auto}\nNo tasks routed yet.` }
    return { text: [auto, ...summary(list), '', ...list.slice(-10).map(row)].join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, log)
    const fit = (s: string) => s.slice(0, Math.max(10, e.props.bodyColumns))
    // ponytail: newest rows that fit the terminal's height; scroll if longer history matters.
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)

    if (list.length === 0) return <Text dimColor>No tasks routed yet. Turns and Agent calls show here as they run.</Text>

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
