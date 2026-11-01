import { useState } from 'react'
import { Glyph, Meter, PriorityMark, TaskStateBadge, taskGlyphKind } from '../design/ui.tsx'
import { fmtDateTime } from '../design/format.ts'
import {
  agentName,
  dependentsOf,
  indexById,
  prerequisiteChain,
  relativeTime,
  transitionOptions,
} from '../domain/rules.ts'
import type { Task, TaskOutput } from '../domain/types.ts'
import { navigate } from '../state/router.ts'
import { store, useWorkspace } from '../state/store.ts'
import { Inspector, Section } from './Inspector.tsx'

export function TaskInspector({
  taskId,
  onClose,
  onSelectTask,
  onBack,
  backLabel,
}: {
  taskId: string
  onClose: () => void
  onSelectTask: (id: string) => void
  onBack?: () => void
  backLabel?: string
}) {
  const ws = useWorkspace()
  const task = ws.tasks.find((t) => t.id === taskId)
  const [blockNote, setBlockNote] = useState('')
  const [blocking, setBlocking] = useState(false)

  if (!task) {
    return (
      <Inspector title="Task not found" onClose={onClose}>
        <p className="muted">{taskId} no longer exists in this workspace.</p>
      </Inspector>
    )
  }

  const byId = indexById(ws.tasks)
  const chain = prerequisiteChain(task.id, ws.tasks)
  const direct = task.dependsOn.map((id) => byId.get(id)).filter((t): t is Task => !!t)
  const indirect = chain.filter((c) => !task.dependsOn.includes(c.id) && c.status !== 'completed')
  const unmetDirect = direct.filter((d) => d.status !== 'completed')
  const unlocks = dependentsOf(task.id, ws.tasks)
  const options = transitionOptions(task, ws)
  const events = ws.events
    .filter((e) => e.taskId === task.id)
    .slice(-6)
    .reverse()
  const memories = ws.memories.filter((m) => m.taskIds.includes(task.id))
  const phase = ws.phases.find((p) => p.id === task.phaseId)
  const criteriaPassed = task.validation.filter((c) => c.result === 'passed').length

  const perform = async (to: Task['status'], note?: string) => {
    const ok = await store.transitionTask({
      taskId: task.id,
      to,
      note,
      blockKind: to === 'blocked' ? 'human' : undefined,
    })
    if (ok) {
      setBlocking(false)
      setBlockNote('')
    }
  }

  return (
    <Inspector
      eyebrow={
        <>
          <span className="mono">{task.id}</span> · {phase?.name}
        </>
      }
      title={task.title}
      onClose={onClose}
      onBack={onBack}
      backLabel={backLabel}
    >
      <div className="inspector__chips">
        <TaskStateBadge task={task} />
        <PriorityMark priority={task.priority} />
        {task.attempts > 1 && <span className="chip">{task.attempts} attempts</span>}
      </div>
      <p className="muted">{task.description}</p>

      {task.blocked && (
        <div
          className={`callout callout--${task.blocked.kind === 'failure' ? 'failed' : 'blocked'}`}
          role="note"
        >
          <div>
            <strong>
              {task.blocked.kind === 'failure'
                ? 'Failed after retries'
                : task.blocked.kind === 'human'
                  ? 'Waiting for a person'
                  : 'Waiting on something external'}
            </strong>
            <p>{task.blocked.note}</p>
            <p className="faint">
              Since {fmtDateTime(task.blocked.since)} ({relativeTime(task.blocked.since, ws.now)})
            </p>
          </div>
        </div>
      )}

      <Section title="Actions">
        <div className="actions">
          {options.map((o) => {
            const isBlock = o.to === 'blocked'
            return (
              <button
                key={o.to}
                type="button"
                className={`btn ${o.to === 'completed' || (o.to === 'running' && task.status === 'ready') ? 'btn--primary' : ''}`}
                aria-disabled={!o.ok}
                disabled={false}
                data-disabled={!o.ok || undefined}
                title={o.ok ? undefined : o.reason}
                onClick={() => {
                  if (!o.ok) {
                    store.toast('error', o.reason ?? 'This move is not allowed.')
                    return
                  }
                  if (isBlock) setBlocking(true)
                  else void perform(o.to)
                }}
              >
                {o.label}
              </button>
            )
          })}
        </div>
        {options
          .filter((o) => !o.ok)
          .map((o) => (
            <p key={o.to} className="faint isec__hint">
              {o.label}: {o.reason}
            </p>
          ))}
        {blocking && (
          <div className="blockform">
            <label className="field-label" htmlFor="block-note">
              Why is this blocked?
            </label>
            <input
              id="block-note"
              className="input"
              value={blockNote}
              placeholder="For example, waiting for compliance sign-off"
              onChange={(e: { target: { value: string } }) => setBlockNote(e.target.value)}
              autoFocus
            />
            <div className="actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void perform('blocked', blockNote.trim() || undefined)}
              >
                Block task
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setBlocking(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section title="What must happen first" count={unmetDirect.length + indirect.length}>
        {direct.length === 0 ? (
          <p className="muted">No prerequisites. This task can start whenever its agent is free.</p>
        ) : (
          <>
            <p className="muted isec__hint">
              {unmetDirect.length === 0
                ? 'All prerequisites are complete.'
                : `${unmetDirect.length} direct prerequisite${unmetDirect.length === 1 ? '' : 's'} still open.`}
            </p>
            <ul className="deplist">
              {direct.map((d) => (
                <li key={d.id}>
                  <button type="button" className="deplist__btn" onClick={() => onSelectTask(d.id)}>
                    <Glyph kind={taskGlyphKind(d)} size={13} />
                    <span className="mono faint">{d.id}</span>
                    <span className="truncate">{d.title}</span>
                    <span className="faint">
                      {d.status === 'completed'
                        ? 'Done'
                        : d.progress
                          ? `${Math.round(d.progress)}%`
                          : d.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {indirect.length > 0 && (
              <>
                <p className="muted isec__hint">Further upstream, still open:</p>
                <ul className="deplist deplist--indirect">
                  {indirect.map((d) => (
                    <li key={d.id}>
                      <button
                        type="button"
                        className="deplist__btn"
                        onClick={() => onSelectTask(d.id)}
                      >
                        <Glyph kind={taskGlyphKind(d)} size={13} />
                        <span className="mono faint">{d.id}</span>
                        <span className="truncate">{d.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Section>

      <Section title="Unlocks" count={unlocks.length}>
        {unlocks.length === 0 ? (
          <p className="muted">Nothing depends on this task.</p>
        ) : (
          <ul className="deplist">
            {unlocks.map((d) => (
              <li key={d.id}>
                <button type="button" className="deplist__btn" onClick={() => onSelectTask(d.id)}>
                  <Glyph kind={taskGlyphKind(d)} size={13} />
                  <span className="mono faint">{d.id}</span>
                  <span className="truncate">{d.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Validation criteria" count={task.validation.length}>
        <p className="muted isec__hint">
          {criteriaPassed} of {task.validation.length} passed. All must pass before approval.
        </p>
        <ul className="criteria">
          {task.validation.map((c) => (
            <li key={c.id} className="criterion">
              <span className={`criterion__mark criterion__mark--${c.result}`} aria-hidden="true">
                {c.result === 'passed' ? '✓' : c.result === 'failed' ? '×' : ''}
              </span>
              <div className="criterion__text">
                <span>{c.text}</span>
                <span className="faint">
                  {c.kind === 'automated' ? 'Automated check' : 'Needs a person'} ·{' '}
                  {c.result === 'pending' ? 'not run yet' : c.result}
                </span>
              </div>
              <div className="criterion__actions">
                {c.result !== 'passed' && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void store.setCriterion(task.id, c.id, 'passed')}
                    aria-label={`Mark passed: ${c.text}`}
                  >
                    Pass
                  </button>
                )}
                {c.result !== 'failed' && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void store.setCriterion(task.id, c.id, 'failed')}
                    aria-label={`Mark failed: ${c.text}`}
                  >
                    Fail
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Section>

      {task.output && (
        <Section title="Agent output">
          <OutputView output={task.output} />
        </Section>
      )}

      <Section title="Assignment and schedule">
        <dl className="kv">
          <dt>Agent</dt>
          <dd>
            <button
              type="button"
              className="linkbtn"
              onClick={() => navigate('orchestration', { agent: task.assigneeId })}
            >
              {agentName(ws.agents, task.assigneeId)}
            </button>
          </dd>
          <dt>Progress</dt>
          <dd>
            <Meter
              value={task.progress}
              label={`${task.id} progress`}
              tone={task.status === 'completed' ? 'ok' : undefined}
            />
            <span className="faint">{Math.round(task.progress)}%</span>
          </dd>
          <dt>Planned</dt>
          <dd>
            {fmtDateTime(task.plannedStart)} to {fmtDateTime(task.plannedEnd)}
          </dd>
          <dt>Actual</dt>
          <dd>
            {task.actualStart
              ? `${fmtDateTime(task.actualStart)} to ${task.actualEnd ? fmtDateTime(task.actualEnd) : 'now'}`
              : 'Not started'}
          </dd>
          <dt>Output</dt>
          <dd className="mono">{task.artifact}</dd>
        </dl>
      </Section>

      <Section title="Recent activity" count={events.length}>
        {events.length === 0 ? (
          <p className="muted">No activity recorded for this task yet.</p>
        ) : (
          <ul className="mini-events">
            {events.map((e) => (
              <li key={e.id}>
                <span className="faint mono">{relativeTime(e.at, ws.now)}</span>
                <span>{e.title}</span>
                {e.simulated && <span className="demo-tag">Simulated</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {memories.length > 0 && (
        <Section title="Related memory" count={memories.length}>
          <ul className="deplist">
            {memories.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="deplist__btn"
                  onClick={() => navigate('memory', { item: m.id })}
                >
                  <span className="mono faint">{m.id}</span>
                  <span className="truncate">{m.title}</span>
                  <span className="faint">{m.origin === 'inferred' ? 'Inferred' : 'Stored'}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Inspector>
  )
}

function OutputView({ output }: { output: TaskOutput }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output.text)
      store.toast('success', 'Copied to the clipboard')
    } catch {
      store.toast('error', 'Could not copy. Select the text and copy it by hand.')
    }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([output.text], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = output.filename
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="output">
      <div className="actions">
        <button type="button" className="btn btn--sm" onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" className="btn btn--sm" onClick={download}>
          Download {output.filename}
        </button>
      </div>
      <pre
        className={`output__text${output.kind === 'code' ? ' output__text--code' : ''}`}
        tabIndex={0}
      >
        {output.text}
      </pre>
    </div>
  )
}
