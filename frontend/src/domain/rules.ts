// Pure domain rules: no React, no I/O. Everything here is unit-tested.
import {
  HOUR,
  TASK_STATUS_LABEL,
  type Agent,
  type AgentState,
  type CriterionResult,
  type EventStatus,
  type EventType,
  type ExecutionEvent,
  type Milestone,
  type Phase,
  type Run,
  type Task,
  type TaskStatus,
  type Workspace,
} from './types.ts'

export const SYSTEM_ID = 'system'
export const HUMAN_ID = 'human'

// ---------------------------------------------------------------- lookups

export function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]))
}

export function unmetDependencies(task: Task, tasks: Task[]): Task[] {
  const byId = indexById(tasks)
  return task.dependsOn
    .map((id) => byId.get(id))
    .filter((t): t is Task => !!t && t.status !== 'completed')
}

export function dependentsOf(taskId: string, tasks: Task[]): Task[] {
  return tasks.filter((t) => t.dependsOn.includes(taskId))
}

/** Transitive prerequisites in breadth-first order (nearest first), excluding the task itself. */
export function prerequisiteChain(taskId: string, tasks: Task[]): Task[] {
  const byId = indexById(tasks)
  const seen = new Set<string>([taskId])
  const out: Task[] = []
  let frontier = [taskId]
  while (frontier.length) {
    const next: string[] = []
    for (const id of frontier) {
      for (const dep of byId.get(id)?.dependsOn ?? []) {
        if (seen.has(dep)) continue
        seen.add(dep)
        const t = byId.get(dep)
        if (t) {
          out.push(t)
          next.push(dep)
        }
      }
    }
    frontier = next
  }
  return out
}

/** Everything upstream that still has to finish before this task can proceed. */
export function unresolvedPrerequisites(taskId: string, tasks: Task[]): Task[] {
  return prerequisiteChain(taskId, tasks).filter((t) => t.status !== 'completed')
}

// ------------------------------------------------------------ agent state

/**
 * Agent state is derived from its tasks, never stored:
 * running > failed > blocked > completed (all assigned work done) > idle.
 */
export function deriveAgentState(agentId: string, tasks: Task[]): AgentState {
  const mine = tasks.filter((t) => t.assigneeId === agentId)
  if (mine.some((t) => t.status === 'running')) return 'running'
  if (mine.some((t) => t.status === 'blocked' && t.blocked?.kind === 'failure')) return 'failed'
  if (mine.some((t) => t.status === 'blocked')) return 'blocked'
  if (mine.length > 0 && mine.every((t) => t.status === 'completed')) return 'completed'
  return 'idle'
}

export function currentTaskOf(agentId: string, tasks: Task[]): Task | undefined {
  const mine = tasks.filter((t) => t.assigneeId === agentId)
  const order: TaskStatus[] = ['running', 'blocked', 'review', 'ready']
  for (const status of order) {
    const found = mine.find((t) => t.status === status)
    if (found) return found
  }
  return undefined
}

export function agentTaskCounts(agentId: string, tasks: Task[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    backlog: 0,
    ready: 0,
    running: 0,
    blocked: 0,
    review: 0,
    completed: 0,
  }
  for (const t of tasks) if (t.assigneeId === agentId) counts[t.status] += 1
  return counts
}

// --------------------------------------------------------------- handoffs

export type EdgeStatus = 'done' | 'active' | 'stalled' | 'pending'

export interface HandoffEdge {
  id: string
  from: string
  to: string
  label: string
  /** Producer/consumer task pairs this handoff is derived from. */
  pairs: { producer: string; consumer: string }[]
  status: EdgeStatus
}

