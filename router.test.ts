import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, TestBody } from 'claude-code/testing'

import { mayWrite } from './hooks/shell'

// Nothing sits beneath the plugin: these hooks stand for the engine. An Agent
// call launches in the background, or, with `foreground` set, runs to its end.
// Every model request records the loop and the model it went out on in `sent`
// and answers with `usage`; the turn router's own call records its prompt in
// `prompts` and answers `picked`; the conversation holds `context` tokens.
let resolved: string | undefined
let foreground = false
let picked = 'haiku'
let sent: string[] = []
let prompts: string[] = []
let usage: object | null = null
let context = 20_000
let clock: MockClock
const engine = (on: Parameters<TestBody>[1]) => {
  resolved = undefined
  foreground = false
  picked = 'haiku'
  sent = []
  prompts = []
  usage = null
  context = 20_000
  mock.store(on)
  clock = mock.clock(on, { now: 1_000_000 })
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: context, window: 1_000_000 }, rateLimits: [] } }))
  on('session.end', () => ({ sessionId: 's' }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('model.complete', (_, e) => {
    prompts.push(String(e.prompt))
    return {
      value: {
        isAnswered: true,
        text: picked,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('turn.step', async function* (_, e) {
    sent.push(`${e.agentId ?? 'main'}:${e.model}`)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'Agent') return { result: {} } as never
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

// One model request, read to its end.
const step = async ($: Engine, e: { turnId: string; index: number; model: string; agentId?: string }) => {
  const stream = $.turn.step({ messageCount: 1, ...e } as never)
  for await (const _ of stream) {
  }
  return stream.result
}

const call = async ($: Engine, input: object) => (await $.tool.call(input as never)).deny

const edit = { tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' }

const mainEnd = (turnId: string, model: string) =>
  ({
    turnId,
    reason: 'answer',
    answer: '',
    durationMs: 1000,
    isAborted: false,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model },
  }) as never

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

test('a light question runs on haiku; a write moves the turn to opus', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.turn.start({ text: 'what is left to build?', turnId: 't1' } as never)
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  expect(sent).toEqual(['main:haiku'])
  expect(await route($)).toContain('main: what is left to build?')

  expect(await call($, { tool: 'Bash', command: 'git status && grep -n "a>b" src | head' })).toBeUndefined()
  expect(await call($, edit)).toContain('only the latest opus writes files')
  await step($, { turnId: 't1', index: 1, model: 'claude-opus-5-5[1m]' })
  expect(sent[1]).toBe('main:claude-opus-5-5[1m]')
  expect(await call($, edit)).toBeUndefined()

  await $.turn.complete(mainEnd('t1', 'claude-opus-5-5'))
  expect(await route($)).toContain('haiku->opus')

  // A turn the router keeps on the picked model leaves the request as it was.
  picked = 'opus'
  await $.turn.start({ text: 'refactor the parser', turnId: 't2' } as never)
  await step($, { turnId: 't2', index: 0, model: 'claude-opus-5-5' })
  expect(sent[2]).toBe('main:claude-opus-5-5')
})

test('a shell command that may change files counts as a write', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'where is the parser?', turnId: 't1' } as never)
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })

  const reads = [
    'ls -la',
    'git -C repo log --oneline -5',
    'grep -rn "x > y" src',
    'cat a 2>/dev/null | wc -l',
    'find . -name "*.ts" 2>&1 | head',
    'for f in *.ts; do head -1 $f; done',
    'gh pr view 12',
  ]
  for (const command of reads) expect(await call($, { tool: 'Bash', command })).toBeUndefined()
  expect(await call($, { tool: 'PowerShell', command: 'Get-ChildItem -Recurse | Select-Object Name' })).toBeUndefined()

  const writes = [
    'echo hi > f',
    'sed -i s/a/b/ f',
    'git commit -m x',
    'npm install',
    'find . -name x -delete',
    'ls && rm -rf x',
    'cat $(which x)',
    `awk '{print > "o"}' f`,
    'Get-Content a | Set-Content b',
  ]
  for (const command of writes) expect(await call($, { tool: 'Bash', command })).toContain('only the latest opus')
  expect(await call($, { tool: 'PowerShell', command: 'Remove-Item x' })).toContain('only the latest opus')
})

test('an agent that writes moves to opus for its later steps', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await agent($, { description: 'work', model: 'sonnet' })

  await step($, { turnId: 'ta', index: 0, model: 'claude-sonnet-5-5', agentId: 'awork' })
  expect(await call($, { tool: 'Read', file_path: 'a.ts', agentId: 'awork' })).toBeUndefined()
  expect(await call($, { ...edit, agentId: 'awork' })).toContain('This agent now continues on opus')
  await step($, { turnId: 'ta', index: 1, model: 'claude-sonnet-5-5', agentId: 'awork' })
  expect(sent).toEqual(['awork:claude-sonnet-5-5', 'awork:opus'])
  expect(await call($, { ...edit, agentId: 'awork' })).toBeUndefined()
  expect(await route($)).toContain('sonnet->opus')

  // An agent on opus from the start writes untouched.
  await step($, { turnId: 'tb', index: 0, model: 'claude-opus-5-5', agentId: 'abuild' })
  expect(await call($, { ...edit, agentId: 'abuild' })).toBeUndefined()
})

