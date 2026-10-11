import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'side-panel',
  props: {
    title: 'Tasks',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Stand in for the engine: no pane is really opened, and the drawing reads a fixed clock and folder
const stubEngine = (on: On) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-10-10T00:00:00Z') }))
  on('session.cwd', () => ({ value: 'C:/work' }))
}

test('/panel opens the pane at one third of the terminal width', async ($, on) => {
  stubEngine(on)

  const answer = await $.command.run({
    command: 'panel',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(answer.text).toContain('Pane opened at 40 columns')
})

test('RESULT lists written and edited files once each, and published pages', async ($, on) => {
  stubEngine(on)
  // Stand in for the tools: each answers as the built-in would
  on('tool.call', ($, e) => {
    const call = e as unknown as Record<string, unknown>
    if (call.tool === 'Write') return { result: { type: 'create', filePath: call.file_path, content: '' } } as never
    if (call.tool === 'Artifact') return { result: { url: 'https://claude.ai/artifact/abc' } } as never
    if (call.tool === 'Edit' && call.file_path === 'C:/work/bad.md') return { result: {}, isError: true } as never
    return { result: {} } as never
  })

  const call = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<unknown>
  await call({ tool: 'Write', file_path: 'C:/work/a.md', content: 'x' })
  await call({ tool: 'Edit', file_path: 'C:/work/a.md', old_string: 'x', new_string: 'y' })
  await call({ tool: 'Edit', file_path: 'C:/work/b.ts', old_string: 'x', new_string: 'y' })
  await call({ tool: 'Edit', file_path: 'C:/work/bad.md', old_string: 'x', new_string: 'y' })
  await call({ tool: 'Artifact', file_path: 'C:/work/page.html' })
  await call({ tool: 'Read', file_path: 'C:/work/c.md' })

  const ui = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /RESULT/ })).toBeDefined()
  // Each file is one pressable row; created then edited stays a creation
  expect((await ui.find({ key: 'open:C:/work/a.md' }))?.text).toMatch(/\+ a\.md/)
  expect((await ui.find({ key: 'open:C:/work/b.ts' }))?.text).toMatch(/✎ b\.ts/)
  // A page is a link to the browser
  expect(await ui.find({ type: 'Link', text: /claude\.ai\/artifact\/abc/ })).toBeDefined()
  // A failed call and a read leave nothing
  expect(await ui.find({ key: 'open:C:/work/bad.md' })).toBeUndefined()
  expect(await ui.find({ key: 'open:C:/work/c.md' })).toBeUndefined()
  await ui.unmount()
})

test('RESULT lists files a shell command wrote, read back from git', async ($, on) => {
  stubEngine(on)
  const now = Date.parse('2026-10-10T00:00:00Z')
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } }) as never)
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    const reply = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } }) as never
    if (argv.includes('rev-parse')) return reply('C:/work\n')
    // Untracked report, a data file it changed, one changed before the call, one deleted
    if (argv.includes('status')) return reply('?? out/report.md\0 M data.csv\0 M stale.md\0 D gone.md\0')
    // A commit it made: a new file, and one it committed without writing
    if (argv.includes('log')) return reply('A\0out/committed.md\0M\0older.md\0')
    return reply('')
  })
  on('fs.stat', ($, e) => {
    const path = (e as unknown as { path: string }).path
    const mtimeMs = /stale|older/.test(path) ? now - 3_600_000 : now
    return { value: { kind: 'file', size: 1, mtimeMs, isLink: false } } as never
  })

  const call = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<unknown>
  await call({ tool: 'Bash', command: 'python report.py && git commit -am x' })

  const ui = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  expect((await ui.find({ key: 'open:C:\\work\\out\\report.md' }))?.text).toMatch(/\+ out[\\/]report\.md/)
  expect((await ui.find({ key: 'open:C:\\work\\out\\committed.md' }))?.text).toMatch(/\+ /)
  expect((await ui.find({ key: 'open:C:\\work\\data.csv' }))?.text).toMatch(/✎ /)
  // Written before the call, or deleted: not this call's output
  expect(await ui.find({ key: 'open:C:\\work\\stale.md' })).toBeUndefined()
  expect(await ui.find({ key: 'open:C:\\work\\older.md' })).toBeUndefined()
  expect(await ui.find({ key: 'open:C:\\work\\gone.md' })).toBeUndefined()
  await ui.unmount()
})

