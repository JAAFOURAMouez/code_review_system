import { Empty, Glyph, OutcomeBadge, type StatusKind } from '../design/ui.tsx'
import { fmtDateTime, fmtDuration, fmtTime } from '../format.ts'
import { setParams, useRoute } from '../state/router.ts'
import { useWorkspace } from '../state/store.ts'
import type { ReviewEvent } from '../types.ts'

function eventKind(e: ReviewEvent): StatusKind {
  if (e.status === 'failed') return 'failed'
  if (e.status === 'warning') return 'partial'
  if (e.status === 'success') return 'ok'
  if (e.type === 'start') return 'running'
  return 'pending'
}

export function History() {
  const ws = useWorkspace()
  const route = useRoute()
  const runs = [...ws.runs].reverse()
  if (!runs.length) {
    return (
      <div className="page">
        <Empty title="No review yet" />
      </div>
    )
  }
  const selected = runs.find((r) => r.id === route.params.run) ?? runs[0]
  const names = new Map(ws.agents.map((a) => [a.id, a.name]))
  const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1)
  const events = ws.events.filter((e) => e.runId === selected.id).reverse()

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1>History</h1>
          <p className="muted">
            Every review on this server, newest first. Select one to see what happened.
          </p>
        </div>
      </header>
      <section className="panel">
        <div className="table-wrap">
          <table className="table runs">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Started</th>
                <th scope="col">Duration</th>
                <th scope="col">Outcome</th>
                <th scope="col">Agents done</th>
                <th scope="col">Approved</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  className={r.id === selected.id ? 'is-selected' : undefined}
                  aria-selected={r.id === selected.id}
                >
                  <td>
                    <button
                      type="button"
                      className="linkbtn mono"
                      onClick={() => setParams({ run: r.id })}
                    >
                      {r.file}
                    </button>
                  </td>
                  <td>{fmtDateTime(r.startedAt)}</td>
                  <td className="mono">{fmtDuration(r.durationMs)}</td>
                  <td>
                    <OutcomeBadge outcome={r.outcome} />
                  </td>
                  <td className="mono">
                    {r.agentsOk}/{r.agentsTotal}
                  </td>
                  <td className="mono">
                    {r.approved}/{r.agentsTotal}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="panel__head">
          <h2>
            What happened in the review of <span className="mono">{selected.file}</span>
          </h2>
          <span className="muted">{events.length} events</span>
        </div>
        <ol className="events">
          {events.map((e) => (
            <li key={e.id} className="events__row">
              <span className="events__time mono">{fmtTime(e.at)}</span>
              <Glyph kind={eventKind(e)} />
              <span className="events__text">
                <span>
                  {e.actorId === 'system' ? (
                    e.title
                  ) : (
                    <>
                      <strong>
                        {e.actorId === 'human' ? 'You' : (names.get(e.actorId) ?? e.actorId)}
                      </strong>{' '}
                      {lower(e.title)}
                    </>
                  )}
                </span>
                {e.detail && <span className="muted events__detail">{e.detail}</span>}
              </span>
              {e.durationMs !== undefined && (
                <span className="events__dur mono muted">{fmtDuration(e.durationMs)}</span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
