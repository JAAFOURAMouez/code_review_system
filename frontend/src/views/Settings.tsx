import { fmtDuration } from '../format.ts'
import { KeyForm } from '../layout/NewReview.tsx'
import { store, useApp, useWorkspace } from '../state/store.ts'

export function Settings() {
  const { address, submitMode } = useApp()
  const ws = useWorkspace()
  const upload = submitMode === 'upload'
  return (
    <div className="page page--narrow">
      <header className="page__head">
        <div>
          <h1>Settings</h1>
        </div>
      </header>

      {upload && (
        <section className="panel" aria-labelledby="s-key">
          <div className="panel__head">
            <h2 id="s-key">Hugging Face key and model</h2>
          </div>
          <div className="panel__body">
            <KeyForm />
          </div>
        </section>
      )}

      <section className="panel" aria-labelledby="s-server">
        <div className="panel__head">
          <h2 id="s-server">Review server</h2>
        </div>
        <div className="panel__body">
          <dl className="kv">
            <dt>Address</dt>
            <dd className="mono">{address}</dd>
            <dt>Mode</dt>
            <dd>
              {upload
                ? 'Public: you paste or upload code and bring your own Hugging Face key.'
                : 'Local: reviews files in the project folder, with the key in its .env file.'}
            </dd>
            <dt>Reviews kept</dt>
            <dd>
              {upload ? (
                'For your session only. The server deletes it after a day without activity.'
              ) : (
                <>
                  In <code>.horizon/runs.json</code> in the project folder (the latest 50).
                </>
              )}
            </dd>
          </dl>
        </div>
      </section>

      <section className="panel" aria-labelledby="s-agents">
        <div className="panel__head">
          <h2 id="s-agents">Agents</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Model</th>
                <th scope="col">Tools</th>
                <th scope="col">Time limit</th>
              </tr>
            </thead>
            <tbody>
              {ws.agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.name}
                    <div className="muted">{a.role}</div>
                  </td>
                  <td className="mono">{a.model ?? 'none'}</td>
                  <td>
                    {a.tools.length ? a.tools.join(', ') : 'None; receives the linter findings'}
                  </td>
                  <td className="nowrap">{fmtDuration(a.budgetMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {upload && (
        <section className="panel" aria-labelledby="s-priv">
          <div className="panel__head">
            <h2 id="s-priv">Your data</h2>
          </div>
          <div className="panel__body">
            <p className="muted">
              Your reviews are tied to a private session id stored in this browser. Forgetting the
              session removes your key from this browser and starts a new, empty one.
            </p>
            <div className="actions">
              <button type="button" className="btn" onClick={() => store.forgetSession()}>
                Forget this session
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