test('with turn routing off the turn keeps its model, and writes still need opus', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await route($, 'auto off')).toContain('model you picked')
  expect(await route($)).toContain('Turn routing off')

  await $.turn.start({ text: 'what is left to build?', turnId: 't1' } as never)
  await step($, { turnId: 't1', index: 0, model: 'claude-sonnet-5-5' })
  expect(await call($, edit)).toContain('This turn now continues on opus')
  await step($, { turnId: 't1', index: 1, model: 'claude-sonnet-5-5' })
  expect(sent).toEqual(['main:claude-sonnet-5-5', 'main:opus'])
})

test('a pick the router cannot read leaves the turn on its model', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  picked = 'not sure'

  await $.turn.start({ text: 'hello', turnId: 't1' } as never)
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  expect(sent).toEqual(['main:claude-opus-5-5'])
  expect(await route($)).toContain('No tasks routed yet.')
})

test('the shell classifier reads commands as each shell does', () => {
  const bashReads = [
    'ls -la',
    'git -C repo log --oneline -5',
    'git branch -a',
    'git --git-dir .git log',
    'grep -rn "x > y" src',
    `grep -n '$(' a.sh`,
    'cat a 2>/dev/null | wc -l',
    'ls &>/dev/null',
    'find . -name "*.ts" 2>&1 | head',
    'for f in *.ts; do head -1 $f; done',
    '(cd src && ls)',
    '[[ -f x ]] && cat x',
    '# list the files\nls src  # what\'s here',
    "sed -n '10,20p' a.ts",
    "sed 's/a/b/g' a.ts",
    "awk -F: '{print $1}' /etc/passwd",
    'LC_ALL=C sort names.txt',
    'gh pr view 12',
    'x=1',
  ]
  for (const command of bashReads) expect([command, mayWrite(command, 'bash')]).toEqual([command, false])

  const bashWrites = [
    'echo hi > f',
    'sed -i s/a/b/ f',
    "sed -n 'w out.ts' a.ts",
    "echo x | sed '1e touch f'",
    'sed -f edit.sed f',
    'git commit -m x',
    'git diff --output=a.ts',
    "git -c core.pager='rm -rf src' log",
    'git grep -O"sh -c x" foo',
    'npm install',
    'find . -name x -delete',
    'find . -fprint0 out.txt',
    'ls && rm -rf x',
    'cat $(which x)',
    'cat "$(which x)"',
    `awk '{print > "o"}' f`,
    `awk 'BEGIN{system("rm -rf src")}'`,
    'sort -o a.ts in.txt',
    'uniq in.txt out.txt',
    'xxd -r patch.hex bin/app',
    'rg --pre rm . src',
    "GIT_EXTERNAL_DIFF='rm -rf src;:' git diff",
    'export GIT_EXTERNAL_DIFF=./x; git diff',
    './scripts/test -u',
    String.raw`echo \' ; rm -rf src ; echo \'`,
    "ls src  # what's here\nsed -i \"s/a/b/\" f  # fix it's import",
    'echo x >/dev/nullx',
    'cat <<EOF > a.ts\nx\nEOF',
    "echo 'unclosed",
  ]
  for (const command of bashWrites) expect([command, mayWrite(command, 'bash')]).toEqual([command, true])

  const pwshReads = [
    'Get-ChildItem -Recurse | Select-Object Name',
    'Get-ChildItem | Where-Object { $_.Length -gt 0 }',
    'Get-ChildItem | ForEach-Object { $_.Name }',
    'Get-Content a.ts 2>$null',
    '(Get-Content a.ts).Length',
    '$x = Get-Item a.ts',
    "Select-String -Path *.ts -Pattern 'x > y'",
    'git status; git log -5',
  ]
  for (const command of pwshReads) expect([command, mayWrite(command, 'pwsh')]).toEqual([command, false])

  const pwshWrites = [
    'Get-Content a | Set-Content b',
    'Remove-Item x',
    "Write-Output (Set-Content a.ts 'code')",
    '(Get-Item a.ts).Delete()',
    "[IO.File]::WriteAllText('a.ts', 'x')",
    "& (Get-Command Set-Content) a.ts 'x'",
    "Get-Item a | Where-Object { Set-Content a.ts 'x' }",
    'Get-ChildItem *.tmp | ForEach-Object -MemberName Delete',
    '$x = Remove-Item a.ts',
    'Get-ChildItem "C:\proj\src\\" ; Set-Content "C:\proj\src\a.ts" \'x\'',
    'echo code >$null"src/a.ts"',
    'Get-Content a > b',
    '. ./setup.ps1',
  ]
  for (const command of pwshWrites) expect([command, mayWrite(command, 'pwsh')]).toEqual([command, true])
})

