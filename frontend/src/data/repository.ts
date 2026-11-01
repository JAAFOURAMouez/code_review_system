// The only seam between the UI and wherever the data lives.
//
// The interface is intentionally small. To connect a real orchestration
// backend, implement `HorizonRepository` (REST/WebSocket/SSE) and pass it to
// `createStore` in `src/main.tsx`. Nothing in `views/`, `viz/` or `layout/`
// imports a concrete repository.
import type { CriterionResult, TaskStatus, Workspace } from '../domain/types.ts'

export interface CommandResult {
  error?: string
}

export interface TransitionRequest {
  taskId: string
  to: TaskStatus
  note?: string
  blockKind?: 'failure' | 'human' | 'external'
}

export interface ReviewInput {
  /** `path` mode: a file in the backend's project folder. */
  file?: string
  /** `upload` mode: the code itself and a file name to show. */
  code?: string
  name?: string
}

export interface SimulationConfig {
  enabled: boolean
  intervalMs: number
  failureRate: number
}

export interface HorizonRepository {
  /** `demo` repositories serve sample data and simulate activity. */
  readonly kind: 'demo' | 'live'
  readonly label: string
  load(): Promise<Workspace>
  /** Receive a fresh snapshot whenever anything changes. Returns an unsubscribe function. */
  subscribe(listener: (ws: Workspace) => void): () => void
  transitionTask(req: TransitionRequest): Promise<CommandResult>
  setCriterion(taskId: string, criterionId: string, result: CriterionResult): Promise<CommandResult>
  reset(): Promise<Workspace>
  /** Demo repositories only: control the simulated activity. */
  configureSimulation?(config: SimulationConfig): void
  /**
   * Live repositories only. `path`: the backend reads files from its own project folder.
   * `upload`: the visitor sends code and brings their own model key (public deployments).
   */
  readonly submit?: 'path' | 'upload'
  listFiles?(): Promise<string[]>
  startRun?(input: ReviewInput): Promise<CommandResult>
  /** Upload deployments: forget this browser's session and start a new, empty one. */
  resetSession?(): void
  /** Live repositories only: called when the connection to the backend is lost or restored. */
  onConnection?(listener: (connected: boolean) => void): () => void
}
