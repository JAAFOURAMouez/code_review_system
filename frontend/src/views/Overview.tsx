import { useState } from 'react'
import { Glyph, Meter, StateBadge, DemoTag, Empty, taskGlyphKind } from '../design/ui.tsx'
import { fmtDate, fmtPct } from '../design/format.ts'
import {
  actualProgress,
  agentName,
  attentionItems,
  computeLiveMetrics,
  currentTaskOf,
  deriveAgentState,
  expectedProgress,
  formatDuration,
  relativeTime,
  statusCounts,
  summarizeMilestones,
  summarizePhases,
} from '../domain/rules.ts'
import { HOUR, type EventStatus } from '../domain/types.ts'
import { navigate } from '../state/router.ts'
import { useApp, useWorkspace } from '../state/store.ts'
import { StatusBar } from '../viz/Charts.tsx'

const EVENT_GLYPH: Record<EventStatus, 'completed' | 'failed' | 'running' | 'blocked' | 'idle'> = {
  success: 'completed',
  failed: 'failed',
  running: 'running',
  warning: 'blocked',
  info: 'idle',
}

export function Overview() {
  const ws = useWorkspace()
  const { repoKind } = useApp()
  const [showAllAttention, setShowAllAttention] = useState(false)
  const runId = ws.project.currentRunId
  const run = ws.runs.find((r) => r.id === runId)!
  const counts = statusCounts(ws.tasks)
  const expected = expectedProgress(ws.tasks, ws.now)
  const actual = actualProgress(ws.tasks)
  const behind = expected - actual
  const metrics = computeLiveMetrics(ws, runId)
  const attention = attentionItems(ws)
  const phases = summarizePhases(ws)
  const activePhase =
    phases.find((p) => p.state === 'active') ?? phases.find((p) => p.state === 'upcoming')
  const milestones = summarizeMilestones(ws)
  const nextMilestones = milestones.filter((m) => m.state !== 'achieved').slice(0, 4)
  const planEnd = Math.max(...ws.tasks.map((t) => t.plannedEnd))
  const plannedTotal = planEnd - run.startedAt
  const recent = ws.events
    .filter((e) => e.runId === runId)
    .slice(-8)
    .reverse()
  const errors = ws.events
    .filter(
      (e) =>
        e.runId === runId && (e.type === 'error' || (e.type === 'retry' && e.recovered === false)),
    )
    .slice(-4)
    .reverse()
  const interventions = ws.events
    .filter((e) => e.runId === runId && e.type === 'intervention')
    .slice(-3)
    .reverse()
  const queued = counts.ready + counts.backlog

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1>{ws.project.name}</h1>
          <p>{ws.project.objective}</p>
        </div>
        <div className="page__actions">
          <DemoTag />
        </div>
      </div>

      <div className="ov-grid">
        <section className="panel ov-attn" aria-labelledby="attn-h">
          <div className="panel__head">
            <h2 id="attn-h">Needs attention</h2>
            <span className="count">{attention.length}</span>
          </div>
          {attention.length === 0 ? (
            <Empty title="Nothing needs you right now">
              Failures, blocked tasks and reviews will appear here as they happen.
            </Empty>
          ) : (
            <ul className="rows">
              {(showAllAttention ? attention : attention.slice(0, 5)).map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className="row-btn attn"
                    onClick={() =>
                      navigate('tasks', a.taskId ? { task: a.taskId } : { view: 'timeline' })
                    }
                  >
                    <Glyph
                      kind={
                        a.severity === 'critical'
                          ? 'failed'
                          : a.kind === 'review'
                            ? 'review'
                            : 'blocked'
                      }
                      size={15}
                    />
                    <span className="attn__text">
                      <strong>{a.title}</strong>
                      <span className="muted">{a.detail}</span>
                    </span>
                    <span className="faint attn__time">{relativeTime(a.since, ws.now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attention.length > 5 && (
            <div className="panel__foot">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-expanded={showAllAttention}
                onClick={() => setShowAllAttention(!showAllAttention)}
              >
                {showAllAttention ? 'Show fewer' : `Show ${attention.length - 5} more`}
              </button>
            </div>
          )}
        </section>

        <div className="ov-stack">
          <section className="panel ov-obj" aria-labelledby="obj-h">
            <div className="panel__head">
              <h2 id="obj-h">Objective progress</h2>
              <span className="spacer" />
              <span className={`badge ${behind > 3 ? 'badge--blocked' : 'badge--completed'}`}>
                {behind > 3 ? `${Math.round(behind)} pts behind plan` : 'On plan'}
              </span>
            </div>
            <div className="panel__body obj">
              <div className="obj__nums">
                <span className="obj__big">{Math.round(actual)}%</span>
                <span className="muted">
                  complete, against {Math.round(expected)}% expected by now
                </span>
              </div>
              <div className="plan" aria-hidden="true">
                <div className="meter">
                  <span style={{ width: `${actual}%` }} />
                </div>
                <i
                  className="plan__tick"
                  style={{ left: `${expected}%` }}
                  title={`Expected ${Math.round(expected)}%`}
                />
              </div>
              <p className="faint obj__legend">
                Bar is actual progress, weighted by planned duration. The vertical tick marks where
                the plan says it should be today.
              </p>
              <dl className="kv obj__kv">
                <dt>Current phase</dt>
                <dd>
                  {activePhase ? `${activePhase.phase.name}: ${activePhase.phase.summary}` : 'None'}
                </dd>
                <dt>Run</dt>
                <dd>
                  <span className="mono">{run.id}</span> · {run.config}
                </dd>
                <dt>Elapsed</dt>
                <dd>
                  {formatDuration(metrics.durationMs)} of about {formatDuration(plannedTotal)}{' '}
                  planned
                </dd>
              </dl>
            </div>
          </section>
          <section className="panel" aria-labelledby="st-h">
            <div className="panel__head">
              <h2 id="st-h">Tasks</h2>
              <span className="spacer" />
              <button type="button" className="btn btn--sm" onClick={() => navigate('tasks')}>
                Open task board
              </button>
            </div>
            <div className="panel__body ov-tasks">
              <div className="ov-tasks__bar">
                <StatusBar counts={counts} onPick={(s) => navigate('tasks', { status: s })} />
              </div>
              <div className="kpis">
                <Kpi label="Running" value={String(counts.running)} />
                <Kpi
                  label="Queued"
                  value={String(queued)}
                  sub={`${counts.ready} ready, ${counts.backlog} backlog`}
                />
                <Kpi
                  label="Blocked"
                  value={String(counts.blocked)}
                  tone={counts.blocked ? 'warn' : undefined}
                />
                <Kpi label="Completed" value={`${counts.completed}/${ws.tasks.length}`} />
              </div>
            </div>
          </section>
        </div>
      </div>

      <div className="ov-cols">
        <section className="panel" aria-labelledby="ag-h">
          <div className="panel__head">
            <h2 id="ag-h">Agents</h2>
            <span className="spacer" />
            <button type="button" className="btn btn--sm" onClick={() => navigate('orchestration')}>
              Open graph
            </button>
          </div>
          <ul className="rows">
            {ws.agents.map((a) => {
              const state = deriveAgentState(a.id, ws.tasks)
              const cur = currentTaskOf(a.id, ws.tasks)
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    className="row-btn agentrow"
                    onClick={() => navigate('orchestration', { agent: a.id })}
                  >
                    <Glyph kind={state} size={14} />
                    <span className="agentrow__name">{a.name}</span>
                    <span className="agentrow__task truncate muted">
                      {cur
                        ? `${cur.id} ${cur.title}`
                        : state === 'completed'
                          ? 'All assigned work done'
                          : 'No active task'}
                    </span>
                    <span className="agentrow__state">
                      <StateBadge kind={state} />
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>

        <div className="ov-stack">
          <section className="panel" aria-labelledby="ph-h">
            <div className="panel__head">
              <h2 id="ph-h">Phases and milestones</h2>
              <span className="spacer" />
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => navigate('tasks', { view: 'timeline' })}
              >
                Open timeline
              </button>
            </div>
            <div className="panel__body phases">
              {phases.map((p) => (
                <div key={p.phase.id} className="phase">
                  <div className="phase__top">
                    <span>
                      {p.state === 'completed' ? (
                        <Glyph kind="completed" size={12} />
                      ) : p.state === 'active' ? (
                        <Glyph kind="running" size={12} />
                      ) : (
                        <Glyph kind="backlog" size={12} />
                      )}{' '}
                      {p.phase.name}
                    </span>
                    <span className="faint">
                      {Math.round(p.actual)}%
                      {p.state !== 'completed' && p.expected > 0
                        ? `, expected ${Math.round(p.expected)}%`
                        : ''}
                    </span>
                  </div>
                  <Meter
                    value={p.actual}
                    small
                    tone={p.state === 'completed' ? 'ok' : undefined}
                    label={`${p.phase.name} progress`}
                  />
                </div>
              ))}
              <h3 className="subhead">Upcoming milestones</h3>
              <ul className="ms-list">
                {nextMilestones.map((m) => (
                  <li key={m.milestone.id}>
                    <svg width="12" height="12" aria-hidden="true">
                      <path
                        d="M6 1 11 6 6 11 1 6Z"
                        fill="none"
                        stroke={
                          m.state === 'overdue'
                            ? 'var(--st-failed)'
                            : m.state === 'at_risk'
                              ? 'var(--st-blocked)'
                              : 'var(--text-2)'
                        }
                        strokeWidth="1.5"
                      />
                    </svg>
                    <span className="truncate">{m.milestone.name}</span>
                    <span
                      className={
                        m.state === 'overdue'
                          ? 'ms-flag ms-flag--bad'
                          : m.state === 'at_risk'
                            ? 'ms-flag ms-flag--warn'
                            : 'faint'
                      }
                    >
                      {m.state === 'overdue' ? 'Overdue' : m.state === 'at_risk' ? 'At risk' : ''}{' '}
                      {fmtDate(m.milestone.due)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      </div>

      <div className="ov-cols ov-cols--even">
        <section className="panel" aria-labelledby="ex-h">
          <div className="panel__head">
            <h2 id="ex-h">Execution and retries</h2>
            <DemoTag />
          </div>
          <div className="panel__body">
            <div className="kpis kpis--2">
              <Kpi
                label="Duration"
                value={formatDuration(metrics.durationMs)}
                sub="since run start"
              />
              <Kpi
                label="Per-step success"
                value={fmtPct(metrics.stepSuccessRate)}
                sub={`${metrics.stepsSucceeded} of ${metrics.stepsTotal} steps`}
              />
              <Kpi
                label="Retries"
                value={String(metrics.retries)}
                sub={`${metrics.recovered} recovered, ${metrics.retries - metrics.recovered} not`}
              />
              <Kpi
                label="Human interventions"
                value={String(metrics.interventions)}
                sub="in this run"
              />
            </div>
            <h3 className="subhead">Recent errors</h3>
            {errors.length === 0 ? (
              <p className="muted">No errors in this run.</p>
            ) : (
              <ul className="mini-events mini-events--errors">
                {errors.map((e) => (
                  <li key={e.id}>
                    <span className="faint mono">{relativeTime(e.at, ws.now)}</span>
                    <span>
                      <strong>{agentName(ws.agents, e.actorId)}</strong> {e.title}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {interventions.length > 0 && (
              <>
                <h3 className="subhead">Recent human interventions</h3>
                <ul className="mini-events">
                  {interventions.map((e) => (
                    <li key={e.id}>
                      <span className="faint mono">{relativeTime(e.at, ws.now)}</span>
                      <span>{e.title}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="ra-h">
          <div className="panel__head">
            <h2 id="ra-h">Recent activity</h2>
            <span className="spacer" />
            <button type="button" className="btn btn--sm" onClick={() => navigate('history')}>
              Open feed
            </button>
          </div>
          <ul className="rows">
            {recent.map((e) => (
              <li key={e.id} className="feedrow-mini">
                <Glyph kind={EVENT_GLYPH[e.status]} size={13} />
                <span className="feedrow-mini__text truncate">
                  <strong>{agentName(ws.agents, e.actorId)}</strong>{' '}
                  <span className="muted">{e.title}</span>
                </span>
                {e.simulated && <span className="demo-tag">Simulated</span>}
                <span className="faint feedrow-mini__time">{relativeTime(e.at, ws.now)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <p className="faint footnote">
        {repoKind === 'live'
          ? 'Real agent runs. Planned time is each agent’s time budget (the orchestrator’s timeout, one agent after another), so “behind plan” means slower than that budget.'
          : `Sample scenario generated in this browser. Progress is weighted by planned task duration; ${
              Math.round(((ws.now - run.startedAt) / HOUR / 24) * 10) / 10
            } days of a planned ${Math.round((plannedTotal / HOUR / 24) * 10) / 10}.`}
      </p>
    </div>
  )
}

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'warn'
}) {
  return (
    <div className="kpi">
      <div className="kpi__label">{label}</div>
      <div className={`kpi__value${tone === 'warn' ? ' kpi__value--warn' : ''}`}>{value}</div>
      {sub && <div className="kpi__sub">{sub}</div>}
    </div>
  )
}

export { taskGlyphKind }
