import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deriveAgentState,
  deriveHandoffs,
  indexById,
  prerequisiteChain,
  summarizeMilestones,
  summarizePhases,
  unmetDependencies,
} from '../src/domain/rules.ts'
import { createSeedWorkspace } from '../src/domain/seed.ts'
import { HOUR } from '../src/domain/types.ts'

const NOW = Date.parse('2026-10-29T12:00:00Z')
const ws = createSeedWorkspace(NOW)

test('every dependency exists and the graph has no cycles', () => {
  const ids = new Set(ws.tasks.map((t) => t.id))
  for (const t of ws.tasks) {
    for (const d of t.dependsOn) assert.ok(ids.has(d), `${t.id} depends on missing ${d}`)
    assert.ok(
      !prerequisiteChain(t.id, ws.tasks).some((p) => p.id === t.id),
      `${t.id} is in a cycle`,
    )
  }
})

test('started or finished tasks never have unmet prerequisites', () => {
  for (const t of ws.tasks) {
    if (['ready', 'running', 'review', 'completed'].includes(t.status)) {
      assert.deepEqual(
        unmetDependencies(t, ws.tasks),
        [],
        `${t.id} is ${t.status} with open prerequisites`,
      )
    }
  }
})

test('each agent runs at most one task at a time', () => {
  for (const a of ws.agents) {
    assert.ok(
      ws.tasks.filter((t) => t.assigneeId === a.id && t.status === 'running').length <= 1,
      a.id,
    )
  }
})

test('the sample shows every agent state, derived from tasks', () => {
  const states = Object.fromEntries(ws.agents.map((a) => [a.id, deriveAgentState(a.id, ws.tasks)]))
  assert.deepEqual(states, {
    planner: 'running',
    researcher: 'completed',
    architect: 'completed',
    ledger: 'running',
    api: 'running',
    tester: 'failed',
    reviewer: 'blocked',
    release: 'idle',
  })
})

test('events reference real tasks and actors, and completed tasks have a completion event', () => {
  const tasks = indexById(ws.tasks)
  const actors = new Set([...ws.agents.map((a) => a.id), 'system', 'human'])
  const runs = new Set(ws.runs.map((r) => r.id))
  for (const e of ws.events) {
    assert.ok(actors.has(e.actorId), `unknown actor ${e.actorId}`)
    assert.ok(runs.has(e.runId), `unknown run ${e.runId}`)
    if (e.taskId) assert.ok(tasks.has(e.taskId), `unknown task ${e.taskId}`)
    assert.ok(e.at <= NOW, 'no events from the future')
  }
  const current = ws.events.filter((e) => e.runId === ws.project.currentRunId)
  for (const t of ws.tasks.filter((x) => x.status === 'completed')) {
    assert.ok(
      current.some((e) => e.taskId === t.id && e.title === `${t.id} moved to Completed`),
      `${t.id} has no completion event`,
    )
  }
  const ids = ws.events.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length, 'event ids are unique')
})

test('blocked tasks have a reason and failed attempts are recorded', () => {
  for (const t of ws.tasks.filter((x) => x.status === 'blocked')) {
    assert.ok(t.blocked?.note, `${t.id} has no block reason`)
  }
  const t403 = ws.tasks.find((t) => t.id === 'T-403')!
  assert.equal(t403.attempts, 3)
  const retries = ws.events.filter((e) => e.taskId === 'T-403' && e.type === 'retry')
  assert.equal(retries.length, 2)
})

test('memory links resolve and inferred memories are marked as such', () => {
  const mem = indexById(ws.memories)
  for (const m of ws.memories) {
    for (const l of m.links) assert.ok(mem.has(l.to), `${m.id} links to missing ${l.to}`)
    for (const id of m.taskIds)
      assert.ok(
        ws.tasks.some((t) => t.id === id),
        `${m.id} -> ${id}`,
      )
    if (m.origin === 'inferred') {
      assert.ok(typeof m.confidence === 'number' && m.confidence > 0 && m.confidence < 1, m.id)
      assert.ok((m.derivedFrom ?? []).length > 0, `${m.id} has no derivedFrom`)
      for (const d of m.derivedFrom ?? []) assert.equal(mem.get(d)?.origin !== undefined, true)
    } else {
      assert.equal(m.confidence, undefined, `${m.id} is stored but has a confidence`)
    }
  }
})

test('handoffs are derived from task dependencies', () => {
  const edges = deriveHandoffs(ws.tasks)
  const get = (id: string) => edges.find((e) => e.id === id)
  assert.equal(get('researcher>planner')?.status, 'done')
  assert.equal(get('api>tester')?.status, 'active')
  assert.equal(get('tester>release')?.status, 'stalled')
  assert.ok(!edges.some((e) => e.from === e.to))
})

test('phases and milestones agree with the tasks', () => {
  const phases = summarizePhases(ws)
  const state = Object.fromEntries(phases.map((p) => [p.phase.id, p.state]))
  assert.deepEqual(state, {
    ph1: 'completed',
    ph2: 'completed',
    ph3: 'active',
    ph4: 'active',
    ph5: 'upcoming',
  })
  const ms = Object.fromEntries(summarizeMilestones(ws).map((m) => [m.milestone.id, m.state]))
  assert.equal(ms.M1, 'achieved')
  assert.equal(ms.M2, 'achieved')
  assert.equal(ms.M3, 'overdue')
  assert.equal(ms.M5, 'at_risk')
})

test('the run is about six days in', () => {
  const run = ws.runs.find((r) => r.id === ws.project.currentRunId)!
  assert.ok(Math.abs(NOW - run.startedAt - 150 * HOUR) < 1000)
})
