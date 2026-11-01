import { Glyph, taskGlyphKind } from '../design/ui.tsx'
import { fmtDateTime } from '../design/format.ts'
import { relativeTime, summarizeMilestones } from '../domain/rules.ts'
import { useWorkspace } from '../state/store.ts'
import { Inspector, Section } from './Inspector.tsx'

const LABEL = {
  achieved: 'Achieved',
  upcoming: 'Upcoming',
  at_risk: 'At risk',
  overdue: 'Overdue',
} as const

export function MilestoneInspector({
  milestoneId,
  onClose,
  onSelectTask,
}: {
  milestoneId: string
  onClose: () => void
  onSelectTask: (id: string) => void
}) {
  const ws = useWorkspace()
  const m = summarizeMilestones(ws).find((x) => x.milestone.id === milestoneId)
  if (!m) {
    return (
      <Inspector title="Milestone not found" onClose={onClose}>
        <p className="muted">This milestone no longer exists.</p>
      </Inspector>
    )
  }
  const phase = ws.phases.find((p) => p.id === m.milestone.phaseId)
  const deps = m.milestone.dependsOn
    .map((id) => ws.tasks.find((t) => t.id === id))
    .filter((t) => !!t)
  return (
    <Inspector eyebrow={`Milestone · ${phase?.name}`} title={m.milestone.name} onClose={onClose}>
      <div className="inspector__chips">
        <span
          className={`badge badge--${m.state === 'achieved' ? 'completed' : m.state === 'overdue' ? 'failed' : m.state === 'at_risk' ? 'blocked' : ''}`}
        >
          {LABEL[m.state]}
        </span>
        <span className="chip">Due {fmtDateTime(m.milestone.due)}</span>
      </div>
      <p className="muted">
        {m.state === 'achieved'
          ? `Achieved ${m.achievedAt ? relativeTime(m.achievedAt, ws.now) : ''} when its last task completed.`
          : m.state === 'overdue'
            ? `This was due ${relativeTime(m.milestone.due, ws.now)} and still has open tasks.`
            : m.state === 'at_risk'
              ? 'A task this milestone depends on, directly or upstream, is blocked.'
              : `Due ${relativeTime(m.milestone.due, ws.now)}. Reached when every task below is completed.`}
      </p>
      <Section title="Tasks that must complete" count={deps.length}>
        <ul className="deplist">
          {deps.map((t) => (
            <li key={t!.id}>
              <button type="button" className="deplist__btn" onClick={() => onSelectTask(t!.id)}>
                <Glyph kind={taskGlyphKind(t!)} size={13} />
                <span className="mono faint">{t!.id}</span>
                <span className="truncate">{t!.title}</span>
                <span className="faint">{t!.status === 'completed' ? 'Done' : t!.status}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </Inspector>
  )
}
