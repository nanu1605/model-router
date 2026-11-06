import { expect, test } from 'claude-code/testing'

// Nothing sits beneath the plugin: this hook stands for the engine. It resolves
// a spawn to the model it was handed, or to `resolved` when the test forces one.
let resolved: string | undefined
const engine = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  resolved = undefined
  on('agent.spawn', (_, e) => ({ model: resolved ?? e.model ?? 'inherit', agentId: `a${e.description}` }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'route' } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

const end = (agentId: string, model: string, reason = 'answer') =>
  ({
    agentId,
    reason,
    answer: '',
    durationMs: 2000,
    isAborted: reason === 'aborted',
    turnId: `t${agentId}`,
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, model },
  }) as never

const route = async ($: { command: { run: (e: never) => Promise<{ text?: string }> } }, args = '') =>
  (await $.command.run({ command: 'route', args, origin: { kind: 'composer' } } as never)).text ?? ''

test('the main model must pick a tier; a valid pick goes on as given', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const spawn = (input: object) => $.agent.spawn({ prompt: 'x', description: '1', ...input } as never)

  expect((await spawn({})).deny).toContain('model-router: this Agent call has no model')
  expect((await spawn({ model: 'fable' })).deny).toContain('haiku')
  expect((await spawn({ model: 'inherit' })).deny).toBeDefined()

  expect((await spawn({ model: 'haiku' })).model).toBe('haiku')
  expect((await spawn({ model: 'opus[1m]' })).model).toBe('opus[1m]')
  expect((await spawn({ model: 'claude-sonnet-4-5' })).model).toBe('claude-sonnet-4-5')
})

test('a workflow agent goes on untouched', async ($, on) => {
  engine(on)
  const workflow = { runId: 'wf_test', agentIndex: 1 }
  const spawn = async (input: object) =>
    (await $.agent.spawn({ prompt: 'x', workflow, ...input } as never)).model

  expect(await spawn({})).toBe('inherit')
  expect(await spawn({ model: 'claude-opus-5-5' })).toBe('claude-opus-5-5')
})

test('/route reports usage, outcome and the model that actually ran', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.agent.spawn({ prompt: 'x', description: 'one', subagentType: 'Explore', model: 'haiku' } as never)
  resolved = 'claude-opus-5-5'
  await $.agent.spawn({ prompt: 'x', description: 'two', subagentType: 'general-purpose', model: 'haiku' } as never)
  expect(await route($)).toContain('running')

  await $.turn.complete(end('aone', 'claude-haiku-5-5'))
  await $.turn.complete(end('atwo', 'claude-opus-5-5', 'error'))

  const text = await route($)
  expect(text).toContain('haiku  2 runs, 1 failed, 3.0k in / 400 out, avg 2.0s')
  expect(text).toContain('haiku->opus')
  expect(text).toContain('error')
  expect(text).toContain('Explore: one')
})

test('the pane lists routed agents on every surface', async ($, on) => {
  engine(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Design auth', subagentType: 'Plan', model: 'opus' } as never)
  expect(await route($, 'pane')).toBe('Model routing pane opened.')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'model-router',
      component: 'Pane',
      requestId: 'model-router',
      surface,
      props: {
        title: 'Model routing',
        isFocused: false,
        bodyColumns: 100,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /Plan: Design auth/ }))?.text).toContain('running')
    await ui.unmount()
  }
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