/** Agent-to-agent handoffs are derived from cross-agent task dependencies. */
export function deriveHandoffs(tasks: Task[]): HandoffEdge[] {
  const byId = indexById(tasks)
  const groups = new Map<string, HandoffEdge>()
  for (const consumer of tasks) {
    for (const depId of consumer.dependsOn) {
      const producer = byId.get(depId)
      if (!producer || producer.assigneeId === consumer.assigneeId) continue
      const key = `${producer.assigneeId}>${consumer.assigneeId}`
      let edge = groups.get(key)
      if (!edge) {
        edge = {
          id: key,
          from: producer.assigneeId,
          to: consumer.assigneeId,
          label: '',
          pairs: [],
          status: 'done',
        }
        groups.set(key, edge)
      }
      edge.pairs.push({ producer: producer.id, consumer: consumer.id })
    }
  }
  for (const edge of groups.values()) {
    const producers = [...new Set(edge.pairs.map((p) => p.producer))].map((id) => byId.get(id)!)
    const undelivered = producers.filter((p) => p.status !== 'completed')
    if (undelivered.length === 0) edge.status = 'done'
    else if (undelivered.some((p) => p.status === 'blocked')) edge.status = 'stalled'
    else if (undelivered.some((p) => p.status === 'running' || p.status === 'review'))
      edge.status = 'active'
    else edge.status = 'pending'
    const shown = undelivered[0] ?? producers[producers.length - 1]!
    edge.label = shown.artifact + (producers.length > 1 ? ` +${producers.length - 1}` : '')
  }
  return [...groups.values()]
}

// ------------------------------------------------------------ transitions

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['ready'],
  ready: ['running', 'backlog'],
  running: ['review', 'blocked'],
  blocked: ['ready', 'running'],
  review: ['completed', 'running'],
  completed: ['review'],
}

export interface TransitionCheck {
  ok: boolean
  reason?: string
}

export interface TransitionOption extends TransitionCheck {
  to: TaskStatus
  label: string
}

function listIds(tasks: Task[]): string {
  return tasks.map((t) => t.id).join(', ')
}

export function checkTransition(
  task: Task,
  to: TaskStatus,
  ws: Pick<Workspace, 'tasks' | 'agents'>,
): TransitionCheck {
  if (task.status === to) return { ok: false, reason: `Already in ${TASK_STATUS_LABEL[to]}.` }
  if (!ALLOWED[task.status].includes(to)) {
    return {
      ok: false,
      reason: `${task.id} can't move from ${TASK_STATUS_LABEL[task.status]} to ${TASK_STATUS_LABEL[to]} directly.`,
    }
  }
  if (to === 'ready' || to === 'running') {
    const unmet = unmetDependencies(task, ws.tasks)
    if (unmet.length) {
      return { ok: false, reason: `Waiting on ${listIds(unmet)} to complete first.` }
    }
  }
  if (to === 'running') {
    const busy = ws.tasks.find(
      (t) => t.assigneeId === task.assigneeId && t.status === 'running' && t.id !== task.id,
    )
    if (busy) {
      const agent = ws.agents.find((a) => a.id === task.assigneeId)
      return {
        ok: false,
        reason: `${agent?.name ?? 'The assigned agent'} is already running ${busy.id}.`,
      }
    }
  }
  if (to === 'completed') {
    const open = task.validation.filter((c) => c.result !== 'passed')
    if (open.length) {
      return {
        ok: false,
        reason: `${open.length} validation ${open.length === 1 ? 'criterion has' : 'criteria have'} not passed.`,
      }
    }
  }
  if (task.status === 'completed' && to === 'review') {
    const started = dependentsOf(task.id, ws.tasks).filter((t) =>
      ['running', 'review', 'completed'].includes(t.status),
    )
    if (started.length) {
      return { ok: false, reason: `${listIds(started)} already started from this output.` }
    }
  }
  return { ok: true }
}

const TRANSITION_VERB: Partial<Record<`${TaskStatus}>${TaskStatus}`, string>> = {
  'backlog>ready': 'Mark ready',
  'ready>running': 'Start',
  'ready>backlog': 'Move to backlog',
  'running>review': 'Send to review',
  'running>blocked': 'Block',
  'blocked>ready': 'Unblock',
  'blocked>running': 'Retry',
  'review>completed': 'Approve',
  'review>running': 'Request changes',
  'completed>review': 'Reopen for review',
}

