import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fmtDuration, includesText, plural } from '../src/format.ts'
import {
  countByTool,
  isIssue,
  peakParallelism,
  severityLevel,
  sortFindings,
  stages,
  timeline,
} from '../src/pipeline.ts'
import type { AgentInfo, AgentRun, CurrentRun, Finding } from '../src/types.ts'

const agent = (id: string, llm: boolean): AgentInfo => ({
  id,
  name: id,
  role: '',
  llm,
  usesTools: false,
  tools: [],
  model: llm ? 'm' : null,
  budgetMs: 1000,
})

const runOf = (
  agents: Record<string, Partial<AgentRun>>,
  startedAt = 0,
  endedAt: number | null = null,
): CurrentRun => ({
  id: 'run-001',
  file: 'a.py',
  model: 'm',
  lines: 3,
  startedAt,
  endedAt,
  durationMs: 0,
  outcome: endedAt === null ? 'in_progress' : 'succeeded',
  agentsOk: 0,
  agentsFailed: 0,
  agentsTotal: Object.keys(agents).length,
  approved: 0,
  agents: Object.fromEntries(
    Object.entries(agents).map(([id, a]) => [
      id,
      {
        id,
        taskId: 'T1.1',
        status: 'ok',
        attempts: 1,
        approved: false,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        problem: null,
        result: null,
        ...a,
      } as AgentRun,
    ]),
  ),
})

test('static analysis comes first, the model agents run together', () => {
  const { first, parallel } = stages([
    agent('static_analysis', false),
    agent('a', true),
    agent('b', true),
  ])
  assert.deepEqual(
    first.map((a) => a.id),
    ['static_analysis'],
  )
  assert.deepEqual(
    parallel.map((a) => a.id),
    ['a', 'b'],
  )
})

test('findings: most severe first, radon information is not an issue', () => {
  const f: Finding[] = [
    { type: 'pylint', line: 9, message: 'c', severity: 'convention' },
    { type: 'bandit', line: 3, message: 'b', severity: 'high' },
    { type: 'radon', line: 1, message: 'cc 2', severity: 'info' },
    { type: 'flake8', line: 2, message: 'w', severity: 'warning' },
  ]
  assert.deepEqual(
    sortFindings(f).map((x) => x.type),
    ['bandit', 'flake8', 'pylint', 'radon'],
  )
  assert.equal(isIssue(f[2]), false)
  assert.deepEqual(countByTool(f), [
    { tool: 'pylint', count: 1 },
    { tool: 'flake8', count: 1 },
    { tool: 'bandit', count: 1 },
    { tool: 'radon', count: 0 },
  ])
  assert.equal(severityLevel('error'), 'high')
  assert.equal(severityLevel('medium'), 'medium')
  assert.equal(severityLevel('refactor'), 'low')
})

test('timeline shows the model agents overlapping after static analysis', () => {
  const run = runOf(
    {
      static_analysis: { startedAt: 0, endedAt: 1000 },
      a: { startedAt: 1000, endedAt: 4000 },
      b: { startedAt: 1000, endedAt: 3000 },
      c: { status: 'pending' },
    },
    0,
    4000,
  )
  const { bars, totalMs } = timeline(run, ['static_analysis', 'a', 'b', 'c'], 9999)
  assert.equal(totalMs, 4000)
  assert.deepEqual(
    bars.map((b) => [b.id, b.from, b.to]),
    [
      ['static_analysis', 0, 0.25],
      ['a', 0.25, 1],
      ['b', 0.25, 0.75],
    ],
  )
  assert.equal(peakParallelism(run, 9999), 2)
})

test('a running agent extends to now', () => {
  const run = runOf({ a: { status: 'running', startedAt: 1000 } }, 0, null)
  const { bars, totalMs } = timeline(run, ['a'], 3000)
  assert.equal(totalMs, 3000)
  assert.deepEqual([bars[0].from, bars[0].to], [1000 / 3000, 1])
})

test('agents that end exactly when the next starts are not counted as parallel', () => {
  const run = runOf(
    { s: { startedAt: 0, endedAt: 1000 }, a: { startedAt: 1000, endedAt: 2000 } },
    0,
    2000,
  )
  assert.equal(peakParallelism(run, 2000), 1)
})

test('formatting', () => {
  assert.equal(fmtDuration(860), '0.9 s')
  assert.equal(fmtDuration(12_400), '12 s')
  assert.equal(fmtDuration(125_000), '2 min 05 s')
  assert.equal(fmtDuration(120_000), '2 min')
  assert.equal(fmtDuration(null), '–')
  assert.equal(plural(1, 'test'), '1 test')
  assert.equal(plural(3, 'test'), '3 tests')
  assert.ok(includesText(['Static analysis', 'B105'], 'b105 static'))
  assert.ok(!includesText(['x'], 'y'))
})
