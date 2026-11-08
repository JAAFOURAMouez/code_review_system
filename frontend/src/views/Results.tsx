import { Empty, Glyph, Icon, Spinner, StatusBadge, AGENT_STATUS_LABEL } from '../design/ui.tsx'
import { fmtDateTime, fmtDuration } from '../format.ts'
import { stages } from '../pipeline.ts'
import { setParams, useRoute } from '../state/router.ts'
import { store, useServerNow, useWorkspace } from '../state/store.ts'
import type { AgentInfo, AgentRun, CommonResult, CurrentRun } from '../types.ts'
import { AgentResult, HowItWorked, resultSummary } from './AgentResult.tsx'

export function Results() {
  const ws = useWorkspace()
  const route = useRoute()
  const run = ws.current
  if (!run) {
    return (
      <div className="page">
        <Empty title="No review yet">Start one with New review.</Empty>
      </div>
    )
  }
  const known = ws.agents.filter((a) => run.agents[a.id])
  const { first, parallel } = stages(known)
  const selectedId =
    route.params.agent && run.agents[route.params.agent] ? route.params.agent : known[0]?.id
  const info = known.find((a) => a.id === selectedId)

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1>Results</h1>
          <p className="muted">
            <span className="mono">{run.file}</span>
            {run.lines ? `, ${run.lines} lines` : ''}. Started {fmtDateTime(run.startedAt)}
            {run.model ? ` with ${run.model}` : ''}.
          </p>
        </div>
      </header>
      <div className="results">
        <nav className="agentlist" aria-label="Agents">
          <p className="agentlist__stage">First</p>
          {first.map((a) => (
            <AgentRow key={a.id} info={a} run={run} selected={a.id === selectedId} />
          ))}
          <p className="agentlist__stage">Then, at the same time</p>
          {parallel.map((a) => (
            <AgentRow key={a.id} info={a} run={run} selected={a.id === selectedId} />
          ))}
        </nav>
        {info && <AgentDetail info={info} run={run} />}
      </div>
    </div>
  )
}

function AgentRow({
  info,
  run,
  selected,
}: {
  info: AgentInfo
  run: CurrentRun
  selected: boolean
}) {
  const a = run.agents[info.id]
  const summary = resultSummary(info.id, a)
  return (
    <button
      type="button"
      className={`agentrow${selected ? ' agentrow--on' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => setParams({ agent: info.id })}
    >
      <Glyph kind={a.status} />
      <span className="agentrow__text">
        <span className="agentrow__name">{info.name}</span>
        <span className="agentrow__sub muted truncate">
          {a.status === 'ok'
            ? summary
            : a.status === 'failed'
              ? 'Failed'
              : AGENT_STATUS_LABEL[a.status]}
        </span>
      </span>
      {a.approved && (
        <span className="agentrow__approved" title="Approved">
          <Icon name="check" size={14} />
        </span>
      )}
    </button>
  )
}

function AgentDetail({ info, run }: { info: AgentInfo; run: CurrentRun }) {
  const a: AgentRun = run.agents[info.id]
  const now = useServerNow(a.status === 'running')
  const busy = run.outcome === 'in_progress'
  return (
    <section className="detail panel" aria-labelledby="detail-title">
      <header className="detail__head">
        <div className="detail__title">
          <h2 id="detail-title">{info.name}</h2>
          <StatusBadge kind={a.status} label={AGENT_STATUS_LABEL[a.status]} />
        </div>
        <p className="muted">{info.role}.</p>
        <p className="detail__meta muted">
          {a.status === 'running' && a.startedAt
            ? `Running for ${fmtDuration(now - a.startedAt)}`
            : a.durationMs !== null
              ? `Took ${fmtDuration(a.durationMs)}`
              : 'Not started yet'}
          {a.attempts > 1 ? `, attempt ${a.attempts}` : ''}
          {info.model ? `, ${info.model}` : ', no language model'}
        </p>
        <div className="detail__actions">
          {a.status === 'ok' &&
            (a.approved ? (
              <span className="approved">
                <Icon name="check" size={14} /> Approved
              </span>
            ) : (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void store.approve(info.id, info.name)}
              >
                Approve
              </button>
            ))}
          {(a.status === 'ok' || a.status === 'failed') && (
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy}
              title={busy ? 'Wait for the review to finish' : undefined}
              onClick={() => void store.rerun(info.id, info.name)}
            >
              <Icon name="refresh" size={14} /> Re-run
            </button>
          )}
        </div>
      </header>
      <div className="detail__body">
        {a.status === 'pending' && (
          <p className="muted">
            {info.llm
              ? 'Waits for static analysis, whose findings it receives.'
              : 'Starts in a moment.'}
          </p>
        )}
        {a.status === 'running' && (
          <div className="detail__running">
            <Spinner label="Running" />
            <p className="muted">
              {info.usesTools
                ? 'Working with its tools. The result appears here when it is done.'
                : 'The result appears here when it is done.'}
            </p>
          </div>
        )}
        {a.status === 'failed' && (
          <div className="callout callout--failed" role="alert">
            <p>{a.problem ?? 'The agent failed.'}</p>
          </div>
        )}
        {a.status === 'ok' && <AgentResult id={info.id} run={a} file={run.file} />}
        {a.result && (a.status === 'ok' || a.status === 'failed') && (
          <HowItWorked result={a.result as CommonResult} llm={info.llm} />
        )}
      </div>
    </section>
  )
}