export function transitionOptions(
  task: Task,
  ws: Pick<Workspace, 'tasks' | 'agents' | 'capabilities'>,
): TransitionOption[] {
  // A live backend runs the agents itself, so it declares the few moves a person may make.
  const offered = ws.capabilities?.transitions
  return ALLOWED[task.status]
    .filter((to) => !offered || `${task.status}>${to}` in offered)
    .map((to) => ({
      to,
      label:
        offered?.[`${task.status}>${to}`] ??
        TRANSITION_VERB[`${task.status}>${to}`] ??
        `Move to ${TASK_STATUS_LABEL[to]}`,
      ...checkTransition(task, to, ws),
    }))
}

// ----------------------------------------------------------------- events

export function nextEventId(ws: Pick<Workspace, 'events'>): string {
  let max = 0
  for (const e of ws.events) {
    const n = Number(e.id.replace(/\D/g, ''))
    if (n > max) max = n
  }
  return `evt-${String(max + 1).padStart(4, '0')}`
}

export function appendEvent(
  ws: Workspace,
  partial: Omit<ExecutionEvent, 'id' | 'at' | 'runId'> & { at?: number; runId?: string },
): Workspace {
  const event: ExecutionEvent = {
    ...partial,
    id: nextEventId(ws),
    at: partial.at ?? ws.now,
    runId: partial.runId ?? ws.project.currentRunId,
  }
  return { ...ws, events: [...ws.events, event] }
}

function replaceTask(ws: Workspace, next: Task): Workspace {
  return { ...ws, tasks: ws.tasks.map((t) => (t.id === next.id ? next : t)) }
}

export interface TransitionOptions {
  actorId: string
  note?: string
  blockKind?: 'failure' | 'human' | 'external'
  simulated?: boolean
}

export interface TransitionResult {
  ws: Workspace
  error?: string
}

/** Apply a validated task transition and everything that follows from it. */
export function applyTransition(
  ws: Workspace,
  taskId: string,
  to: TaskStatus,
  opts: TransitionOptions,
): TransitionResult {
  const task = ws.tasks.find((t) => t.id === taskId)
  if (!task) return { ws, error: `Task ${taskId} no longer exists.` }
  const check = checkTransition(task, to, ws)
  if (!check.ok) return { ws, error: check.reason }

  const now = ws.now
  const from = task.status
  let next: Task = { ...task, status: to }
  let retried = false

  switch (to) {
    case 'running':
      next.actualStart = task.actualStart ?? now
      next.blocked = undefined
      if (from === 'blocked' || from === 'review') {
        next.attempts = task.attempts + 1
        retried = from === 'blocked'
        if (from === 'review') {
          next.progress = Math.min(task.progress, 85)
          next.validation = task.validation.map((c) =>
            c.result === 'passed' ? c : { ...c, result: 'pending' as CriterionResult },
          )
        }
      }
      break
    case 'review':
      next.progress = 100
      next.actualEnd = undefined
      break
    case 'completed':
      next.progress = 100
      next.actualEnd = now
      break
    case 'blocked':
      next.blocked = {
        kind: opts.blockKind ?? 'human',
        note: opts.note ?? 'Blocked by operator.',
        since: now,
      }
      break
    case 'ready':
    case 'backlog':
      next.blocked = undefined
      break
  }

  let out = replaceTask(ws, next)
  const human = opts.actorId === HUMAN_ID
  const label = TASK_STATUS_LABEL[to]
  out = appendEvent(out, {
    actorId: opts.actorId,
    type: human ? 'intervention' : 'transition',
    status: to === 'blocked' ? 'warning' : 'success',
    title: human ? `You moved ${task.id} to ${label}` : `${task.id} moved to ${label}`,
    detail: opts.note ?? `${TASK_STATUS_LABEL[from]} to ${label}: ${task.title}`,
    taskId: task.id,
    simulated: opts.simulated,
  })
  if (retried) {
    out = appendEvent(out, {
      actorId: task.assigneeId,
      type: 'retry',
      status: 'running',
      title: `Retry ${next.attempts} started for ${task.id}`,
      detail: task.blocked?.note,
      taskId: task.id,
      simulated: opts.simulated,
    })
  }

  // Completing a task releases dependents whose prerequisites are now all done.
  if (to === 'completed') {
    for (const dep of dependentsOf(task.id, out.tasks)) {
      if (dep.status === 'backlog' && unmetDependencies(dep, out.tasks).length === 0) {
        out = replaceTask(out, { ...dep, status: 'ready' })
        out = appendEvent(out, {
          actorId: SYSTEM_ID,
          type: 'transition',
          status: 'info',
          title: `${dep.id} is ready`,
          detail: `All prerequisites complete after ${task.id}.`,
          taskId: dep.id,
          simulated: opts.simulated,
        })
      }
    }
  }
  // Reopening a task pulls back dependents that were ready but not started.
  if (from === 'completed') {
    for (const dep of dependentsOf(task.id, out.tasks)) {
      if (dep.status === 'ready') {
        out = replaceTask(out, { ...dep, status: 'backlog' })
        out = appendEvent(out, {
          actorId: SYSTEM_ID,
          type: 'transition',
          status: 'info',
          title: `${dep.id} returned to Backlog`,
          detail: `${task.id} was reopened.`,
          taskId: dep.id,
          simulated: opts.simulated,
        })
      }
    }
  }
  return { ws: out }
}

