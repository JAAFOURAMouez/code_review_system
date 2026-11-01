import { useMemo } from 'react'
import type { LinkRelation, MemoryItem, MemoryKind } from '../domain/types.ts'
import { forceLayout } from './layout.ts'
import { Viewport } from './Viewport.tsx'

const W = 920
const H = 560

const KIND_COLOR: Record<MemoryKind, string> = {
  fact: 'var(--cyan)',
  observation: 'var(--text-2)',
  decision: 'var(--violet)',
}
const RELATION_LABEL: Record<LinkRelation, string> = {
  supports: 'supports',
  contradicts: 'contradicts',
  derived_from: 'derived from',
  supersedes: 'supersedes',
  relates: 'relates to',
}

export interface MemoryGraphProps {
  memories: MemoryItem[]
  /** All memories, used to keep the layout stable while filters change. */
  layoutSource: MemoryItem[]
  selectedId?: string
  onSelect: (id: string | undefined) => void
}

export function MemoryGraph({ memories, layoutSource, selectedId, onSelect }: MemoryGraphProps) {
  const positions = useMemo(
    () =>
      forceLayout(
        layoutSource.map((m) => m.id),
        layoutSource.flatMap((m) => m.links.map((l) => ({ from: m.id, to: l.to }))),
        { width: W, height: H, minSeparation: 104 },
      ),
    [layoutSource],
  )
  const visible = new Set(memories.map((m) => m.id))
  const selected = layoutSource.find((m) => m.id === selectedId)
  const neighbours = new Set<string>()
  if (selected) {
    neighbours.add(selected.id)
    for (const l of selected.links) neighbours.add(l.to)
    for (const m of layoutSource)
      if (m.links.some((l) => l.to === selected.id)) neighbours.add(m.id)
  }

  // One edge per pair: links stored in both directions describe the same connection.
  const edges: { from: string; to: string; relation: LinkRelation }[] = []
  const seenPairs = new Set<string>()
  for (const m of layoutSource) {
    for (const l of m.links) {
      const key = m.id < l.to ? `${m.id}|${l.to}` : `${l.to}|${m.id}`
      if (seenPairs.has(key)) continue
      seenPairs.add(key)
      edges.push({ from: m.id, to: l.to, relation: l.relation })
    }
  }

  return (
    <Viewport
      label="Memory relationship graph"
      contentWidth={W}
      contentHeight={H}
      fitKey="memory"
      minFitZoom={0.6}
      onBackgroundClick={() => onSelect(undefined)}
      overlay={
        <ul className="legend" aria-label="Legend">
          <li>
            <svg width="14" height="14" aria-hidden="true">
              <circle cx="7" cy="7" r="5" fill="var(--cyan)" />
            </svg>
            Fact
          </li>
          <li>
            <svg width="14" height="14" aria-hidden="true">
              <circle cx="7" cy="7" r="5" fill="var(--text-2)" />
            </svg>
            Observation
          </li>
          <li>
            <svg width="14" height="14" aria-hidden="true">
              <circle cx="7" cy="7" r="5" fill="var(--violet)" />
            </svg>
            Decision
          </li>
          <li className="legend__sep" aria-hidden="true" />
          <li>
            <svg width="16" height="16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" fill="none" stroke="var(--text-1)" strokeWidth="1.6" />
            </svg>
            Stored
          </li>
          <li>
            <svg width="16" height="16" aria-hidden="true">
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="var(--text-1)"
                strokeWidth="1.6"
                strokeDasharray="2.5 2.5"
              />
            </svg>
            Inferred
          </li>
        </ul>
      }
    >
      {() => (
        <>
          <defs>
            <marker
              id="mem-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M1 1 9 5 1 9Z" fill="#6a7385" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = positions.get(e.from)
            const b = positions.get(e.to)
            if (!a || !b) return null
            const shown = visible.has(e.from) && visible.has(e.to)
            const hot = !!selected && (e.from === selected.id || e.to === selected.id)
            const opacity = !shown ? 0.06 : selected ? (hot ? 1 : 0.12) : 0.55
            const dx = b.x - a.x
            const dy = b.y - a.y
            const len = Math.hypot(dx, dy) || 1
            const r = 14
            const x1 = a.x + (dx / len) * r
            const y1 = a.y + (dy / len) * r
            const x2 = b.x - (dx / len) * (r + 5)
            const y2 = b.y - (dy / len) * (r + 5)
            return (
              <g key={`${e.from}-${e.to}-${i}`} opacity={opacity}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={hot ? 'var(--text-1)' : '#6a7385'}
                  strokeWidth={hot ? 1.8 : 1.2}
                  strokeDasharray={
                    e.relation === 'derived_from'
                      ? '4 3'
                      : e.relation === 'supersedes'
                        ? '1 4'
                        : undefined
                  }
                  markerEnd="url(#mem-arrow)"
                />
                {hot && (
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 - 5}
                    textAnchor="middle"
                    fontSize={10.5}
                    fill="var(--text-1)"
                    stroke="var(--bg-0)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {RELATION_LABEL[e.relation]}
                  </text>
                )}
              </g>
            )
          })}
          {layoutSource.map((m) => {
            const p = positions.get(m.id)
            if (!p) return null
            const shown = visible.has(m.id)
            const isSel = selectedId === m.id
            const dim = !shown || (!!selected && !neighbours.has(m.id))
            return (
              <g
                key={m.id}
                className="mnode"
                transform={`translate(${p.x} ${p.y})`}
                opacity={dim ? 0.22 : 1}
                role="button"
                tabIndex={shown ? 0 : -1}
                aria-pressed={isSel}
                aria-label={`${m.origin === 'inferred' ? 'Inferred' : 'Stored'} ${m.kind}: ${m.title}`}
                onClick={(e: { stopPropagation: () => void }) => {
                  e.stopPropagation()
                  onSelect(m.id)
                }}
                onKeyDown={(e: { key: string; preventDefault: () => void }) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(m.id)
                  }
                }}
              >
                <title>{`${m.id} ${m.title}`}</title>
                {/* Transparent hit area: easier to click and tap than the dot alone. */}
                <rect x={-30} y={-24} width={60} height={isSel ? 72 : 52} fill="transparent" />
                {isSel && <circle r={19} fill="none" stroke="var(--violet)" strokeWidth={2} />}
                <circle
                  r={m.origin === 'inferred' ? 11 : 12}
                  fill={m.origin === 'inferred' ? 'var(--bg-1)' : KIND_COLOR[m.kind]}
                  stroke={KIND_COLOR[m.kind]}
                  strokeWidth={2}
                  strokeDasharray={m.origin === 'inferred' ? '3 3' : undefined}
                />
                <text
                  y={28}
                  textAnchor="middle"
                  fontSize={10.5}
                  fill="var(--text-2)"
                  className="mono"
                >
                  {m.id}
                </text>
                {isSel && (
                  <text
                    y={43}
                    textAnchor="middle"
                    fontSize={10.5}
                    fill="var(--text-1)"
                    stroke="var(--bg-0)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {m.title.length > 34 ? `${m.title.slice(0, 33)}…` : m.title}
                  </text>
                )}
              </g>
            )
          })}
        </>
      )}
    </Viewport>
  )
}
