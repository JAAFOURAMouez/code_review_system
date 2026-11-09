import { Empty, Glyph, AGENT_STATUS_LABEL } from '../design/ui.tsx'
import { fmtDuration, plural } from '../format.ts'
import { peakParallelism, stages, timeline } from '../pipeline.ts'
import { navigate } from '../state/router.ts'
import { useServerNow, useWorkspace } from '../state/store.ts'
import type { AgentInfo, AgentRun, AgentStatus, CurrentRun } from '../types.ts'

// Graph geometry (SVG units).
const W = 920
const NODE_W = 210
const NODE_H = 58
const GAP = 16
const FILE_X = 0
const FILE_W = 140
const FIRST_X = 200
const PAR_X = 500
const TOOL_X = PAR_X + NODE_W + 34

function statusLine(a: AgentRun | undefined, now: number): string {
  if (!a) return 'Not in this review'
  if (a.status === 'running')
    return a.startedAt ? `Running, ${fmtDuration(now - a.startedAt)}` : 'Running'
  if (a.status === 'ok') return `Done in ${fmtDuration(a.durationMs)}`
  if (a.status === 'failed') return 'Failed'
  if (a.status === 'skipped') return 'Skipped by the planner'
  return 'Waiting'
}

function edgeState(status: AgentStatus | undefined): string {
  return status === 'running'
    ? 'live'
    : status === 'ok'
      ? 'done'
      : status === 'failed'
        ? 'failed'
        : status === 'skipped'
          ? 'skipped'
          : 'idle'
}

/** The tool a tool-loop agent calls, as shown next to it. */
function toolLabel(info: AgentInfo): string | null {
  if (!info.usesTools) return null
  return info.tools.includes('run_tests') && !info.tools.includes('run_pylint')
    ? 'pytest'
    : 'linters, pytest'
}

