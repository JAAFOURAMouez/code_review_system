// Pure helpers about the review pipeline: agent order, finding counts, the run timeline.
// No React here, so it is easy to test.
import type { AgentInfo, AgentRun, CurrentRun, Finding } from './types.ts'

/** Lower is more severe. Covers pylint, flake8, bandit and radon severities. */
const SEVERITY_RANK: Record<string, number> = {
  error: 0,
  high: 0,
  warning: 1,
  medium: 1,
  refactor: 2,
  convention: 3,
  low: 3,
  info: 4,
}

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 5
}

/** Severity as one of three levels for colouring. */
export function severityLevel(severity: string): 'high' | 'medium' | 'low' {
  const r = severityRank(severity)
  return r === 0 ? 'high' : r === 1 ? 'medium' : 'low'
}

/** Radon reports every block; scores of 5 or less are information, not problems. */
export function isIssue(f: Finding): boolean {
  return !(f.type === 'radon' && f.severity === 'info')
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.type.localeCompare(b.type),
  )
}

/** Issues per tool, in the pipeline's tool order. */
export function countByTool(findings: Finding[]): { tool: string; count: number }[] {
  const order = ['pylint', 'flake8', 'bandit', 'radon']
  const counts = new Map<string, number>(order.map((t) => [t, 0]))
  for (const f of findings) if (isIssue(f)) counts.set(f.type, (counts.get(f.type) ?? 0) + 1)
  return [...counts].map(([tool, count]) => ({ tool, count }))
}

/**
 * The pipeline in three steps: the agents that run first (static analysis, then the planner),
 * the model-based agents that run in parallel, in the backend's order but with an agent right
 * after the one it depends on (code correction after the test generator), and the
 * dependencies between those agents as [from, to] pairs.
 */
export function stages(agents: AgentInfo[]): {
  first: AgentInfo[]
  parallel: AgentInfo[]
  links: [string, string][]
} {
  const first = agents.filter((a) => !a.llm || a.planner)
  const rest = agents.filter((a) => a.llm && !a.planner)
  const ids = new Set(rest.map((a) => a.id))
  const dep = (a: AgentInfo) => (a.dependsOn ?? []).find((d) => ids.has(d))
  const roots = rest.filter((a) => !dep(a))
  const parallel: AgentInfo[] = []
  for (const a of roots) {
    parallel.push(a)
    parallel.push(...rest.filter((b) => dep(b) === a.id))
  }
  // A dependency on an agent that is not in the list is ignored; nothing is dropped.
  for (const a of rest) if (!parallel.includes(a)) parallel.push(a)
  const links: [string, string][] = rest.flatMap((a) => {
    const d = dep(a)
    return d ? [[d, a.id] as [string, string]] : []
  })
  return { first, parallel, links }
}

export interface TimelineBar {
  id: string
  /** Start and end as fractions (0..1) of the timeline's width. */
  from: number
  to: number
  status: AgentRun['status']
}

/**
 * Where each agent ran in time, relative to the review's start. Running agents extend to
 * `now`. The scale ends at the latest end (or now), so a finished review fills the width.
 */
export function timeline(
  run: CurrentRun,
  order: string[],
  now: number,
): { bars: TimelineBar[]; totalMs: number } {
  const start = run.startedAt
  const ends = order
    .map((id) => run.agents[id])
    .filter((a): a is AgentRun => !!a && a.startedAt !== null)
    .map((a) => (a.status === 'running' ? now : (a.endedAt ?? now)))
  const totalMs = Math.max(1, ...ends.map((e) => e - start), (run.endedAt ?? now) - start)
  const bars: TimelineBar[] = []
  for (const id of order) {
    const a = run.agents[id]
    if (!a || a.startedAt === null) continue
    const end = a.status === 'running' ? now : (a.endedAt ?? now)
    bars.push({
      id,
      from: Math.min(1, Math.max(0, (a.startedAt - start) / totalMs)),
      to: Math.min(1, Math.max(0, (end - start) / totalMs)),
      status: a.status,
    })
  }
  return { bars, totalMs }
}

/** The largest number of agents that were running at the same moment. */
export function peakParallelism(run: CurrentRun, now: number): number {
  const points: [number, number][] = []
  for (const a of Object.values(run.agents)) {
    if (a.startedAt === null) continue
    points.push([a.startedAt, 1], [a.status === 'running' ? now : (a.endedAt ?? now), -1])
  }
  points.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  let cur = 0
  let peak = 0
  for (const [, d] of points) {
    cur += d
    peak = Math.max(peak, cur)
  }
  return peak
}
