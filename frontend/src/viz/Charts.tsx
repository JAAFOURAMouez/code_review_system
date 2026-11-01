import { TASK_STATUS_LABEL, TASK_STATUSES, type TaskStatus } from '../domain/types.ts'

const SEG_COLOR: Record<TaskStatus, string> = {
  completed: 'var(--st-completed)',
  review: 'var(--st-review)',
  running: 'var(--st-running)',
  blocked: 'var(--st-blocked)',
  ready: '#5b6275',
  backlog: '#3a4050',
}
const ORDER: TaskStatus[] = ['completed', 'review', 'running', 'blocked', 'ready', 'backlog']

/** One stacked bar with a direct-labelled legend below it. */
export function StatusBar({
  counts,
  onPick,
}: {
  counts: Record<TaskStatus, number>
  onPick?: (s: TaskStatus) => void
}) {
  const total = TASK_STATUSES.reduce((s, k) => s + counts[k], 0)
  return (
    <div>
      <div
        className="statusbar"
        role="img"
        aria-label={ORDER.map((s) => `${counts[s]} ${TASK_STATUS_LABEL[s]}`).join(', ')}
      >
        {ORDER.map((s) =>
          counts[s] ? (
            <span
              key={s}
              style={{ flexGrow: counts[s], background: SEG_COLOR[s] }}
              title={`${TASK_STATUS_LABEL[s]}: ${counts[s]}`}
            />
          ) : null,
        )}
      </div>
      <ul className="statuslegend">
        {ORDER.map((s) => (
          <li key={s}>
            <button
              type="button"
              className="statuslegend__btn"
              onClick={() => onPick?.(s)}
              disabled={!onPick}
            >
              <i style={{ background: SEG_COLOR[s] }} aria-hidden="true" />
              <span className="muted">{TASK_STATUS_LABEL[s]}</span>
              <strong>{counts[s]}</strong>
            </button>
          </li>
        ))}
        <li className="faint statuslegend__total">{total} tasks</li>
      </ul>
    </div>
  )
}

export interface BarDatum {
  label: string
  value: number
  display: string
  note?: string
  highlight?: boolean
}

/** Horizontal bars, one series, value labelled directly. Zero baseline. */
export function HBars({ data, max, label }: { data: BarDatum[]; max?: number; label: string }) {
  const top = max ?? Math.max(...data.map((d) => d.value), 1)
  return (
    <ul className="hbars" aria-label={label}>
      {data.map((d) => (
        <li key={d.label} className={d.highlight ? 'hbars__row hbars__row--hl' : 'hbars__row'}>
          <span className="hbars__label truncate" title={d.label}>
            {d.label}
          </span>
          <span className="hbars__track">
            <span style={{ width: `${Math.max(0, Math.min(100, (d.value / top) * 100))}%` }} />
          </span>
          <span className="hbars__value">{d.display}</span>
          {d.note && <span className="hbars__note faint">{d.note}</span>}
        </li>
      ))}
    </ul>
  )
}

/** Step success over time. Axis is fixed 0 to 100% so dips are not exaggerated. */
export function RateLine({
  points,
  label,
  unitLabel,
}: {
  points: { x: number; y: number; n: number }[]
  label: string
  unitLabel: (x: number) => string
}) {
  const w = 520
  const h = 150
  const pl = 34
  const pb = 22
  const pt = 8
  if (points.length < 2) return <p className="muted">Not enough steps recorded yet.</p>
  const xs = points.map((p) => p.x)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const sx = (x: number) => pl + ((x - x0) / Math.max(1, x1 - x0)) * (w - pl - 8)
  const sy = (y: number) => pt + (1 - y) * (h - pt - pb)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x)},${sy(p.y)}`).join(' ')
  return (
    <svg className="rateline" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line x1={pl} x2={w - 8} y1={sy(t)} y2={sy(t)} stroke="var(--line)" />
          <text x={pl - 6} y={sy(t) + 4} textAnchor="end" fontSize={10.5} fill="var(--text-3)">
            {t * 100}%
          </text>
        </g>
      ))}
      <path d={d} fill="none" stroke="var(--cyan)" strokeWidth={2} strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={sx(p.x)}
          cy={sy(p.y)}
          r={p.n < 3 ? 2 : 3.2}
          fill={p.y < 0.9 ? 'var(--st-blocked)' : 'var(--cyan)'}
        >
          <title>{`${unitLabel(p.x)}: ${Math.round(p.y * 100)}% of ${p.n} steps`}</title>
        </circle>
      ))}
      <text x={pl} y={h - 5} fontSize={10.5} fill="var(--text-3)">
        {unitLabel(x0)}
      </text>
      <text x={w - 8} y={h - 5} fontSize={10.5} textAnchor="end" fill="var(--text-3)">
        {unitLabel(x1)}
      </text>
    </svg>
  )
}