function AgentNode({
  info,
  run,
  x,
  y,
  now,
}: {
  info: AgentInfo
  run: CurrentRun
  x: number
  y: number
  now: number
}) {
  const a = run.agents[info.id]
  const open = () => navigate('results', { agent: info.id })
  return (
    <g
      className={`gnode gnode--${a?.status ?? 'pending'}`}
      role="link"
      tabIndex={0}
      aria-label={`${info.name}: ${a ? AGENT_STATUS_LABEL[a.status] : 'not run'}. Open its result.`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      {a?.status === 'skipped' && a.reason && <title>{`Skipped: ${a.reason}`}</title>}
      <rect x={x} y={y} width={NODE_W} height={NODE_H} rx="8" className="gnode__box" />
      <g transform={`translate(${x + 14} ${y + 14})`}>
        <Glyph kind={a?.status ?? 'pending'} size={15} />
      </g>
      <text x={x + 38} y={y + 25} className="gnode__name">
        {info.name}
      </text>
      <text x={x + 38} y={y + 43} className="gnode__status">
        {statusLine(a, now)}
      </text>
      {a?.approved && (
        <text x={x + NODE_W - 12} y={y + 25} textAnchor="end" className="gnode__approved">
          ✓ approved
        </text>
      )}
    </g>
  )
}

function Graph({ run, agents, now }: { run: CurrentRun; agents: AgentInfo[]; now: number }) {
  const { first, parallel, links } = stages(agents)
  const dependent = new Set(links.map(([, to]) => to))
  const H = Math.max(parallel.length, first.length, 1) * (NODE_H + GAP) - GAP
  const midY = H / 2
  const firstTop = midY - (first.length * (NODE_H + GAP) - GAP) / 2
  const firstStatus = first.length ? run.agents[first[first.length - 1].id]?.status : 'ok'
  return (
    <svg
      className="graph"
      viewBox={`-2 -2 ${W + 4} ${H + 4}`}
      role="group"
      aria-label="The review pipeline and the state of each agent"
    >
      <defs>
        <marker
          id="g-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0 L8 4 L0 8 z" className="graph__arrowhead" />
        </marker>
      </defs>

      {/* the file */}
      <g className="gfile">
        <rect x={FILE_X} y={midY - 34} width={FILE_W} height="68" rx="8" />
        <text x={FILE_X + 14} y={midY - 8} className="gnode__status">
          File under review
        </text>
        <text x={FILE_X + 14} y={midY + 13} className="gfile__name">
          {(run.file.split('/').pop() ?? run.file).slice(0, 18)}
        </text>
      </g>

      {/* file -> first stage (one after another) */}
      {first.map((info, i) => {
        const y = firstTop + i * (NODE_H + GAP)
        const fromX = i === 0 ? FILE_X + FILE_W : FIRST_X + NODE_W / 2
        const d = i === 0 ? `M${fromX} ${midY} H${FIRST_X - 2}` : `M${fromX} ${y - GAP} V${y - 2}`
        return (
          <path
            key={`e-${info.id}`}
            d={d}
            className={`gedge gedge--${edgeState(run.agents[info.id]?.status)}`}
            markerEnd="url(#g-arrow)"
          />
        )
      })}
      {first.map((info, i) => (
        <AgentNode
          key={info.id}
          info={info}
          run={run}
          x={FIRST_X}
          y={firstTop + i * (NODE_H + GAP)}
          now={now}
        />
      ))}

      {/* first stage -> parallel agents: the findings fan out */}
      {parallel.map((info, i) => {
        if (dependent.has(info.id)) return null // linked to its dependency below
        const cy = i * (NODE_H + GAP) + NODE_H / 2
        const x0 = FIRST_X + NODE_W
        const d = `M${x0} ${midY} C ${x0 + 60} ${midY}, ${PAR_X - 60} ${cy}, ${PAR_X - 2} ${cy}`
        const state = firstStatus === 'ok' ? edgeState(run.agents[info.id]?.status) : 'idle'
        return (
          <path
            key={`f-${info.id}`}
            d={d}
            className={`gedge gedge--${state}`}
            markerEnd="url(#g-arrow)"
          />
        )
      })}

      {/* an agent that uses another agent's result: a short arrow from that agent */}
      {links.map(([from, to]) => {
        const a = parallel.findIndex((p) => p.id === from)
        const b = parallel.findIndex((p) => p.id === to)
        if (a < 0 || b < 0) return null
        const x = PAR_X + NODE_W / 2
        const y0 = a * (NODE_H + GAP) + NODE_H
        const y1 = b * (NODE_H + GAP)
        return (
          <g key={`d-${from}-${to}`}>
            <path
              d={`M${x} ${y0} V${y1 - 2}`}
              className={`gedge gedge--${edgeState(run.agents[to]?.status)}`}
              markerEnd="url(#g-arrow)"
            />
            <text x={x + 10} y={(y0 + y1) / 2 + 3} className="gedge__label">
              passes its tests
            </text>
          </g>
        )
      })}

      {parallel.map((info, i) => {
        const y = i * (NODE_H + GAP)
        const tool = toolLabel(info)
        const status = run.agents[info.id]?.status
        return (
          <g key={info.id}>
            <AgentNode info={info} run={run} x={PAR_X} y={y} now={now} />
            {tool && (
              <g className={`gtool${status === 'running' ? ' gtool--live' : ''}`}>
                <path
                  d={`M${PAR_X + NODE_W} ${y + NODE_H / 2 - 6} H${TOOL_X - 2}`}
                  className="gloop"
                  markerEnd="url(#g-arrow)"
                />
                <path
                  d={`M${TOOL_X} ${y + NODE_H / 2 + 6} H${PAR_X + NODE_W + 2}`}
                  className="gloop"
                  markerEnd="url(#g-arrow)"
                />
                <rect x={TOOL_X} y={y + NODE_H / 2 - 15} width={W - TOOL_X} height="30" rx="15" />
                <text x={TOOL_X + (W - TOOL_X) / 2} y={y + NODE_H / 2 + 4} textAnchor="middle">
                  {tool}
                </text>
              </g>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** The same pipeline as a list, for narrow screens. */
function Stack({ run, agents, now }: { run: CurrentRun; agents: AgentInfo[]; now: number }) {
  const { first, parallel } = stages(agents)
  const row = (info: AgentInfo) => {
    const a = run.agents[info.id]
    return (
      <li key={info.id}>
        <button
          type="button"
          className="agentrow"
          onClick={() => navigate('results', { agent: info.id })}
        >
          <Glyph kind={a?.status ?? 'pending'} />
          <span className="agentrow__text">
            <span className="agentrow__name">{info.name}</span>
            <span className="agentrow__sub muted">
              {statusLine(a, now)}
              {toolLabel(info) ? `, uses ${toolLabel(info)}` : ''}
              {a?.status === 'skipped' && a.reason ? `: ${a.reason}` : ''}
            </span>
          </span>
        </button>
      </li>
    )
  }
  return (
    <ol className="stack" aria-label="Pipeline">
      <li className="stack__label">First</li>
      {first.map(row)}
      <li className="stack__label">Then the planner's choice, at the same time</li>
      {parallel.map(row)}
    </ol>
  )
}

function Timeline({ run, agents, now }: { run: CurrentRun; agents: AgentInfo[]; now: number }) {
  const order = agents.map((a) => a.id)
  const { bars, totalMs } = timeline(run, order, now)
  const byId = new Map(bars.map((b) => [b.id, b]))
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <div className="tl" role="table" aria-label="When each agent ran">
      {agents.map((info) => {
        const bar = byId.get(info.id)
        const a = run.agents[info.id]
        return (
          <div className="tl__row" role="row" key={info.id}>
            <span className="tl__name" role="rowheader">
              {info.name}
            </span>
            <span className="tl__track" role="cell">
              {bar ? (
                <span
                  className={`tl__bar tl__bar--${bar.status}`}
                  style={{
                    left: `${bar.from * 100}%`,
                    width: `max(3px, ${(bar.to - bar.from) * 100}%)`,
                  }}
                  title={`${info.name}: ${statusLine(a, now)}`}
                />
              ) : (
                <span className="tl__none muted">
                  {a?.status === 'skipped'
                    ? `Skipped: ${a.reason ?? 'not needed for this file'}`
                    : a
                      ? 'Not started'
                      : 'Not in this review'}
                </span>
              )}
            </span>
            <span className="tl__dur mono" role="cell">
              {a?.status === 'running' && a.startedAt
                ? fmtDuration(now - a.startedAt)
                : fmtDuration(a?.durationMs)}
            </span>
          </div>
        )
      })}
      <div className="tl__axis" aria-hidden="true">
        <span />
        <span className="tl__ticks">
          {ticks.map((t) => (
            <span key={t} style={{ left: `${t * 100}%` }}>
              {fmtDuration(t * totalMs)}
            </span>
          ))}
        </span>
        <span />
      </div>
    </div>
  )
}

export function Orchestration() {
  const ws = useWorkspace()
  const run = ws.current
  const now = useServerNow(run?.outcome === 'in_progress')
  if (!run) {
    return (
      <div className="page">
        <Empty title="No review yet">The pipeline appears here once a review starts.</Empty>
      </div>
    )
  }
  const agents = ws.agents.filter((a) => run.agents[a.id])
  const { first, parallel } = stages(agents)
  const skipped = parallel.filter((p) => run.agents[p.id]?.status === 'skipped').length
  const plan = run.agents.planner?.result as { summary?: string } | null | undefined
  const peak = peakParallelism(run, now)
  const firstDone = first.every((f) => run.agents[f.id]?.status === 'ok')
  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1>Orchestration</h1>
          <p className="muted">
            {first.map((f) => f.name).join(' and the ')} run first. The planner then picks, from the
            file and the findings, which of the {plural(parallel.length, 'model agent')} are worth
            running; those run at the same time. The code correction waits for the test generator
            and uses its tests to check the fix. Select an agent to open its result.
            {skipped > 0 && ` ${plan?.summary ?? `${skipped} skipped.`}`}
          </p>
        </div>
      </header>
      <section className="panel">
        <div className="panel__body graphwrap">
          <Graph run={run} agents={agents} now={now} />
          <Stack run={run} agents={agents} now={now} />
        </div>
      </section>
      <section className="panel">
        <div className="panel__head">
          <h2>When each agent ran</h2>
          <span className="muted">
            {run.outcome === 'in_progress' && !firstDone
              ? 'Static analysis is running'
              : `Up to ${plural(peak, 'agent')} at the same time`}
          </span>
        </div>
        <div className="panel__body">
          <Timeline run={run} agents={agents} now={now} />
        </div>
      </section>
    </div>
  )
}