export function setCriterionResult(
  ws: Workspace,
  taskId: string,
  criterionId: string,
  result: CriterionResult,
  actorId: string,
  simulated = false,
): Workspace {
  const task = ws.tasks.find((t) => t.id === taskId)
  const crit = task?.validation.find((c) => c.id === criterionId)
  if (!task || !crit || crit.result === result) return ws
  const next: Task = {
    ...task,
    validation: task.validation.map((c) => (c.id === criterionId ? { ...c, result } : c)),
  }
  const status: EventStatus =
    result === 'passed' ? 'success' : result === 'failed' ? 'failed' : 'info'
  return appendEvent(replaceTask(ws, next), {
    actorId,
    type: 'verification',
    status,
    title: `${task.id} check ${result}: ${crit.text}`,
    taskId: task.id,
    simulated,
  })
}

// ---------------------------------------------------------- plan vs actual

const weight = (t: Task) => Math.max(1, t.plannedEnd - t.plannedStart)

/** Share of the plan that should be done by `now` (0-100), weighted by planned duration. */
export function expectedProgress(tasks: Task[], now: number): number {
  const total = tasks.reduce((s, t) => s + weight(t), 0)
  if (!total) return 0
  const done = tasks.reduce((s, t) => {
    const f = (now - t.plannedStart) / Math.max(1, t.plannedEnd - t.plannedStart)
    return s + weight(t) * Math.min(1, Math.max(0, f))
  }, 0)
  return (done / total) * 100
}

export function actualProgress(tasks: Task[]): number {
  const total = tasks.reduce((s, t) => s + weight(t), 0)
  if (!total) return 0
  return (tasks.reduce((s, t) => s + weight(t) * (t.progress / 100), 0) / total) * 100
}

export function statusCounts(tasks: Task[]): Record<TaskStatus, number> {
  const c: Record<TaskStatus, number> = {
    backlog: 0,
    ready: 0,
    running: 0,
    blocked: 0,
    review: 0,
    completed: 0,
  }
  for (const t of tasks) c[t.status] += 1
  return c
}

export type PhaseState = 'completed' | 'active' | 'upcoming'

export interface PhaseSummary {
  phase: Phase
  state: PhaseState
  hasBlocked: boolean
  tasks: Task[]
  expected: number
  actual: number
}

export function summarizePhases(ws: Pick<Workspace, 'phases' | 'tasks' | 'now'>): PhaseSummary[] {
  return [...ws.phases]
    .sort((a, b) => a.order - b.order)
    .map((phase) => {
      const tasks = ws.tasks.filter((t) => t.phaseId === phase.id)
      const allDone = tasks.length > 0 && tasks.every((t) => t.status === 'completed')
      const started = tasks.some((t) => t.status !== 'backlog' && t.status !== 'ready')
      return {
        phase,
        tasks,
        state: allDone ? 'completed' : started ? 'active' : 'upcoming',
        hasBlocked: tasks.some((t) => t.status === 'blocked'),
        expected: expectedProgress(tasks, ws.now),
        actual: actualProgress(tasks),
      }
    })
}

