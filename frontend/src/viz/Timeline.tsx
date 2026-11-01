import { useEffect, useMemo, useRef, useState } from 'react'
import { Glyph, Segmented, taskGlyphKind } from '../design/ui.tsx'
import { fmtDate, fmtTime } from '../design/format.ts'
import {
  prerequisiteChain,
  dependentsOf,
  summarizeMilestones,
  summarizePhases,
  type MilestoneState,
} from '../domain/rules.ts'
import { HOUR, type Task, type Workspace } from '../domain/types.ts'

const ROW_H = 30
const LABEL_W = 264
const AXIS_H = 44

const ZOOMS = { compact: 2.2, comfortable: 3.4, wide: 5.2 } as const
type Zoom = keyof typeof ZOOMS

const BAR_COLOR: Record<string, string> = {
  running: 'var(--st-running)',
  completed: 'var(--st-completed)',
  blocked: 'var(--st-blocked)',
  failed: 'var(--st-failed)',
  review: 'var(--st-review)',
  ready: 'var(--st-review)',
  backlog: 'var(--st-backlog)',
}

const MS_COLOR: Record<MilestoneState, string> = {
  achieved: 'var(--st-completed)',
  upcoming: 'var(--text-2)',
  at_risk: 'var(--st-blocked)',
  overdue: 'var(--st-failed)',
}
const MS_LABEL: Record<MilestoneState, string> = {
  achieved: 'Achieved',
  upcoming: 'Upcoming',
  at_risk: 'At risk',
  overdue: 'Overdue',
}

type Row =
  | { kind: 'phase'; id: string; name: string; state: string; expected: number; actual: number }
  | { kind: 'task'; id: string; task: Task }
  | { kind: 'milestone'; id: string; msId: string }

export interface TimelineProps {
  ws: Workspace
  /** Task ids that match the active filters; others are dimmed. */
  visibleTaskIds: Set<string>
  selectedTaskId?: string
  selectedMilestoneId?: string
  onSelectTask: (id: string) => void
  onSelectMilestone: (id: string) => void
}

