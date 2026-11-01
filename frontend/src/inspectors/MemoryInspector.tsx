import { agentName, relativeTime } from '../domain/rules.ts'
import { fmtDateTime } from '../design/format.ts'
import type { LinkRelation } from '../domain/types.ts'
import { navigate } from '../state/router.ts'
import { useWorkspace } from '../state/store.ts'
import { Inspector, Section } from './Inspector.tsx'

const RELATION: Record<LinkRelation, string> = {
  supports: 'Supports',
  contradicts: 'Contradicts',
  derived_from: 'Derived from',
  supersedes: 'Supersedes',
  relates: 'Related to',
}
const KIND_LABEL = { fact: 'Fact', observation: 'Observation', decision: 'Decision' } as const
const SOURCE_LABEL = {
  document: 'Document',
  tool_output: 'Tool output',
  agent: 'Agent',
  human: 'Person',
} as const

export function OriginBadge({
  origin,
  confidence,
}: {
  origin: 'stored' | 'inferred'
  confidence?: number
}) {
  return origin === 'stored' ? (
    <span className="origin origin--stored" title="Written down from a source">
      <svg width="12" height="12" aria-hidden="true">
        <circle cx="6" cy="6" r="4.5" fill="currentColor" />
      </svg>
      Stored
    </span>
  ) : (
    <span className="origin origin--inferred" title="Concluded by an agent, not read from a source">
      <svg width="12" height="12" aria-hidden="true">
        <circle
          cx="6"
          cy="6"
          r="4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2.2 2"
        />
      </svg>
      Inferred{confidence !== undefined ? ` · ${Math.round(confidence * 100)}% confidence` : ''}
    </span>
  )
}

export function MemoryInspector({
  memoryId,
  onClose,
  onSelect,
}: {
  memoryId: string
  onClose: () => void
  onSelect: (id: string) => void
}) {
  const ws = useWorkspace()
  const m = ws.memories.find((x) => x.id === memoryId)
  if (!m) {
    return (
      <Inspector title="Memory not found" onClose={onClose}>
        <p className="muted">This memory no longer exists.</p>
      </Inspector>
    )
  }
  const byId = new Map(ws.memories.map((x) => [x.id, x]))
  const backlinks = ws.memories.filter((x) => x.links.some((l) => l.to === m.id))
  const run = ws.runs.find((r) => r.id === m.runId)

  return (
    <Inspector
      eyebrow={
        <>
          <span className="mono">{m.id}</span> · {KIND_LABEL[m.kind]}
        </>
      }
      title={m.title}
      onClose={onClose}
    >
      <div className="inspector__chips">
        <OriginBadge origin={m.origin} confidence={m.confidence} />
        {m.tags.map((t) => (
          <span key={t} className="chip">
            {t}
          </span>
        ))}
      </div>
      <p>{m.body}</p>
      {m.rationale && (
        <Section title="Rationale">
          <p className="muted">{m.rationale}</p>
        </Section>
      )}
      {m.origin === 'inferred' && (
        <div className="callout" role="note">
          <div>
            <strong>This is an inference.</strong>
            <p>
              It was concluded from other memories and has not been confirmed against a source.
              Treat it as a working assumption.
            </p>
          </div>
        </div>
      )}

      <Section title="Provenance">
        <dl className="kv">
          <dt>Source type</dt>
          <dd>{SOURCE_LABEL[m.provenance.sourceType]}</dd>
          <dt>Source</dt>
          <dd className="mono">{m.provenance.source}</dd>
          {m.provenance.agentId && (
            <>
              <dt>Recorded by</dt>
              <dd>
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => navigate('orchestration', { agent: m.provenance.agentId })}
                >
                  {agentName(ws.agents, m.provenance.agentId)}
                </button>
              </dd>
            </>
          )}
          <dt>Created</dt>
          <dd>
            {fmtDateTime(m.createdAt)} ({relativeTime(m.createdAt, ws.now)})
          </dd>
          <dt>Last accessed</dt>
          <dd>
            {fmtDateTime(m.lastAccessedAt)} ({relativeTime(m.lastAccessedAt, ws.now)})
          </dd>
          <dt>Times read</dt>
          <dd>{m.accessCount}</dd>
          <dt>Run</dt>
          <dd>{run?.id ?? m.runId}</dd>
        </dl>
      </Section>

      {m.origin === 'inferred' && (m.derivedFrom ?? []).length > 0 && (
        <Section title="Inferred from" count={m.derivedFrom!.length}>
          <ul className="deplist">
            {m.derivedFrom!.map((id) => {
              const src = byId.get(id)
              return (
                <li key={id}>
                  <button type="button" className="deplist__btn" onClick={() => onSelect(id)}>
                    <span className="mono faint">{id}</span>
                    <span className="truncate">{src?.title ?? 'Missing memory'}</span>
                    {src && (
                      <span className="faint">
                        {src.origin === 'inferred' ? 'Inferred' : 'Stored'}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      <Section title="Links" count={m.links.length + backlinks.length}>
        {m.links.length + backlinks.length === 0 ? (
          <p className="muted">Not linked to other memories.</p>
        ) : (
          <ul className="deplist">
            {m.links.map((l) => (
              <li key={`o-${l.to}-${l.relation}`}>
                <button type="button" className="deplist__btn" onClick={() => onSelect(l.to)}>
                  <span className="faint">{RELATION[l.relation]}</span>
                  <span className="mono faint">{l.to}</span>
                  <span className="truncate">{byId.get(l.to)?.title}</span>
                </button>
              </li>
            ))}
            {backlinks.map((b) => {
              const rel = b.links.find((l) => l.to === m.id)!
              return (
                <li key={`i-${b.id}`}>
                  <button type="button" className="deplist__btn" onClick={() => onSelect(b.id)}>
                    <span className="faint">{RELATION[rel.relation]} this</span>
                    <span className="mono faint">{b.id}</span>
                    <span className="truncate">{b.title}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Section title="Task references" count={m.taskIds.length}>
        <ul className="deplist">
          {m.taskIds.map((id) => {
            const t = ws.tasks.find((x) => x.id === id)
            return (
              <li key={id}>
                <button
                  type="button"
                  className="deplist__btn"
                  onClick={() => navigate('tasks', { task: id })}
                >
                  <span className="mono faint">{id}</span>
                  <span className="truncate">{t?.title}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </Section>
    </Inspector>
  )
}