test('every tool that can change files is held to opus', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'where is the parser?', turnId: 't1' } as never)
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })

  expect(await call($, { tool: 'Monitor', command: 'npm run dev', description: 'x' })).toContain('only the latest opus')
  expect(await call($, { tool: 'Monitor', command: 'tail -f log.txt', description: 'x' })).toBeUndefined()
  expect(await call($, { tool: 'mcp__terminal__run_in_terminal', command: 'Remove-Item x' })).toContain('only the latest opus')
  expect(await call($, { tool: 'ExitWorktree', action: 'remove' })).toContain('only the latest opus')
  expect(await call($, { tool: 'ExitWorktree', action: 'keep' })).toBeUndefined()
})

test('a downgrade that would cost more than staying is skipped', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // Sonnet must write the whole conversation into its own cache: worth it only when opus's is cold.
  picked = 'opus'
  await $.turn.start({ text: 'design the parser', turnId: 't1' } as never)
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  expect(sent[0]).toBe('main:claude-opus-5-5')
  await $.turn.complete(mainEnd('t1', 'claude-opus-5-5'))

  picked = 'sonnet'
  await $.turn.start({ text: 'review the parser', turnId: 't2' } as never)
  await step($, { turnId: 't2', index: 0, model: 'claude-opus-5-5' })
  expect(sent[1]).toBe('main:claude-opus-5-5')
  await clock.advance(61 * 60_000)
  await $.turn.start({ text: 'review the parser', turnId: 't3' } as never)
  await step($, { turnId: 't3', index: 0, model: 'claude-opus-5-5' })
  expect(sent[2]).toBe('main:sonnet')

  // Haiku pays more per token past 100K, so a long conversation on a warm opus cache stays.
  picked = 'opus'
  await $.turn.start({ text: 'design the cache', turnId: 't4' } as never)
  await step($, { turnId: 't4', index: 0, model: 'claude-opus-5-5' })
  picked = 'haiku'
  context = 150_000
  await $.turn.start({ text: 'what is left?', turnId: 't5' } as never)
  await step($, { turnId: 't5', index: 0, model: 'claude-opus-5-5' })
  expect(sent[4]).toBe('main:claude-opus-5-5')
  context = 60_000
  await $.turn.start({ text: 'what is left?', turnId: 't6' } as never)
  await step($, { turnId: 't6', index: 0, model: 'claude-opus-5-5' })
  expect(sent[5]).toBe('main:haiku')

  // Moving up is for quality: always.
  picked = 'opus'
  await $.turn.start({ text: 'design the cache', turnId: 't7' } as never)
  await step($, { turnId: 't7', index: 0, model: 'claude-haiku-5-5' })
  expect(sent[6]).toBe('main:opus')
})

