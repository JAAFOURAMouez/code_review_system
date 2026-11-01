// Live repository: talks to the Python backend (`server.py` in the code-review project).
// The backend owns all state; this class only fetches snapshots and sends commands.
import { getCredentials } from '../state/credentials.ts'
import type { CriterionResult, Workspace } from '../domain/types.ts'
import type {
  CommandResult,
  HorizonRepository,
  ReviewInput,
  TransitionRequest,
} from './repository.ts'

const UNREACHABLE =
  'Could not reach the Horizon server. Check that it is still running and try again.'
const SESSION_KEY = 'horizon.session.v1'
let memorySession: string | undefined

function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function sessionId(): string {
  try {
    let id = localStorage.getItem(SESSION_KEY)
    if (!id) {
      id = newSessionId()
      localStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    return (memorySession ??= newSessionId())
  }
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

export class HttpRepository implements HorizonRepository {
  readonly kind = 'live' as const
  readonly label: string
  readonly submit: 'path' | 'upload'
  private listeners = new Set<(ws: Workspace) => void>()
  private connection = new Set<(connected: boolean) => void>()
  private stream: EventSource | undefined
  private last: Workspace | undefined

  /**
   * `base` is '' for the same origin, or e.g. 'http://127.0.0.1:8787'.
   * `mode` comes from the backend's /api/health: `public` backends separate visitors by session.
   */
  constructor(
    private readonly base: string,
    private readonly mode: 'local' | 'public' = 'local',
  ) {
    this.label = `Live · ${base || location.origin}`
    this.submit = mode === 'public' ? 'upload' : 'path'
  }

  private url(path: string): string {
    return this.mode === 'public'
      ? `${this.base}${path}${path.includes('?') ? '&' : '?'}s=${sessionId()}`
      : this.base + path
  }

  /** The key must never travel over plain http, except to a server on this computer. */
  private keyAllowed(): boolean {
    const target = new URL(this.base || location.origin, location.href)
    return target.protocol === 'https:' || isLocalHost(target.hostname)
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await fetch(this.url(path), init)
    } catch {
      throw new Error(UNREACHABLE)
    }
    const body = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok && !('error' in body)) throw new Error(`The server answered ${res.status}.`)
    return body
  }

  private async command(path: string, payload: unknown): Promise<CommandResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.mode === 'public') {
      const { key } = getCredentials()
      if (key) {
        if (!this.keyAllowed()) {
          return { error: 'Your key is only sent over HTTPS. Open this site with https://.' }
        }
        headers['X-HF-Token'] = key
      }
    }
    try {
      const res = await this.request<CommandResult>(path, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
      return res.error ? { error: res.error } : {}
    } catch (e) {
      return { error: e instanceof Error ? e.message : UNREACHABLE }
    }
  }

  async load(): Promise<Workspace> {
    const ws = await this.request<Workspace>('/api/workspace')
    this.last = ws
    this.open()
    return ws
  }

  /** Server-sent events push a full snapshot on every change; the browser reconnects itself. */
  private open() {
    if (this.stream) return
    const es = new EventSource(this.url('/api/stream'))
    es.onmessage = (ev) => {
      this.last = JSON.parse(ev.data) as Workspace
      for (const l of this.listeners) l(this.last)
    }
    es.onopen = () => this.connection.forEach((l) => l(true))
    es.onerror = () => this.connection.forEach((l) => l(false))
    this.stream = es
  }

  subscribe(listener: (ws: Workspace) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onConnection(listener: (connected: boolean) => void): () => void {
    this.connection.add(listener)
    return () => this.connection.delete(listener)
  }

  transitionTask(req: TransitionRequest): Promise<CommandResult> {
    return this.command(`/api/tasks/${encodeURIComponent(req.taskId)}/transition`, {
      to: req.to,
      note: req.note,
    })
  }

  setCriterion(taskId: string, criterionId: string, result: CriterionResult) {
    return this.command(
      `/api/tasks/${encodeURIComponent(taskId)}/criteria/${encodeURIComponent(criterionId)}`,
      { result },
    )
  }

  async listFiles(): Promise<string[]> {
    return (await this.request<{ files: string[] }>('/api/files')).files
  }

  startRun(input: ReviewInput): Promise<CommandResult> {
    if (this.mode === 'public') {
      return this.command('/api/runs', {
        name: input.name,
        code: input.code,
        model: getCredentials().model || undefined,
      })
    }
    return this.command('/api/runs', { file: input.file })
  }

  /** Forget this browser's session. The server deletes the old one after a day of inactivity. */
  resetSession(): void {
    this.stream?.close()
    this.stream = undefined
    try {
      localStorage.removeItem(SESSION_KEY)
    } catch {
      // ignore
    }
    memorySession = undefined
  }

  /** Live data cannot be reset from the browser; stored runs belong to the project. */
  async reset(): Promise<Workspace> {
    return this.last ?? this.load()
  }
}
