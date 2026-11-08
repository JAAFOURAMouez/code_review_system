// Application store: the backend's latest snapshot plus a little app state (connection,
// saved key, toasts). Selection lives in the URL (see router.ts).
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Api, ReviewInput } from '../api.ts'
import {
  clearCredentials,
  getCredentials,
  looksLikeKey,
  looksLikeModel,
  saveCredentials,
} from '../credentials.ts'
import type { Workspace } from '../types.ts'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
}

export interface AppState {
  status: 'loading' | 'ready' | 'error'
  error?: string
  ws?: Workspace
  /** The server's address. */
  address: string
  /** `upload`: visitors send code and bring their own model key (public deployments). */
  submitMode: 'path' | 'upload'
  /** A model key is saved in this browser (upload mode). */
  hasKey: boolean
  /** False while the server cannot be reached. */
  connected: boolean
  /** Server clock minus this browser's clock, from the latest snapshot. */
  clockOffset: number
  toasts: Toast[]
}

type Listener = () => void

export class AppStore {
  private state: AppState = {
    status: 'loading',
    address: '',
    submitMode: 'path',
    hasKey: false,
    connected: true,
    clockOffset: 0,
    toasts: [],
  }
  private listeners = new Set<Listener>()
  private api: Api | undefined
  private unsubscribe: (() => void) | undefined
  private toastId = 1

  getState = (): AppState => this.state

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  fail(message: string) {
    this.set({ status: 'error', error: message })
  }

  async init(api: Api): Promise<void> {
    this.api = api
    this.set({
      address: api.address,
      submitMode: api.submit,
      hasKey: !!getCredentials().key,
    })
    api.onConnection((connected) => this.set({ connected }))
    await this.load()
  }

  async load(): Promise<void> {
    if (!this.api) {
      location.reload()
      return
    }
    this.set({ status: 'loading', error: undefined })
    try {
      const ws = await this.api.load()
      this.unsubscribe?.()
      this.unsubscribe = this.api.subscribe((next) =>
        this.set({ ws: next, clockOffset: next.now - Date.now() }),
      )
      this.set({ ws, status: 'ready', clockOffset: ws.now - Date.now() })
    } catch (e) {
      this.fail(e instanceof Error ? e.message : 'Something went wrong while loading.')
    }
  }

  async approve(agent: string, label: string): Promise<void> {
    const res = await this.api?.approve(agent)
    if (res?.error) this.toast('error', res.error)
    else if (res) this.toast('success', `${label}: result approved`)
  }

  async rerun(agent: string, label: string): Promise<void> {
    const res = await this.api?.rerun(agent)
    if (res?.error) this.toast('error', res.error)
    else if (res) this.toast('info', `${label} is running again`)
  }

  listFiles(): Promise<string[]> {
    return this.api?.listFiles() ?? Promise.resolve([])
  }

  async startReview(input: ReviewInput): Promise<boolean> {
    const res = await this.api?.startRun(input)
    if (!res) return false
    if (res.error) {
      this.toast('error', res.error)
      return false
    }
    this.toast('success', `Review of ${input.name ?? input.file ?? 'your code'} started`)
    return true
  }

  /** Save the visitor's key and model name in this browser. Returns an error message or nothing. */
  saveCredentials(key: string, model: string): string | undefined {
    const k = key.trim()
    const m = model.trim()
    if (!looksLikeKey(k)) {
      return 'That does not look like a Hugging Face key: it is one token of 8 to 200 characters, with no spaces.'
    }
    if (!looksLikeModel(m)) return 'The model name contains characters that are not allowed.'
    saveCredentials({ key: k, model: m })
    this.set({ hasKey: true })
    return undefined
  }

  removeKey() {
    clearCredentials()
    this.set({ hasKey: false })
    this.toast('success', 'Key removed from this browser')
  }

  /** Remove the key and start a new, empty session. The server deletes the old one on its own. */
  forgetSession() {
    clearCredentials()
    this.api?.resetSession()
    location.reload()
  }

  toast(kind: Toast['kind'], message: string) {
    const id = this.toastId++
    this.set({ toasts: [...this.state.toasts, { id, kind, message }].slice(-4) })
    setTimeout(() => this.dismissToast(id), kind === 'error' ? 6000 : 3500)
  }

  dismissToast(id: number) {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) })
  }
}

export const store = new AppStore()

export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState)
}

/** The loaded workspace. Only call below the loading/error gate in App. */
export function useWorkspace(): Workspace {
  const { ws } = useApp()
  if (!ws) throw new Error('useWorkspace called before the workspace loaded')
  return ws
}

/** The server's current time, ticking every second while `live` is true (a review is running). */
export function useServerNow(live: boolean): number {
  const { clockOffset, ws } = useApp()
  const [, tick] = useState(0)
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [live])
  return live ? Date.now() + clockOffset : (ws?.now ?? Date.now())
}
