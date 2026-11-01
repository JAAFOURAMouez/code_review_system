// Demonstration simulator. It advances the in-browser sample workspace so the
// interface has something live to show. It does NOT run agents: every event it
// produces is flagged `simulated: true` and labelled as demonstration data.
import {
  SYSTEM_ID,
  appendEvent,
  applyTransition,
  setCriterionResult,
  unmetDependencies,
} from './rules.ts'
import type { Task, Workspace } from './types.ts'

export interface SimulationOptions {
  /** Probability (0-1) that a simulated tool call fails and has to be retried. */
  failureRate?: number
}

const clampProgress = (n: number) => Math.min(100, Math.max(0, n))

function updateTask(ws: Workspace, next: Task): Workspace {
  return { ...ws, tasks: ws.tasks.map((t) => (t.id === next.id ? next : t)) }
}

/** Advance the simulated run by one step. Pure: returns a new workspace. */
export function simulationStep(
  input: Workspace,
  now: number,
  rng: () => number,
  opts: SimulationOptions = {},
): Workspace {
  const failureRate = opts.failureRate ?? 0.05
  let ws: Workspace = { ...input, now }

  // 1. Running tasks make progress and call tools.
  for (const running of ws.tasks.filter((t) => t.status === 'running')) {
    const agent = ws.agents.find((a) => a.id === running.assigneeId)
    if (!agent) continue
    const tool = agent.tools[Math.floor(rng() * agent.tools.length)] ?? 'tool'
    const tokens = Math.round(1800 + rng() * 9000)

    if (rng() < failureRate) {
      ws = appendEvent(ws, {
        actorId: agent.id,
        type: 'error',
        status: 'failed',
        taskId: running.id,
        tool,
        title: `${tool} failed on ${running.id}`,
        detail: 'Transient error in the demonstration simulator.',
        simulated: true,
      })
      const recovers = rng() < 0.85
      ws = appendEvent(ws, {
        actorId: agent.id,
        type: 'retry',
        status: recovers ? 'success' : 'failed',
        recovered: recovers,
        taskId: running.id,
        tool,
        title: recovers ? `Retry recovered ${running.id}` : `Retry failed for ${running.id}`,
        detail: recovers ? 'The second attempt succeeded.' : 'The second attempt failed too.',
        simulated: true,
      })
      if (!recovers) {
        const r = applyTransition(ws, running.id, 'blocked', {
          actorId: SYSTEM_ID,
          blockKind: 'failure',
          simulated: true,
          note: `${tool} failed twice in a row (demonstration simulator).`,
        })
        ws = updateTask(r.ws, {
          ...r.ws.tasks.find((t) => t.id === running.id)!,
          attempts: running.attempts + 1,
        })
      }
      continue
    }

    const progress = clampProgress(running.progress + 3 + rng() * 3)
    ws = updateTask(ws, { ...running, progress })
    ws = appendEvent(ws, {
      actorId: agent.id,
      type: 'tool_call',
      status: 'success',
      taskId: running.id,
      tool,
      title: `${tool} on ${running.id}`,
      detail: `Progress ${Math.round(progress)}%`,
      tokens,
      durationMs: Math.round(1500 + rng() * 25000),
      simulated: true,
    })

    if (progress >= 100) {
      ws = applyTransition(ws, running.id, 'review', { actorId: agent.id, simulated: true }).ws
      const task = ws.tasks.find((t) => t.id === running.id)!
      let anyFailed = false
      for (const c of task.validation) {
        if (c.kind !== 'automated' || c.result === 'passed') continue
        const pass = rng() < 0.92
        if (!pass) anyFailed = true
        ws = setCriterionResult(ws, task.id, c.id, pass ? 'passed' : 'failed', agent.id, true)
      }
      if (anyFailed) {
        ws = applyTransition(ws, task.id, 'running', {
          actorId: SYSTEM_ID,
          simulated: true,
          note: 'An automated check failed, so the task went back for another attempt.',
        }).ws
      }
    }
  }

  // 2. The orchestrator starts a ready task when its agent is free.
  for (const ready of ws.tasks.filter((t) => t.status === 'ready')) {
    if (rng() > 0.45) continue
    if (unmetDependencies(ready, ws.tasks).length) continue
    const busy = ws.tasks.some((t) => t.assigneeId === ready.assigneeId && t.status === 'running')
    if (busy) continue
    ws = applyTransition(ws, ready.id, 'running', {
      actorId: SYSTEM_ID,
      simulated: true,
      note: 'The orchestrator started this task: its prerequisites are complete and its agent is free.',
    }).ws
  }
  return ws
}

/** True when the simulator would have nothing to do (used to explain a quiet feed). */
export function isSimulationIdle(ws: Workspace): boolean {
  return !ws.tasks.some((t) => t.status === 'running' || t.status === 'ready')
}