test('RESULT previews a pressed file and opens it in Notepad', async ($, on) => {
  stubEngine(on)
  on('tool.call', ($, e) => {
    const call = e as unknown as Record<string, unknown>
    return { result: { type: 'create', filePath: call.file_path, content: '' } } as never
  })
  on('fs.read', () => ({ value: '# Spec\n\nKim Eunhye' }) as never)
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push([...(e as unknown as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })

  const call = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<unknown>
  await call({ tool: 'Write', file_path: 'C:/work/spec.md', content: 'x' })

  const ui = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'open:C:/work/spec.md' })
  expect(await ui.find({ key: 'preview:back' })).toBeDefined()
  expect(await ui.find({ text: /Kim Eunhye/ })).toBeDefined()

  await ui.press({ key: 'preview:notepad' })
  expect(runs).toEqual([['cmd', '/d', '/c', 'start', '', 'notepad.exe', 'C:\\work\\spec.md']])

  // Back returns to the list
  await ui.press({ key: 'preview:back' })
  expect(await ui.find({ key: 'open:C:/work/spec.md' })).toBeDefined()
  await ui.unmount()
})

test('QUESTIONS starts empty', async ($, on) => {
  stubEngine(on)

  const ui = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /QUESTIONS/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No questions yet/ })).toBeDefined()
  await ui.unmount()
})

test('SESSIONS shows other terminals and marks the one that just finished', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-10T00:00:00Z') })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: 'C:/work' }))
  on('session.id', () => ({ value: 'self-id' }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    return { value: undefined } as never
  })
  // Stand in for `claude agents --json`: the other session works, then finishes
  let otherStatus = 'busy'
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify([
        { sessionId: 'self-id', name: 'side-panel', cwd: 'C:/work', status: 'busy' },
        { sessionId: 'other-id', name: 'eoullim-spec', cwd: 'C:/dev/eoullim', status: otherStatus },
      ]),
    },
  }) as never)
  // What session.start reads besides the sessions; the engine beneath answers the start itself
  on('command.register', () => ({ value: undefined }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.usage', () => ({ value: { rateLimits: [] } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /eoullim-spec/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /working/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\(this\)/ })).toBeDefined()

  otherStatus = 'idle'
  await clock.advance(10_000)
  expect(await ui.find({ type: 'Text', text: /done 0s ago/ })).toBeDefined()
  expect(toasts).toContain('✓ eoullim-spec finished')
  await ui.unmount()
})

test('A pressed question shows its Haiku summary and scrolls back to it', async ($, on) => {
  stubEngine(on)
  // The engine beneath: the turn's reply, the transcript row and the model
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.render', { component: 'UserMessage' }, () => ({ type: 'Text', props: {}, children: ['row'] }) as never)
  const asked: { model: string; prompt: string }[] = []
  on('model.complete', ($, e) => {
    asked.push(e as unknown as { model: string; prompt: string })
    return { value: { isAnswered: true, text: '- 이름을 김은혜로 바꿈', usage: {} } } as never
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    return { value: undefined } as never
  })

  await $.turn.start({ turnId: 't1', text: '최민영을 김은혜로 바꿔줘' } as never)
  await $.turn.complete({
    turnId: 't1',
    reason: 'answer',
    answer: 'Renamed 최민영 to 김은혜 in docs/specs/quq.md.',
    durationMs: 1000,
    isAborted: false,
  } as never)
  const row = await $.ui.mount({
    plugin: 'side-panel',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'row-1',
    props: { text: '최민영을 김은혜로 바꿔줘', origin: { kind: 'composer' }, isExpanded: false } as never,
  })
  await row.unmount()

  const ui = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  await ui.press({ key: 'q:t1' })
  expect(asked.map(one => one.model)).toEqual(['haiku'])
  expect(asked[0]!.prompt).toContain('quq.md')
  expect(await ui.find({ text: /김은혜로 바꿈/ })).toBeDefined()

  // Opening it again reuses the summary
  await ui.press({ key: 'question:back' })
  await ui.press({ key: 'q:t1' })
  expect(asked).toHaveLength(1)

  await ui.press({ key: 'question:jump' })
  // The row was found and a scroll to it was asked for; the test kit has no transcript to
  // answer a scroll of one, so only the attempt is checked here
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('ui.scroll')
  await ui.unmount()
})

