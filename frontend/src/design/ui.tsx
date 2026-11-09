import { useEffect, useRef, useState, type ReactNode } from 'react'
import { store, useApp } from '../state/store.ts'
import type { AgentStatus, Outcome } from '../types.ts'

// ------------------------------------------------------------------ icons

const ICONS = {
  results: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  graph: (
    <>
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="19" cy="5" r="2.2" />
      <circle cx="19" cy="12" r="2.2" />
      <circle cx="19" cy="19" r="2.2" />
      <path d="M7.2 12H16.8M7 11 16.9 5.8M7 13l9.9 5.2" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  refresh: (
    <path d="M20 11a8 8 0 0 0-14.5-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15M20 20v-5h-5" />
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </>
  ),
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
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

export type StatusKind = AgentStatus | 'partial'

const KIND_COLOR: Record<StatusKind, string> = {
  pending: 'var(--st-idle)',
  running: 'var(--st-running)',
  ok: 'var(--st-completed)',
  failed: 'var(--st-failed)',
  skipped: 'var(--st-idle)',
  partial: 'var(--st-blocked)',
}

/** Shape encodes status and colour reinforces it, so it reads without colour. */
export function Glyph({ kind, size = 14 }: { kind: StatusKind; size?: number }) {
  const c = KIND_COLOR[kind]
  const ink = 'var(--bg-0)'
  let body: ReactNode
  switch (kind) {
    case 'pending':
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
    case 'skipped':
      body = (
        <>
          <circle cx="7" cy="7" r="5" fill="none" stroke={c} strokeWidth="1.6" />
          <path d="M4.6 7h4.8" stroke={c} strokeWidth="1.6" strokeLinecap="round" />
        </>
      )
      break
    case 'running':
      body = (
        <>
          <circle cx="7" cy="7" r="5" fill="none" stroke={c} strokeWidth="1.6" />
          <path d="M7 3.9A3.1 3.1 0 0 0 7 10.1Z" fill={c} />
        </>
      )
      break
    case 'ok':
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
    case 'partial':
      body = (
        <>
          <rect x="1.2" y="1.2" width="11.6" height="11.6" rx="2.4" fill={c} />
          <path d="M4.5 7h5" stroke={ink} strokeWidth="1.6" strokeLinecap="round" />
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

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  pending: 'Waiting',
  running: 'Running',
  ok: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  in_progress: 'In progress',
  succeeded: 'Succeeded',
  partial: 'Partly failed',
  failed: 'Failed',
}

export function outcomeKind(outcome: Outcome): StatusKind {
  return outcome === 'in_progress'
    ? 'running'
    : outcome === 'succeeded'
      ? 'ok'
      : outcome === 'partial'
        ? 'partial'
        : 'failed'
}

export function StatusBadge({ kind, label }: { kind: StatusKind; label: string }) {
  return (
    <span className={`badge badge--${kind}`}>
      <Glyph kind={kind} />
      {label}
    </span>
  )
}

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  return <StatusBadge kind={outcomeKind(outcome)} label={OUTCOME_LABEL[outcome]} />
}

// ----------------------------------------------------------------- small pieces

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="spinner" role="status" aria-label={label} />
}

/** A block of code with Copy and Download buttons. */
export function CodeBlock({ code, filename }: { code: string; filename?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      store.toast('error', 'The browser did not allow copying. Select the text instead.')
    }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/x-python' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename ?? 'code.py'
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="codeblock">
      <div className="codeblock__bar">
        {filename && <span className="mono codeblock__name">{filename}</span>}
        <span className="codeblock__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copy()}>
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? 'Copied' : 'Copy'}
          </button>
          {filename && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={download}>
              <Icon name="download" size={14} />
              Download
            </button>
          )}
        </span>
      </div>
      <pre className="codeblock__code">
        <code>{code}</code>
      </pre>
    </div>
  )
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
