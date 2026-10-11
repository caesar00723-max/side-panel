export type QuestionItem = {
  // The turn the question started
  id: string
  text: string
  status: 'running' | 'done' | 'aborted' | 'error'
  // Claude's reply, kept so the question can be summarized later
  answer?: string
  // Haiku's summary, made the first time the question is opened
  summary?: string
  summaryState?: 'loading' | 'done' | 'error'
}

// A file written or edited, or a page published
export type OutputItem = {
  // The path or URL; one row per key
  key: string
  kind: 'create' | 'edit' | 'link'
  // The turn that last touched it
  turnId: string
}

// One Claude Code session on this machine, from `claude agents --json`
export type SessionView = {
  sessionId: string
  name: string
  cwd: string
  // waiting: a permission prompt; asking: it ended a turn on a question
  status: 'busy' | 'idle' | 'waiting' | 'asking'
  // When the status last changed, or when the session was first seen
  since: number
  // When it went from busy to done while this pane watched; cleared when it works again
  finishedAt?: number
  isSelf: boolean
}

// A file shown in RESULT in place of the list; path '' when the list shows
export type PreviewView = {
  path: string
  kind: 'markdown' | 'text'
  text: string
  isTruncated: boolean
  error: string
}

export type AskItem = {
  header: string
  question: string
  options: string[]
}

export type TurnView = {
  status: 'idle' | 'running' | 'done' | 'aborted' | 'error'
  turnId: string
  // A question Claude asked this turn (AskUserQuestion) and its answers
  ask: { state: 'none' | 'waiting' | 'answered'; items: AskItem[]; answers: string[] }
}

export type LimitView = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type InfoView = {
  model: string
  effort: string
  limits: LimitView[]
}

declare module 'claude-code' {
  interface PluginState {
    'side-panel': {
      questions: QuestionItem[]
      outputs: OutputItem[]
      sessions: SessionView[]
      // Sessions the person took off the SESSIONS list, mirrored from $.store; dropped once they end
      hidden: string[]
      preview: PreviewView
      // The question whose summary RESULT shows; '' for none
      opened: string
      turn: TurnView
      info: InfoView
    }
  }
}
