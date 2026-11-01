import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HUMAN_ID,
  actualProgress,
  applyTransition,
  attentionItems,
  checkTransition,
  computeLiveMetrics,
  deriveAgentState,
  estimateCostUsd,
  expectedProgress,
  formatDuration,
  metricsForRun,
  relativeTime,
  setCriterionResult,
  transitionOptions,
} from '../src/domain/rules.ts'
import { createSeedWorkspace } from '../src/domain/seed.ts'
import { HOUR, type Workspace } from '../src/domain/types.ts'

const NOW = Date.parse('2026-10-29T12:00:00Z')
const fresh = (): Workspace => createSeedWorkspace(NOW)
const task = (ws: Workspace, id: string) => ws.tasks.find((t) => t.id === id)!

test('cannot mark a task ready while prerequisites are open, and the reason names them', () => {
  const ws = fresh()
  const res = checkTransition(task(ws, 'T-305'), 'ready', ws)
  assert.equal(res.ok, false)
  assert.match(res.reason!, /T-302/)
})

test('an agent cannot run two tasks at once', () => {
  const ws = fresh()
  // T-305 would go to Ledger Engineer, who is running T-302. Make it ready by force.
  const forced: Workspace = {
    ...ws,
    tasks: ws.tasks.map((t) => (t.id === 'T-302' ? { ...t, status: 'completed' as const } : t)),
  }
  const t = { ...task(forced, 'T-305'), status: 'ready' as const }
  const busyWs: Workspace = {
    ...forced,
    tasks: forced.tasks.map((x) =>
      x.id === 'T-305' ? t : x.id === 'T-301' ? { ...x, status: 'running' as const } : x,
    ),
  }
  const res = checkTransition(t, 'running', busyWs)
  assert.equal(res.ok, false)
  assert.match(res.reason!, /already running T-301/)
})

test('review cannot be approved until every criterion has passed', () => {
  const ws = fresh()
  const blocked = applyTransition(ws, 'T-303', 'completed', { actorId: HUMAN_ID })
  assert.ok(blocked.error)
  assert.equal(task(blocked.ws, 'T-303').status, 'review')

  const crit = task(ws, 'T-303').validation.find((c) => c.result !== 'passed')!
  const passed = setCriterionResult(ws, 'T-303', crit.id, 'passed', HUMAN_ID)
  const done = applyTransition(passed, 'T-303', 'completed', { actorId: HUMAN_ID })
  assert.equal(done.error, undefined)
  const t = task(done.ws, 'T-303')
  assert.equal(t.status, 'completed')
  assert.equal(t.progress, 100)
  assert.equal(t.actualEnd, NOW)
})

test('completing a task releases dependents whose prerequisites are all complete', () => {
  let ws = fresh()
  // Drive T-302 through review to completed.
  ws = applyTransition(ws, 'T-302', 'review', { actorId: 'ledger' }).ws
  for (const c of task(ws, 'T-302').validation)
    ws = setCriterionResult(ws, 'T-302', c.id, 'passed', HUMAN_ID)
  assert.equal(task(ws, 'T-305').status, 'backlog')
  const res = applyTransition(ws, 'T-302', 'completed', { actorId: HUMAN_ID })
  assert.equal(res.error, undefined)
  assert.equal(task(res.ws, 'T-305').status, 'ready')
  assert.ok(res.ws.events.some((e) => e.taskId === 'T-305' && e.title === 'T-305 is ready'))
  // T-306 still waits on T-304.
  assert.equal(task(res.ws, 'T-306').status, 'backlog')
})

test('human transitions are logged as interventions, system ones as transitions', () => {
  const ws = fresh()
  const before = ws.events.length
  const human = applyTransition(ws, 'T-501', 'running', { actorId: HUMAN_ID })
  assert.equal(human.ws.events.length, before + 1)
  assert.equal(human.ws.events.at(-1)!.type, 'intervention')
  const sys = applyTransition(ws, 'T-501', 'running', { actorId: 'system' })
  assert.equal(sys.ws.events.at(-1)!.type, 'transition')
})

test('retrying a failed task logs a retry, increments attempts and changes the agent state', () => {
  const ws = fresh()
  assert.equal(deriveAgentState('tester', ws.tasks), 'failed')
  const res = applyTransition(ws, 'T-403', 'running', { actorId: HUMAN_ID })
  assert.equal(res.error, undefined)
  const t = task(res.ws, 'T-403')
  assert.equal(t.attempts, 4)
  assert.equal(t.blocked, undefined)
  assert.equal(deriveAgentState('tester', res.ws.tasks), 'running')
  assert.ok(res.ws.events.some((e) => e.type === 'retry' && e.title.includes('Retry 4')))
})

test('requesting changes is refused while the agent is busy, with the reason', () => {
  const ws = fresh()
  const res = applyTransition(ws, 'T-303', 'running', { actorId: HUMAN_ID })
  assert.match(res.error!, /API Engineer is already running T-304/)
  assert.equal(task(res.ws, 'T-303').status, 'review')
})

