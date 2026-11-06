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

test('a workflow agent keeps the session model unless its script names a tier', async ($, on) => {
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'inherit', agentId: 'a1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // `workflow` is stamped by the engine for a script's agent(); the test hands it over.
  const workflow = { runId: 'wf_test', agentIndex: 1 }
  const route = async (input: object) =>
    (await $.agent.spawn({ prompt: 'x', workflow, ...input } as never)).model

  // Fallback keywords ("Find") would send this to haiku for any other agent.
  expect(await route({ prompt: 'Find the config files' })).toBe('inherit')
  expect(await route({ model: 'fable' })).toBe('fable')
  expect(await route({ model: 'claude-opus-5-5' })).toBe('opus')
})

test('the policy rides only a prompt that offers the Agent tool', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))

  const has = async (tools: string[]) =>
    (
      await $.prompt.compose({
        model: 'claude-sonnet-5-5',
        promptModel: 'claude-sonnet-5-5',
        surfaces: [],
        tools,
        outputStyle: null,
        traits: [],
      })
    ).sections.some(s => s.id === 'model-router:policy')

  expect(await has(['Agent', 'Read'])).toBe(true)
  expect(await has(['Read'])).toBe(false)
})
