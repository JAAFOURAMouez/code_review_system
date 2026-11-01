// Demonstration dataset. All of it is sample data: a plausible long-running
// "billing extraction" objective used to exercise the interface. Nothing here
// is a measurement of a real system. Timestamps are anchored to `now` so the
// scenario always reads as "six days into a twelve day plan".
import { HOUR, DAY } from './types.ts'
import type {
  Agent,
  Communication,
  CriterionResult,
  ExecutionEvent,
  MemoryItem,
  Milestone,
  Phase,
  Priority,
  Run,
  Task,
  TaskStatus,
  ValidationCriterion,
  Workspace,
} from './types.ts'

/** Deterministic RNG so the sample data is identical on every load. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const RUN_HOURS_ELAPSED = 150

export const AGENTS: Agent[] = [
  {
    id: 'planner',
    name: 'Planner',
    role: 'Decomposes the objective and re-plans the critical path',
    model: 'Large reasoning model',
    responsibilities: [
      'Break the objective into dependent tasks with validation criteria',
      'Re-plan the schedule when a task slips or fails',
      'Record decisions and their rationale in persistent memory',
    ],
    tools: ['plan.decompose', 'deps.analyze', 'schedule.simulate'],
  },
  {
    id: 'researcher',
    name: 'Researcher',
    role: 'Maps the existing system and gathers baselines',
    model: 'Large reasoning model',
    responsibilities: [
      'Inventory code paths and data ownership in the monolith',
      'Collect production traffic baselines',
      'Write findings to memory with their sources',
    ],
    tools: ['repo.search', 'sql.explain', 'metrics.query', 'docs.read'],
  },
  {
    id: 'architect',
    name: 'Schema Architect',
    role: 'Designs event schemas and the migration strategy',
    model: 'Large reasoning model',
    responsibilities: [
      'Define the event schema and its versioning rules',
      'Specify dual-write and backfill strategy',
      'Keep schema changes backward compatible',
    ],
    tools: ['schema.lint', 'diff.compare', 'docs.write'],
  },
  {
    id: 'ledger',
    name: 'Ledger Engineer',
    role: 'Implements the event store and projections',
    model: 'Code model',
    responsibilities: [
      'Implement the ledger event store',
      'Build projections and run the historical backfill',
      'Address review comments on ledger code',
    ],
    tools: ['repo.edit', 'test.run', 'db.migrate'],
  },
  {
    id: 'api',
    name: 'API Engineer',
    role: 'Builds the billing-core API and the monolith adapter',
    model: 'Code model',
    responsibilities: [
      'Implement billing-core endpoints from the agreed contract',
      'Implement the dual-write adapter in the monolith',
      'Migrate the refund flow',
    ],
    tools: ['repo.edit', 'openapi.validate', 'test.run'],
  },
  {
    id: 'tester',
    name: 'Test Engineer',
    role: 'Verifies behaviour against the contract and live traffic',
    model: 'Fast model',
    responsibilities: [
      'Write and run contract tests',
      'Replay production traffic in shadow mode and compare results',
      'Report mismatches to the owning agent',
    ],
    tools: ['test.run', 'replay.shadow', 'load.gen'],
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    role: 'Reviews code, security and data handling',
    model: 'Large reasoning model',
    responsibilities: [
      'Review changes before they reach release',
      'Scan event payloads for sensitive data',
      'Escalate policy questions to a person',
    ],
    tools: ['repo.diff', 'pii.scan', 'policy.check'],
  },
  {
    id: 'release',
    name: 'Release Manager',
    role: 'Plans and runs the staged rollout',
    model: 'Fast model',
    responsibilities: [
      'Prepare the canary plan with automatic rollback',
      'Progress traffic only after verification gates pass',
      'Decommission legacy paths once stable',
    ],
    tools: ['deploy.plan', 'flags.read', 'canary.simulate'],
  },
]

export const COMMUNICATIONS: Communication[] = [
  { id: 'c-review', from: 'reviewer', to: 'ledger', label: 'review comments' },
  { id: 'c-contract', from: 'tester', to: 'api', label: 'failing contract cases' },
  { id: 'c-replan', from: 'planner', to: 'release', label: 're-planned schedule' },
]

export const PHASES: Phase[] = [
  {
    id: 'ph1',
    name: 'Discovery',
    summary: 'Understand the current system and its load.',
    order: 1,
  },
  {
    id: 'ph2',
    name: 'Design',
    summary: 'Settle schemas, contracts and migration strategy.',
    order: 2,
  },
  {
    id: 'ph3',
    name: 'Implementation',
    summary: 'Build the event store, API and adapter.',
    order: 3,
  },
  {
    id: 'ph4',
    name: 'Verification',
    summary: 'Prove parity with contract and shadow tests.',
    order: 4,
  },
  {
    id: 'ph5',
    name: 'Rollout',
    summary: 'Shift traffic in stages and retire legacy paths.',
    order: 5,
  },
]

type CritSpec = [text: string, kind: 'automated' | 'manual', result: CriterionResult]

interface TaskSpec {
  id: string
  title: string
  description: string
  phaseId: string
  assigneeId: string
  status: TaskStatus
  priority: Priority
  dependsOn: string[]
  artifact: string
  progress: number
  plan: [start: number, end: number]
  actual?: [start: number, end?: number]
  attempts?: number
  blocked?: { kind: 'failure' | 'human' | 'external'; note: string; since: number }
  criteria: CritSpec[]
}

const P = 'passed' as const
const N = 'pending' as const

const TASK_SPECS: TaskSpec[] = [
  {
    id: 'T-101',
    title: 'Inventory billing code paths',
    phaseId: 'ph1',
    assigneeId: 'researcher',
    status: 'completed',
    priority: 'high',
    dependsOn: [],
    artifact: 'code-path-inventory.md',
    progress: 100,
    description: 'List every entry point that reads or writes billing data, with its owner.',
    plan: [0, 16],
    actual: [0, 15],
    attempts: 1,
    criteria: [
      ['Every billing entry point has an owner', 'automated', P],
      ['Planner confirms coverage', 'manual', P],
    ],
  },
  {
    id: 'T-102',
    title: 'Map data ownership across modules',
    phaseId: 'ph1',
    assigneeId: 'researcher',
    status: 'completed',
    priority: 'high',
    dependsOn: [],
    artifact: 'data-ownership-map.md',
    progress: 100,
    description: 'Show which module owns each table and which modules write to it.',
    plan: [0, 20],
    actual: [2, 22],
    attempts: 2,
    criteria: [
      ['Each table has one owning module', 'automated', P],
      ['Shared tables are flagged', 'automated', P],
    ],
  },
  {
    id: 'T-103',
    title: 'Collect production traffic baselines',
    phaseId: 'ph1',
    assigneeId: 'researcher',
    status: 'completed',
    priority: 'medium',
    dependsOn: [],
    artifact: 'traffic-baseline.csv',
    progress: 100,
    description: 'Measure daily, weekly and month-end volumes for invoices, payments and refunds.',
    plan: [4, 24],
    actual: [4, 21],
    attempts: 1,
    criteria: [
      ['Covers 90 days of traffic', 'automated', P],
      ['Month-end peaks reported separately', 'automated', P],
    ],
  },
  {
    id: 'T-104',
    title: 'Draft extraction plan and risk register',
    phaseId: 'ph1',
    assigneeId: 'planner',
    status: 'completed',
    priority: 'critical',
    dependsOn: ['T-101', 'T-102', 'T-103'],
    artifact: 'extraction-plan.md',
    progress: 100,
    description: 'Choose the migration approach, sequence the work and list the main risks.',
    plan: [24, 36],
    actual: [23, 34],
    attempts: 1,
    criteria: [
      ['Every task has validation criteria', 'automated', P],
      ['Ops lead accepts the cutover constraints', 'manual', P],
    ],
  },
  {
    id: 'T-201',
    title: 'Design event schema v3',
    phaseId: 'ph2',
    assigneeId: 'architect',
    status: 'completed',
    priority: 'critical',
    dependsOn: ['T-104'],
    artifact: 'event-schema-v3.json',
    progress: 100,
    description: 'One envelope for invoice, payment and refund events, with versioning rules.',
    plan: [36, 60],
    actual: [35, 62],
    attempts: 1,
    criteria: [
      ['Schema passes lint with no breaking changes', 'automated', P],
      ['All three event families covered', 'automated', P],
    ],
  },
  {
    id: 'T-202',
    title: 'Define dual-write and backfill strategy',
    phaseId: 'ph2',
    assigneeId: 'architect',
    status: 'completed',
    priority: 'critical',
    dependsOn: ['T-201'],
    artifact: 'dual-write-strategy.md',
    progress: 100,
    description: 'Specify ordering guarantees, failure handling and the rollback switch.',
    plan: [60, 76],
    actual: [62, 80],
    attempts: 1,
    criteria: [
      ['Rollback is a single flag change', 'automated', P],
      ['Ops lead approves the freeze window', 'manual', P],
    ],
  },
  {
    id: 'T-203',
    title: 'Specify billing-core API contract',
    phaseId: 'ph2',
    assigneeId: 'api',
    status: 'completed',
    priority: 'high',
    dependsOn: ['T-104', 'T-201'],
    artifact: 'billing-core.openapi.yaml',
    progress: 100,
    description: 'Write the OpenAPI contract that implementers and testers both work from.',
    plan: [48, 72],
    actual: [50, 70],
    attempts: 1,
    criteria: [
      ['Contract validates against OpenAPI 3.1', 'automated', P],
      ['Every endpoint has an example', 'automated', P],
    ],
  },
  {
    id: 'T-301',
    title: 'Implement ledger event store',
    phaseId: 'ph3',
    assigneeId: 'ledger',
    status: 'completed',
    priority: 'critical',
    dependsOn: ['T-201', 'T-202'],
    artifact: 'ledger-event-store',
    progress: 100,
    description: 'Append-only store with idempotent writes and per-account ordering.',
    plan: [76, 104],
    actual: [80, 112],
    attempts: 2,
    criteria: [
      ['Idempotency tests pass', 'automated', P],
      ['Ordering holds under concurrent writes', 'automated', P],
    ],
  },
  {
    id: 'T-302',
    title: 'Implement invoice projection service',
    phaseId: 'ph3',
    assigneeId: 'ledger',
    status: 'running',
    priority: 'high',
    dependsOn: ['T-301'],
    artifact: 'invoice-projection',
    progress: 58,
    description: 'Build read models for invoices from the event stream.',
    plan: [112, 140],
    actual: [113],
    attempts: 1,
    criteria: [
      ['Projection matches legacy totals on sampled invoices', 'automated', N],
      ['Rebuild from empty state succeeds', 'automated', N],
    ],
  },
  {
    id: 'T-303',
    title: 'Implement dual-write adapter in the monolith',
    phaseId: 'ph3',
    assigneeId: 'api',
    status: 'review',
    priority: 'critical',
    dependsOn: ['T-202', 'T-203'],
    artifact: 'dual-write-adapter',
    progress: 100,
    description: 'Write to legacy tables and the event store, with a runtime switch.',
    plan: [80, 120],
    actual: [84],
    attempts: 1,
    criteria: [
      ['Parity tests pass on 10k sampled invoices', 'automated', P],
      ['No writes lost under simulated failover', 'automated', P],
      ['Owner confirms rollback switch behaviour', 'manual', N],
    ],
  },
  {
    id: 'T-304',
    title: 'Implement billing-core REST endpoints',
    phaseId: 'ph3',
    assigneeId: 'api',
    status: 'running',
    priority: 'high',
    dependsOn: ['T-203', 'T-301'],
    artifact: 'billing-core-service',
    progress: 41,
    description: 'Serve the contract from the new service, backed by projections.',
    plan: [100, 132],
    actual: [112],
    attempts: 1,
    criteria: [
      ['All contract endpoints respond', 'automated', N],
      ['p95 latency within the agreed budget', 'automated', N],
    ],
  },
  {
    id: 'T-305',
    title: 'Backfill historical invoices',
    phaseId: 'ph3',
    assigneeId: 'ledger',
    status: 'backlog',
    priority: 'medium',
    dependsOn: ['T-302'],
    artifact: 'backfilled-history',
    progress: 0,
    description: 'Replay legacy history into the event store in small batches.',
    plan: [140, 170],
    criteria: [
      ['Row counts match legacy per account', 'automated', N],
      ['No lock timeouts during the run', 'automated', N],
    ],
  },
  {
    id: 'T-306',
    title: 'Migrate the refund flow',
    phaseId: 'ph3',
    assigneeId: 'api',
    status: 'backlog',
    priority: 'high',
    dependsOn: ['T-304', 'T-303'],
    artifact: 'refund-flow-migrated',
    progress: 0,
    description: 'Move refunds to billing-core behind the same rollback switch.',
    plan: [150, 180],
    criteria: [
      ['Refund parity tests pass', 'automated', N],
      ['Finance ops signs off on refund totals', 'manual', N],
    ],
  },
  {
    id: 'T-401',
    title: 'Write contract test suite',
    phaseId: 'ph4',
    assigneeId: 'tester',
    status: 'completed',
    priority: 'high',
    dependsOn: ['T-203'],
    artifact: 'contract-tests',
    progress: 100,
    description: 'Generate and hand-write tests for every endpoint in the contract.',
    plan: [72, 100],
    actual: [72, 96],
    attempts: 1,
    criteria: [
      ['Every endpoint has at least one test', 'automated', P],
      ['Error responses covered', 'automated', P],
    ],
  },
  {
    id: 'T-402',
    title: 'Run contract tests against billing-core',
    phaseId: 'ph4',
    assigneeId: 'tester',
    status: 'backlog',
    priority: 'high',
    dependsOn: ['T-304', 'T-401'],
    artifact: 'contract-test-report',
    progress: 0,
    description: 'Execute the suite against the new service and report failures.',
    plan: [132, 156],
    criteria: [
      ['All contract tests pass', 'automated', N],
      ['Flaky tests quarantined with a ticket', 'manual', N],
    ],
  },
  {
    id: 'T-403',
    title: 'Shadow-traffic comparison harness',
    phaseId: 'ph4',
    assigneeId: 'tester',
    status: 'blocked',
    priority: 'critical',
    dependsOn: ['T-103', 'T-301'],
    artifact: 'shadow-comparison-report',
    progress: 72,
    description: 'Replay production traffic against both paths and diff the results.',
    plan: [104, 130],
    actual: [120],
    attempts: 3,
    blocked: {
      kind: 'failure',
      note: 'Replay shows 12% of refund events differ on occurred_at after 3 attempts. Likely timestamp serialization in the dual-write adapter (T-303).',
      since: 138,
    },
    criteria: [
      ['Mismatch rate under 0.1%', 'automated', 'failed'],
      ['Diff report reviewed', 'manual', N],
    ],
  },
  {
    id: 'T-404',
    title: 'Security and PII review of event payloads',
    phaseId: 'ph4',
    assigneeId: 'reviewer',
    status: 'blocked',
    priority: 'high',
    dependsOn: ['T-201', 'T-301'],
    artifact: 'pii-review.md',
    progress: 40,
    description: 'Check that events carry no data the retention policy forbids.',
    plan: [116, 140],
    actual: [125],
    attempts: 1,
    blocked: {
      kind: 'human',
      note: 'Compliance decision needed: card-last4 appears in invoice.paid payloads. Tokenize it or drop it before the schema is final.',
      since: 144,
    },
    criteria: [
      ['No unapproved personal data in payloads', 'automated', N],
      ['Compliance owner signs off', 'manual', N],
    ],
  },
  {
    id: 'T-405',
    title: 'Code review of the ledger event store',
    phaseId: 'ph4',
    assigneeId: 'reviewer',
    status: 'completed',
    priority: 'medium',
    dependsOn: ['T-301'],
    artifact: 'review-ledger.md',
    progress: 100,
    description: 'Review T-301 for correctness, idempotency and failure handling.',
    plan: [104, 116],
    actual: [112, 120],
    attempts: 1,
    criteria: [
      ['All review comments resolved', 'automated', P],
      ['No blocking findings open', 'automated', P],
    ],
  },
  {
    id: 'T-107',
    title: 'Re-plan rollout schedule around the T-403 blocker',
    phaseId: 'ph4',
    assigneeId: 'planner',
    status: 'running',
    priority: 'high',
    dependsOn: ['T-104'],
    artifact: 'revised-schedule.md',
    progress: 35,
    description: 'Simulate schedule options if the mismatch fix takes one to three days.',
    plan: [140, 170],
    actual: [143],
    attempts: 1,
    criteria: [
      ['Critical path recomputed', 'automated', N],
      ['Ops lead reviews the revised dates', 'manual', N],
    ],
  },
  {
    id: 'T-501',
    title: 'Prepare canary rollout plan',
    phaseId: 'ph5',
    assigneeId: 'release',
    status: 'ready',
    priority: 'medium',
    dependsOn: ['T-104', 'T-202'],
    artifact: 'canary-plan.md',
    progress: 0,
    description: 'Define canary cohorts, health checks and automatic rollback thresholds.',
    plan: [130, 150],
    criteria: [
      ['Rollback thresholds defined for every health check', 'automated', N],
      ['Ops lead approves cohorts', 'manual', N],
    ],
  },
  {
    id: 'T-502',
    title: 'Canary at 5% of traffic with auto-rollback',
    phaseId: 'ph5',
    assigneeId: 'release',
    status: 'backlog',
    priority: 'critical',
    dependsOn: ['T-402', 'T-403', 'T-404', 'T-501'],
    artifact: 'canary-report',
    progress: 0,
    description: 'Send a small share of live traffic through billing-core and watch health checks.',
    plan: [170, 200],
    criteria: [
      ['No health check breached for 24 hours', 'automated', N],
      ['Finance ops confirms totals', 'manual', N],
    ],
  },
  {
    id: 'T-503',
    title: 'Progressive rollout to 100%',
    phaseId: 'ph5',
    assigneeId: 'release',
    status: 'backlog',
    priority: 'critical',
    dependsOn: ['T-502'],
    artifact: 'rollout-report',
    progress: 0,
    description: 'Raise traffic in stages, pausing at each gate.',
    plan: [200, 248],
    criteria: [
      ['Each stage holds for its soak time', 'automated', N],
      ['Rollback drill completed once', 'manual', N],
    ],
  },
  {
    id: 'T-504',
    title: 'Decommission legacy billing paths',
    phaseId: 'ph5',
    assigneeId: 'release',
    status: 'backlog',
    priority: 'low',
    dependsOn: ['T-503', 'T-306'],
    artifact: 'decommission-checklist',
    progress: 0,
    description: 'Remove dual-write and legacy writes once the new path is stable.',
    plan: [248, 280],
    criteria: [
      ['No traffic on legacy paths for 7 days', 'automated', N],
      ['Final sign-off recorded', 'manual', N],
    ],
  },
]

const MILESTONE_SPECS: {
  id: string
  name: string
  phaseId: string
  due: number
  dependsOn: string[]
}[] = [
  { id: 'M1', name: 'Extraction plan approved', phaseId: 'ph1', due: 36, dependsOn: ['T-104'] },
  { id: 'M2', name: 'Event schema frozen', phaseId: 'ph2', due: 80, dependsOn: ['T-201', 'T-202'] },
  {
    id: 'M3',
    name: 'Dual-write verified in shadow',
    phaseId: 'ph4',
    due: 148,
    dependsOn: ['T-303', 'T-403'],
  },
  {
    id: 'M4',
    name: 'Contract and PII gates green',
    phaseId: 'ph4',
    due: 170,
    dependsOn: ['T-402', 'T-404'],
  },
  { id: 'M5', name: 'Canary at 5%', phaseId: 'ph5', due: 200, dependsOn: ['T-502'] },
  { id: 'M6', name: 'Full rollout', phaseId: 'ph5', due: 248, dependsOn: ['T-503'] },
  { id: 'M7', name: 'Legacy decommissioned', phaseId: 'ph5', due: 280, dependsOn: ['T-504'] },
]

const TOOL_DETAILS: Record<string, string[]> = {
  'repo.search': [
    'Searched 1,240 files, 38 matches',
    'Searched billing/ for ledger writers, 12 matches',
  ],
  'sql.explain': [
    'Plan reviewed: index scan on ledger_entries',
    'Plan reviewed: no sequential scans',
  ],
  'metrics.query': ['Pulled 90 days of request counts', 'Pulled p95 latency by endpoint'],
  'docs.read': ['Read the finance close runbook', 'Read the retention policy summary'],
  'schema.lint': ['0 breaking changes, 2 warnings', '0 breaking changes, 0 warnings'],
  'diff.compare': ['Compared v2 and v3 envelopes', 'Compared refund payload variants'],
  'docs.write': ['Updated the migration notes', 'Wrote the versioning rules section'],
  'repo.edit': ['Edited 4 files', 'Edited 7 files, added 2 tests', 'Edited 3 files'],
  'test.run': [
    'Ran 212 tests, all passed',
    'Ran 96 tests, all passed',
    'Ran 148 tests, all passed',
  ],
  'db.migrate': [
    'Applied migration to the rehearsal database',
    'Rolled back and reapplied migration',
  ],
  'openapi.validate': ['Contract valid, 0 errors', 'Contract valid, 1 warning'],
  'replay.shadow': ['Replayed 50k requests in shadow mode', 'Replayed 20k refund requests'],
  'load.gen': ['Generated month-end load profile', 'Generated 3x median load'],
  'pii.scan': ['Scanned 14 payload types', 'Scanned 3 payload types, 1 finding'],
  'policy.check': ['Checked payloads against the retention policy', 'Checked logging fields'],
  'repo.diff': ['Reviewed a 640-line diff', 'Reviewed a 210-line diff'],
  'deploy.plan': ['Drafted the cohort schedule', 'Drafted rollback thresholds'],
  'flags.read': ['Read current rollout flags', 'Checked flag defaults'],
  'canary.simulate': [
    'Simulated a 5% canary against recorded traffic',
    'Simulated an automatic rollback',
  ],
  'plan.decompose': ['Split the objective into 5 phases', 'Recomputed task dependencies'],
  'deps.analyze': ['Critical path is 11.7 days', 'Found no dependency cycles'],
  'schedule.simulate': ['Simulated a 1-day slip on T-403', 'Simulated a 3-day slip on T-403'],
}

type RawEvent = Omit<ExecutionEvent, 'id'>

function buildCurrentEvents(base: number, runId: string, now: number): ExecutionEvent[] {
  const rng = mulberry32(7)
  const at = (h: number) => base + h * HOUR
  const out: RawEvent[] = []
  const agentTools = new Map(AGENTS.map((a) => [a.id, a.tools]))

  const pick = <T>(items: T[]) => items[Math.floor(rng() * items.length)]!

  for (const spec of TASK_SPECS) {
    if (!spec.actual) continue
    const start = spec.actual[0]
    const tools = agentTools.get(spec.assigneeId) ?? []
    // The window in which this task produced tool calls.
    let end: number
    if (spec.status === 'completed') end = spec.actual[1] ?? start + 4
    else if (spec.status === 'review') end = 139
    else if (spec.status === 'blocked') end = spec.blocked!.since - 1
    else end = RUN_HOURS_ELAPSED - 0.3

    out.push({
      at: at(start),
      runId,
      actorId: 'system',
      type: 'transition',
      status: 'success',
      title: `${spec.id} moved to Running`,
      detail: `Assigned to ${AGENTS.find((a) => a.id === spec.assigneeId)!.name}: ${spec.title}`,
      taskId: spec.id,
    })
    const calls = spec.status === 'completed' ? 3 : 3
    for (let i = 1; i <= calls; i++) {
      const tool = pick(tools)
      const t = start + ((end - start) * i) / (calls + 1) + rng() * 0.4
      out.push({
        at: at(t),
        runId,
        actorId: spec.assigneeId,
        type: 'tool_call',
        status: 'success',
        title: `${tool} on ${spec.id}`,
        detail: pick(TOOL_DETAILS[tool] ?? ['Completed']),
        taskId: spec.id,
        tool,
        tokens: Math.round(2000 + rng() * 12000),
        durationMs: Math.round(1500 + rng() * 38000),
      })
    }
    if (spec.status === 'completed') {
      const done = spec.actual[1]!
      spec.criteria.forEach(([text], i) => {
        out.push({
          at: at(done - 0.4 + i * 0.05),
          runId,
          actorId: spec.assigneeId,
          type: 'verification',
          status: 'success',
          title: `${spec.id} check passed: ${text}`,
          taskId: spec.id,
        })
      })
      out.push({
        at: at(done),
        runId,
        actorId: 'system',
        type: 'transition',
        status: 'success',
        title: `${spec.id} moved to Completed`,
        detail: `Delivered ${spec.artifact}`,
        taskId: spec.id,
      })
    }
  }

  // Review state for T-303.
  out.push(
    {
      at: at(139.6),
      runId,
      actorId: 'api',
      type: 'verification',
      status: 'success',
      title: 'T-303 check passed: Parity tests pass on 10k sampled invoices',
      taskId: 'T-303',
    },
    {
      at: at(139.8),
      runId,
      actorId: 'api',
      type: 'verification',
      status: 'success',
      title: 'T-303 check passed: No writes lost under simulated failover',
      taskId: 'T-303',
    },
    {
      at: at(140),
      runId,
      actorId: 'system',
      type: 'transition',
      status: 'success',
      title: 'T-303 moved to Review',
      detail: 'Automated checks passed. One manual criterion needs a person.',
      taskId: 'T-303',
    },
  )

  // Authored events: errors, retries, decisions, human interventions.
  out.push(
    {
      at: at(18),
      runId,
      actorId: 'researcher',
      type: 'error',
      status: 'failed',
      title: 'sql.explain timed out on ledger_entries (30s)',
      taskId: 'T-102',
      tool: 'sql.explain',
      detail: 'The planner query ran against the full table.',
    },
    {
      at: at(18.1),
      runId,
      actorId: 'researcher',
      type: 'retry',
      status: 'success',
      recovered: true,
      title: 'Retry 1 recovered T-102',
      taskId: 'T-102',
      tool: 'sql.explain',
      detail: 'Re-ran on a 1% sample; plan reviewed.',
    },
    {
      at: at(26),
      runId,
      actorId: 'human',
      type: 'intervention',
      status: 'info',
      title: 'You set the maximum freeze window to 15 minutes',
      taskId: 'T-104',
      detail: 'Answer to the planner’s question about acceptable downtime.',
    },
    {
      at: at(34),
      runId,
      actorId: 'planner',
      type: 'decision',
      status: 'success',
      title: 'Chose dual-write with CDC backfill over big-bang cutover',
      taskId: 'T-104',
      detail: 'Rollback must stay a flag flip and the freeze window is capped at 15 minutes.',
    },
    {
      at: at(50),
      runId,
      actorId: 'architect',
      type: 'decision',
      status: 'success',
      title: 'Use one event envelope for invoices, payments and refunds',
      taskId: 'T-201',
      detail: 'Refund-to-invoice ordering needs a shared partition key.',
    },
    {
      at: at(62),
      runId,
      actorId: 'human',
      type: 'intervention',
      status: 'success',
      title: 'You approved a freeze exception for refund.reason_code',
      taskId: 'T-202',
      detail: 'Additive field allowed after the schema freeze.',
    },
    {
      at: at(96),
      runId,
      actorId: 'ledger',
      type: 'error',
      status: 'failed',
      title: 'Lock timeout above 2s on ledger_entries during backfill rehearsal',
      taskId: 'T-301',
      tool: 'db.migrate',
    },
    {
      at: at(98),
      runId,
      actorId: 'ledger',
      type: 'retry',
      status: 'failed',
      recovered: false,
      title: 'Retry 1 failed for T-301',
      taskId: 'T-301',
      tool: 'db.migrate',
      detail: 'Same lock timeout with the original batch size.',
    },
    {
      at: at(99.5),
      runId,
      actorId: 'ledger',
      type: 'retry',
      status: 'success',
      recovered: true,
      title: 'Retry 2 recovered T-301',
      taskId: 'T-301',
      tool: 'db.migrate',
      detail: 'Batch size lowered to 5k rows.',
    },
    {
      at: at(121),
      runId,
      actorId: 'tester',
      type: 'error',
      status: 'failed',
      title: '12% of refund events differ on occurred_at',
      taskId: 'T-403',
      tool: 'replay.shadow',
    },
    {
      at: at(126),
      runId,
      actorId: 'tester',
      type: 'retry',
      status: 'failed',
      recovered: false,
      title: 'Retry 1 failed for T-403',
      taskId: 'T-403',
      tool: 'replay.shadow',
      detail: 'Mismatch rate unchanged after re-seeding the replay.',
    },
    {
      at: at(132),
      runId,
      actorId: 'tester',
      type: 'retry',
      status: 'failed',
      recovered: false,
      title: 'Retry 2 failed for T-403',
      taskId: 'T-403',
      tool: 'replay.shadow',
      detail: 'Same mismatch on a different traffic window.',
    },
    {
      at: at(138),
      runId,
      actorId: 'system',
      type: 'transition',
      status: 'warning',
      title: 'T-403 moved to Blocked',
      detail: 'Three attempts failed. Likely timestamp serialization in T-303.',
      taskId: 'T-403',
    },
    {
      at: at(143.5),
      runId,
      actorId: 'planner',
      type: 'decision',
      status: 'success',
      title: 'Started re-planning around the T-403 blocker',
      taskId: 'T-107',
      detail: 'Canary start slips while T-403 stays blocked.',
    },
    {
      at: at(144),
      runId,
      actorId: 'reviewer',
      type: 'action',
      status: 'warning',
      title: 'Requested a human decision on card-last4 retention',
      taskId: 'T-404',
      detail: 'Tokenize or drop before the schema is final.',
    },
    {
      at: at(144.1),
      runId,
      actorId: 'system',
      type: 'transition',
      status: 'warning',
      title: 'T-404 moved to Blocked',
      detail: 'Waiting on a compliance decision.',
      taskId: 'T-404',
    },
  )

  // Recent activity on the running tasks (the last few minutes of the run).
  const recent: [string, string, string, number][] = [
    ['ledger', 'T-302', 'repo.edit', 149.4],
    ['api', 'T-304', 'openapi.validate', 149.55],
    ['planner', 'T-107', 'schedule.simulate', 149.7],
    ['ledger', 'T-302', 'test.run', 149.8],
  ]
  for (const [actor, taskId, tool, h] of recent) {
    out.push({
      at: at(h),
      runId,
      actorId: actor,
      type: 'tool_call',
      status: 'success',
      title: `${tool} on ${taskId}`,
      detail: pick(TOOL_DETAILS[tool] ?? ['Completed']),
      taskId,
      tool,
      tokens: Math.round(2000 + rng() * 9000),
      durationMs: Math.round(2000 + rng() * 20000),
    })
  }

  return out
    .filter((e) => e.at <= now)
    .sort((a, b) => a.at - b.at)
    .map((e, i) => ({ ...e, id: `evt-${String(i + 1).padStart(4, '0')}` }))
}

function buildPastRuns(now: number): { runs: Run[]; events: ExecutionEvent[] } {
  const runs: Run[] = [
    {
      id: 'run-04',
      label: 'Baseline',
      config: 'Single implementer, no persistent memory',
      startedAt: now - 62 * DAY,
      endedAt: now - 62 * DAY + 9.4 * DAY,
      outcome: 'failed',
      note: 'Stopped on day 9 after repeated rework of decisions that were already made.',
      aggregates: {
        tasksTotal: 21,
        tasksCompleted: 14,
        stepsTotal: 412,
        stepsSucceeded: 331,
        retries: 58,
        recovered: 31,
        interventions: 14,
        durationMs: 9.4 * DAY,
        tokens: 9_800_000,
      },
    },
    {
      id: 'run-05',
      label: 'Persistent memory',
      config: 'Single implementer, persistent memory on',
      startedAt: now - 45 * DAY,
      endedAt: now - 45 * DAY + 13.6 * DAY,
      outcome: 'partial',
      note: 'Finished 20 of 23 tasks. Rollout stages were deferred to a later run.',
      aggregates: {
        tasksTotal: 23,
        tasksCompleted: 20,
        stepsTotal: 538,
        stepsSucceeded: 462,
        retries: 47,
        recovered: 36,
        interventions: 9,
        durationMs: 13.6 * DAY,
        tokens: 11_200_000,
      },
    },
    {
      id: 'run-06',
      label: 'Review gate',
      config: 'Persistent memory and a human review gate',
      startedAt: now - 27 * DAY,
      endedAt: now - 27 * DAY + 12.4 * DAY,
      outcome: 'succeeded',
      note: 'All tasks completed. Legacy paths decommissioned.',
      aggregates: {
        tasksTotal: 23,
        tasksCompleted: 23,
        stepsTotal: 571,
        stepsSucceeded: 514,
        retries: 39,
        recovered: 33,
        interventions: 6,
        durationMs: 12.4 * DAY,
        tokens: 11_900_000,
      },
    },
  ]
  const e = (
    runId: string,
    startedAt: number,
    d: number,
    p: Omit<RawEvent, 'at' | 'runId'>,
    n: number,
  ): ExecutionEvent => ({
    ...p,
    id: `hist-${runId}-${n}`,
    at: startedAt + d * DAY,
    runId,
  })
  const events: ExecutionEvent[] = [
    e(
      'run-04',
      runs[0]!.startedAt,
      0,
      {
        actorId: 'planner',
        type: 'action',
        status: 'success',
        title: 'Run started with the baseline configuration',
      },
      1,
    ),
    e(
      'run-04',
      runs[0]!.startedAt,
      4.1,
      {
        actorId: 'ledger',
        type: 'error',
        status: 'failed',
        title: 'Reimplemented the idempotency key scheme a second time',
        detail: 'The earlier decision was not available to the agent.',
      },
      2,
    ),
    e(
      'run-04',
      runs[0]!.startedAt,
      7.3,
      {
        actorId: 'human',
        type: 'intervention',
        status: 'warning',
        title: 'You paused the run after repeated rework',
      },
      3,
    ),
    e(
      'run-04',
      runs[0]!.startedAt,
      9.4,
      {
        actorId: 'system',
        type: 'transition',
        status: 'failed',
        title: 'Run stopped with 14 of 21 tasks completed',
      },
      4,
    ),
    e(
      'run-05',
      runs[1]!.startedAt,
      0,
      {
        actorId: 'planner',
        type: 'action',
        status: 'success',
        title: 'Run started with persistent memory enabled',
      },
      1,
    ),
    e(
      'run-05',
      runs[1]!.startedAt,
      6.2,
      {
        actorId: 'tester',
        type: 'error',
        status: 'failed',
        title: 'Contract tests failed on refund payloads',
      },
      2,
    ),
    e(
      'run-05',
      runs[1]!.startedAt,
      6.5,
      {
        actorId: 'tester',
        type: 'retry',
        status: 'success',
        recovered: true,
        title: 'Retry recovered after the schema was corrected',
      },
      3,
    ),
    e(
      'run-05',
      runs[1]!.startedAt,
      13.6,
      {
        actorId: 'system',
        type: 'transition',
        status: 'warning',
        title: 'Run ended with 20 of 23 tasks completed',
      },
      4,
    ),
    e(
      'run-06',
      runs[2]!.startedAt,
      0,
      {
        actorId: 'planner',
        type: 'action',
        status: 'success',
        title: 'Run started with persistent memory and a review gate',
      },
      1,
    ),
    e(
      'run-06',
      runs[2]!.startedAt,
      5.8,
      {
        actorId: 'human',
        type: 'intervention',
        status: 'success',
        title: 'You approved the schema freeze',
      },
      2,
    ),
    e(
      'run-06',
      runs[2]!.startedAt,
      10.2,
      {
        actorId: 'release',
        type: 'verification',
        status: 'success',
        title: 'Canary held for 24 hours with no health check breached',
      },
      3,
    ),
    e(
      'run-06',
      runs[2]!.startedAt,
      12.4,
      {
        actorId: 'system',
        type: 'transition',
        status: 'success',
        title: 'Run completed with 23 of 23 tasks completed',
      },
      4,
    ),
  ]
  return { runs, events }
}

function buildMemories(base: number, runId: string): MemoryItem[] {
  const at = (h: number) => base + h * HOUR
  const m = (
    id: string,
    h: number,
    accessedH: number,
    accessCount: number,
    p: Omit<MemoryItem, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount' | 'runId'>,
  ): MemoryItem => ({
    id,
    createdAt: at(h),
    lastAccessedAt: at(accessedH),
    accessCount,
    runId,
    ...p,
  })
  return [
    m('M-01', 20, 143, 9, {
      kind: 'fact',
      origin: 'stored',
      title: 'Billing handles about 4.2M invoices a month',
      body: 'Average over the last 90 days, across all customer tiers.',
      provenance: {
        sourceType: 'tool_output',
        source: 'metrics.query: invoices_created, 90d',
        agentId: 'researcher',
      },
      taskIds: ['T-103'],
      links: [{ to: 'M-02', relation: 'relates' }],
      tags: ['volume', 'baseline'],
    }),
    m('M-02', 21, 147, 7, {
      kind: 'observation',
      origin: 'stored',
      title: 'Month-end traffic peaks at about 3x the daily median',
      body: 'Peaks last roughly 6 hours around the finance close.',
      provenance: {
        sourceType: 'tool_output',
        source: 'metrics.query: requests_per_minute, 90d',
        agentId: 'researcher',
      },
      taskIds: ['T-103'],
      links: [{ to: 'M-01', relation: 'relates' }],
      tags: ['volume', 'peak'],
    }),
    m('M-03', 24, 140, 3, {
      kind: 'fact',
      origin: 'inferred',
      title: 'Month-end write rate likely stays under 600 events a second',
      body: 'Scaled from monthly volume and the observed peak factor. Not yet confirmed by a load test.',
      confidence: 0.64,
      derivedFrom: ['M-01', 'M-02'],
      provenance: { sourceType: 'agent', source: 'Planner estimate', agentId: 'planner' },
      taskIds: ['T-104'],
      links: [
        { to: 'M-01', relation: 'derived_from' },
        { to: 'M-02', relation: 'derived_from' },
      ],
      tags: ['capacity'],
    }),
    m('M-04', 22, 128, 6, {
      kind: 'fact',
      origin: 'stored',
      title: 'Invoices, payments and refunds share the ledger_entries table',
      body: 'All three modules write to one table with a type column.',
      provenance: {
        sourceType: 'document',
        source: 'billing/models/ledger.py',
        agentId: 'researcher',
      },
      taskIds: ['T-102'],
      links: [{ to: 'M-05', relation: 'relates' }],
      tags: ['data model'],
    }),
    m('M-05', 15, 126, 5, {
      kind: 'observation',
      origin: 'stored',
      title: 'Refunds write to ledger_entries from three code paths, one undocumented',
      body: 'The undocumented path is a nightly reconciliation job.',
      provenance: {
        sourceType: 'tool_output',
        source: 'repo.search: ledger_entries writers',
        agentId: 'researcher',
      },
      taskIds: ['T-101'],
      links: [{ to: 'M-04', relation: 'relates' }],
      tags: ['refunds', 'risk'],
    }),
    m('M-06', 34, 145, 11, {
      kind: 'decision',
      origin: 'stored',
      title: 'Use dual-write with CDC backfill, not a big-bang cutover',
      body: 'Write to the legacy tables and the event store together, then backfill history from change data capture.',
      rationale:
        'Rollback has to remain a flag flip, and finance ops will not accept a freeze window longer than 15 minutes.',
      provenance: {
        sourceType: 'agent',
        source: 'Planner decision, extraction plan',
        agentId: 'planner',
      },
      taskIds: ['T-104', 'T-202'],
      links: [
        { to: 'M-07', relation: 'supports' },
        { to: 'M-02', relation: 'relates' },
      ],
      tags: ['strategy'],
    }),
    m('M-07', 26, 144, 8, {
      kind: 'fact',
      origin: 'stored',
      title: 'Finance ops rejects any freeze window longer than 15 minutes',
      body: 'Stated by the operations lead during planning.',
      provenance: { sourceType: 'human', source: 'Operations lead, planning answer' },
      taskIds: ['T-104'],
      links: [{ to: 'M-06', relation: 'supports' }],
      tags: ['constraint'],
    }),
    m('M-08', 50, 120, 6, {
      kind: 'decision',
      origin: 'stored',
      title: 'Use one event envelope for invoices, payments and refunds',
      body: 'A shared envelope with a type field and a version field.',
      rationale:
        'Refund-to-invoice ordering needs a shared partition key, and consumers only version once.',
      provenance: {
        sourceType: 'agent',
        source: 'Schema Architect decision, schema v3',
        agentId: 'architect',
      },
      taskIds: ['T-201'],
      links: [
        { to: 'M-18', relation: 'supersedes' },
        { to: 'M-04', relation: 'relates' },
      ],
      tags: ['schema'],
    }),
    m('M-09', 62, 118, 4, {
      kind: 'decision',
      origin: 'stored',
      title: 'Allow an additive refund.reason_code after the schema freeze',
      body: 'Optional field only. No existing field may change.',
      rationale:
        'Finance needs a reason on each refund for reporting, and an optional field keeps consumers compatible.',
      provenance: { sourceType: 'human', source: 'Approved in the task inspector' },
      taskIds: ['T-202'],
      links: [{ to: 'M-08', relation: 'relates' }],
      tags: ['schema', 'exception'],
    }),
    m('M-10', 96, 130, 4, {
      kind: 'observation',
      origin: 'stored',
      title: 'Lock timeouts above 2s on ledger_entries during backfill rehearsal',
      body: 'Seen with batches of 20k rows or more on the rehearsal database.',
      provenance: {
        sourceType: 'tool_output',
        source: 'db.migrate: rehearsal run 3',
        agentId: 'ledger',
      },
      taskIds: ['T-301'],
      links: [{ to: 'M-11', relation: 'supports' }],
      tags: ['backfill', 'performance'],
    }),
    m('M-11', 99, 131, 5, {
      kind: 'fact',
      origin: 'inferred',
      title: 'Backfill should run in batches of 5k rows or fewer',
      body: 'Smaller batches avoided the lock timeouts in the rehearsal. Production tables are larger.',
      confidence: 0.78,
      derivedFrom: ['M-10'],
      provenance: { sourceType: 'agent', source: 'Ledger Engineer inference', agentId: 'ledger' },
      taskIds: ['T-301', 'T-305'],
      links: [{ to: 'M-10', relation: 'derived_from' }],
      tags: ['backfill'],
    }),
    m('M-12', 121, 148, 6, {
      kind: 'observation',
      origin: 'stored',
      title: '12% of refund events differ on occurred_at in shadow replay',
      body: 'Other fields match. The difference is a constant offset of one hour on most mismatches.',
      provenance: {
        sourceType: 'tool_output',
        source: 'replay.shadow: refund window A',
        agentId: 'tester',
      },
      taskIds: ['T-403'],
      links: [{ to: 'M-13', relation: 'supports' }],
      tags: ['shadow', 'refunds'],
    }),
    m('M-13', 127, 148, 5, {
      kind: 'fact',
      origin: 'inferred',
      title: 'The mismatch is likely timezone-naive serialization in the adapter',
      body: 'The one-hour offset matches the legacy server zone. Not yet reproduced in a unit test.',
      confidence: 0.71,
      derivedFrom: ['M-12', 'M-14'],
      provenance: { sourceType: 'agent', source: 'Test Engineer inference', agentId: 'tester' },
      taskIds: ['T-403', 'T-303'],
      links: [
        { to: 'M-12', relation: 'derived_from' },
        { to: 'M-14', relation: 'derived_from' },
      ],
      tags: ['shadow', 'hypothesis'],
    }),
    m('M-14', 12, 147, 4, {
      kind: 'fact',
      origin: 'stored',
      title: 'The monolith stores occurred_at in local server time (UTC+1)',
      body: 'Found while mapping code paths. The event store expects UTC.',
      provenance: {
        sourceType: 'document',
        source: 'billing/ledger.py:212',
        agentId: 'researcher',
      },
      taskIds: ['T-101'],
      links: [{ to: 'M-13', relation: 'supports' }],
      tags: ['time', 'risk'],
    }),
    m('M-15', 96, 110, 2, {
      kind: 'observation',
      origin: 'stored',
      title: 'Contract tests pass 118 of 118 against schema v3',
      body: 'Run before the endpoints existed, using the mock server generated from the contract.',
      provenance: {
        sourceType: 'tool_output',
        source: 'test.run: contract suite',
        agentId: 'tester',
      },
      taskIds: ['T-401'],
      links: [{ to: 'M-08', relation: 'relates' }],
      tags: ['tests'],
    }),
    m('M-16', 130, 146, 3, {
      kind: 'fact',
      origin: 'stored',
      title: 'card-last4 appears in invoice.paid payloads',
      body: 'Present in all payloads for card payments since schema v2.',
      provenance: {
        sourceType: 'tool_output',
        source: 'pii.scan: invoice.paid',
        agentId: 'reviewer',
      },
      taskIds: ['T-404'],
      links: [{ to: 'M-17', relation: 'supports' }],
      tags: ['pii'],
    }),
    m('M-17', 131, 146, 3, {
      kind: 'fact',
      origin: 'inferred',
      title: 'Retaining card-last4 in events probably needs tokenization',
      body: 'The retention policy summary limits card data in long-lived stores. A person has not confirmed this reading.',
      confidence: 0.55,
      derivedFrom: ['M-16'],
      provenance: { sourceType: 'agent', source: 'Reviewer inference', agentId: 'reviewer' },
      taskIds: ['T-404'],
      links: [{ to: 'M-16', relation: 'derived_from' }],
      tags: ['pii', 'policy'],
    }),
    m('M-18', 30, 110, 2, {
      kind: 'decision',
      origin: 'stored',
      title: 'Original plan: a single billing.events topic with per-type consumers',
      body: 'Replaced after the ordering analysis for refunds.',
      rationale: 'Chosen early for simplicity. Superseded once ordering requirements were clear.',
      provenance: {
        sourceType: 'agent',
        source: 'Planner draft, extraction plan v1',
        agentId: 'planner',
      },
      taskIds: ['T-104'],
      links: [],
      tags: ['schema', 'superseded'],
    }),
    m('M-19', 144, 149, 2, {
      kind: 'observation',
      origin: 'inferred',
      title: 'Canary start slips about two days if T-403 stays blocked',
      body: 'Estimated from the revised critical path. Depends on how long the mismatch fix takes.',
      confidence: 0.6,
      derivedFrom: ['M-12', 'M-13'],
      provenance: {
        sourceType: 'agent',
        source: 'Planner schedule simulation',
        agentId: 'planner',
      },
      taskIds: ['T-107', 'T-403'],
      links: [
        { to: 'M-12', relation: 'derived_from' },
        { to: 'M-13', relation: 'derived_from' },
      ],
      tags: ['schedule'],
    }),
  ]
}

export function createSeedWorkspace(now: number): Workspace {
  const base = now - RUN_HOURS_ELAPSED * HOUR
  const at = (h: number) => base + h * HOUR
  const runId = 'run-07'

  const tasks: Task[] = TASK_SPECS.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    phaseId: s.phaseId,
    assigneeId: s.assigneeId,
    status: s.status,
    priority: s.priority,
    dependsOn: s.dependsOn,
    artifact: s.artifact,
    progress: s.progress,
    plannedStart: at(s.plan[0]),
    plannedEnd: at(s.plan[1]),
    actualStart: s.actual ? at(s.actual[0]) : undefined,
    actualEnd: s.actual?.[1] !== undefined ? at(s.actual[1]) : undefined,
    attempts: s.attempts ?? 0,
    blocked: s.blocked ? { ...s.blocked, since: at(s.blocked.since) } : undefined,
    validation: s.criteria.map(
      ([text, kind, result], i): ValidationCriterion => ({
        id: `${s.id}-c${i + 1}`,
        text,
        kind,
        result,
      }),
    ),
  }))

  const milestones: Milestone[] = MILESTONE_SPECS.map((m) => ({ ...m, due: at(m.due) }))
  const past = buildPastRuns(now)
  const currentRun: Run = {
    id: runId,
    label: 'Parallel implementers',
    config: 'Persistent memory, review gate and two parallel implementers',
    startedAt: base,
    outcome: 'in_progress',
    note: 'Day 6 of a planned 12. Two tasks are blocked and need attention.',
  }

  return {
    project: {
      id: 'billing-extraction',
      name: 'Billing extraction',
      objective:
        'Move billing from the monolith to an event-driven service with no customer-visible downtime and a rollback that is a single flag change.',
      currentRunId: runId,
    },
    agents: AGENTS,
    phases: PHASES,
    milestones,
    tasks,
    events: [...past.events, ...buildCurrentEvents(base, runId, now)].sort((a, b) => a.at - b.at),
    memories: buildMemories(base, runId),
    runs: [...past.runs, currentRun],
    now,
  }
}
