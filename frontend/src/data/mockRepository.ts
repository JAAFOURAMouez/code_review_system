// In-browser demonstration repository: seeded sample data plus a simulator.
// It never talks to a network and it does not run agents.
import { HUMAN_ID, applyTransition, setCriterionResult } from '../domain/rules.ts'
import { createSeedWorkspace, mulberry32 } from '../domain/seed.ts'
import { simulationStep } from '../domain/simulator.ts'
import type { CriterionResult, Workspace } from '../domain/types.ts'
import type {
  CommandResult,
  HorizonRepository,
  SimulationConfig,
  TransitionRequest,
} from './repository.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface MockRepositoryOptions {
  /** Artificial latency for the first load, so loading states are real. */
  latencyMs?: number
  /** Reject the first load, to exercise the error state (`?fail=1`). */
  failFirstLoad?: boolean
  clock?: () => number
}

export class MockRepository implements HorizonRepository {
  readonly kind = 'demo' as const
  readonly label = 'Demo data (in this browser)'
  private ws: Workspace | undefined
  private listeners = new Set<(ws: Workspace) => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private rng = mulberry32(Date.now() & 0xffff)
  private sim: SimulationConfig = { enabled: true, intervalMs: 3500, failureRate: 0.05 }
  private failNext: boolean
  private clock: () => number
  private latency: number

  constructor(opts: MockRepositoryOptions = {}) {
    this.failNext = !!opts.failFirstLoad
    this.latency = opts.latencyMs ?? 450
    this.clock = opts.clock ?? Date.now
  }

  async load(): Promise<Workspace> {
    await wait(this.latency)
    if (this.failNext) {
      this.failNext = false
      throw new Error('Could not reach the demo data source. Check the connection and try again.')
    }
    this.ws = createSeedWorkspace(this.clock())
    this.restartTimer()
    return this.ws
  }

  subscribe(listener: (ws: Workspace) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  configureSimulation(config: SimulationConfig): void {
    this.sim = config
    this.restartTimer()
  }

  async transitionTask(req: TransitionRequest): Promise<CommandResult> {
    if (!this.ws) return { error: 'The workspace has not loaded yet.' }
    const result = applyTransition({ ...this.ws, now: this.clock() }, req.taskId, req.to, {
      actorId: HUMAN_ID,
      note: req.note,
      blockKind: req.blockKind,
    })
    if (result.error) return { error: result.error }
    this.publish(result.ws)
    return {}
  }

  async setCriterion(
    taskId: string,
    criterionId: string,
    result: CriterionResult,
  ): Promise<CommandResult> {
    if (!this.ws) return { error: 'The workspace has not loaded yet.' }
    this.publish(
      setCriterionResult({ ...this.ws, now: this.clock() }, taskId, criterionId, result, HUMAN_ID),
    )
    return {}
  }

  async reset(): Promise<Workspace> {
    this.ws = createSeedWorkspace(this.clock())
    this.publish(this.ws)
    return this.ws
  }

  private publish(ws: Workspace) {
    this.ws = ws
    for (const l of this.listeners) l(ws)
  }

  private restartTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (!this.sim.enabled || !this.ws) return
    this.timer = setInterval(() => {
      if (!this.ws) return
      this.publish(
        simulationStep(this.ws, this.clock(), this.rng, { failureRate: this.sim.failureRate }),
      )
    }, this.sim.intervalMs)
  }
}
