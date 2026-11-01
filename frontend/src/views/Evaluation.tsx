import { useMemo, useState } from 'react'
import { DemoTag } from '../design/ui.tsx'
import { fmtCompact, fmtPct, fmtUsd } from '../design/format.ts'
import {
  agentName,
  estimateCostUsd,
  formatDuration,
  metricsForRun,
  rollingStepSuccess,
  tokensByAgent,
  type RunMetrics,
} from '../domain/rules.ts'
import { HOUR, type Run } from '../domain/types.ts'
import { useApp, useWorkspace } from '../state/store.ts'
import { HBars, RateLine } from '../viz/Charts.tsx'

const OUTCOME = {
  in_progress: 'In progress',
  succeeded: 'Succeeded',
  partial: 'Partial',
  failed: 'Failed',
} as const

export function Evaluation() {
  const ws = useWorkspace()
  const { settings, repoKind } = useApp()
  const [runId, setRunId] = useState(ws.project.currentRunId)
  const run = ws.runs.find((r) => r.id === runId)!
  const rows = useMemo(() => ws.runs.map((r) => ({ run: r, m: metricsForRun(ws, r) })), [ws])
  const current = rows.find((r) => r.run.id === runId)!.m
  const live = run.outcome === 'in_progress'
  const tokensKnown = ws.capabilities?.tokens !== false
  const price = settings.pricePerMillionTokens

  const rolling = useMemo(
    () => rollingStepSuccess(ws.events, ws.project.currentRunId, 12 * HOUR),
    [ws.events, ws.project.currentRunId],
  )
  const byAgent = useMemo(() => {
    const m = tokensByAgent(ws.events, ws.project.currentRunId)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [ws.events, ws.project.currentRunId])
  const runStart = ws.runs.find((r) => r.id === ws.project.currentRunId)!.startedAt

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1>Evaluation & Reliability</h1>
          <p>
            How reliably runs reach the objective, and what that costs. Compare configurations side
            by side.
          </p>
        </div>
        <div className="page__actions">
          <DemoTag>Sample metrics</DemoTag>
          <label className="field field--inline">
            <span className="field-label">Run</span>
            <select
              className="select"
              value={runId}
              onChange={(e: { target: { value: string } }) => setRunId(e.target.value)}
            >
              {[...ws.runs].reverse().map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} · {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="callout" role="note">
        <div>
          {repoKind === 'live' ? (
            <>
              <strong>Measured from your stored runs.</strong> Success rates count each agent’s
              result: an error or an empty answer is a failed step. Your agents do not report token
              usage, so tokens and cost are not shown.
            </>
          ) : (
            <>
              <strong>These are sample numbers.</strong> They are generated for this demonstration
              and are not measurements of any real system or model. Cost uses a blended price of $
              {price} per million tokens, which you can change in Settings.
            </>
          )}
        </div>
      </div>

      <section className="panel" aria-labelledby="m-h">
        <div className="panel__head">
          <h2 id="m-h">
            {run.id} · {run.label}
          </h2>
          <span
            className={`badge badge--${run.outcome === 'succeeded' ? 'completed' : run.outcome === 'failed' ? 'failed' : run.outcome === 'partial' ? 'blocked' : 'running'}`}
          >
            {OUTCOME[run.outcome]}
          </span>
          <span className="spacer" />
          <span className="faint">{run.config}</span>
        </div>
        <div className="panel__body">
          <div className="kpis kpis--6">
            <Metric
              label="End-to-end task success"
              value={fmtPct(
                current.tasksTotal ? current.tasksCompleted / current.tasksTotal : null,
                0,
              )}
              sub={`${current.tasksCompleted} of ${current.tasksTotal} tasks${live ? ' so far' : ''}`}
              help="Share of planned tasks that finished and passed validation."
            />
            <Metric
              label="Per-step success"
              value={fmtPct(current.stepSuccessRate)}
              sub={`${current.stepsSucceeded} of ${current.stepsTotal} steps`}
              help="Tool calls and verifications that succeeded on the first attempt."
            />
            <Metric
              label="Retries"
              value={String(current.retries)}
              sub={`${current.recovered} recovered${current.recoveryRate !== null ? ` (${fmtPct(current.recoveryRate, 0)})` : ''}`}
              help="Retry attempts, and how many resolved the failure."
            />
            <Metric
              label="Execution time"
              value={formatDuration(current.durationMs)}
              sub={live ? 'still running' : 'start to finish'}
              help="Wall-clock duration of the run."
            />
            <Metric
              label="Tokens and cost"
              value={tokensKnown ? fmtCompact(current.tokens) : 'Not reported'}
              sub={
                tokensKnown
                  ? `about ${fmtUsd(estimateCostUsd(current.tokens, price))} estimated`
                  : 'the agents do not return usage'
              }
              help="Estimated from a blended per-token price. Not a bill."
            />
            <Metric
              label="Human interventions"
              value={String(current.interventions)}
              sub={
                current.tasksCompleted
                  ? `${(current.interventions / current.tasksCompleted).toFixed(2)} per completed task`
                  : 'none completed yet'
              }
              help="Times a person had to step in."
            />
          </div>
          {live && (
            <p className="faint footnote">
              This run is still in progress, so its totals are partial and will change as work
              continues. Token counts include only events that report them.
            </p>
          )}
        </div>
      </section>

      <section className="panel" aria-labelledby="c-h">
        <div className="panel__head">
          <h2 id="c-h">Comparison between runs</h2>
          <span className="spacer" />
          <span className="faint">Selected run is highlighted</span>
        </div>
        <div className="table-wrap">
          <table className="table cmp">
            <caption className="sr-only">Metrics for each run</caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Configuration</th>
                <th scope="col">Outcome</th>
                <th scope="col" className="num">
                  Tasks done
                </th>
                <th scope="col" className="num">
                  Per-step success
                </th>
                <th scope="col" className="num">
                  Recovered
                </th>
                <th scope="col" className="num">
                  Interventions
                </th>
                <th scope="col" className="num">
                  Duration
                </th>
                <th scope="col" className="num">
                  Est. cost
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ run: r, m }) => (
                <tr key={r.id} className={r.id === runId ? 'cmp__sel' : undefined}>
                  <th scope="row">
                    <button type="button" className="linkbtn" onClick={() => setRunId(r.id)}>
                      {r.id}
                    </button>
                    <div className="faint">{r.label}</div>
                  </th>
                  <td className="muted">{r.config}</td>
                  <td>{OUTCOME[r.outcome]}</td>
                  <td className="num">
                    {m.tasksCompleted}/{m.tasksTotal}
                  </td>
                  <td className="num">{fmtPct(m.stepSuccessRate)}</td>
                  <td className="num">
                    {m.recoveryRate === null ? 'n/a' : fmtPct(m.recoveryRate, 0)}
                  </td>
                  <td className="num">{m.interventions}</td>
                  <td className="num">{formatDuration(m.durationMs)}</td>
                  <td className="num">
                    {tokensKnown ? fmtUsd(estimateCostUsd(m.tokens, price)) : 'n/a'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="ov-cols ov-cols--even">
        <ChartPanel
          title="Per-step success by run"
          rows={rows}
          runId={runId}
          pick={(m) => m.stepSuccessRate ?? 0}
          fmt={(m) => fmtPct(m.stepSuccessRate)}
          domain={[0, 1]}
          note="Bars start at 0%."
        />
        <ChartPanel
          title="Human interventions by run"
          rows={rows}
          runId={runId}
          pick={(m) => m.interventions}
          fmt={(m) => String(m.interventions)}
        />
        <ChartPanel
          title="Execution time by run"
          rows={rows}
          runId={runId}
          pick={(m) => m.durationMs}
          fmt={(m) => formatDuration(m.durationMs)}
        />
        {tokensKnown && (
          <ChartPanel
            title="Estimated cost by run"
            rows={rows}
            runId={runId}
            pick={(m) => m.tokens}
            fmt={(m) => fmtUsd(estimateCostUsd(m.tokens, price))}
          />
        )}
      </div>

      {repoKind === 'live' ? (
        <AgentResults />
      ) : (
        <div className="ov-cols ov-cols--even">
          <section className="panel" aria-labelledby="r-h">
            <div className="panel__head">
              <h2 id="r-h">Step success over the current run</h2>
            </div>
            <div className="panel__body">
              <RateLine
                label="Share of steps that succeeded in each 12 hour window of the current run"
                points={rolling.map((p) => ({ x: p.at, y: p.rate, n: p.total }))}
                unitLabel={(x) =>
                  `Day ${Math.floor((x - runStart) / (24 * HOUR)) + 1}, ${Math.round(((x - runStart) % (24 * HOUR)) / HOUR)}h`
                }
              />
              <p className="faint">
                Each point is a 12 hour window. Amber points are below 90%. Windows with few steps
                vary more.
              </p>
            </div>
          </section>
          <section className="panel" aria-labelledby="t-h">
            <div className="panel__head">
              <h2 id="t-h">Tokens by agent, current run</h2>
            </div>
            <div className="panel__body">
              <HBars
                label="Tokens by agent"
                data={byAgent.map(([id, n]) => ({
                  label: agentName(ws.agents, id),
                  value: n,
                  display: fmtCompact(n),
                }))}
              />
              <p className="faint">Only events that report token counts are included.</p>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function AgentResults() {
  const ws = useWorkspace()
  const rows = ws.tasks.map((t) => ({
    task: t,
    ms: t.actualStart ? (t.actualEnd ?? ws.now) - t.actualStart : undefined,
  }))
  return (
    <section className="panel" aria-labelledby="ar-h">
      <div className="panel__head">
        <h2 id="ar-h">Results by agent, current run</h2>
      </div>
      <div className="panel__body">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Result</th>
              <th scope="col" className="num">
                Attempts
              </th>
              <th scope="col" className="num">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ task, ms }) => (
              <tr key={task.id}>
                <th scope="row">{agentName(ws.agents, task.assigneeId)}</th>
                <td>
                  {task.status === 'blocked' ? `Failed: ${task.blocked?.note ?? ''}` : task.status}
                </td>
                <td className="num">{task.attempts}</td>
                <td className="num">{ms === undefined ? 'n/a' : formatDuration(ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Metric({
  label,
  value,
  sub,
  help,
}: {
  label: string
  value: string
  sub: string
  help: string
}) {
  return (
    <div className="kpi" title={help}>
      <div className="kpi__label">{label}</div>
      <div className="kpi__value">{value}</div>
      <div className="kpi__sub">{sub}</div>
    </div>
  )
}

function ChartPanel({
  title,
  rows,
  runId,
  pick,
  fmt,
  domain,
  note,
}: {
  title: string
  rows: { run: Run; m: RunMetrics }[]
  runId: string
  pick: (m: RunMetrics) => number
  fmt: (m: RunMetrics) => string
  domain?: [number, number]
  note?: string
}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>{title}</h2>
      </div>
      <div className="panel__body">
        <HBars
          label={title}
          max={domain?.[1]}
          data={rows.map(({ run, m }) => ({
            label: `${run.id} ${run.label}`,
            value: pick(m),
            display: fmt(m),
            highlight: run.id === runId,
            note: run.outcome === 'in_progress' ? 'in progress, partial' : undefined,
          }))}
        />
        {note && <p className="faint">{note}</p>}
      </div>
    </section>
  )
}
