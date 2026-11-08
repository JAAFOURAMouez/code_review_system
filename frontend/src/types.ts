// The data the backend (server.py, horizon_adapter.py) sends. The backend owns all state;
// the front end only shows it and sends the two human actions (approve, re-run).

export type AgentStatus = 'pending' | 'running' | 'ok' | 'failed'
export type Outcome = 'in_progress' | 'succeeded' | 'partial' | 'failed'

/** One agent of the pipeline. */
export interface AgentInfo {
  id: string
  name: string
  role: string
  /** Uses a language model (all but static analysis). */
  llm: boolean
  /** Calls tools in a loop (test generator, code correction). */
  usesTools: boolean
  tools: string[]
  model: string | null
  /** Timeout of the agent, in ms. */
  budgetMs: number
}

/** One agent in the latest review. */
export interface AgentRun {
  id: string
  taskId: string
  status: AgentStatus
  attempts: number
  approved: boolean
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
  problem: string | null
  /** The agent's JSON output (see the result types below). */
  result: Record<string, unknown> | null
}

export interface RunSummary {
  id: string
  file: string
  model: string | null
  lines: number | null
  startedAt: number
  endedAt: number | null
  durationMs: number
  outcome: Outcome
  agentsOk: number
  agentsFailed: number
  agentsTotal: number
  approved: number
}

export interface CurrentRun extends RunSummary {
  agents: Record<string, AgentRun>
}

export type EventType = 'review' | 'start' | 'output' | 'error' | 'retry' | 'human'

export interface ReviewEvent {
  id: string
  at: number
  runId: string
  actorId: string
  type: EventType
  status: 'info' | 'success' | 'failed' | 'warning'
  title: string
  detail?: string
  taskId?: string
  durationMs?: number
  recovered?: boolean
}

export interface Workspace {
  agents: AgentInfo[]
  /** Oldest first. */
  runs: RunSummary[]
  /** The latest review, in detail. */
  current: CurrentRun | null
  events: ReviewEvent[]
  now: number
}

// ------------------------------------------------------------------ agent results

export interface Finding {
  type: string
  line?: number | null
  column?: number | null
  code?: string | null
  symbol?: string | null
  message: string
  severity: string
  complexity_score?: number
}

export interface ToolCall {
  step: number
  tool: string
  summary: string
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  requests: number
}

export interface StaticResult {
  findings: Finding[]
  tools?: Record<string, string>
}

export interface UnderstandingResult {
  explanation: string
  complex_sections: { line: number; end_line?: number; reason: string }[]
}

export interface Improvement {
  line: number | null
  category?: string
  severity?: string
  description: string
  related_findings?: string[]
}

export interface ImprovementResult {
  improvements: Improvement[]
}

export interface DocumentationResult {
  overview?: string
  docstrings?: { name: string; kind: string; docstring: string }[]
  usage_example?: string
  documentation: string
}

export interface TestVerification {
  ran: boolean
  syntax_valid?: boolean
  reason?: string
  runner?: string
  passed?: boolean
  tests?: number
  failures?: number
  errors?: number
  skipped?: number
  output?: string
}

export interface TestsResult {
  tests: string
  framework?: string
  notes?: string
  module?: string
  verification?: TestVerification
}

export interface CorrectionVerification {
  syntax_valid: boolean
  api_preserved?: boolean
  missing_api?: string[]
  findings_before?: Record<string, number>
  findings_after?: Record<string, number>
  total_before?: number
  total_after?: number
  accepted?: boolean
  problems?: string[]
}

export interface CorrectionResult {
  corrected_code: string
  rejected_code?: string
  changes?: { line: number | null; description: string }[]
  remaining_issues?: string[]
  verification?: CorrectionVerification
}

/** Fields every agent may add to its result. */
export interface CommonResult {
  tool_calls?: ToolCall[]
  mode?: string
  usage?: Usage
  lint_source?: string
  duration_s?: number
}
