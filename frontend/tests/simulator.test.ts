import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unmetDependencies } from '../src/domain/rules.ts'
import { createSeedWorkspace, mulberry32 } from '../src/domain/seed.ts'
import { simulationStep } from '../src/domain/simulator.ts'
import type { Workspace } from '../src/domain/types.ts'

const NOW = Date.parse('2026-10-29T12:00:00Z')

function run(steps: number, seed: number, failureRate = 0.05): Workspace {
  let ws = createSeedWorkspace(NOW)
  const rng = mulberry32(seed)
  for (let i = 1; i <= steps; i++) ws = simulationStep(ws, NOW + i * 3500, rng, { failureRate })
  return ws
}

test('simulation is deterministic for a given seed', () => {
  const a = run(40, 11)
  const b = run(40, 11)
  assert.deepEqual(a.tasks, b.tasks)
  assert.equal(a.events.length, b.events.length)
})

test('simulated events are flagged and appended after the seed events', () => {
  const base = createSeedWorkspace(NOW)
  const ws = run(10, 3)
  const added = ws.events.slice(base.events.length)
  assert.ok(added.length > 0)
  assert.ok(added.every((e) => e.simulated === true))
  assert.ok(added.every((e) => e.at > NOW))
})

test('invariants hold across many simulated steps and seeds', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const ws = run(120, seed)
    for (const t of ws.tasks) {
      if (['ready', 'running', 'review', 'completed'].includes(t.status)) {
        assert.deepEqual(unmetDependencies(t, ws.tasks), [], `seed ${seed}: ${t.id} ${t.status}`)
      }
      assert.ok(t.progress >= 0 && t.progress <= 100)
    }
    for (const a of ws.agents) {
      const running = ws.tasks.filter((t) => t.assigneeId === a.id && t.status === 'running')
      assert.ok(running.length <= 1, `seed ${seed}: ${a.id} runs ${running.length} tasks`)
    }
    const ids = ws.events.map((e) => e.id)
    assert.equal(new Set(ids).size, ids.length, `seed ${seed}: duplicate event ids`)
  }
})

test('running tasks make progress and reach review', () => {
  const ws = run(60, 5, 0)
  const t302 = ws.tasks.find((t) => t.id === 'T-302')!
  assert.notEqual(t302.status, 'running')
  assert.ok(['review', 'completed'].includes(t302.status))
})

test('the orchestrator starts the ready task once its agent is free', () => {
  const ws = run(40, 8, 0)
  const t501 = ws.tasks.find((t) => t.id === 'T-501')!
  assert.notEqual(t501.status, 'ready')
})

test('with failures disabled no simulated error events appear', () => {
  const base = createSeedWorkspace(NOW)
  const ws = run(80, 9, 0)
  const added = ws.events.slice(base.events.length)
  assert.equal(added.filter((e) => e.type === 'error').length, 0)
})

test('the simulator never approves work: completing a task is always a person’s action', () => {
  const base = createSeedWorkspace(NOW)
  const ws = run(150, 12, 0)
  const completedBefore = base.tasks.filter((t) => t.status === 'completed').map((t) => t.id)
  const completedAfter = ws.tasks.filter((t) => t.status === 'completed').map((t) => t.id)
  assert.deepEqual(completedAfter, completedBefore)
  // Tasks the simulator finished wait in review.
  assert.ok(ws.tasks.some((t) => t.status === 'review' && t.id !== 'T-303'))
})
