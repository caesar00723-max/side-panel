import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AskItem,
  ContextView,
  InfoView,
  LimitView,
  OutputItem,
  PreviewView,
  QuestionItem,
  SessionView,
  TurnView,
} from '../types'

const PANE = 'side-panel'
const MAX_QUESTIONS = 60
const MAX_OUTPUTS = 80
// QUESTIONS takes up to this share of the pane's rows; RESULT gets the rest
const QUESTION_SHARE = 0.6
// How often the other sessions are checked (`claude agents --json` takes about a second)
const POLL_MS = 10_000
// How long a session that just finished stays highlighted
const FINISHED_MS = 10 * 60_000
const MAX_SESSIONS_SHOWN = 6
// A preview shows at most this much of a file; Notepad opens the whole of it
const PREVIEW_CHARS = 20_000
// How much of each reply is kept for its summary
const ANSWER_CHARS = 8_000
const SUMMARY_RULES =
  'You summarize one exchange between a user and a coding assistant for a narrow side panel. ' +
  'Write 3 to 6 lines in the same language as the question, one terse statement per line: ' +
  'what was asked, what was done or decided, and the outcome or the next step. ' +
  'Each line is a clipped fragment that ends the moment the fact is stated, never a flowing ' +
  'sentence with connectives. In Korean end every line with a bare past-tense stem, not a polite ' +
  'or narrative ending (e.g. "물어봄.", "대답함.", "파일 수정함.", "테스트 통과함.", "다음 단계 제안함."). ' +
  'Name files, commands and numbers when they matter. ' +
  'Plain lines only: no bullet characters, numbering, bold, headings, preamble or closing line.'

// Theme keys, not raw colors, so the pane follows whatever theme the person picked (custom ones too)
const PALETTE = {
  mint: 'success',
  mintBorder: 'success',
  blue: 'suggestion',
  blueBorder: 'promptBorder',
  lavender: 'claude',
  peach: 'warning',
  yellow: 'warning',
  yellowBorder: 'warning',
  infoBorder: 'subtle',
  text: 'text',
  muted: 'inactive',
  // Marks this session among the others
  red: 'error',
  status: {
    idle: 'inactive',
    running: 'warning',
    done: 'success',
    aborted: 'warning',
    error: 'error',
  },
} as const

const OUTPUT_MARK: Record<OutputItem['kind'], { mark: string; color: string }> = {
  create: { mark: '+', color: PALETTE.mint },
  edit: { mark: '✎', color: PALETTE.yellow },
  link: { mark: '↗', color: PALETTE.blue },
}

const QUESTION_MARK: Record<QuestionItem['status'], string> = {
  running: '●',
  done: '✓',
  aborted: '■',
  error: '✗',
}

// How each session state is marked, in the order rows are listed (most pressing first)
const SESSION_LOOK = {
  finished: { mark: '✓', color: PALETTE.mint, rank: 0 },
  waiting: { mark: '!', color: PALETTE.peach, rank: 1 },
  asking: { mark: '?', color: PALETTE.yellow, rank: 2 },
  busy: { mark: '●', color: PALETTE.blue, rank: 3 },
  idle: { mark: '○', color: PALETTE.muted, rank: 4 },
} as const

const questions = atom({ plugin: 'side-panel', key: 'questions' } as const, [])
const outputs = atom({ plugin: 'side-panel', key: 'outputs' } as const, [])
const sessions = atom({ plugin: 'side-panel', key: 'sessions' } as const, [])
const hidden = atom({ plugin: 'side-panel', key: 'hidden' } as const, [])
const NO_PREVIEW: PreviewView = { path: '', kind: 'text', text: '', isTruncated: false, error: '' }
const preview = atom({ plugin: 'side-panel', key: 'preview' } as const, NO_PREVIEW)
const opened = atom({ plugin: 'side-panel', key: 'opened' } as const, '')
const NO_ASK: TurnView['ask'] = { state: 'none', items: [], answers: [] }
const turn = atom({ plugin: 'side-panel', key: 'turn' } as const, {
  status: 'idle',
  turnId: '',
  ask: NO_ASK,
} as TurnView)
const info = atom({ plugin: 'side-panel', key: 'info' } as const, {
  model: '',
  effort: '',
  limits: [],
  context: { window: 0 },
} as InfoView)

// Short model name: claude-opus-5-5 -> opus-5-5
const shortModel = (model: string): string => model.replace(/^claude-/, '').replace(/\[1m\]$/, ' 1M')

const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

// A model's own weekly window (e.g. seven_day_fable) is labelled by the model
const limitLabel = (kind: string): string =>
  LIMIT_LABEL[kind] ?? (/fable/i.test(kind) ? 'fable' : kind)

