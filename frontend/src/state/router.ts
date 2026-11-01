// Minimal hash router. Selection state (agent, task, memory, run) lives in the
// URL so deep links work and every view agrees on what is selected.
import { useSyncExternalStore } from 'react'

export type ViewId =
  | 'overview'
  | 'orchestration'
  | 'tasks'
  | 'memory'
  | 'history'
  | 'evaluation'
  | 'settings'

export const VIEWS: ViewId[] = [
  'overview',
  'orchestration',
  'tasks',
  'memory',
  'history',
  'evaluation',
  'settings',
]

export interface Route {
  view: ViewId
  params: Record<string, string>
  raw: string
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [path = '', query = ''] = raw.split('?')
  const view = (VIEWS as string[]).includes(path) ? (path as ViewId) : 'overview'
  const params: Record<string, string> = {}
  new URLSearchParams(query).forEach((v, k) => {
    params[k] = v
  })
  return { view, params, raw }
}

export function buildHash(view: ViewId, params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v)
  const s = q.toString()
  return `#/${view}${s ? `?${s}` : ''}`
}

let cached: Route = parseHash(typeof location === 'undefined' ? '' : location.hash)

function subscribe(cb: () => void): () => void {
  const handler = () => cb()
  window.addEventListener('hashchange', handler)
  return () => window.removeEventListener('hashchange', handler)
}

function snapshot(): Route {
  const raw = location.hash.replace(/^#\/?/, '')
  if (raw !== cached.raw) cached = parseHash(location.hash)
  return cached
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot)
}

export function navigate(
  view: ViewId,
  params: Record<string, string | undefined> = {},
  opts: { replace?: boolean } = {},
): void {
  const next = buildHash(view, params)
  if (next === location.hash) return
  if (opts.replace) history.replaceState(null, '', next)
  else location.hash = next
  // replaceState does not fire hashchange.
  if (opts.replace) window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/** Merge into the current route's params; undefined or empty values remove a key. */
export function setParams(
  patch: Record<string, string | undefined>,
  opts: { replace?: boolean } = {},
): void {
  const cur = snapshot()
  const merged: Record<string, string | undefined> = { ...cur.params, ...patch }
  navigate(cur.view, merged, { replace: opts.replace ?? true })
}
