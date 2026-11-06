export type Tier = 'haiku' | 'sonnet' | 'opus'

export type Routed = {
  type: string
  task: string
  model: Tier
  // 'model': the main model chose it. 'router': it chose none valid; the mod's fallback did.
  by: 'model' | 'router'
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': { log: Shaped<Routed[]> }
  }
}
