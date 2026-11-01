import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from '../design/ui.tsx'

/** Side panel shell used by every inspector. Escape closes; focus moves in on open. */
export function Inspector({
  title,
  eyebrow,
  onClose,
  onBack,
  backLabel,
  children,
  footer,
}: {
  title: ReactNode
  eyebrow?: ReactNode
  onClose: () => void
  onBack?: () => void
  backLabel?: string
  children: ReactNode
  footer?: ReactNode
}) {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  return (
    <aside
      className="inspector"
      ref={ref}
      tabIndex={-1}
      aria-label="Details"
      onKeyDown={(e: { key: string; stopPropagation: () => void }) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <header className="inspector__head">
        {onBack && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
            <span aria-hidden="true">&larr;</span> {backLabel ?? 'Back'}
          </button>
        )}
        <div className="inspector__titles">
          {eyebrow && <div className="inspector__eyebrow">{eyebrow}</div>}
          <h2>{title}</h2>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--sm"
          aria-label="Close details"
          onClick={onClose}
        >
          <Icon name="x" size={16} />
        </button>
      </header>
      <div className="inspector__body">{children}</div>
      {footer && <footer className="inspector__foot">{footer}</footer>}
    </aside>
  )
}

export function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: ReactNode
}) {
  return (
    <section className="isec">
      <h3 className="isec__title">
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h3>
      {children}
    </section>
  )
}
