export type Tier = 'haiku' | 'sonnet' | 'opus'

export type Routed = {
  // The subagent's id, as agent.spawn's result and its turn.complete carry it.
  id: string
  type: string
  task: string
  // The tier the main model picked.
  asked: Tier
  // The model that actually runs: core's resolved id at spawn, then the one that answered.
  ran?: string
  status: 'running' | 'done' | 'error' | 'aborted' | 'refusal'
  ms: number
  tokIn: number
  tokOut: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': { log: Shaped<Routed[]> }
  }
}
