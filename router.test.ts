import { expect, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

// Nothing sits beneath the plugin: these hooks stand for the engine. An Agent
// call launches in the background, or, with `foreground` set, runs to its end.
let resolved: string | undefined
let foreground = false
const engine = (on: Parameters<TestBody>[1]) => {
  resolved = undefined
  foreground = false
  on('tool.call', (_, e) => {
    const call = e as unknown as { description: string; prompt: string; model?: string; name?: string }
    const model = resolved ?? `claude-${call.model}-5-5`
    // A completed record's usage is its last response alone: kept small so a test tells it from a summed run.
    const result = call.name
      ? { status: 'teammate_spawned', agentId: `a${call.description}`, agent_id: `a${call.description}`, name: call.name }
      : foreground
      ? {
          status: 'completed',
          agentId: `a${call.description}`,
          resolvedModel: model,
          content: [],
          prompt: call.prompt,
          totalToolUseCount: 0,
          totalDurationMs: 9000,
          totalTokens: 15,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: 0 },
        }
      : {
          status: 'async_launched',
          agentId: `a${call.description}`,
          description: call.description,
          resolvedModel: model,
          prompt: call.prompt,
          outputFile: '',
        }
    return { result } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'route' } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
}

const agent = ($: Engine, input: object) =>
  $.tool.call({ tool: 'Agent', prompt: 'x', description: 'task', ...input } as never)

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

const route = async ($: Engine, args = '') =>
  (await $.command.run({ command: 'route', args, origin: { kind: 'composer' } } as never)).text ?? ''

test('the main model must pick a tier; a fork and a valid pick go on', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect((await agent($, {})).deny).toContain('model-router: this Agent call has no model')
  expect((await agent($, { model: 'fable' })).deny).toContain('haiku')

  expect((await agent($, { model: 'haiku' })).deny).toBeUndefined()
  expect((await agent($, { subagent_type: 'fork' })).deny).toBeUndefined()
})

test('/route reports usage, outcome and the model that actually ran', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await agent($, { description: 'one', subagent_type: 'Explore', model: 'haiku' })
  resolved = 'claude-opus-5-5'
  await agent($, { description: 'two', model: 'haiku' })
  expect(await route($)).toContain('running')

  await $.turn.complete(end('aone', 'claude-haiku-5-5'))
  await $.turn.complete(end('atwo', 'claude-opus-5-5', 'error'))

  const text = await route($)
  expect(text).toContain('haiku  2 runs, 1 failed, 3.0k in / 400 out, avg 2.0s')
  expect(text).toContain('haiku->opus')
  expect(text).toContain('error')
  expect(text).toContain('Explore: one')
  expect(text).toContain('general-purpose: two')
})

test('a foreground agent takes its summed run, which ends before its call returns', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  foreground = true

  await $.turn.complete(end('areview', 'claude-sonnet-5-5', 'error'))
  await agent($, { description: 'review', model: 'sonnet' })
  // With no run heard, the record stands in.
  await agent($, { description: 'lint', model: 'haiku' })

  const text = await route($)
  expect(text).toContain('sonnet 1 runs, 1 failed, 1.5k in / 200 out, avg 2.0s')
  expect(text).toContain('haiku  1 runs, 0 failed, 10 in / 5 out, avg 9.0s')
})

test('a teammate and a resumed agent run again on each turn', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await agent($, { description: 'mate', name: 'scout', model: 'haiku' })
  expect(await route($)).toContain('haiku        running')

  await $.turn.complete(end('amate', 'claude-haiku-5-5'))
  expect(await route($)).toContain('haiku        done')

  await $.turn.start({ agentId: 'amate', text: 'next', turnId: 't2' } as never)
  expect(await route($)).toContain('haiku        running')
  await $.turn.complete(end('amate', 'claude-haiku-5-5'))
  expect(await route($)).toContain('3.0k/400')
})

test('a model id with no tier word is no mismatch', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  resolved = 'arn:aws:bedrock:us-east-1:123:application-inference-profile/x'

  await agent($, { description: 'arn', model: 'opus' })

  expect(await route($)).not.toContain('->')
})

test('the pane lists routed agents on every surface', async ($, on) => {
  engine(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await agent($, { description: 'Design auth', subagent_type: 'Plan', model: 'opus' })
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
