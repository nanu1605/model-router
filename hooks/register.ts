import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Routed, Tier } from '../types'

// The policy. The main model reads POLICY and picks a tier per Agent call;
// the tables below only fill in when it picks none (or a tier outside these three).
const POLICY = `## Model routing (orchestrator rules)
You are the orchestrator. Split work into tasks, hand each to a subagent with the Agent tool, and ALWAYS set \`model\` on every Agent call. Pick the agent type that fits the task, then the cheapest model that can do it well. Only three models exist here:
- haiku: lookup and mechanical work. Finding files or symbols, grepping, listing, reading and summarizing, renames, formatting, simple fetches, yes/no checks.
- sonnet: the default. Writing or editing code to a clear spec, bug fixes with a known cause, tests, docs, routine reviews, moderate research.
- opus: hard thinking. Architecture and design, root-causing unclear bugs, security review, cross-cutting refactors, ambiguous or high-stakes decisions, final synthesis.
Do a task yourself, with no subagent, when it is one or two tool calls. Split independent tasks into parallel Agent calls, each with its own model. When unsure between two tiers, take the cheaper one and escalate if the result is weak.`

const BY_TYPE: Record<string, Tier> = {
  Explore: 'haiku',
  'claude-code-guide': 'haiku',
  'statusline-setup': 'haiku',
  'caveman:cavecrew-investigator': 'haiku',
  'caveman:cavecrew-builder': 'sonnet',
  'caveman:cavecrew-reviewer': 'sonnet',
  Plan: 'opus',
}
const OPUS = /\b(architect\w*|design|root[- ]?cause|debug\w*|security|vulnerab\w*|audit|migrat\w*|refactor\w*|plan|trade-?offs?|concurren\w*|race)\b/i
const HAIKU = /\b(find|search|locate|list|grep|glob|read|summari[sz]e|look ?up|rename|format|count|fetch|where)\b/i

const tierOf = (m?: string): Tier | undefined =>
  /haiku/i.test(m ?? '') ? 'haiku' : /sonnet/i.test(m ?? '') ? 'sonnet' : /opus/i.test(m ?? '') ? 'opus' : undefined

const fallback = (type: string, description: string, prompt: string): Tier => {
  if (BY_TYPE[type]) return BY_TYPE[type]
  const text = description.trim() || prompt.slice(0, 200)
  return OPUS.test(text) ? 'opus' : HAIKU.test(text) ? 'haiku' : 'sonnet'
}

const log = atom({ plugin: 'model-router', key: 'log' } as const, [] as Routed[], {
  shape: 'log-1',
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Show which model each delegated task was routed to',
    })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [...composed.sections, { id: 'model-router:policy', text: POLICY, scope: 'session' }],
    }
  })

  on('agent.spawn', async ($, e, next) => {
    // Forks always inherit the parent model; a resume keeps its content.
    if (e.fork || e.resume) return next(e)

    const asked = tierOf(e.model)
    const model = asked ?? fallback(e.subagentType, e.description, e.prompt)
    const ran = await next({ ...e, model })

    if (ran.deny === undefined) {
      const row: Routed = {
        type: e.subagentType,
        task: (e.description || e.prompt).slice(0, 60),
        model,
        by: asked ? 'model' : 'router',
      }
      await update($, log, list => [...list, row].slice(-50))
      $.ui.status(`route: ${e.subagentType} -> ${model}`)
    }
    return ran
  })

  on('command.run', { command: 'route' }, async $ => {
    const list = await read($, log)
    if (list.length === 0) return { text: 'No tasks delegated yet.' }

    const count = (t: Tier) => list.filter(r => r.model === t).length
    const fell = list.filter(r => r.by === 'router').length
    const rows = list.slice(-10).map(r => `${r.model.padEnd(6)} ${r.by === 'router' ? '*' : ' '} ${r.type}: ${r.task}`)

    return {
      text: [
        `Routed ${list.length}: haiku ${count('haiku')}, sonnet ${count('sonnet')}, opus ${count('opus')}`,
        ...rows,
        ...(fell ? [`* ${fell} had no valid model from the main model; the router picked.`] : []),
      ].join('\n'),
    }
  })
}
