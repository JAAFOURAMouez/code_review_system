import { useMemo, useState } from 'react'
import { COMMUNICATIONS } from '../domain/seed.ts'
import {
  agentTaskCounts,
  currentTaskOf,
  deriveAgentState,
  deriveHandoffs,
  type EdgeStatus,
  type HandoffEdge,
} from '../domain/rules.ts'
import { AGENT_STATE_LABEL, type Agent, type AgentState, type Task } from '../domain/types.ts'
import { Glyph } from '../design/ui.tsx'
import { bezierMid, layeredLayout, type LayeredLayout, type Point } from './layout.ts'
import { Viewport } from './Viewport.tsx'

export const NODE_W = 236
export const NODE_H = 108
const GAP_X = 150
const GAP_Y = 30
const BAND_GAP = 96
const WRAP_AFTER = 3

const STATE_COLOR: Record<AgentState, string> = {
  idle: 'var(--st-idle)',
  running: 'var(--st-running)',
  completed: 'var(--st-completed)',
  blocked: 'var(--st-blocked)',
  failed: 'var(--st-failed)',
}

const EDGE_COLOR: Record<EdgeStatus, string> = {
  done: '#4b5363',
  active: 'var(--cyan)',
  stalled: 'var(--st-blocked)',
  pending: '#4b5363',
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

interface Route {
  d: string
  mid: Point
}

function route(from: Point, to: Point, bendY = 0): Route {
  // Target sits in a lower band (the pipeline wrapped): leave the bottom, arrive at the top.
  if (to.y >= from.y + NODE_H + 30) {
    const p0 = { x: from.x + NODE_W / 2 + bendY, y: from.y + NODE_H }
    const p3 = { x: to.x + NODE_W / 2 + bendY, y: to.y }
    const dy = Math.max(30, (p3.y - p0.y) / 2)
    const p1 = { x: p0.x, y: p0.y + dy }
    const p2 = { x: p3.x, y: p3.y - dy }
    return {
      d: `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`,
      mid: bezierMid(p0, p1, p2, p3),
    }
  }
  // Target sits in an upper band: leave the top, arrive at the bottom.
  if (to.y + NODE_H + 30 <= from.y) {
    const p0 = { x: from.x + NODE_W / 2 + bendY, y: from.y }
    const p3 = { x: to.x + NODE_W / 2 + bendY, y: to.y + NODE_H }
    const dy = Math.max(30, (p0.y - p3.y) / 2)
    const p1 = { x: p0.x, y: p0.y - dy }
    const p2 = { x: p3.x, y: p3.y + dy }
    return {
      d: `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`,
      mid: bezierMid(p0, p1, p2, p3),
    }
  }
  if (to.x > from.x + NODE_W / 2) {
    const p0 = { x: from.x + NODE_W, y: from.y + NODE_H / 2 }
    const p3 = { x: to.x, y: to.y + NODE_H / 2 }
    const dx = Math.max(40, (p3.x - p0.x) / 2)
    const p1 = { x: p0.x + dx, y: p0.y }
    const p2 = { x: p3.x - dx, y: p3.y }
    return {
      d: `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`,
      mid: bezierMid(p0, p1, p2, p3),
    }
  }
  // Backward within a band: leave the bottom, arc below, arrive at the bottom.
  const p0 = { x: from.x + NODE_W / 2 - 24 + bendY, y: from.y + NODE_H }
  const p3 = { x: to.x + NODE_W / 2 + 24 + bendY, y: to.y + NODE_H }
  const depth = 54 + Math.abs(p0.y - p3.y) * 0.2
  const p1 = { x: p0.x, y: Math.max(p0.y, p3.y) + depth }
  const p2 = { x: p3.x, y: Math.max(p0.y, p3.y) + depth }
  return {
    d: `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`,
    mid: bezierMid(p0, p1, p2, p3),
  }
}

export interface AgentGraphProps {
  agents: Agent[]
  tasks: Task[]
  selectedId?: string
  onSelect: (id: string | undefined) => void
}

/** Agents that hand nothing to each other are shown as a plain grid, in pipeline order. */
function gridLayout(ids: string[]): LayeredLayout {
  const cols = Math.min(3, Math.max(1, ids.length))
  const positions = new Map<string, Point>()
  const layers = new Map<string, number>()
  ids.forEach((id, i) => {
    positions.set(id, {
      x: (i % cols) * (NODE_W + GAP_X),
      y: Math.floor(i / cols) * (NODE_H + GAP_Y + 40),
    })
    layers.set(id, i % cols)
  })
  const rows = Math.ceil(ids.length / cols)
  return {
    positions,
    layers,
    width: cols * NODE_W + (cols - 1) * GAP_X,
    height: rows * NODE_H + (rows - 1) * (GAP_Y + 40),
  }
}

export function AgentGraph({ agents, tasks, selectedId, onSelect }: AgentGraphProps) {
  const handoffs = useMemo(() => deriveHandoffs(tasks), [tasks])
  const ids = useMemo(() => agents.map((a) => a.id), [agents])
  const layout = useMemo(
    () =>
      handoffs.length === 0
        ? gridLayout(ids)
        : layeredLayout(ids, handoffs, {
            nodeWidth: NODE_W,
            nodeHeight: NODE_H,
            columnGap: GAP_X,
            rowGap: GAP_Y,
            wrapAfter: WRAP_AFTER,
            bandGap: BAND_GAP,
          }),
    [ids, handoffs],
  )
  const [hover, setHover] = useState<string | undefined>()
  const focus = hover ?? selectedId

  const touches = (e: { from: string; to: string }) => !focus || e.from === focus || e.to === focus
  const comms = COMMUNICATIONS.filter(
    (c) => layout.positions.has(c.from) && layout.positions.has(c.to),
  )
  const statuses = new Set<EdgeStatus>(handoffs.map((h) => h.status))
  // Agents that hand nothing to each other still run in a fixed order; show that order.
  const sequence = useMemo(() => {
    if (handoffs.length > 0) return []
    return ids.slice(1).map((to, i) => {
      const from = ids[i]!
      const a = layout.positions.get(from)!
      const b = layout.positions.get(to)!
      const sameRow = Math.abs(a.y - b.y) < 1
      const midY = a.y + NODE_H + (b.y - a.y - NODE_H) / 2
      const d = sameRow
        ? `M${a.x + NODE_W},${a.y + NODE_H / 2} H${b.x}`
        : `M${a.x + NODE_W / 2},${a.y + NODE_H} V${midY} H${b.x + NODE_W / 2} V${b.y}`
      const started = tasks.some((t) => t.assigneeId === to && !!t.actualStart)
      return { key: `${from}>${to}`, d, started, from, to }
    })
  }, [handoffs, ids, layout, tasks])

  return (
    <Viewport
      label="Agent orchestration graph"
      contentWidth={layout.width}
      contentHeight={layout.height + 70}
      fitKey={ids.join(',')}
      minFitZoom={0.55}
      onBackgroundClick={() => onSelect(undefined)}
      overlay={
        <ul className="legend" aria-label="Legend">
          {(['running', 'completed', 'blocked', 'failed', 'idle'] as AgentState[]).map((s) => (
            <li key={s}>
              <Glyph kind={s} size={12} /> {AGENT_STATE_LABEL[s]}
            </li>
          ))}
          {(handoffs.length > 0 || comms.length > 0 || sequence.length > 0) && (
            <li className="legend__sep" aria-hidden="true" />
          )}
          {statuses.has('active') && (
            <li>
              <svg width="26" height="8" aria-hidden="true">
                <line
                  x1="1"
                  y1="4"
                  x2="25"
                  y2="4"
                  stroke="var(--cyan)"
                  strokeWidth="2"
                  strokeDasharray="5 3"
                />
              </svg>{' '}
              Handoff in progress
            </li>
          )}
          {sequence.length > 0 && (
            <>
              <li>
                <svg width="26" height="8" aria-hidden="true">
                  <line x1="1" y1="4" x2="25" y2="4" stroke={EDGE_COLOR.done} strokeWidth="2" />
                </svg>{' '}
                Runs next (already started)
              </li>
              <li>
                <svg width="26" height="8" aria-hidden="true">
                  <line
                    x1="1"
                    y1="4"
                    x2="25"
                    y2="4"
                    stroke={EDGE_COLOR.pending}
                    strokeWidth="2"
                    strokeDasharray="5 4"
                  />
                </svg>{' '}
                Runs next (waiting)
              </li>
            </>
          )}
          {handoffs.length > 0 && (
            <li>
              <svg width="26" height="8" aria-hidden="true">
                <line x1="1" y1="4" x2="25" y2="4" stroke="#6a7385" strokeWidth="2" />
              </svg>{' '}
              Delivered (label on hover)
            </li>
          )}
          {handoffs.length > 0 && (
            <li>
              <svg width="26" height="8" aria-hidden="true">
                <line
                  x1="1"
                  y1="4"
                  x2="25"
                  y2="4"
                  stroke="var(--st-blocked)"
                  strokeWidth="2"
                  strokeDasharray="2 3"
                />
              </svg>{' '}
              Stalled
            </li>
          )}
          {comms.length > 0 && (
            <li>
              <svg width="26" height="8" aria-hidden="true">
                <line
                  x1="1"
                  y1="4"
                  x2="25"
                  y2="4"
                  stroke="var(--violet)"
                  strokeWidth="1.5"
                  strokeDasharray="1 3"
                  strokeLinecap="round"
                />
              </svg>{' '}
              Feedback
            </li>
          )}
        </ul>
      }
    >
      {() => (
        <>
          <defs>
            {(['done', 'active', 'stalled', 'pending'] as EdgeStatus[]).map((s) => (
              <marker
                key={s}
                id={`arrow-${s}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M1 1 9 5 1 9Z" fill={EDGE_COLOR[s]} />
              </marker>
            ))}
            <marker
              id="arrow-comm"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M1 1 9 5 1 9Z" fill="var(--violet)" />
            </marker>
          </defs>

          {sequence.map((s) => (
            <path
              key={s.key}
              d={s.d}
              fill="none"
              stroke={s.started ? EDGE_COLOR.done : EDGE_COLOR.pending}
              strokeWidth={2}
              strokeDasharray={s.started ? undefined : '5 4'}
              markerEnd={`url(#arrow-${s.started ? 'done' : 'pending'})`}
              opacity={!focus || s.from === focus || s.to === focus ? 1 : 0.25}
            />
          ))}
          {handoffs.map((h) => (
            <Edge
              key={h.id}
              edge={h}
              layout={layout.positions}
              dim={!touches(h)}
              showLabel={h.status !== 'done' || (!!focus && (h.from === focus || h.to === focus))}
            />
          ))}
          {comms.map((c, i) => {
            const r = route(layout.positions.get(c.from)!, layout.positions.get(c.to)!, i * 36)
            const dim = !touches(c)
            return (
              <g key={c.id} opacity={dim ? 0.2 : 1}>
                <title>{`${c.label}: ${c.from} to ${c.to}`}</title>
                <path
                  d={r.d}
                  fill="none"
                  stroke="var(--violet)"
                  strokeWidth={1.5}
                  strokeDasharray="1 4"
                  strokeLinecap="round"
                  markerEnd="url(#arrow-comm)"
                />
                <EdgeLabel at={r.mid} text={c.label} color="var(--violet)" />
              </g>
            )
          })}

          {agents.map((a) => {
            const pos = layout.positions.get(a.id)!
            const state = deriveAgentState(a.id, tasks)
            const current = currentTaskOf(a.id, tasks)
            const counts = agentTaskCounts(a.id, tasks)
            const total = Object.values(counts).reduce((s, n) => s + n, 0)
            const dim =
              !!focus &&
              focus !== a.id &&
              !handoffs
                .concat(comms.map((c) => ({ ...c, pairs: [], status: 'done' as const })))
                .some(
                  (e) => (e.from === focus && e.to === a.id) || (e.to === focus && e.from === a.id),
                )
            return (
              <AgentNode
                key={a.id}
                agent={a}
                pos={pos}
                state={state}
                current={current}
                done={counts.completed}
                total={total}
                selected={selectedId === a.id}
                dim={dim}
                onSelect={() => onSelect(a.id)}
                onHover={(on) => setHover(on ? a.id : undefined)}
              />
            )
          })}
        </>
      )}
    </Viewport>
  )
}

function EdgeLabel({ at, text, color }: { at: Point; text: string; color: string }) {
  const w = text.length * 6.1 + 14
  return (
    <g transform={`translate(${at.x} ${at.y})`}>
      <rect
        x={-w / 2}
        y={-9}
        width={w}
        height={18}
        rx={4}
        fill="var(--bg-0)"
        stroke="var(--line-strong)"
      />
      <text textAnchor="middle" y={4} fontSize={10.5} fill={color} fontWeight={560}>
        {text}
      </text>
    </g>
  )
}

function Edge({
  edge,
  layout,
  dim,
  showLabel,
}: {
  edge: HandoffEdge
  layout: Map<string, Point>
  dim: boolean
  showLabel: boolean
}) {
  const from = layout.get(edge.from)
  const to = layout.get(edge.to)
  if (!from || !to) return null
  const r = route(from, to)
  const color = EDGE_COLOR[edge.status]
  const dash =
    edge.status === 'active'
      ? '6 4'
      : edge.status === 'stalled'
        ? '2 4'
        : edge.status === 'pending'
          ? '1 5'
          : undefined
  const label = edge.status === 'done' ? edge.label : `${edge.label}`
  return (
    <g opacity={dim ? 0.18 : 1} className={edge.status === 'active' ? 'edge edge--active' : 'edge'}>
      <title>{`${edge.label}: ${edge.from} to ${edge.to} (${edge.status})`}</title>
      <path
        d={r.d}
        fill="none"
        stroke={color}
        strokeWidth={edge.status === 'done' ? 1.5 : 2}
        strokeDasharray={dash}
        strokeLinecap={edge.status === 'pending' ? 'round' : undefined}
        markerEnd={`url(#arrow-${edge.status})`}
      />
      {showLabel && (
        <EdgeLabel
          at={r.mid}
          text={clip(label, 22)}
          color={edge.status === 'done' || edge.status === 'pending' ? 'var(--text-2)' : color}
        />
      )}
    </g>
  )
}

function AgentNode({
  agent,
  pos,
  state,
  current,
  done,
  total,
  selected,
  dim,
  onSelect,
  onHover,
}: {
  agent: Agent
  pos: Point
  state: AgentState
  current?: Task
  done: number
  total: number
  selected: boolean
  dim: boolean
  onSelect: () => void
  onHover: (on: boolean) => void
}) {
  const color = STATE_COLOR[state]
  const progress = current ? current.progress : total > 0 ? (done / total) * 100 : 0
  const barW = NODE_W - 24
  return (
    <g
      className={`node${selected ? ' node--selected' : ''}`}
      transform={`translate(${pos.x} ${pos.y})`}
      opacity={dim ? 0.35 : 1}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${agent.name}, ${AGENT_STATE_LABEL[state]}${current ? `, working on ${current.id} ${current.title}` : ''}`}
      onClick={(e: { stopPropagation: () => void }) => {
        e.stopPropagation()
        onSelect()
      }}
      onKeyDown={(e: { key: string; preventDefault: () => void }) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
    >
      <rect className="node__box" width={NODE_W} height={NODE_H} rx={6} />
      <rect width={4} height={NODE_H} rx={2} fill={color} />
      <g transform="translate(16 14)">
        <Glyph kind={state} size={14} />
      </g>
      <text x={36} y={26} fontSize={13.5} fontWeight={650} fill="var(--text-1)">
        {clip(agent.name, 20)}
      </text>
      <text x={NODE_W - 12} y={26} fontSize={11} textAnchor="end" fill={color} fontWeight={600}>
        {AGENT_STATE_LABEL[state]}
      </text>
      <text x={16} y={44} fontSize={11} fill="var(--text-3)">
        {clip(agent.role, 36)}
      </text>
      <text x={16} y={64} fontSize={11.5} fill="var(--text-2)" className="mono">
        {current ? current.id : 'No active task'}
      </text>
      <text
        x={current ? 66 : 16}
        y={64}
        fontSize={11.5}
        fill="var(--text-1)"
        display={current ? undefined : 'none'}
      >
        {current ? clip(current.title, 26) : ''}
      </text>
      <rect x={12} y={76} width={barW} height={5} rx={2.5} fill="var(--bg-3)" />
      <rect x={12} y={76} width={(barW * progress) / 100} height={5} rx={2.5} fill={color} />
      <text x={16} y={98} fontSize={10.5} fill="var(--text-3)">
        {`${done} of ${total} tasks done`}
      </text>
      <text x={NODE_W - 12} y={98} fontSize={10.5} fill="var(--text-3)" textAnchor="end">
        {current ? `${Math.round(progress)}%` : ''}
      </text>
    </g>
  )
}
