import { expect, test } from 'claude-code/testing'

test('every spawn gets one of haiku, sonnet, opus', async ($, on) => {
  // Nothing sits beneath the plugin: this hook stands for the engine and
  // echoes the model the plugin handed down.
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'inherit', agentId: 'a1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const route = async (input: Parameters<typeof $.agent.spawn>[0]) =>
    (await $.agent.spawn(input)).model

  // The main model's valid pick stands, full ids become aliases.
  expect(await route({ prompt: 'x', model: 'opus' })).toBe('opus')
  expect(await route({ prompt: 'x', model: 'claude-haiku-5-5' })).toBe('haiku')
  // No pick, or one outside the three: the fallback decides.
  expect(await route({ prompt: 'x', subagentType: 'Explore' })).toBe('haiku')
  expect(await route({ prompt: 'x', subagentType: 'Explore', model: 'fable' })).toBe('haiku')
  expect(await route({ prompt: 'x', description: 'Design auth architecture' })).toBe('opus')
  expect(await route({ prompt: 'x', description: 'Find config files' })).toBe('haiku')
  expect(await route({ prompt: 'x', description: 'Add retry to client' })).toBe('sonnet')
})
