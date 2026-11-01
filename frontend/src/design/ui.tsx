import { useEffect, useRef, type ReactNode } from 'react'
import {
  TASK_STATUS_LABEL,
  type AgentState,
  type Priority,
  type Task,
  type TaskStatus,
} from '../domain/types.ts'
import { store, useApp } from '../state/store.ts'

// ------------------------------------------------------------------ icons

const ICONS = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  graph: (
    <>
      <circle cx="5" cy="6" r="2.2" />
      <circle cx="19" cy="6" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <path d="M7 6.8 17 6.8M6 8 11 16M18 8 13 16" />
    </>
  ),
  tasks: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1.2" />
      <rect x="10" y="4" width="5" height="10" rx="1.2" />
      <rect x="17" y="4" width="4" height="13" rx="1.2" />
    </>
  ),
  memory: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  evaluation: <path d="M3 20V10M9 20V4M15 20v-7M21 20V8" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  bell: <path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7 2.5 7h-17S6 15 6 9ZM10 20a2 2 0 0 0 4 0" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  alert: (
    <>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 10v4.5M12 17.5v.01" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c.8-3.6 3.4-5.5 7-5.5s6.2 1.9 7 5.5" />
    </>
  ),
  refresh: (
    <path d="M20 11a8 8 0 0 0-14.5-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15M20 20v-5h-5" />
  ),
  link: (
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" />
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8v.01" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="M7 5v14l12-7L7 5Z" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
} as const

export type IconName = keyof typeof ICONS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  )
}

// ----------------------------------------------------------- status glyphs

export type GlyphKind = AgentState | TaskStatus

const GLYPH_COLOR: Record<GlyphKind, string> = {
  idle: 'var(--st-idle)',
  running: 'var(--st-running)',
  completed: 'var(--st-completed)',
  blocked: 'var(--st-blocked)',
  failed: 'var(--st-failed)',
  backlog: 'var(--st-backlog)',
  ready: 'var(--st-ready)',
  review: 'var(--st-review)',
}

/** Shape encodes status, colour reinforces it, so it reads without colour. */
export function Glyph({ kind, size = 14 }: { kind: GlyphKind; size?: number }) {
  const c = GLYPH_COLOR[kind]
  const ink = 'var(--bg-0)'
  let body: ReactNode
  switch (kind) {
    case 'idle':
      body = <circle cx="7" cy="7" r="5" fill="none" stroke={c} strokeWidth="1.6" />
      break
    case 'backlog':
      body = (
        <circle
          cx="7"
          cy="7"
          r="5"
          fill="none"
          stroke={c}
          strokeWidth="1.6"
          strokeDasharray="2.4 2.2"
        />
      )
      break
    case 'ready':
      body = <circle cx="7" cy="7" r="5" fill="none" stroke={c} strokeWidth="1.6" />
      break
    case 'running':
      body = (
        <>
          <circle cx="7" cy="7" r="5" fill="none" stroke={c} strokeWidth="1.6" />
          <path d="M7 3.9A3.1 3.1 0 0 0 7 10.1Z" fill={c} />
        </>
      )
      break
    case 'review':
      body = (
        <>
          <circle cx="7" cy="7" r="5" fill="none" stroke={c} strokeWidth="1.6" />
          <path d="M7 7V3.9A3.1 3.1 0 1 1 3.9 7Z" fill={c} />
        </>
      )
      break
    case 'completed':
      body = (
        <>
          <circle cx="7" cy="7" r="6" fill={c} />
          <path
            d="m4.4 7.2 1.8 1.8 3.4-3.6"
            fill="none"
            stroke={ink}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )
      break
    case 'blocked':
      body = (
        <>
          <rect x="1.2" y="1.2" width="11.6" height="11.6" rx="2.4" fill={c} />
          <path d="M5.3 4.6v4.8M8.7 4.6v4.8" stroke={ink} strokeWidth="1.5" strokeLinecap="round" />
        </>
      )
      break
    case 'failed':
      body = (
        <>
          <circle cx="7" cy="7" r="6" fill={c} />
          <path
            d="m4.8 4.8 4.4 4.4M9.2 4.8 4.8 9.2"
            stroke={ink}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      )
      break
  }
  return (
    <svg
      className="glyph"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
    >
      {body}
    </svg>
  )
}

const STATE_LABEL: Record<GlyphKind, string> = {
  idle: 'Idle',
  running: 'Running',
  completed: 'Completed',
  blocked: 'Blocked',
  failed: 'Failed',
  backlog: 'Backlog',
  ready: 'Ready',
  review: 'Review',
}

export function StateBadge({ kind, label }: { kind: GlyphKind; label?: string }) {
  return (
    <span className={`badge badge--${kind}`}>
      <Glyph kind={kind} />
      {label ?? STATE_LABEL[kind]}
    </span>
  )
}

/** A task's visual state: blocked-by-failure reads as failed. */
export function taskGlyphKind(task: Pick<Task, 'status' | 'blocked'>): GlyphKind {
  return task.status === 'blocked' && task.blocked?.kind === 'failure' ? 'failed' : task.status
}

export function TaskStateBadge({ task }: { task: Task }) {
  const kind = taskGlyphKind(task)
  const label = kind === 'failed' ? 'Blocked: failed' : TASK_STATUS_LABEL[task.status]
  return <StateBadge kind={kind} label={label} />
}

const PRIORITY_LABEL: Record<Priority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export function PriorityMark({ priority }: { priority: Priority }) {
  return (
    <span className={`prio prio--${priority}`} title={`${PRIORITY_LABEL[priority]} priority`}>
      <i aria-hidden="true">
        <b />
        <b />
        <b />
      </i>
      {PRIORITY_LABEL[priority]}
    </span>
  )
}

// ---------------------------------------------------------------- controls

export function Meter({
  value,
  tone,
  small,
  label,
}: {
  value: number
  tone?: 'ok' | 'violet'
  small?: boolean
  label: string
}) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div
      className={`meter${tone ? ` meter--${tone}` : ''}${small ? ' meter--sm' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
    >
      <span style={{ width: `${v}%` }} />
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    />
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  label: string
}) {
  return (
    <div className="search">
      <Icon name="search" size={14} />
      <input
        className="input"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e: { target: { value: string } }) => onChange(e.target.value)}
      />
    </div>
  )
}

export function Empty({
  title,
  children,
  action,
  center,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
  center?: boolean
}) {
  return (
    <div className={`empty${center ? ' empty--center' : ''}`}>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function DemoTag({ children = 'Demo data' }: { children?: ReactNode }) {
  const { repoKind } = useApp()
  if (repoKind === 'live') return null
  return (
    <span
      className="demo-tag"
      title="Sample data generated in this browser, not a measurement of a real system."
    >
      {children}
    </span>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="spinner" role="status" aria-label={label} />
}

// ----------------------------------------------------------------- toasts

export function Toasts() {
  const { toasts } = useApp()
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.kind}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          <span>{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => store.dismissToast(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

// --------------------------------------------------------------- dismissal

/** Close a popover on outside click or Escape. */
export function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  return ref
}
