// Domain model. Everything the UI shows is derived from these records so that
// agents, tasks, the timeline, memory and the feed cannot drift apart.

export type AgentState = 'idle' | 'running' | 'completed' | 'blocked' | 'failed'
export type TaskStatus = 'backlog' | 'ready' | 'running' | 'blocked' | 'review' | 'completed'
export type Priority = 'critical' | 'high' | 'medium' | 'low'

export interface Agent {
  id: string
  name: string
  role: string
  model: string
  responsibilities: string[]
  tools: string[]
}

export interface Phase {
  id: string
  name: string
  summary: string
  order: number
}

export interface Milestone {
  id: string
  name: string
  phaseId: string
  /** Hours-based timestamps are stored as epoch milliseconds. */
  due: number
  /** Milestone is achieved once every task in `dependsOn` is completed. */
  dependsOn: string[]
}

export type CriterionResult = 'pending' | 'passed' | 'failed'

export interface ValidationCriterion {
  id: string
  text: string
  /** Automated criteria are verified by the system; manual ones need a person. */
  kind: 'automated' | 'manual'
  result: CriterionResult
}

export type BlockKind = 'failure' | 'human' | 'external'

export interface Task {
  id: string
  title: string
  description: string
  phaseId: string
  assigneeId: string
  status: TaskStatus
  priority: Priority
  dependsOn: string[]
  /** Name of the artifact handed to dependents when this task completes. */
  artifact: string
  /** 0-100. Completed and review tasks are 100. */
  progress: number
  plannedStart: number
  plannedEnd: number
  actualStart?: number
  actualEnd?: number
  attempts: number
  blocked?: { kind: BlockKind; note: string; since: number }
  validation: ValidationCriterion[]
  /** What the agent produced, when the data source can show it (live backends). */
  output?: TaskOutput
}

export interface TaskOutput {
  kind: 'code' | 'text'
  text: string
  /** Suggested file name when the person saves it. */
  filename: string
}

export type EventType =
  | 'action'
  | 'tool_call'
  | 'transition'
  | 'decision'
  | 'error'
  | 'retry'
  | 'verification'
  | 'intervention'

export type EventStatus = 'success' | 'failed' | 'running' | 'warning' | 'info'

export interface ExecutionEvent {
  id: string
  at: number
  runId: string
  /** An agent id, `system` (orchestrator) or `human`. */
  actorId: string
  type: EventType
  status: EventStatus
  title: string
  detail?: string
  taskId?: string
  tool?: string
  tokens?: number
  durationMs?: number
  /** For retry events: whether the retry recovered the step. */
  recovered?: boolean
  /** True for events produced by the in-browser demo simulator. */
  simulated?: boolean
}

export type MemoryKind = 'fact' | 'observation' | 'decision'
export type MemoryOrigin = 'stored' | 'inferred'
export type LinkRelation = 'supports' | 'contradicts' | 'derived_from' | 'supersedes' | 'relates'

export interface MemoryLink {
  to: string
  relation: LinkRelation
}

export interface MemoryItem {
  id: string
  kind: MemoryKind
  /** `stored` was written down from a source; `inferred` was concluded by an agent. */
  origin: MemoryOrigin
  title: string
  body: string
  rationale?: string
  /** Only for inferred memories (0-1). */
  confidence?: number
  derivedFrom?: string[]
  provenance: {
    sourceType: 'document' | 'tool_output' | 'agent' | 'human'
    source: string
    agentId?: string
  }
  createdAt: number
  lastAccessedAt: number
  accessCount: number
  taskIds: string[]
  runId: string
  links: MemoryLink[]
  tags: string[]
}

export type RunOutcome = 'in_progress' | 'succeeded' | 'partial' | 'failed'

export interface RunAggregates {
  tasksTotal: number
  tasksCompleted: number
  stepsTotal: number
  stepsSucceeded: number
  retries: number
  recovered: number
  interventions: number
  durationMs: number
  tokens: number
}

export interface Run {
  id: string
  label: string
  config: string
  startedAt: number
  endedAt?: number
  outcome: RunOutcome
  note: string
  /** Stored aggregates exist only for finished (sample) runs; the live run is computed. */
  aggregates?: RunAggregates
}

export interface Project {
  id: string
  name: string
  objective: string
  currentRunId: string
}

export interface Workspace {
  project: Project
  agents: Agent[]
  phases: Phase[]
  milestones: Milestone[]
  tasks: Task[]
  events: ExecutionEvent[]
  memories: MemoryItem[]
  runs: Run[]
  now: number
  /** What the data source can measure. Absent means everything is available (demo data). */
  capabilities?: {
    tokens: boolean
    /** When present, only these `from>to` status moves exist, with their button labels. */
    transitions?: Record<string, string>
  }
}

export interface Communication {
  id: string
  from: string
  to: string
  label: string
}

export const TASK_STATUSES: TaskStatus[] = [
  'backlog',
  'ready',
  'running',
  'blocked',
  'review',
  'completed',
]

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  running: 'Running',
  blocked: 'Blocked',
  review: 'Review',
  completed: 'Completed',
}

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  idle: 'Idle',
  running: 'Running',
  completed: 'Completed',
  blocked: 'Blocked',
  failed: 'Failed',
}

export const PRIORITY_ORDER: Priority[] = ['critical', 'high', 'medium', 'low']

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  action: 'Action',
  tool_call: 'Tool call',
  transition: 'Task transition',
  decision: 'Decision',
  error: 'Error',
  retry: 'Retry',
  verification: 'Verification',
  intervention: 'Human intervention',
}

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
