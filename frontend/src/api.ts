// Talks to the Python backend (server.py). The backend owns all state; this class fetches
// snapshots, follows the live stream and sends commands.
import { getCredentials } from './credentials.ts'
import type { Workspace } from './types.ts'

export interface CommandResult {
  error?: string
}

export interface ReviewInput {
  /** Local mode: a file in the backend's project folder. */
  file?: string
  /** Public mode: the code itself and a file name to show. */
  code?: string
  name?: string
}

const UNREACHABLE = 'Could not reach the review server. Check that it is running and try again.'
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

export class Api {
  /** Local mode reads files from the server's project; public mode takes uploaded code and the
   * visitor's own Hugging Face key. */
  readonly submit: 'path' | 'upload'
  readonly address: string
  private listeners = new Set<(ws: Workspace) => void>()
  private connection = new Set<(connected: boolean) => void>()
  private stream: EventSource | undefined

  /** `base` is '' for the same origin, or e.g. 'http://127.0.0.1:8787'. */
  constructor(
    private readonly base: string,
    readonly mode: 'local' | 'public' = 'local',
  ) {
    this.submit = mode === 'public' ? 'upload' : 'path'
    this.address = base || location.origin
  }

  private url(path: string): string {
    return this.mode === 'public'
      ? `${this.base}${path}${path.includes('?') ? '&' : '?'}s=${sessionId()}`
      : this.base + path
  }

  /** The key never travels over plain http, except to a server on this computer. */
  private keyAllowed(): boolean {
    const target = new URL(this.address, location.href)
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

  private async command(path: string, payload: unknown = {}): Promise<CommandResult> {
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
    this.open()
    return ws
  }

  /** Server-sent events push a full snapshot on every change; the browser reconnects itself. */
  private open() {
    if (this.stream) return
    const es = new EventSource(this.url('/api/stream'))
    es.onmessage = (ev) => {
      const ws = JSON.parse(ev.data) as Workspace
      for (const l of this.listeners) l(ws)
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

  approve(agent: string): Promise<CommandResult> {
    return this.command(`/api/agents/${encodeURIComponent(agent)}/approve`)
  }

  rerun(agent: string): Promise<CommandResult> {
    return this.command(`/api/agents/${encodeURIComponent(agent)}/rerun`)
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
}

/** Find the backend: `?api=`, then the address set at build time, then this page's server. */
export async function connect(): Promise<Api> {
  const q = new URLSearchParams(location.search)
  const base = (q.get('api') ?? __HORIZON_API_URL__).replace(/\/+$/, '')
  let res: Response
  try {
    res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) })
  } catch {
    throw new Error(
      `No review server answered at ${base || location.origin}. Start it with \`python server.py\`, or open this page with ?api=<server address>.`,
    )
  }
  const body = (await res.json().catch(() => ({}))) as { app?: string; mode?: 'local' | 'public' }
  if (body.app !== 'horizon-code-review') {
    throw new Error(`${base || location.origin} is not a code review server.`)
  }
  return new Api(base, body.mode ?? 'local')
}
