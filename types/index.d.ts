export type Tier = 'haiku' | 'sonnet' | 'opus'

export type Routed = {
  // The subagent's id, as the Agent tool's result and its turn.complete carry it; a main turn's turn id.
  id: string
  type: string
  task: string
  // The tier the main model picked, or the router picked for a main turn.
  asked: Tier
  // The model that actually runs: the Agent tool's resolved model, then the one that answered.
  ran?: string
  status: 'running' | 'done' | 'error' | 'aborted' | 'refusal'
  ms: number
  tokIn: number
  tokOut: number
}

// The main loop's prompt cache: how long an entry lives, learned from the requests, and when
// the main loop last sent a request on each model.
export type Cache = {
  ttl: '5m' | '1h'
  sentAt: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': { log: Shaped<Routed[]>; cache: Shaped<Cache> }
  }
}
