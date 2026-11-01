import { useMemo, useState } from 'react'
import { DemoTag, Empty, Glyph, SearchInput, Switch } from '../design/ui.tsx'
import { fmtCompact, fmtDateTime, fmtTime, includesText } from '../design/format.ts'
import { agentName, relativeTime } from '../domain/rules.ts'
import {
  EVENT_TYPE_LABEL,
  type EventStatus,
  type EventType,
  type ExecutionEvent,
} from '../domain/types.ts'
import { navigate } from '../state/router.ts'
import { store, useApp, useWorkspace } from '../state/store.ts'

const STATUS_GLYPH: Record<EventStatus, 'completed' | 'failed' | 'running' | 'blocked' | 'idle'> = {
  success: 'completed',
  failed: 'failed',
  running: 'running',
  warning: 'blocked',
  info: 'idle',
}
const STATUS_LABEL: Record<EventStatus, string> = {
  success: 'Succeeded',
  failed: 'Failed',
  running: 'In progress',
  warning: 'Warning',
  info: 'Info',
}
const OUTCOME_LABEL = {
  in_progress: 'In progress',
  succeeded: 'Succeeded',
  partial: 'Partial',
  failed: 'Failed',
} as const
const PAGE = 60

export function History() {
  const ws = useWorkspace()
  const { settings, repoKind } = useApp()
  const [q, setQ] = useState('')
  const [actor, setActor] = useState('all')
  const [type, setType] = useState<EventType | 'all'>('all')
  const [status, setStatus] = useState<EventStatus | 'all'>('all')
  const [runId, setRunId] = useState(ws.project.currentRunId)
  const [limit, setLimit] = useState(PAGE)
  const [openId, setOpenId] = useState<string | undefined>()

  const run = ws.runs.find((r) => r.id === runId)!
  const filtered = useMemo(() => {
    const list = ws.events.filter(
      (e) =>
        (runId === 'all' || e.runId === runId) &&
        (actor === 'all' || e.actorId === actor) &&
        (type === 'all' || e.type === type) &&
        (status === 'all' || e.status === status) &&
        includesText([e.title, e.detail, e.tool, e.taskId, agentName(ws.agents, e.actorId)], q),
    )
    return list.slice().reverse()
  }, [ws.events, ws.agents, runId, actor, type, status, q])

  const filtersActive = q !== '' || actor !== 'all' || type !== 'all' || status !== 'all'
  const clear = () => {
    setQ('')
    setActor('all')
    setType('all')
    setStatus('all')
  }
  const isLive = runId === ws.project.currentRunId
  const shown = filtered.slice(0, limit)

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1>Execution History</h1>
          <p>
            Every agent action, tool call, decision, error and human intervention, newest first.
          </p>
        </div>
        <div className="page__actions">
          <DemoTag>Demo data · simulated activity</DemoTag>
        </div>
      </div>

      <div className="panel">
        <div className="panel__body runbar">
          <label className="field">
            <span className="field-label">Run</span>
            <select
              className="select"
              value={runId}
              onChange={(e: { target: { value: string } }) => {
                setRunId(e.target.value)
                setLimit(PAGE)
              }}
            >
              <option value="all">All runs</option>
              {[...ws.runs].reverse().map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} · {r.label}
                </option>
              ))}
            </select>
          </label>
          {runId !== 'all' ? (
            <div className="runbar__info">
              <div>
                <strong>{run.label}</strong>{' '}
                <span
                  className={`badge badge--${run.outcome === 'succeeded' ? 'completed' : run.outcome === 'failed' ? 'failed' : run.outcome === 'partial' ? 'blocked' : 'running'}`}
                >
                  {OUTCOME_LABEL[run.outcome]}
                </span>
              </div>
              <p className="muted">{run.note}</p>
              <p className="faint">
                {run.config} · started {fmtDateTime(run.startedAt)}
              </p>
            </div>
          ) : (
            <p className="muted runbar__info">
              Showing events from all {ws.runs.length} runs.
              {repoKind === 'demo' && ' Earlier runs keep a short sample history.'}
            </p>
          )}
          {repoKind === 'demo' && isLive && (
            <div className="runbar__live">
              <span
                className={`livedot${settings.simulate ? ' livedot--on' : ''}`}
                aria-hidden="true"
              />
              <span>
                {settings.simulate ? 'Simulated updates running' : 'Simulated updates paused'}
              </span>
              <Switch
                checked={settings.simulate}
                onChange={(v) => store.updateSettings({ simulate: v })}
                label="Simulated updates"
              />
            </div>
          )}
        </div>
      </div>

      <div className="filters">
        <div className="filters__search">
          <SearchInput
            value={q}
            onChange={(v) => {
              setQ(v)
              setLimit(PAGE)
            }}
            placeholder="Search events, tools, task ids"
            label="Search events"
          />
        </div>
        <select
          className="select"
          value={actor}
          onChange={(e: { target: { value: string } }) => setActor(e.target.value)}
          aria-label="Filter by agent"
        >
          <option value="all">All agents</option>
          {ws.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          <option value="system">Orchestrator</option>
          <option value="human">You</option>
        </select>
        <select
          className="select"
          value={type}
          onChange={(e: { target: { value: string } }) =>
            setType(e.target.value as EventType | 'all')
          }
          aria-label="Filter by event type"
        >
          <option value="all">All event types</option>
          {(Object.keys(EVENT_TYPE_LABEL) as EventType[]).map((t) => (
            <option key={t} value={t}>
              {EVENT_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={status}
          onChange={(e: { target: { value: string } }) =>
            setStatus(e.target.value as EventStatus | 'all')
          }
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          {(Object.keys(STATUS_LABEL) as EventStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={clear}>
            Clear filters
          </button>
        )}
        <span className="faint filters__count" aria-live="polite">
          {filtered.length} events
        </span>
      </div>

      <div className="panel">
        {filtered.length === 0 ? (
          <Empty
            title="No events match"
            action={
              filtersActive ? (
                <button type="button" className="btn btn--sm" onClick={clear}>
                  Clear filters
                </button>
              ) : undefined
            }
          >
            {filtersActive
              ? 'Try removing a filter or searching for a task id like T-403.'
              : 'Events appear here as agents work.'}
          </Empty>
        ) : (
          <ol className="feed" aria-label="Event feed">
            {shown.map((e) => (
              <FeedRow
                key={e.id}
                e={e}
                open={openId === e.id}
                onToggle={() => setOpenId(openId === e.id ? undefined : e.id)}
              />
            ))}
          </ol>
        )}
        {filtered.length > shown.length && (
          <div className="feed__more">
            <button type="button" className="btn" onClick={() => setLimit(limit + PAGE)}>
              Show {Math.min(PAGE, filtered.length - shown.length)} older events
            </button>
            <span className="faint">{filtered.length - shown.length} not shown</span>
          </div>
        )}
      </div>
    </div>
  )
}

function FeedRow({
  e,
  open,
  onToggle,
}: {
  e: ExecutionEvent
  open: boolean
  onToggle: () => void
}) {
  const ws = useWorkspace()
  const hasMore = !!(e.detail || e.tool || e.tokens || e.durationMs || e.taskId)
  const id = `feed-${e.id}`
  return (
    <li className={`feedrow feedrow--${e.status}`}>
      <button
        type="button"
        className="feedrow__btn"
        aria-expanded={hasMore ? open : undefined}
        aria-controls={hasMore ? id : undefined}
        onClick={hasMore ? onToggle : undefined}
        disabled={!hasMore}
      >
        <span className="feedrow__time mono" title={fmtDateTime(e.at)}>
          {fmtTime(e.at)}
        </span>
        <span className="feedrow__status" title={STATUS_LABEL[e.status]}>
          <Glyph kind={STATUS_GLYPH[e.status]} size={14} />
          <span className="sr-only">{STATUS_LABEL[e.status]}</span>
        </span>
        <span className="feedrow__main">
          <span className="feedrow__title">
            <strong>{agentName(ws.agents, e.actorId)}</strong> {e.title}
          </span>
          <span className="feedrow__meta">
            <span className="chip">{EVENT_TYPE_LABEL[e.type]}</span>
            {e.taskId && <span className="chip mono">{e.taskId}</span>}
            {e.simulated && <span className="demo-tag">Simulated</span>}
            <span className="faint">{relativeTime(e.at, ws.now)}</span>
          </span>
        </span>
      </button>
      {open && hasMore && (
        <div className="feedrow__detail" id={id}>
          {e.detail && <p>{e.detail}</p>}
          <dl className="kv">
            <dt>Status</dt>
            <dd>{STATUS_LABEL[e.status]}</dd>
            <dt>Time</dt>
            <dd>{fmtDateTime(e.at)}</dd>
            {e.tool && (
              <>
                <dt>Tool</dt>
                <dd className="mono">{e.tool}</dd>
              </>
            )}
            {e.durationMs !== undefined && (
              <>
                <dt>Duration</dt>
                <dd>{(e.durationMs / 1000).toFixed(1)}s</dd>
              </>
            )}
            {e.tokens !== undefined && (
              <>
                <dt>Tokens</dt>
                <dd>{fmtCompact(e.tokens)}</dd>
              </>
            )}
            <dt>Run</dt>
            <dd className="mono">{e.runId}</dd>
          </dl>
          {e.taskId && ws.tasks.some((t) => t.id === e.taskId) && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => navigate('tasks', { task: e.taskId })}
            >
              Open {e.taskId}
            </button>
          )}
        </div>
      )}
    </li>
  )
}