export type MilestoneState = 'achieved' | 'upcoming' | 'at_risk' | 'overdue'

export interface MilestoneSummary {
  milestone: Milestone
  state: MilestoneState
  achievedAt?: number
  /** Dependencies not yet completed. */
  open: Task[]
}

export function summarizeMilestones(
  ws: Pick<Workspace, 'milestones' | 'tasks' | 'now'>,
): MilestoneSummary[] {
  const byId = indexById(ws.tasks)
  return ws.milestones
    .map((milestone) => {
      const deps = milestone.dependsOn.map((id) => byId.get(id)).filter((t): t is Task => !!t)
      const open = deps.filter((t) => t.status !== 'completed')
      if (open.length === 0) {
        const achievedAt = Math.max(0, ...deps.map((t) => t.actualEnd ?? 0))
        return { milestone, state: 'achieved' as const, achievedAt, open }
      }
      const unresolved = new Set<string>()
      for (const d of open) {
        unresolved.add(d.id)
        for (const p of unresolvedPrerequisites(d.id, ws.tasks)) unresolved.add(p.id)
      }
      const anyBlocked = [...unresolved].some((id) => byId.get(id)?.status === 'blocked')
      const state: MilestoneState =
        ws.now > milestone.due ? 'overdue' : anyBlocked ? 'at_risk' : 'upcoming'
      return { milestone, state, open }
    })
    .sort((a, b) => a.milestone.due - b.milestone.due)
}

// ------------------------------------------------------------- attention

export interface AttentionItem {
  id: string
  severity: 'critical' | 'warning' | 'info'
  kind: 'failure' | 'human_block' | 'review' | 'milestone'
  title: string
  detail: string
  taskId?: string
  agentId?: string
  since: number
}

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const

/** Everything that needs a person right now, most urgent first. */
export function attentionItems(ws: Workspace): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const t of ws.tasks) {
    if (t.status === 'blocked' && t.blocked) {
      const failure = t.blocked.kind === 'failure'
      items.push({
        id: `blk-${t.id}`,
        severity: failure ? 'critical' : 'warning',
        kind: failure ? 'failure' : 'human_block',
        title: failure
          ? `${t.id} failed after ${t.attempts} attempts`
          : `${t.id} needs your decision`,
        detail: t.blocked.note,
        taskId: t.id,
        agentId: t.assigneeId,
        since: t.blocked.since,
      })
    }
    if (t.status === 'review') {
      const pending = t.validation.filter((c) => c.result !== 'passed').length
      items.push({
        id: `rev-${t.id}`,
        severity: pending ? 'warning' : 'info',
        kind: 'review',
        title: pending ? `${t.id} awaits review` : `${t.id} is ready to approve`,
        detail: pending
          ? `${pending} of ${t.validation.length} criteria still need a result.`
          : 'All criteria passed.',
        taskId: t.id,
        agentId: t.assigneeId,
        since: t.actualEnd ?? ws.now,
      })
    }
  }
  for (const m of summarizeMilestones(ws)) {
    if (m.state === 'overdue' || m.state === 'at_risk') {
      items.push({
        id: `ms-${m.milestone.id}`,
        severity: m.state === 'overdue' ? 'warning' : 'info',
        kind: 'milestone',
        title: `${m.milestone.name} is ${m.state === 'overdue' ? 'overdue' : 'at risk'}`,
        detail: `Open: ${listIds(m.open)}`,
        since: m.milestone.due,
      })
    }
  }
  return items.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.since - a.since,
  )
}

// ---------------------------------------------------------------- metrics

export interface RunMetrics {
  tasksTotal: number
  tasksCompleted: number
  stepsTotal: number
  stepsSucceeded: number
  stepSuccessRate: number | null
  retries: number
  recovered: number
  recoveryRate: number | null
  errors: number
  interventions: number
  durationMs: number
  tokens: number
}

/** A step is a tool call or verification; an error event is a step that failed. */
const STEP_TYPES: EventType[] = ['tool_call', 'verification', 'error']