// Time until a reset, as 2h13m or 3d4h
const until = (resetsAt: string | undefined, now: number): string => {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at)) return ''
  const mins = Math.max(0, Math.round((at - now) / 60000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  return d > 0 ? d + 'd' + h + 'h' : h > 0 ? h + 'h' + m + 'm' : m + 'm'
}

const toLimits = (list: readonly LimitView[]): LimitView[] =>
  list.map(one => ({ kind: one.kind, percentUsed: one.percentUsed, resetsAt: one.resetsAt }))

const remainColor = (left: number, plenty: string = PALETTE.mint): string =>
  left <= 10 ? PALETTE.status.error : left <= 30 ? PALETTE.peach : plenty

// Only the status line's figures; the engine's object may carry more
const toContext = (context: ContextView | undefined): ContextView | undefined =>
  context === undefined ? undefined : { tokens: context.tokens, window: context.window, percent: context.percent }

// Token count, as 84k or 1M
const tokensLabel = (n: number): string =>
  n >= 1_000_000 ? Math.round(n / 100_000) / 10 + 'M' : Math.round(n / 1000) + 'k'

// Collapse whitespace and cut to a length so a long prompt fits one line
const brief = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

// A summary as its statements: one per line, any list marker the model added removed
const summaryLines = (text: string): string[] =>
  text
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim())
    .filter(line => line !== '')

// A path shown relative to the session's directory when it lies inside it
const shortPath = (path: string, cwd: string): string => {
  const flat = path.replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '') + '/'
  return base !== '/' && flat.toLowerCase().startsWith(base.toLowerCase()) ? flat.slice(base.length) : flat
}

// The working folder in full when it fits the width, else only its last folder's name
export const folderLabel = (cwd: string, width: number): string =>
  cwd.length <= width ? cwd : cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd

// What a finished tool call produced: a file it wrote or edited, or a page it published
const outputOf = (
  call: Record<string, unknown>,
  result: Record<string, unknown>,
): { key: string; kind: OutputItem['kind'] } | undefined => {
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined
  const found = (key: string | undefined, kind: OutputItem['kind']) => (key ? { key, kind } : undefined)
  switch (call.tool) {
    case 'Write':
      return found(str(result.filePath) ?? str(call.file_path), result.type === 'update' ? 'edit' : 'create')
    case 'Edit':
      return found(str(call.file_path), 'edit')
    case 'NotebookEdit':
      return found(str(call.notebook_path), 'edit')
    case 'Artifact':
      // Only a page publish; an asset upload's url is a file, not the page
      return (call.action ?? 'publish') === 'publish' && call.asset !== true
        ? found(str(result.url), 'link')
        : undefined
  }
  return undefined
}

// Record an output, one row per key, moved to the turn that touched it last
const addOutput = (list: OutputItem[], item: OutputItem): OutputItem[] => {
  const earlier = list.find(one => one.key === item.key)
  // A file created then edited in the same turn stays a creation
  const kind = earlier && earlier.turnId === item.turnId && earlier.kind === 'create' ? 'create' : item.kind
  return [...list.filter(one => one.key !== item.key), { ...item, kind }].slice(-MAX_OUTPUTS)
}

// Shell tools write files without naming them; what they left is read back from git
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
// At most this many files from one shell call, documents first
const MAX_SHELL_OUTPUTS = 12
// A file counts as the call's own when written no earlier than this before it started
const MTIME_SLACK_MS = 2_000
const SKIP_PATH = /(^|\/)(\.git|node_modules|__pycache__|\.venv)\//
const DOC_FILE = /\.(md|html?|txt|csv|xlsx|pdf|json)$/i

const git = async ($: EngineInterface, root: string, args: string[]): Promise<string | undefined> => {
  const { exitCode, stdout } = await $.process.run(['git', '-C', root, '-c', 'core.quotePath=false', ...args], {
    timeoutMs: 5_000,
  })
  return exitCode === 0 ? stdout : undefined
}

