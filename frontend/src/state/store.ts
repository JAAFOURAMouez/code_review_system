// Application store: mirrors the repository's workspace snapshot and holds the
// few pieces of app-level state (settings, toasts, read notifications).
// Selection and filters live in the URL (see router.ts) or in view-local state.
import { useSyncExternalStore } from 'react'
import type { HorizonRepository, ReviewInput, TransitionRequest } from '../data/repository.ts'
import {
  clearCredentials,
  getCredentials,
  looksLikeKey,
  looksLikeModel,
  saveCredentials,
} from './credentials.ts'
import { TASK_STATUS_LABEL, type CriterionResult, type Workspace } from '../domain/types.ts'
import {
  DEFAULT_SETTINGS,
  SPEED_INTERVAL_MS,
  loadSettings,
  saveSettings,
  type Settings,
} from './settings.ts'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
}

export interface AppState {
  status: 'loading' | 'ready' | 'error'
  error?: string
  ws?: Workspace
  repoKind: 'demo' | 'live'
  repoLabel: string
  /** The repository can start new reviews (live backend only). */
  canStartRun: boolean
  /** `upload`: visitors send code and bring their own model key (public deployments). */
  submitMode: 'path' | 'upload'
  /** A model key is saved in this browser (upload mode). */
  hasKey: boolean
  /** False while a live backend cannot be reached. */
  connected: boolean
  settings: Settings
  toasts: Toast[]
  readNotifications: string[]
}

type Listener = () => void

export class AppStore {
  private state: AppState = {
    status: 'loading',
    repoKind: 'demo',
    repoLabel: '',
    canStartRun: false,
    submitMode: 'path',
    hasKey: false,
    connected: true,
    settings: DEFAULT_SETTINGS,
    toasts: [],
    readNotifications: [],
  }
  private listeners = new Set<Listener>()
  private repo: HorizonRepository | undefined
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

  async init(repo: HorizonRepository): Promise<void> {
    this.repo = repo
    this.set({
      repoKind: repo.kind,
      repoLabel: repo.label,
      canStartRun: !!repo.startRun,
      submitMode: repo.submit ?? 'path',
      hasKey: !!getCredentials().key,
      settings: loadSettings(),
    })
    repo.onConnection?.((connected) => this.set({ connected }))
    await this.load()
  }

  async load(): Promise<void> {
    if (!this.repo) return
    this.set({ status: 'loading', error: undefined })
    try {
      const ws = await this.repo.load()
      this.unsubscribe?.()
      this.unsubscribe = this.repo.subscribe((next) => this.set({ ws: next }))
      this.set({ ws, status: 'ready' })
      this.applySimulation()
    } catch (e) {
      this.set({
        status: 'error',
        error: e instanceof Error ? e.message : 'Something went wrong while loading.',
      })
    }
  }

  private applySimulation() {
    const { settings } = this.state
    this.repo?.configureSimulation?.({
      enabled: settings.simulate,
      intervalMs: SPEED_INTERVAL_MS[settings.speed],
      failureRate: settings.injectFailures ? 0.05 : 0,
    })
  }

  updateSettings(patch: Partial<Settings>) {
    const settings = { ...this.state.settings, ...patch }
    saveSettings(settings)
    this.set({ settings })
    this.applySimulation()
  }

  async transitionTask(req: TransitionRequest): Promise<boolean> {
    if (!this.repo) return false
    const res = await this.repo.transitionTask(req)
    if (res.error) {
      this.toast('error', res.error)
      return false
    }
    this.toast('success', `${req.taskId} moved to ${TASK_STATUS_LABEL[req.to]}`)
    return true
  }

  async setCriterion(taskId: string, criterionId: string, result: CriterionResult): Promise<void> {
    if (!this.repo) return
    const res = await this.repo.setCriterion(taskId, criterionId, result)
    if (res.error) this.toast('error', res.error)
  }

  listFiles(): Promise<string[]> {
    return this.repo?.listFiles?.() ?? Promise.resolve([])
  }

  async startReview(input: ReviewInput): Promise<boolean> {
    const res = await this.repo?.startRun?.(input)
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
    this.repo?.resetSession?.()
    location.reload()
  }

  async resetDemo(): Promise<void> {
    if (!this.repo) return
    await this.repo.reset()
    this.set({ readNotifications: [] })
    this.toast('success', 'Demo data reset')
  }

  markNotificationsRead(ids: string[]) {
    const merged = [...new Set([...this.state.readNotifications, ...ids])]
    this.set({ readNotifications: merged })
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
