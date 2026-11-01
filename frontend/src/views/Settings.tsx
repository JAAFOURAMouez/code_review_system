import { DemoTag, Segmented, Switch } from '../design/ui.tsx'
import { KeyForm } from '../layout/NewReview.tsx'
import { store, useApp } from '../state/store.ts'
import type { Settings as S } from '../state/settings.ts'

export function Settings() {
  const { settings, repoKind, repoLabel, submitMode } = useApp()
  const set = (patch: Partial<S>) => store.updateSettings(patch)
  const demo = repoKind === 'demo'

  return (
    <div className="page page--narrow">
      <div className="page__head">
        <div>
          <h1>Settings</h1>
          <p>Preferences are saved in this browser.</p>
        </div>
      </div>

      {submitMode === 'upload' && (
        <>
          <section className="panel" aria-labelledby="s-key">
            <div className="panel__head">
              <h2 id="s-key">Hugging Face access</h2>
            </div>
            <div className="panel__body">
              <KeyForm />
            </div>
          </section>
          <section className="panel" aria-labelledby="s-priv">
            <div className="panel__head">
              <h2 id="s-priv">Your data</h2>
            </div>
            <div className="panel__body">
              <p className="muted setting__help">
                Your reviews are tied to a private session id stored in this browser. The server
                deletes a session, with its code and results, after a day without activity. You can
                also remove everything now: this deletes your key from this browser and starts a
                new, empty session.
              </p>
              <button type="button" className="btn" onClick={() => store.forgetSession()}>
                Forget this session
              </button>
            </div>
          </section>
        </>
      )}

      <section className="panel" aria-labelledby="s-src">
        <div className="panel__head">
          <h2 id="s-src">Data source</h2>
          <DemoTag />
        </div>
        <div className="panel__body">
          <dl className="kv">
            <dt>Source</dt>
            <dd>{repoLabel}</dd>
            <dt>Execution backend</dt>
            <dd>
              {demo
                ? 'None connected. Horizon does not run agents; everything here is sample data.'
                : 'Your code-review agents, run by server.py. Statuses and events come from real runs.'}
            </dd>
          </dl>
          <p className="muted setting__help">
            {demo ? (
              <>
                To connect a backend, run <code>python server.py</code> in your project and open the
                page it serves, or add <code>?api=http://127.0.0.1:8787</code> to this address.
              </>
            ) : (
              <>
                {submitMode === 'upload' ? (
                  'Runs are kept on the server for your session only.'
                ) : (
                  <>
                    Runs are stored in <code>.horizon/runs.json</code> in your project folder.
                  </>
                )}{' '}
                Add <code>?demo</code> to the address to see the sample scenario instead.
              </>
            )}
          </p>
        </div>
      </section>

      {demo && (
        <section className="panel" aria-labelledby="s-sim">
          <div className="panel__head">
            <h2 id="s-sim">Demonstration simulator</h2>
          </div>
          <div className="panel__body setting-list">
            <div className="setting">
              <div>
                <div className="setting__label" id="l-sim">
                  Simulate live activity
                </div>
                <p className="muted setting__help">
                  Advances running tasks and adds events marked “Simulated” so the interface has
                  something live to show.
                </p>
              </div>
              <Switch
                checked={settings.simulate}
                onChange={(v) => set({ simulate: v })}
                label="Simulate live activity"
              />
            </div>
            <div className="setting">
              <div>
                <div className="setting__label">Speed</div>
                <p className="muted setting__help">How often the simulator takes a step.</p>
              </div>
              <Segmented
                label="Simulator speed"
                value={settings.speed}
                onChange={(v) => set({ speed: v })}
                options={[
                  { value: 'slow', label: 'Slow' },
                  { value: 'normal', label: 'Normal' },
                  { value: 'fast', label: 'Fast' },
                ]}
              />
            </div>
            <div className="setting">
              <div>
                <div className="setting__label">Occasional failures</div>
                <p className="muted setting__help">
                  Lets the simulator produce errors and retries so recovery states are visible.
                </p>
              </div>
              <Switch
                checked={settings.injectFailures}
                onChange={(v) => set({ injectFailures: v })}
                label="Occasional failures"
              />
            </div>
            <div className="setting">
              <div>
                <div className="setting__label">Reset demo data</div>
                <p className="muted setting__help">
                  Restores the original scenario, including tasks you moved and events you caused.
                </p>
              </div>
              <button
                type="button"
                className="btn"
                disabled={!demo}
                onClick={() => void store.resetDemo()}
              >
                Reset
              </button>
            </div>
          </div>
        </section>
      )}

      {demo && (
        <section className="panel" aria-labelledby="s-cost">
          <div className="panel__head">
            <h2 id="s-cost">Cost estimates</h2>
          </div>
          <div className="panel__body">
            <label className="field" style={{ maxWidth: 260 }}>
              <span className="field-label">Blended price per million tokens (USD)</span>
              <input
                className="input"
                type="number"
                min={0}
                step={0.5}
                value={settings.pricePerMillionTokens}
                onChange={(e: { target: { value: string } }) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v) && v >= 0) set({ pricePerMillionTokens: v })
                }}
              />
            </label>
            <p className="muted setting__help">
              Used only on the Evaluation page. It is a placeholder, not a real price list.
            </p>
          </div>
        </section>
      )}

      <section className="panel" aria-labelledby="s-lim">
        <div className="panel__head">
          <h2 id="s-lim">Limitations</h2>
        </div>
        <div className="panel__body">
          <ul className="bullets">
            <li>
              All agents, tasks, memories, runs and metrics are generated sample data. None of it
              measures a real system.
            </li>
            <li>
              No agents are executed. Simulated events are labelled and cannot approve work:
              completion always needs a person.
            </li>
            <li>Changes you make are kept in memory for this tab and are lost on reload.</li>
            <li>
              Agent-to-agent handoffs are derived from task dependencies; the “feedback” lines are
              sample data.
            </li>
          </ul>
        </div>
      </section>

      <section className="panel" aria-labelledby="s-keys">
        <div className="panel__head">
          <h2 id="s-keys">Keyboard</h2>
        </div>
        <div className="panel__body">
          <dl className="kv">
            <dt>Graph and timeline</dt>
            <dd>Focus the canvas, then arrow keys pan, plus and minus zoom, 0 fits to view.</dd>
            <dt>Graph nodes</dt>
            <dd>Tab to a node, Enter or Space to inspect it.</dd>
            <dt>Details panel</dt>
            <dd>Escape closes it.</dd>
          </dl>
        </div>
      </section>
    </div>
  )
}