// Files a shell call left in the session's git repository: dirty or untracked ones it wrote,
// and the ones a commit it made carried. Outside a repository it finds nothing
const shellOutputs = async (
  $: EngineInterface,
  since: number,
): Promise<{ key: string; kind: OutputItem['kind'] }[]> => {
  const top = (await git($, await $.session.cwd(), ['rev-parse', '--show-toplevel']))?.trim()
  if (!top) return []
  const kinds = new Map<string, OutputItem['kind']>()
  // `XY path` entries, NUL separated
  for (const entry of ((await git($, top, ['status', '--porcelain', '-z', '-uall', '--no-renames'])) ?? '').split('\0')) {
    if (entry.length < 4 || entry[0] === 'D' || entry[1] === 'D') continue
    kinds.set(entry.slice(3), entry.startsWith('??') || entry[0] === 'A' ? 'create' : 'edit')
  }
  // `status \0 path \0` pairs of the commits made since the call started
  const sinceSecs = Math.floor((since - MTIME_SLACK_MS) / 1000)
  const log = (await git($, top, ['log', `--since=@${sinceSecs}`, '--name-status', '--no-renames', '-z', '--format=']))
    ?.split('\0')
    .map(token => token.trim())
  for (let i = 0; log && i < log.length - 1; i++) {
    const status = log[i]
    if (!/^[AMT]$/.test(status ?? '')) continue
    const path = log[++i] ?? ''
    if (path !== '' && !kinds.has(path)) kinds.set(path, status === 'A' ? 'create' : 'edit')
  }

  const isWindows = /^[A-Za-z]:\//.test(top)
  const found: { key: string; kind: OutputItem['kind']; mtimeMs: number }[] = []
  for (const [path, kind] of kinds) {
    if (SKIP_PATH.test(path)) continue
    const full = top + '/' + path
    const stat = await $.fs.stat(full).catch(() => undefined)
    if (!stat || stat.kind !== 'file' || stat.mtimeMs < since - MTIME_SLACK_MS) continue
    // The same spelling a Write reports, so one file is one row
    found.push({ key: isWindows ? full.replace(/\//g, '\\') : full, kind, mtimeMs: stat.mtimeMs })
  }
  return found
    .sort((a, b) => Number(DOC_FILE.test(b.key)) - Number(DOC_FILE.test(a.key)) || b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SHELL_OUTPUTS)
    .map(({ key, kind }) => ({ key, kind }))
}

// Time since a moment, as 45s, 12m or 2h5m
const ago = (at: number, now: number): string => {
  const secs = Math.max(0, Math.round((now - at) / 1000))
  if (secs < 60) return secs + 's'
  const mins = Math.floor(secs / 60)
  return mins < 60 ? mins + 'm' : Math.floor(mins / 60) + 'h' + (mins % 60) + 'm'
}

type RawSession = { sessionId?: string; name?: string; cwd?: string; status?: string; state?: string }

const statusOf = (raw: RawSession): SessionView['status'] =>
  raw.status === 'waiting'
    ? 'waiting'
    : raw.status === 'busy'
      ? 'busy'
      : raw.state === 'blocked'
        ? 'asking'
        : 'idle'

const lookOf = (one: SessionView, now: number) =>
  one.finishedAt !== undefined && now - one.finishedAt < FINISHED_MS ? SESSION_LOOK.finished : SESSION_LOOK[one.status]

// Fold a fresh `claude agents --json` reading into what the pane knew: keep how long each
// session has been in its state, and mark the ones that went from busy to done since the last look
export const mergeSessions = (
  previous: readonly SessionView[],
  raw: readonly RawSession[],
  selfId: string,
  now: number,
): { list: SessionView[]; finished: SessionView[]; waiting: SessionView[] } => {
  const finished: SessionView[] = []
  const waiting: SessionView[] = []
  const list = raw
    .filter(one => typeof one.sessionId === 'string' && one.sessionId !== '')
    .map((one): SessionView => {
      const sessionId = one.sessionId!
      const before = previous.find(p => p.sessionId === sessionId)
      const status = statusOf(one)
      const cwd = typeof one.cwd === 'string' ? one.cwd : ''
      const name =
        typeof one.name === 'string' && one.name !== ''
          ? one.name
          : cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || sessionId.slice(0, 8)
      const justFinished = before?.status === 'busy' && (status === 'idle' || status === 'asking')
      const finishedAt =
        status === 'busy' || status === 'waiting' ? undefined : justFinished ? now : before?.finishedAt
      const view: SessionView = {
        sessionId,
        name,
        cwd,
        status,
        since: before && before.status === status ? before.since : now,
        isSelf: sessionId === selfId,
        ...(finishedAt === undefined ? {} : { finishedAt }),
      }
      if (justFinished && !view.isSelf) finished.push(view)
      if (status === 'waiting' && before !== undefined && before.status !== 'waiting' && !view.isSelf) waiting.push(view)
      return view
    })
    .sort((a, b) => lookOf(a, now).rank - lookOf(b, now).rank || a.name.localeCompare(b.name))
  return { list, finished, waiting }
}

// Show a file in RESULT: Markdown drawn as Markdown, anything else as plain text
const openPreview = async ($: EngineInterface, path: string): Promise<void> => {
  const kind: PreviewView['kind'] = /\.(md|markdown)$/i.test(path) ? 'markdown' : 'text'
  await update($, opened, () => '')
  try {
    const text = await $.fs.read(path)
    await update($, preview, () => ({
      path,
      kind,
      text: text.slice(0, PREVIEW_CHARS),
      isTruncated: text.length > PREVIEW_CHARS,
      error: '',
    }))
  } catch (err) {
    await update($, preview, () => ({ ...NO_PREVIEW, path, kind, error: String(err) }))
  }
}

const setQuestion = ($: EngineInterface, id: string, change: Partial<QuestionItem>) =>
  update($, questions, list => list.map(one => (one.id === id ? { ...one, ...change } : one)))

// Show a question in RESULT, asking Haiku for its summary the first time; a separate
// one-off request, so the session's own model and conversation are untouched
const openQuestion = async ($: EngineInterface, id: string): Promise<void> => {
  await update($, preview, () => NO_PREVIEW)
  await update($, opened, () => id)
  const item = (await read($, questions)).find(one => one.id === id)
  if (!item || item.answer === undefined || item.summaryState === 'loading' || item.summaryState === 'done') return

  await setQuestion($, id, { summaryState: 'loading' })
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: SUMMARY_RULES,
      prompt: 'Question:\n' + item.text + '\n\nReply:\n' + item.answer,
      maxTokens: 400,
      effort: 'low',
      timeoutMs: 30_000,
    })
    await setQuestion(
      $,
      id,
      reply.isAnswered
        ? { summary: reply.text.trim(), summaryState: 'done' }
        : { summary: 'Summary failed: ' + reply.reason, summaryState: 'error' },
    )
  } catch (err) {
    await setQuestion($, id, { summary: 'Summary failed: ' + String(err), summaryState: 'error' })
  }
}