test('LEFT lists every window the account reports, a model\'s own one by the model name', async ($, on) => {
  stubEngine(on)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.usage', () => ({
    value: {
      rateLimits: [
        { kind: 'five_hour', percentUsed: 20 },
        { kind: 'seven_day', percentUsed: 40 },
        { kind: 'seven_day_fable', percentUsed: 75 },
      ],
    },
  }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('session.id', () => ({ value: 'self-id' }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /fable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /25%/ })).toBeDefined()
  await ui.unmount()
})

test('MODEL shows how full the context window is, and follows each measurement', async ($, on) => {
  stubEngine(on)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  // A fresh session: the window is known, its fill not yet
  on('session.usage', () => ({ value: { rateLimits: [], context: { window: 200_000 } } }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('session.id', () => ({ value: 'self-id' }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /ctx —/ })).toBeDefined()
  await ui.unmount()

  await $.session.measure({
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [],
    changed: ['context'],
  } as never)
  const after = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  expect(await after.find({ type: 'Text', text: /ctx 42% \(84k\/200k\)/ })).toBeDefined()
  await after.unmount()
})

test('The top box names the working folder, only its last folder when the path is too long', async ($, on) => {
  let cwd = 'C:/work'
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-10-10T00:00:00Z') }))
  on('session.cwd', () => ({ value: cwd }))

  const ui = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /DIR C:\/work/ })).toBeDefined()
  await ui.unmount()

  cwd = 'C:/Users/someone/Documents/projects/a-rather-long-folder/deeper/still/side-panel'
  const narrow = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  expect(await narrow.find({ type: 'Text', text: /DIR side-panel$/ })).toBeDefined()
  await narrow.unmount()
})

test('A session can be hidden from SESSIONS and shown again', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-10T00:00:00Z') })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: 'C:/work' }))
  on('session.id', () => ({ value: 'self-id' }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    return { value: undefined } as never
  })
  // The plugin's store, shared by every terminal; the test reads it and writes it as another terminal would
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }) as never)
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined } as never
  })
  let otherStatus = 'busy'
  let listed = true
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify([
        { sessionId: 'self-id', name: 'side-panel', cwd: 'C:/work', status: 'busy' },
        ...(listed ? [{ sessionId: 'other-id', name: 'eoullim-spec', cwd: 'C:/dev/eoullim', status: otherStatus }] : []),
      ]),
    },
  }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.usage', () => ({ value: { rateLimits: [] } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'side-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /eoullim-spec/ })).toBeDefined()

  await ui.press({ key: 'hide:other-id' })
  expect(await ui.find({ type: 'Text', text: /eoullim-spec/ })).toBeUndefined()
  expect(await ui.find({ key: 'sessions:unhide' })).toBeDefined()

  // A hidden session that finishes raises no toast
  otherStatus = 'idle'
  await clock.advance(10_000)
  expect(toasts).toEqual([])

  // The choice is kept in the store, where every terminal reads it
  expect(store.hidden).toEqual(['other-id'])

  await ui.press({ key: 'sessions:unhide' })
  expect(await ui.find({ type: 'Text', text: /eoullim-spec/ })).toBeDefined()
  expect(store.hidden).toEqual([])

  // Hidden from another terminal: taken up at the next look
  store.hidden = ['other-id']
  await clock.advance(10_000)
  expect(await ui.find({ type: 'Text', text: /eoullim-spec/ })).toBeUndefined()

  // The session ends: it is forgotten, in the store too
  listed = false
  await clock.advance(10_000)
  expect(await ui.find({ key: 'sessions:unhide' })).toBeUndefined()
  expect(store.hidden).toEqual([])
  await ui.unmount()
})