export function Timeline({
  ws,
  visibleTaskIds,
  selectedTaskId,
  selectedMilestoneId,
  onSelectTask,
  onSelectMilestone,
}: TimelineProps) {
  const [zoom, setZoom] = useState<Zoom>('comfortable')
  const scroller = useRef<HTMLDivElement | null>(null)
  const pxPerHour = ZOOMS[zoom]
  const run = ws.runs.find((r) => r.id === ws.project.currentRunId)!
  const phases = useMemo(() => summarizePhases(ws), [ws])
  const milestones = useMemo(() => summarizeMilestones(ws), [ws])
  const msById = useMemo(() => new Map(milestones.map((m) => [m.milestone.id, m])), [milestones])

  const t0 = run.startedAt
  const lastPlanned = Math.max(
    ...ws.tasks.map((t) => t.plannedEnd),
    ...milestones.map((m) => m.milestone.due),
  )
  // Runs measured in minutes (a live code-review run) get a minute axis; long runs keep days.
  const short = lastPlanned - t0 < 6 * HOUR
  const unitMs = short ? 60_000 : 24 * HOUR
  const pxPerUnit = short ? pxPerHour * 20 : pxPerHour * 24
  const endAt = Math.max(lastPlanned, ws.now) + (short ? 2 * 60_000 : 12 * HOUR)
  const x = (at: number) => ((at - t0) / unitMs) * pxPerUnit
  const width = Math.ceil(x(endAt))

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const p of phases) {
      out.push({
        kind: 'phase',
        id: `ph-${p.phase.id}`,
        name: p.phase.name,
        state: p.state,
        expected: p.expected,
        actual: p.actual,
      })
      for (const t of [...p.tasks].sort((a, b) => a.plannedStart - b.plannedStart))
        out.push({ kind: 'task', id: t.id, task: t })
      for (const m of milestones.filter((m) => m.milestone.phaseId === p.phase.id))
        out.push({ kind: 'milestone', id: m.milestone.id, msId: m.milestone.id })
    }
    return out
  }, [phases, milestones])

  const rowIndex = new Map(rows.map((r, i) => [r.id, i]))
  const rowY = (id: string) => (rowIndex.get(id) ?? 0) * ROW_H

  // Upstream and downstream of the selected task are emphasised.
  const related = useMemo(() => {
    if (!selectedTaskId) return undefined
    const up = prerequisiteChain(selectedTaskId, ws.tasks)
    const down = (function walk(id: string, seen: Set<string>): Task[] {
      const out: Task[] = []
      for (const d of dependentsOf(id, ws.tasks)) {
        if (seen.has(d.id)) continue
        seen.add(d.id)
        out.push(d, ...walk(d.id, seen))
      }
      return out
    })(selectedTaskId, new Set())
    return new Set([selectedTaskId, ...up.map((t) => t.id), ...down.map((t) => t.id)])
  }, [selectedTaskId, ws.tasks])

  const taskById = useMemo(() => new Map(ws.tasks.map((t) => [t.id, t])), [ws.tasks])

  const barEnd = (t: Task) =>
    t.status === 'completed' ? (t.actualEnd ?? t.plannedEnd) : t.actualStart ? ws.now : t.plannedEnd
  const barStart = (t: Task) => t.actualStart ?? t.plannedStart

  // Connectors for the selected task's direct edges and its upstream chain.
  const connectors = useMemo(() => {
    if (!related) return []
    const out: { key: string; d: string; met: boolean; direct: boolean }[] = []
    for (const id of related) {
      const t = taskById.get(id)
      if (!t) continue
      for (const depId of t.dependsOn) {
        if (!related.has(depId)) continue
        const dep = taskById.get(depId)
        if (!dep) continue
        const x1 = x(dep.actualStart ? barEnd(dep) : dep.plannedEnd)
        const x2 = x(barStart(t))
        const y1 = rowY(dep.id) + ROW_H / 2
        const y2 = rowY(t.id) + ROW_H / 2
        const mid = Math.max(x1 + 8, Math.min(x2 - 8, (x1 + x2) / 2))
        out.push({
          key: `${depId}>${id}`,
          d: `M${x1},${y1} H${mid} V${y2} H${Math.max(x2, mid)}`,
          met: dep.status === 'completed',
          direct: id === selectedTaskId || depId === selectedTaskId,
        })
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [related, taskById, pxPerHour, ws.now, selectedTaskId])

  const days: number[] = []
  for (let d = 0; x(t0 + d * unitMs) < width; d++) days.push(d)

  const height = rows.length * ROW_H
  const nowX = x(ws.now)

  // Start with "Now" in view instead of the beginning of the run.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = Math.max(0, LABEL_W + nowX - el.clientWidth * 0.62)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom])

  return (
    <div className="tl">
      <div className="tl__toolbar">
        <Segmented
          label="Timeline density"
          value={zoom}
          onChange={setZoom}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'wide', label: 'Wide' },
          ]}
        />
        <ul className="legend legend--inline" aria-label="Legend">
          <li>
            <svg width="26" height="10" aria-hidden="true">
              <rect
                x="1"
                y="1"
                width="24"
                height="8"
                rx="2"
                fill="none"
                stroke="var(--text-3)"
                strokeDasharray="3 2"
              />
            </svg>
            Planned
          </li>
          <li>
            <svg width="26" height="10" aria-hidden="true">
              <rect x="1" y="1" width="24" height="8" rx="2" fill="var(--st-running)" />
            </svg>
            Actual
          </li>
          <li>
            <svg width="26" height="10" aria-hidden="true">
              <rect
                x="1"
                y="1"
                width="24"
                height="8"
                rx="2"
                fill="url(#tl-proj-legend)"
                stroke="var(--st-running)"
                strokeDasharray="2 2"
              />
              <defs>
                <pattern
                  id="tl-proj-legend"
                  width="5"
                  height="5"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width="2" height="5" fill="var(--st-running)" opacity="0.5" />
                </pattern>
              </defs>
            </svg>
            Projected at current pace
          </li>
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <path d="M6 1 11 6 6 11 1 6Z" fill="var(--st-completed)" />
            </svg>
            Milestone
          </li>
        </ul>
      </div>

      <div
        className="tl__scroll"
        ref={scroller}
        tabIndex={0}
        role="region"
        aria-label="Execution timeline. Scroll to see later dates."
      >
        <div className="tl__grid" style={{ gridTemplateColumns: `${LABEL_W}px ${width}px` }}>
          <div className="tl__corner" style={{ height: AXIS_H }}>
            <span className="muted">Task</span>
          </div>
          <svg className="tl__axis" width={width} height={AXIS_H} aria-hidden="true">
            {days.map((d) => {
              const at = t0 + d * unitMs
              return (
                <g key={d} transform={`translate(${x(at)} 0)`}>
                  <line y1={26} y2={AXIS_H} stroke="var(--line-strong)" />
                  <text x={5} y={16} fontSize={11} fill="var(--text-2)" fontWeight={600}>
                    {short ? `+${d} min` : `Day ${d + 1}`}
                  </text>
                  <text x={5} y={38} fontSize={10.5} fill="var(--text-3)">
                    {short ? fmtTime(at) : fmtDate(at)}
                  </text>
                </g>
              )
            })}
            <g transform={`translate(${nowX} 0)`}>
              <rect x={-17} y={4} width={34} height={16} rx={3} fill="var(--violet-strong)" />
              <text y={16} textAnchor="middle" fontSize={10.5} fontWeight={650} fill="#fff">
                Now
              </text>
            </g>
          </svg>

          <div className="tl__labels" style={{ height }}>
            {rows.map((r) => {
              if (r.kind === 'phase') {
                return (
                  <div key={r.id} className="tl__label tl__label--phase" style={{ height: ROW_H }}>
                    <strong>{r.name}</strong>
                    <span className="faint">
                      {r.state === 'completed'
                        ? 'Complete'
                        : r.state === 'active'
                          ? 'In progress'
                          : 'Upcoming'}
                    </span>
                  </div>
                )
              }
              if (r.kind === 'milestone') {
                const m = msById.get(r.msId)!
                return (
                  <button
                    key={r.id}
                    type="button"
                    className="tl__label tl__label--ms"
                    style={{ height: ROW_H }}
                    aria-pressed={selectedMilestoneId === r.msId}
                    onClick={() => onSelectMilestone(r.msId)}
                  >
                    <svg width="12" height="12" aria-hidden="true">
                      <path
                        d="M6 1 11 6 6 11 1 6Z"
                        fill={m.state === 'upcoming' ? 'none' : MS_COLOR[m.state]}
                        stroke={MS_COLOR[m.state]}
                        strokeWidth="1.4"
                      />
                    </svg>
                    <span className="truncate">{m.milestone.name}</span>
                    <span className="faint">{MS_LABEL[m.state]}</span>
                  </button>
                )
              }
              const t = r.task
              const dim = !visibleTaskIds.has(t.id) || (related ? !related.has(t.id) : false)
              return (
                <button
                  key={r.id}
                  type="button"
                  className="tl__label tl__label--task"
                  style={{ height: ROW_H, opacity: dim ? 0.4 : 1 }}
                  aria-pressed={selectedTaskId === t.id}
                  onClick={() => onSelectTask(t.id)}
                >
                  <Glyph kind={taskGlyphKind(t)} size={13} />
                  <span className="mono faint">{t.id}</span>
                  <span className="truncate">{t.title}</span>
                </button>
              )
            })}
          </div>

          <svg
            className="tl__body"
            width={width}
            height={height}
            role="img"
            aria-label="Task schedule. Select a task in the list to see what it depends on."
          >
            <defs>
              <pattern
                id="tl-blocked"
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="3" height="6" fill="rgba(0,0,0,0.28)" />
              </pattern>
              <pattern
                id="tl-proj"
                width="5"
                height="5"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="2" height="5" fill="var(--st-running)" opacity="0.5" />
              </pattern>
            </defs>
            {days.map((d) => (
              <line
                key={d}
                x1={x(t0 + d * unitMs)}
                x2={x(t0 + d * unitMs)}
                y1={0}
                y2={height}
                stroke="var(--line)"
              />
            ))}
            {rows.map((r, i) =>
              r.kind === 'phase' ? (
                <rect
                  key={r.id}
                  x={0}
                  y={i * ROW_H}
                  width={width}
                  height={ROW_H}
                  fill="var(--bg-2)"
                  opacity={0.55}
                />
              ) : null,
            )}
            {rows.map((r, i) => {
              if (r.kind === 'phase') {
                const w = 150
                return (
                  <g
                    key={r.id}
                    transform={`translate(${Math.max(8, nowX - w - 8)} ${i * ROW_H + 11})`}
                  >
                    <title>{`Expected ${Math.round(r.expected)}% by now, actual ${Math.round(r.actual)}%`}</title>
                    <text x={0} y={9} fontSize={10.5} fill="var(--text-3)">
                      {`Expected ${Math.round(r.expected)}%`}
                    </text>
                    <text
                      x={w}
                      y={9}
                      fontSize={10.5}
                      textAnchor="end"
                      fill={r.actual + 1 < r.expected ? 'var(--st-blocked)' : 'var(--text-2)'}
                      fontWeight={600}
                    >
                      {`Actual ${Math.round(r.actual)}%`}
                    </text>
                  </g>
                )
              }
              return null
            })}

            {rows.map((r, i) => {
              const y = i * ROW_H
              if (r.kind === 'milestone') {
                const m = msById.get(r.msId)!
                const cx = x(m.milestone.due)
                const selected = selectedMilestoneId === r.msId
                return (
                  <g key={r.id} className="tl__ms" onClick={() => onSelectMilestone(r.msId)}>
                    <title>{`${m.milestone.name}: due ${fmtDate(m.milestone.due)} (${MS_LABEL[m.state]})`}</title>
                    <rect x={0} y={y} width={width} height={ROW_H} fill="transparent" />
                    {m.state === 'achieved' && m.achievedAt ? (
                      <line
                        x1={x(m.achievedAt)}
                        x2={cx}
                        y1={y + ROW_H / 2}
                        y2={y + ROW_H / 2}
                        stroke="var(--text-3)"
                        strokeDasharray="2 3"
                      />
                    ) : null}
                    <path
                      transform={`translate(${cx} ${y + ROW_H / 2})`}
                      d="M0 -8 8 0 0 8 -8 0Z"
                      fill={m.state === 'upcoming' ? 'var(--bg-0)' : MS_COLOR[m.state]}
                      stroke={MS_COLOR[m.state]}
                      strokeWidth={selected ? 3 : 1.6}
                    />
                    <text x={cx + 14} y={y + ROW_H / 2 + 4} fontSize={11} fill="var(--text-2)">
                      {fmtDate(m.milestone.due)}
                    </text>
                  </g>
                )
              }
              if (r.kind !== 'task') return null
              const t = r.task
              const dim = !visibleTaskIds.has(t.id) || (related ? !related.has(t.id) : false)
              const kind = taskGlyphKind(t)
              const color = BAR_COLOR[kind] ?? BAR_COLOR.backlog!
              const px = x(t.plannedStart)
              const pw = Math.max(3, x(t.plannedEnd) - px)
              const started = !!t.actualStart
              const ax = x(barStart(t))
              const aw = Math.max(3, x(barEnd(t)) - ax)
              const selected = selectedTaskId === t.id
              const late = !started && t.plannedStart < ws.now
              // Projection for running tasks, based on progress so far.
              let projW = 0
              if (t.status === 'running' && t.actualStart && t.progress >= 10) {
                const elapsed = ws.now - t.actualStart
                const total = elapsed / (t.progress / 100)
                projW = Math.max(0, x(t.actualStart + total) - (ax + aw))
              }
              return (
                <g
                  key={r.id}
                  className="tl__task"
                  opacity={dim ? 0.3 : 1}
                  onClick={() => onSelectTask(t.id)}
                >
                  <title>
                    {`${t.id} ${t.title}\nPlanned ${fmtDate(t.plannedStart)} to ${fmtDate(t.plannedEnd)}${started ? `\nStarted ${fmtDate(t.actualStart!)}` : late ? '\nNot started; planned start has passed' : ''}${t.actualEnd ? `\nFinished ${fmtDate(t.actualEnd)}` : ''}`}
                  </title>
                  {selected && (
                    <rect x={0} y={y} width={width} height={ROW_H} fill="var(--violet-wash)" />
                  )}
                  <rect
                    x={px}
                    y={y + 5}
                    width={pw}
                    height={ROW_H - 10}
                    rx={3}
                    fill="none"
                    stroke={late ? 'var(--st-blocked)' : 'var(--text-3)'}
                    strokeDasharray="3 2"
                    strokeWidth={1}
                  />
                  {started && (
                    <>
                      <rect
                        x={ax}
                        y={y + 8}
                        width={aw}
                        height={ROW_H - 16}
                        rx={2.5}
                        fill={color}
                        opacity={t.status === 'completed' ? 0.85 : 1}
                      />
                      {t.status === 'blocked' && (
                        <rect
                          x={ax}
                          y={y + 8}
                          width={aw}
                          height={ROW_H - 16}
                          rx={2.5}
                          fill="url(#tl-blocked)"
                        />
                      )}
                      {projW > 1 && (
                        <rect
                          x={ax + aw}
                          y={y + 8}
                          width={projW}
                          height={ROW_H - 16}
                          rx={2.5}
                          fill="url(#tl-proj)"
                          stroke="var(--st-running)"
                          strokeDasharray="2 2"
                        />
                      )}
                    </>
                  )}
                  {selected && (
                    <rect
                      x={Math.min(px, ax) - 2}
                      y={y + 3}
                      width={Math.max(px + pw, ax + aw + projW) - Math.min(px, ax) + 4}
                      height={ROW_H - 6}
                      rx={4}
                      fill="none"
                      stroke="var(--violet)"
                      strokeWidth={1.6}
                    />
                  )}
                </g>
              )
            })}

            {connectors.map((c) => (
              <path
                key={c.key}
                d={c.d}
                fill="none"
                stroke={c.met ? 'var(--st-completed)' : 'var(--st-blocked)'}
                strokeWidth={c.direct ? 2 : 1.2}
                strokeDasharray={c.met ? undefined : '4 3'}
                opacity={c.direct ? 0.95 : 0.4}
              />
            ))}

            <line x1={nowX} x2={nowX} y1={0} y2={height} stroke="var(--violet)" strokeWidth={1.5} />
          </svg>
        </div>
      </div>
    </div>
  )
}