// The transcript row last drawn for each question text
const rowIds = new Map<string, string>()

// Scroll the transcript to the row that shows a question
const jumpToQuestion = async ($: EngineInterface, text: string): Promise<void> => {
  const rowId = rowIds.get(text)
  if (rowId === undefined) {
    $.ui.toast('This question is no longer on screen to scroll to')
    return
  }
  try {
    const moved = await $.ui.scroll({ to: { requestId: rowId }, block: 'start' })
    if (moved.deny !== undefined) $.ui.toast('Could not scroll: ' + moved.deny)
  } catch (err) {
    $.ui.toast('Could not scroll: ' + String(err))
  }
}

// Open a file in Notepad without waiting for it to close: `start` hands it off and returns
const openInNotepad = async ($: EngineInterface, path: string): Promise<void> => {
  try {
    const { exitCode, stderr } = await $.process.run(
      ['cmd', '/d', '/c', 'start', '', 'notepad.exe', path.replace(/\//g, '\\')],
      { timeoutMs: 10_000 },
    )
    if (exitCode !== 0) $.ui.toast('Could not open Notepad: ' + (stderr.trim() || 'exit ' + exitCode))
  } catch (err) {
    $.ui.toast('Could not open Notepad: ' + String(err))
  }
}

// Open a page in the default browser. The row is a Button, not a Link: a Link is an OSC 8 span
// that the terminal opens on its own as well, so one click opened the page twice.
// rundll32 takes the URL as one argument, where `cmd /c start` would split it at an `&`
const openInBrowser = async ($: EngineInterface, url: string): Promise<void> => {
  if (!/^https?:\/\//i.test(url)) {
    $.ui.toast('Not a web address: ' + url)
    return
  }
  try {
    const { exitCode, stderr } = await $.process.run(['rundll32', 'url.dll,FileProtocolHandler', url], {
      timeoutMs: 10_000,
    })
    if (exitCode !== 0) $.ui.toast('Could not open the browser: ' + (stderr.trim() || 'exit ' + exitCode))
  } catch (err) {
    $.ui.toast('Could not open the browser: ' + String(err))
  }
}

// The hidden sessions live in the store, shared by every terminal and kept across restarts;
// the `hidden` state mirrors it for drawing
const HIDDEN_KEY = 'hidden'

const readHidden = async ($: EngineInterface): Promise<string[]> => {
  const value = await $.store.get(HIDDEN_KEY)
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

const changeHidden = async ($: EngineInterface, change: (ids: string[]) => string[]): Promise<void> => {
  try {
    const ids = change(await readHidden($))
    await $.store.set(HIDDEN_KEY, ids)
    await update($, hidden, () => ids)
  } catch (err) {
    $.ui.toast('Could not save the hidden sessions: ' + String(err))
  }
}

// One look at every Claude Code session on this machine; never two at once
let polling = false
const pollSessions = async ($: EngineInterface): Promise<void> => {
  if (polling) return
  polling = true
  try {
    const { exitCode, stdout } = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 20_000 })
    if (exitCode !== 0) return
    const parsed: unknown = JSON.parse(stdout)
    if (!Array.isArray(parsed)) return
    const selfId = await $.session.id()
    const now = await $.clock.now()
    let news: ReturnType<typeof mergeSessions> | undefined
    await update($, sessions, list => {
      news = mergeSessions(list, parsed as RawSession[], selfId, now)
      return news.list
    })
    // Take up what other terminals hid; a hidden session that ended is forgotten,
    // one still running stays hidden and quiet
    const live = new Set((news?.list ?? []).map(one => one.sessionId))
    let quiet: string[]
    try {
      const stored = await readHidden($)
      quiet = stored.filter(id => live.has(id))
      if (quiet.length !== stored.length) await $.store.set(HIDDEN_KEY, quiet)
    } catch {
      // The store out of reach: go on with what this pane last knew
      quiet = (await read($, hidden)).filter(id => live.has(id))
    }
    await update($, hidden, ids => (ids.join('\n') === quiet.join('\n') ? ids : quiet))
    for (const one of news?.finished ?? []) if (!quiet.includes(one.sessionId)) $.ui.toast('✓ ' + one.name + ' finished')
    for (const one of news?.waiting ?? [])
      if (!quiet.includes(one.sessionId)) $.ui.toast('! ' + one.name + ' needs your approval')
  } catch {
  } finally {
    polling = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'panel',
      description: 'Open the right-hand pane (your questions and their results) at one third of the screen',
    })
    // Opened unasked it waits below 144 columns; /panel always opens it
    void $.ui.open({ id: PANE, title: 'Tasks' })

    // Seed model, effort and usage so the pane shows them before the first turn
    try {
      const model = await $.session.model()
      const settings = (await $.settings.read()) as Record<string, unknown>
      const usage = await $.session.usage()
      await update($, info, view => ({
        model: model || view.model,
        effort: view.effort || (typeof settings.effortLevel === 'string' ? settings.effortLevel : ''),
        limits: usage.rateLimits.length > 0 ? toLimits(usage.rateLimits) : view.limits,
        context: toContext(usage.context) ?? view.context,
      }))
    } catch {}

    // Watch the other terminals: once now, then on a timer for the session's life
    void pollSessions($)
    $.clock.every(POLL_MS, () => void pollSessions($))

    return next(e)
  })

  on('command.run', { command: 'panel' }, async ($, e) => {
    const screen = e.presentation?.columns ?? 120
    const columns = Math.max(24, Math.floor(screen / 3))
    await $.ui.open({ id: PANE, title: 'Tasks', columns })

    return { text: 'Pane opened at ' + columns + ' columns, one third of ' + screen + '.' }
  })

  on('turn.start', async ($, e, next) => {
    await update($, turn, (): TurnView => ({ status: 'running', turnId: e.turnId, ask: NO_ASK }))
    const text = brief(e.text, 200)
    if (text !== '') {
      await update($, questions, list =>
        [...list.filter(one => one.id !== e.turnId), { id: e.turnId, text, status: 'running' as const }].slice(
          -MAX_QUESTIONS,
        ),
      )
    }

    return next(e)
  })

  // The main loop's model and effort, as each request is sent
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      try {
        const model = e.model
        const effort = e.effort === undefined ? '' : String(e.effort)
        await update($, info, view =>
          view.model === model && view.effort === effort ? view : { ...view, model, effort },
        )
      } catch {}
    }

    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      try {
        await update($, info, view => ({ ...view, limits: toLimits(e.rateLimits) }))
      } catch {}
    }
    if (e.changed.includes('context')) {
      try {
        await update($, info, view => ({ ...view, context: toContext(e.context) ?? view.context }))
      } catch {}
    }

    return next(e)
  })

  // A question Claude asks: shown in the pane while it waits, then its answers
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    try {
      const items: AskItem[] = e.questions.map(q => ({
        header: q.header,
        question: q.question,
        options: q.options.map(option => option.label),
      }))
      await update($, turn, (view): TurnView => ({ ...view, ask: { state: 'waiting', items, answers: [] } }))
    } catch {}

    const result = await next(e)

    try {
      const output = (result.result ?? {}) as { answers?: Record<string, string>; response?: string }
      const answers = Object.values(output.answers ?? {}).map(String)
      if (typeof output.response === 'string' && output.response !== '') answers.push(output.response)
      await update($, turn, (view): TurnView => ({ ...view, ask: { ...view.ask, state: 'answered', answers } }))
    } catch {}

    return result
  })

  on('tool.call', async ($, e, next) => {
    const isShell = SHELL_TOOLS.has(String((e as unknown as Record<string, unknown>).tool))
    const startedAt = isShell ? await $.clock.now().catch(() => 0) : 0
    const result = await next(e)

    // Recording must never change what the tool answered
    try {
      const answered = result as { deny?: string; isError?: boolean; result?: unknown }
      // A shell call that failed partway may still have written files
      if (answered.deny === undefined && (isShell || answered.isError !== true)) {
        const found = outputOf(
          e as unknown as Record<string, unknown>,
          (answered.result ?? {}) as Record<string, unknown>,
        )
        const made = found ? [found] : startedAt > 0 ? await shellOutputs($, startedAt) : []
        if (made.length > 0) {
          const { turnId } = await read($, turn)
          for (const one of made) await update($, outputs, list => addOutput(list, { ...one, turnId: turnId ?? '' }))
        }
      }
    } catch {}

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)
    // A subagent's run ends turns of its own; only the main loop's answer the person's questions
    if (e.agentId !== undefined) return answer
    const status: QuestionItem['status'] =
      e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error'
    const text = e.answer.slice(0, ANSWER_CHARS)
    await update($, turn, view => ({ ...view, status }))
    await update($, questions, list =>
      list.map(one => (one.id === e.turnId ? { ...one, status, ...(text === '' ? {} : { answer: text }) } : one)),
    )

    return answer
  })

  // Learn which transcript row shows each question, so its summary can scroll back to it
  // (kept in memory: a render may not write state, and the rows are drawn again after a reload)
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind === 'composer') rowIds.set(brief(e.props.text, 200), e.requestId)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const asked = await read($, questions)
    const made = await read($, outputs)
    const hiddenIds = await read($, hidden)
    const all = await read($, sessions)
    const others = all.filter(one => !hiddenIds.includes(one.sessionId))
    const hiddenCount = all.length - others.length
    const shown = await read($, preview)
    const openedId = await read($, opened)
    const question = openedId === '' ? undefined : asked.find(one => one.id === openedId)
    const view = await read($, turn)
    const meta = await read($, info)
    const now = await $.clock.now()
    const cwd = await $.session.cwd()

    // QUESTIONS has a fixed height, up to 60% of the room; RESULT grows below it
    // and the pane body scrolls (wheel / scroll keys) once it runs long
    // Rows left once MODEL (5) and SESSIONS (its border, title and rows) are drawn
    const sessionRows =
      3 +
      Math.max(1, Math.min(others.length, MAX_SESSIONS_SHOWN)) +
      (others.length > MAX_SESSIONS_SHOWN ? 1 : 0) +
      (hiddenCount > 0 ? 1 : 0)
    const room = Math.max(10, (e.viewport?.rows ?? 30) - 5 - sessionRows)
    // The body less the box's border and padding and the 'DIR ' label
    const folder = folderLabel(cwd, e.props.bodyColumns - 8)
    const topHeight = Math.max(4, Math.floor(room * QUESTION_SHARE))
    const topLines = Math.max(1, topHeight - 3)
    // Shrink to the questions listed, never past the cap
    const questionHeight = Math.min(topHeight, 3 + Math.max(1, asked.length))

    // This turn's outputs first, then earlier ones dimmed; newest first in each
    const turnId = view.turnId ?? ''
    const newestFirst = [...made].reverse()
    const current = turnId === '' ? [] : newestFirst.filter(one => one.turnId === turnId)
    const earlier = newestFirst.filter(one => turnId === '' || one.turnId !== turnId)

    const statusColor = PALETTE.status[view.status]
    const finishedCount = others.filter(one => lookOf(one, now) === SESSION_LOOK.finished).length
    // A page opens in the browser; a file opens in the preview below
    const outputRow = (item: OutputItem, dim: boolean) => {
      const mark = (
        <Text color={dim ? PALETTE.muted : OUTPUT_MARK[item.kind].color}>{OUTPUT_MARK[item.kind].mark} </Text>
      )
      return item.kind === 'link' ? (
        <Button key={'link:' + item.key} plain dimColor={dim} onPress={() => void openInBrowser($, item.key)}>
          {mark}
          <Text wrap="truncate-middle" color={dim ? PALETTE.muted : PALETTE.blue}>
            {item.key}
          </Text>
        </Button>
      ) : (
        <Button
          key={'open:' + item.key}
          plain
          dimColor={dim}
          onPress={() => void openPreview($, item.key)}
        >
          {mark}
          <Text color={dim ? PALETTE.muted : PALETTE.text}>{shortPath(item.key, cwd)}</Text>
        </Button>
      )
    }
    const previewBody =
      shown.error !== '' ? (
        <Text color={PALETTE.status.error}>Could not read the file: {shown.error}</Text>
      ) : shown.kind === 'markdown' ? (
        <Markdown text={shown.text} />
      ) : (
        <Text color={PALETTE.text}>{shown.text}</Text>
      )

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor={PALETTE.infoBorder} paddingX={1}>
          <Text wrap="truncate-end">
            <Text bold color={PALETTE.lavender}>
              DIR
            </Text>
            <Text color={PALETTE.text}> {folder !== '' ? folder : '—'}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text bold color={PALETTE.lavender}>
              MODEL
            </Text>
            <Text color={PALETTE.yellow}> {meta.model !== '' ? shortModel(meta.model) : '—'}</Text>
            <Text color={PALETTE.text}> · effort </Text>
            <Text color={PALETTE.yellow}>{meta.effort !== '' ? meta.effort : '—'}</Text>
            <Text color={PALETTE.text}> · ctx </Text>
            {meta.context.percent === undefined ? (
              <Text color={PALETTE.text}>—</Text>
            ) : (
              <Text>
                <Text bold color={remainColor(100 - meta.context.percent, PALETTE.text)}>
                  {meta.context.percent}%
                </Text>
                {meta.context.tokens !== undefined && meta.context.window > 0 && (
                  <Text color={PALETTE.text}>
                    {' '}
                    ({tokensLabel(meta.context.tokens)}/{tokensLabel(meta.context.window)})
                  </Text>
                )}
              </Text>
            )}
          </Text>
          <Text wrap="truncate-end">
            <Text bold color={PALETTE.lavender}>
              LEFT
            </Text>
            {meta.limits.length === 0 && <Text color={PALETTE.text}> no reading yet</Text>}
            {meta.limits.map((limit, i) => {
              const left = Math.max(0, Math.round((100 - limit.percentUsed) * 10) / 10)
              const reset = until(limit.resetsAt, now)
              return (
                <Text>
                  <Text color={PALETTE.text}>
                    {i === 0 ? ' ' : ' · '}
                    {limitLabel(limit.kind)}{' '}
                  </Text>
                  <Text bold color={remainColor(left)}>
                    {left}%
                  </Text>
                  {reset !== '' && <Text color={PALETTE.text}> ({reset})</Text>}
                </Text>
              )
            })}
          </Text>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor={PALETTE.infoBorder} paddingX={1}>
          <Text>
            <Text bold color={PALETTE.lavender}>
              SESSIONS
            </Text>
            <Text color={PALETTE.muted}> · {others.length}</Text>
            {finishedCount > 0 && <Text color={PALETTE.mint}> · {finishedCount} done</Text>}
          </Text>
          {all.length === 0 && <Text color={PALETTE.muted}>Looking for sessions…</Text>}
          {all.length > 0 && others.length === 0 && <Text color={PALETTE.muted}>All hidden.</Text>}
          {others.slice(0, MAX_SESSIONS_SHOWN).map(one => {
            const look = lookOf(one, now)
            const isFinished = look === SESSION_LOOK.finished
            const label = isFinished
              ? 'done ' + ago(one.finishedAt ?? now, now) + ' ago'
              : one.status === 'busy'
                ? 'working ' + ago(one.since, now)
                : one.status === 'waiting'
                  ? 'needs approval'
                  : one.status === 'asking'
                    ? 'asked you'
                    : 'idle'
            return (
              <Box gap={1}>
                <Box flexShrink={1} flexGrow={1}>
                  <Text wrap="truncate-end" color={PALETTE.text} bold={isFinished}>
                    <Text color={look.color}>{look.mark} </Text>
                    {one.name}
                    {one.isSelf && <Text bold color={PALETTE.red}> (this)</Text>}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Text color={look.color}>{label}</Text>
                </Box>
                <Box flexShrink={0}>
                  <Button
                    key={'hide:' + one.sessionId}
                    label="×"
                    plain
                    dimColor
                    onPress={() =>
                      void changeHidden($, ids => (ids.includes(one.sessionId) ? ids : [...ids, one.sessionId]))
                    }
                  />
                </Box>
              </Box>
            )
          })}
          {others.length > MAX_SESSIONS_SHOWN && (
            <Text color={PALETTE.muted}>+{others.length - MAX_SESSIONS_SHOWN} more</Text>
          )}
          {hiddenCount > 0 && (
            <Button key="sessions:unhide" plain dimColor onPress={() => void changeHidden($, () => [])}>
              {hiddenCount} hidden · show all
            </Button>
          )}
        </Box>
        <Box
          flexDirection="column"
          height={questionHeight}
          overflow="hidden"
          borderStyle="round"
          borderColor={PALETTE.mintBorder}
          paddingX={1}
        >
          <Text>
            <Text bold color={PALETTE.mint}>
              QUESTIONS
            </Text>
            <Text color={PALETTE.muted}> · {asked.length}</Text>
          </Text>
          {asked.length === 0 && <Text color={PALETTE.muted}>No questions yet.</Text>}
          {asked.slice(-topLines).map(item => (
            <Button key={'q:' + item.id} plain onPress={() => void openQuestion($, item.id)}>
              <Text color={PALETTE.status[item.status]}>{QUESTION_MARK[item.status]} </Text>
              <Text color={item.id === openedId ? PALETTE.lavender : PALETTE.text} bold={item.id === openedId}>
                {item.text}
              </Text>
            </Button>
          ))}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor={PALETTE.blueBorder} paddingX={1}>
          <Text>
            <Text bold color={PALETTE.blue}>
              RESULT
            </Text>
            <Text color={statusColor}> ● {view.status}</Text>
            <Text color={PALETTE.muted}> · {made.length}</Text>
          </Text>
          {view.ask.state !== 'none' && (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={view.ask.state === 'waiting' ? PALETTE.yellowBorder : PALETTE.mintBorder}
              paddingX={1}
            >
              <Text bold color={view.ask.state === 'waiting' ? PALETTE.yellow : PALETTE.mint}>
                {view.ask.state === 'waiting' ? '? Claude asks — answer in the dialog' : '✓ Answered'}
              </Text>
              {view.ask.items.map(item => (
                <Box flexDirection="column">
                  <Text color={PALETTE.text}>
                    <Text color={PALETTE.muted}>[{item.header}] </Text>
                    {item.question}
                  </Text>
                  {view.ask.state === 'waiting' && (
                    <Box flexDirection="column" paddingLeft={2}>
                      {item.options.map((label, i) => (
                        <Text color={PALETTE.muted} wrap="truncate-end">
                          {i + 1}. {label}
                        </Text>
                      ))}
                    </Box>
                  )}
                </Box>
              ))}
              {view.ask.state === 'answered' &&
                view.ask.answers.map(answer => (
                  <Text color={PALETTE.mint} wrap="truncate-end">
                    → {answer}
                  </Text>
                ))}
            </Box>
          )}
          {question !== undefined ? (
            <Box flexDirection="column">
              <Box gap={2} flexWrap="wrap">
                <Button key="question:back" plain onPress={() => void update($, opened, () => '')}>
                  ‹ back
                </Button>
                <Button key="question:jump" plain onPress={() => void jumpToQuestion($, question.text)}>
                  ↗ Go to it in the conversation
                </Button>
              </Box>
              <Text bold color={PALETTE.lavender}>
                ❯ {question.text}
              </Text>
              <Box marginTop={1} flexDirection="column">
                {question.answer === undefined ? (
                  <Text color={PALETTE.muted}>
                    {question.status === 'running'
                      ? 'Still working; the summary comes once it answers.'
                      : 'No reply was kept for this question (asked before summaries existed).'}
                  </Text>
                ) : question.summaryState === 'done' ? (
                  // One clipped statement per row with a blank row between, easier to scan than a tight list
                  <Box flexDirection="column" gap={1}>
                    {summaryLines(question.summary ?? '').map(line => (
                      <Box gap={1}>
                        <Box flexShrink={0}>
                          <Text color={PALETTE.muted}>·</Text>
                        </Box>
                        <Box flexShrink={1}>
                          <Text color={PALETTE.text}>{line}</Text>
                        </Box>
                      </Box>
                    ))}
                  </Box>
                ) : question.summaryState === 'error' ? (
                  <Text color={PALETTE.status.error}>{question.summary}</Text>
                ) : (
                  <Text color={PALETTE.yellow}>Summarizing with Haiku…</Text>
                )}
              </Box>
            </Box>
          ) : shown.path !== '' ? (
            <Box flexDirection="column">
              <Box gap={2} flexWrap="wrap">
                <Button key="preview:back" plain onPress={() => void update($, preview, () => NO_PREVIEW)}>
                  ‹ back
                </Button>
                <Button key="preview:notepad" plain onPress={() => void openInNotepad($, shown.path)}>
                  ↗ Open in Notepad
                </Button>
              </Box>
              <Text bold color={PALETTE.lavender} wrap="truncate-middle">
                {shortPath(shown.path, cwd)}
              </Text>
              <Box marginTop={1} flexDirection="column">
                {previewBody}
              </Box>
              {shown.isTruncated && (
                <Text color={PALETTE.muted}>… cut at {PREVIEW_CHARS.toLocaleString()} characters; open in Notepad for the rest</Text>
              )}
            </Box>
          ) : (
            <Box flexDirection="column">
              {current.map(item => outputRow(item, false))}
              {turnId !== '' && current.length === 0 && view.status !== 'running' && (
                <Text color={PALETTE.muted}>No output this turn (answer only).</Text>
              )}
              {turnId !== '' && current.length === 0 && view.status === 'running' && (
                <Text color={PALETTE.muted}>Working…</Text>
              )}
              {earlier.length > 0 && (
                <Box flexDirection="column" marginTop={current.length > 0 || turnId !== '' ? 1 : 0}>
                  <Text color={PALETTE.muted}>earlier</Text>
                  {earlier.map(item => outputRow(item, true))}
                </Box>
              )}
              {made.length === 0 && turnId === '' && <Text color={PALETTE.muted}>No output yet.</Text>}
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