test('a message typed into a running turn drops its pick; a delivered notice does not', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'what is left to build?', turnId: 't1' } as never)
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  const notice = { text: '<task-notification>done</task-notification>', turnId: 't1', isMeta: true }
  await $.prompt.submit({ ...notice, origin: { kind: 'task-notification' } } as never)
  await step($, { turnId: 't1', index: 1, model: 'claude-opus-5-5' })
  await $.prompt.submit({ text: 'ok, build the next item', turnId: 't1', origin: { kind: 'composer' } } as never)
  await step($, { turnId: 't1', index: 2, model: 'claude-opus-5-5' })
  expect(sent).toEqual(['main:haiku', 'main:haiku', 'main:claude-opus-5-5'])
})

test('the router reads the reply a message answers, until the conversation is cleared', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'clean up the old files', turnId: 't1' } as never)
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  await $.turn.complete({ ...(mainEnd('t1', 'claude-opus-5-5') as object), answer: 'Shall I delete build/?' } as never)

  await $.turn.start({ text: 'yes', turnId: 't2' } as never)
  await step($, { turnId: 't2', index: 0, model: 'claude-opus-5-5' })
  expect(prompts[1]).toContain('Shall I delete build/?')

  await $.session.end({ reason: 'clear' } as never)
  await $.turn.start({ text: 'yes', turnId: 't3' } as never)
  await step($, { turnId: 't3', index: 0, model: 'claude-opus-5-5' })
  expect(prompts[2]).not.toContain('previous-reply')
})

test('the cache lifetime is learned from what a request found cached', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  picked = 'opus'
  await $.turn.start({ text: 'design it', turnId: 't1' } as never)
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5' })

  // Twenty minutes on, the cache had to be written again: entries live five minutes.
  await clock.advance(20 * 60_000)
  usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 20_000 }
  await $.turn.start({ text: 'design it', turnId: 't2' } as never)
  await step($, { turnId: 't2', index: 0, model: 'claude-opus-5-5' })
  usage = null

  // Ten minutes later opus's cache is cold, so a review moves to sonnet; under an hour's cache it would stay.
  await clock.advance(10 * 60_000)
  picked = 'sonnet'
  await $.turn.start({ text: 'review it', turnId: 't3' } as never)
  await step($, { turnId: 't3', index: 0, model: 'claude-opus-5-5' })
  expect(sent[2]).toBe('main:sonnet')
})

test('only the latest opus writes; an id with no tier word is left alone', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await route($, 'auto off')

  await $.turn.start({ text: 'fix it', turnId: 't1' } as never)
  await step($, { turnId: 't1', index: 0, model: 'claude-opus-4-8' })
  expect(await call($, edit)).toContain('only the latest opus')
  await step($, { turnId: 't1', index: 1, model: 'claude-opus-4-8' })
  expect(sent[1]).toBe('main:opus')

  const arn = 'arn:aws:bedrock:us-east-1:123:application-inference-profile/x'
  await $.turn.start({ text: 'fix it', turnId: 't2' } as never)
  await step($, { turnId: 't2', index: 0, model: arn })
  expect(await call($, edit)).toBeUndefined()

  // A gateway spells the version with a dot.
  await $.turn.start({ text: 'fix it', turnId: 't3' } as never)
  await step($, { turnId: 't3', index: 0, model: 'anthropic/claude-opus-5.5' })
  expect(await call($, edit)).toBeUndefined()
})

test('a turn whose start was missed is still held to opus', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($, { turnId: 't9', index: 3, model: 'claude-sonnet-5-5' })
  expect(await call($, edit)).toContain('This turn now continues on opus')
  await step($, { turnId: 't9', index: 4, model: 'claude-sonnet-5-5' })
  expect(sent[1]).toBe('main:opus')
})

test('main turns never push a running agent out of the log', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await agent($, { description: 'mate', name: 'scout', model: 'haiku' })
  for (let i = 0; i < 60; i++) {
    await $.turn.start({ text: `question ${i}`, turnId: `t${i}` } as never)
    await step($, { turnId: `t${i}`, index: 0, model: 'claude-opus-5-5' })
    await $.turn.complete(mainEnd(`t${i}`, 'claude-haiku-5-5'))
  }
  await $.turn.complete(end('amate', 'claude-haiku-5-5'))
  // 25 turns kept, and the teammate's run counted though 60 turns came after it.
  expect(await route($)).toContain('haiku  26 runs, 0 failed, 4.0k in / 1.4k out')
})
