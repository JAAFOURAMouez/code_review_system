import { Glyph, Meter, StateBadge, taskGlyphKind } from '../design/ui.tsx'
import {
  agentName,
  agentTaskCounts,
  currentTaskOf,
  deriveAgentState,
  deriveHandoffs,
  relativeTime,
} from '../domain/rules.ts'
import { COMMUNICATIONS } from '../domain/seed.ts'
import type { EventType } from '../domain/types.ts'
import { useWorkspace } from '../state/store.ts'
import { Inspector, Section } from './Inspector.tsx'

const ACTION_TYPES: EventType[] = [
  'action',
  'tool_call',
  'transition',
  'decision',
  'verification',
  'retry',
  'intervention',
]

export function AgentInspector({
  agentId,
  onClose,
  onSelectTask,
  onSelectAgent,
}: {
  agentId: string
  onClose: () => void
  onSelectTask: (id: string) => void
  onSelectAgent: (id: string) => void
}) {
  const ws = useWorkspace()
  const agent = ws.agents.find((a) => a.id === agentId)
  if (!agent) {
    return (
      <Inspector title="Agent not found" onClose={onClose}>
        <p className="muted">This agent no longer exists.</p>
      </Inspector>
    )
  }
  const state = deriveAgentState(agent.id, ws.tasks)
  const current = currentTaskOf(agent.id, ws.tasks)
  const counts = agentTaskCounts(agent.id, ws.tasks)
  const mine = ws.tasks.filter((t) => t.assigneeId === agent.id)
  const handoffs = deriveHandoffs(ws.tasks)
  const incoming = handoffs.filter((h) => h.to === agent.id)
  const outgoing = handoffs.filter((h) => h.from === agent.id)
  const comms = COMMUNICATIONS.filter((c) => c.from === agent.id || c.to === agent.id)
  const runId = ws.project.currentRunId
  const mineEvents = ws.events.filter((e) => e.actorId === agent.id && e.runId === runId)
  const recent = mineEvents
    .filter((e) => ACTION_TYPES.includes(e.type))
    .slice(-6)
    .reverse()
  const errors = mineEvents
    .filter((e) => e.type === 'error' || (e.type === 'retry' && e.recovered === false))
    .slice(-5)
    .reverse()
  const tokens = mineEvents.reduce((s, e) => s + (e.tokens ?? 0), 0)

  return (
    <Inspector eyebrow={agent.model} title={agent.name} onClose={onClose}>
      <div className="inspector__chips">
        <StateBadge kind={state} />
        <span className="chip">{mine.length} tasks assigned</span>
        <span className="chip">{(tokens / 1000).toFixed(0)}k tokens this run</span>
      </div>
      <p className="muted">{agent.role}</p>

      {current && (
        <div className="callout">
          <div style={{ flex: 1 }}>
            <div className="faint">Current task</div>
            <button type="button" className="linkbtn" onClick={() => onSelectTask(current.id)}>
              <span className="mono">{current.id}</span> {current.title}
            </button>
            <Meter value={current.progress} label={`${current.id} progress`} />
          </div>
        </div>
      )}

      <Section title="Responsibilities">
        <ul className="bullets">
          {agent.responsibilities.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className="chips">
          {agent.tools.map((t) => (
            <span key={t} className="chip mono">
              {t}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Assigned tasks" count={mine.length}>
        <p className="muted isec__hint">
          {counts.completed} done, {counts.running + counts.review} in progress, {counts.blocked}{' '}
          blocked, {counts.ready + counts.backlog} waiting.
        </p>
        <ul className="deplist">
          {mine.map((t) => (
            <li key={t.id}>
              <button type="button" className="deplist__btn" onClick={() => onSelectTask(t.id)}>
                <Glyph kind={taskGlyphKind(t)} size={13} />
                <span className="mono faint">{t.id}</span>
                <span className="truncate">{t.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Handoffs" count={incoming.length + outgoing.length + comms.length}>
        {incoming.length + outgoing.length + comms.length === 0 && (
          <p className="muted">This agent has no handoffs.</p>
        )}
        <ul className="deplist">
          {incoming.map((h) => (
            <li key={h.id}>
              <button type="button" className="deplist__btn" onClick={() => onSelectAgent(h.from)}>
                <span className="faint">From</span>
                <strong className="truncate">{agentName(ws.agents, h.from)}</strong>
                <span className="faint truncate">{h.label}</span>
                <span className={`edgestate edgestate--${h.status}`}>
                  {h.status === 'done'
                    ? 'Delivered'
                    : h.status === 'active'
                      ? 'In progress'
                      : h.status === 'stalled'
                        ? 'Stalled'
                        : 'Pending'}
                </span>
              </button>
            </li>
          ))}
          {outgoing.map((h) => (
            <li key={h.id}>
              <button type="button" className="deplist__btn" onClick={() => onSelectAgent(h.to)}>
                <span className="faint">To</span>
                <strong className="truncate">{agentName(ws.agents, h.to)}</strong>
                <span className="faint truncate">{h.label}</span>
                <span className={`edgestate edgestate--${h.status}`}>
                  {h.status === 'done'
                    ? 'Delivered'
                    : h.status === 'active'
                      ? 'In progress'
                      : h.status === 'stalled'
                        ? 'Stalled'
                        : 'Pending'}
                </span>
              </button>
            </li>
          ))}
          {comms.map((c) => {
            const other = c.from === agent.id ? c.to : c.from
            return (
              <li key={c.id}>
                <button type="button" className="deplist__btn" onClick={() => onSelectAgent(other)}>
                  <span className="faint">
                    {c.from === agent.id ? 'Sends to' : 'Receives from'}
                  </span>
                  <strong className="truncate">{agentName(ws.agents, other)}</strong>
                  <span className="faint truncate">{c.label}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </Section>

      <Section title="Recent actions" count={recent.length}>
        {recent.length === 0 ? (
          <p className="muted">No actions recorded in this run yet.</p>
        ) : (
          <ul className="mini-events">
            {recent.map((e) => (
              <li key={e.id}>
                <span className="faint mono">{relativeTime(e.at, ws.now)}</span>
                <span>{e.title}</span>
                {e.simulated && <span className="demo-tag">Simulated</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Errors" count={errors.length}>
        {errors.length === 0 ? (
          <p className="muted">No errors in this run.</p>
        ) : (
          <ul className="mini-events mini-events--errors">
            {errors.map((e) => (
              <li key={e.id}>
                <span className="faint mono">{relativeTime(e.at, ws.now)}</span>
                <span>
                  {e.title}
                  {e.detail && <span className="faint"> {e.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Inspector>
  )
}