export function computeLiveMetrics(ws: Workspace, runId: string): RunMetrics {
  const run = ws.runs.find((r) => r.id === runId)
  const events = ws.events.filter((e) => e.runId === runId)
  const steps = events.filter(
    (e) => STEP_TYPES.includes(e.type) && (e.status === 'success' || e.status === 'failed'),
  )
  const stepsSucceeded = steps.filter((e) => e.status === 'success').length
  const retries = events.filter((e) => e.type === 'retry' && e.recovered !== undefined)
  const recovered = retries.filter((e) => e.recovered).length
  return {
    tasksTotal: ws.tasks.length,
    tasksCompleted: ws.tasks.filter((t) => t.status === 'completed').length,
    stepsTotal: steps.length,
    stepsSucceeded,
    stepSuccessRate: steps.length ? stepsSucceeded / steps.length : null,
    retries: retries.length,
    recovered,
    recoveryRate: retries.length ? recovered / retries.length : null,
    errors: events.filter((e) => e.type === 'error').length,
    interventions: events.filter((e) => e.type === 'intervention').length,
    durationMs: (run?.endedAt ?? ws.now) - (run?.startedAt ?? ws.now),
    tokens: events.reduce((s, e) => s + (e.tokens ?? 0), 0),
  }
}

export function metricsForRun(ws: Workspace, run: Run): RunMetrics {
  if (!run.aggregates) return computeLiveMetrics(ws, run.id)
  const a = run.aggregates
  return {
    tasksTotal: a.tasksTotal,
    tasksCompleted: a.tasksCompleted,
    stepsTotal: a.stepsTotal,
    stepsSucceeded: a.stepsSucceeded,
    stepSuccessRate: a.stepsTotal ? a.stepsSucceeded / a.stepsTotal : null,
    retries: a.retries,
    recovered: a.recovered,
    recoveryRate: a.retries ? a.recovered / a.retries : null,
    errors: a.retries,
    interventions: a.interventions,
    durationMs: a.durationMs,
    tokens: a.tokens,
  }
}

export function estimateCostUsd(tokens: number, pricePerMillion: number): number {
  return (tokens / 1_000_000) * pricePerMillion
}

/** Tokens per agent for a run, from the events that carry token counts. */
export function tokensByAgent(events: ExecutionEvent[], runId: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of events) {
    if (e.runId !== runId || !e.tokens) continue
    out.set(e.actorId, (out.get(e.actorId) ?? 0) + e.tokens)
  }
  return out
}

/** Cumulative per-step success after each step, for a sparkline of reliability over the run. */
export function rollingStepSuccess(events: ExecutionEvent[], runId: string, bucketMs: number) {
  const steps = events
    .filter(
      (e) =>
        e.runId === runId &&
        STEP_TYPES.includes(e.type) &&
        (e.status === 'success' || e.status === 'failed'),
    )
    .sort((a, b) => a.at - b.at)
  if (!steps.length) return []
  const start = steps[0]!.at
  const buckets = new Map<number, { ok: number; total: number }>()
  for (const s of steps) {
    const k = Math.floor((s.at - start) / bucketMs)
    const b = buckets.get(k) ?? { ok: 0, total: 0 }
    b.total += 1
    if (s.status === 'success') b.ok += 1
    buckets.set(k, b)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, b]) => ({ at: start + k * bucketMs, rate: b.ok / b.total, total: b.total }))
}

export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function relativeTime(at: number, now: number): string {
  const diff = now - at
  if (diff < 0) {
    const ahead = -diff
    if (ahead < HOUR) return `in ${Math.max(1, Math.round(ahead / 60_000))}m`
    if (ahead < 48 * HOUR) return `in ${Math.round(ahead / HOUR)}h`
    return `in ${Math.round(ahead / (24 * HOUR))}d`
  }
  if (diff < 45_000) return 'just now'
  if (diff < HOUR) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 48 * HOUR) return `${Math.round(diff / HOUR)}h ago`
  return `${Math.round(diff / (24 * HOUR))}d ago`
}

export function agentName(agents: Agent[], id: string): string {
  if (id === SYSTEM_ID) return 'Orchestrator'
  if (id === HUMAN_ID) return 'You'
  return agents.find((a) => a.id === id)?.name ?? id
}