test('requesting changes sends a reviewed task back and resets non-passed criteria', () => {
  const base = fresh()
  // Free the API Engineer by moving T-304 to review.
  const ws = applyTransition(base, 'T-304', 'review', { actorId: 'api' }).ws
  const res = applyTransition(ws, 'T-303', 'running', {
    actorId: HUMAN_ID,
    note: 'Rollback switch unclear.',
  })
  assert.equal(res.error, undefined)
  const t = task(res.ws, 'T-303')
  assert.equal(t.status, 'running')
  assert.ok(t.progress <= 85)
  assert.equal(t.attempts, 2)
})

test('a started dependent prevents reopening a completed task', () => {
  const ws = fresh()
  const res = checkTransition(task(ws, 'T-301'), 'review', ws)
  assert.equal(res.ok, false)
  assert.match(res.reason!, /already started/)
  // T-101 feeds only T-104 which is complete, so it is also locked.
  assert.equal(checkTransition(task(ws, 'T-101'), 'review', ws).ok, false)
})

test('transition options list every allowed target with a reason when disabled', () => {
  const ws = fresh()
  const opts = transitionOptions(task(ws, 'T-501'), ws)
  assert.deepEqual(opts.map((o) => o.to).sort(), ['backlog', 'running'])
  assert.equal(opts.find((o) => o.to === 'running')!.ok, true)
  const blockedOpts = transitionOptions(task(ws, 'T-404'), ws)
  assert.ok(blockedOpts.every((o) => o.ok))
})

test('plan versus actual: the run is behind plan', () => {
  const ws = fresh()
  const expected = expectedProgress(ws.tasks, ws.now)
  const actual = actualProgress(ws.tasks)
  assert.ok(expected > actual, `expected ${expected} should exceed actual ${actual}`)
  assert.ok(expected > 0 && expected < 100)
})

test('attention items rank failures before decisions before reviews', () => {
  const items = attentionItems(fresh())
  assert.equal(items[0]!.kind, 'failure')
  assert.equal(items[0]!.taskId, 'T-403')
  assert.ok(items.some((i) => i.kind === 'human_block' && i.taskId === 'T-404'))
  assert.ok(items.some((i) => i.kind === 'review' && i.taskId === 'T-303'))
  const severities = items.map((i) => i.severity)
  const rank = { critical: 0, warning: 1, info: 2 } as const
  assert.deepEqual(
    severities,
    [...severities].sort((a, b) => rank[a] - rank[b]),
  )
})

test('live metrics are computed from events and stay consistent with the log', () => {
  const ws = fresh()
  const m = computeLiveMetrics(ws, ws.project.currentRunId)
  const steps = ws.events.filter(
    (e) =>
      e.runId === ws.project.currentRunId &&
      (e.type === 'tool_call' || e.type === 'verification' || e.type === 'error') &&
      (e.status === 'success' || e.status === 'failed'),
  )
  assert.equal(m.stepsTotal, steps.length)
  assert.ok(
    m.stepSuccessRate! > 0.9 && m.stepSuccessRate! < 1,
    `failed steps must lower the rate: ${m.stepSuccessRate}`,
  )
  assert.equal(m.stepsTotal - m.stepsSucceeded, m.errors)
  assert.equal(m.retries, 5)
  assert.equal(m.recovered, 2)
  assert.equal(m.interventions, 2)
  assert.equal(m.tasksCompleted, 10)
  assert.ok(m.tokens > 0)
  const run = ws.runs.find((r) => r.id === ws.project.currentRunId)!
  assert.equal(metricsForRun(ws, run).stepsTotal, m.stepsTotal)
  assert.equal(m.durationMs, 150 * HOUR)
})

test('finished runs use their stored sample aggregates', () => {
  const ws = fresh()
  const run = ws.runs.find((r) => r.id === 'run-06')!
  const m = metricsForRun(ws, run)
  assert.equal(m.tasksCompleted, 23)
  assert.ok(Math.abs(m.stepSuccessRate! - 514 / 571) < 1e-9)
})

test('formatting helpers', () => {
  assert.equal(formatDuration(150 * HOUR), '6d 6h')
  assert.equal(formatDuration(95 * 60_000), '1h 35m')
  assert.equal(formatDuration(20 * 60_000), '20m')
  assert.equal(relativeTime(NOW - 10_000, NOW), 'just now')
  assert.equal(relativeTime(NOW - 5 * 60_000, NOW), '5m ago')
  assert.equal(relativeTime(NOW - 5 * HOUR, NOW), '5h ago')
  assert.equal(relativeTime(NOW + 3 * HOUR, NOW), 'in 3h')
  assert.equal(estimateCostUsd(2_000_000, 5), 10)
})
