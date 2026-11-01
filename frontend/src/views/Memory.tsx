import { useMemo, useState } from 'react'
import { DemoTag, Empty, SearchInput, Segmented } from '../design/ui.tsx'
import { fmtDateTime, includesText } from '../design/format.ts'
import { agentName, relativeTime } from '../domain/rules.ts'
import type { MemoryKind, MemoryOrigin } from '../domain/types.ts'
import { MemoryInspector, OriginBadge } from '../inspectors/MemoryInspector.tsx'
import { setParams, useRoute } from '../state/router.ts'
import { useWorkspace } from '../state/store.ts'
import { MemoryGraph } from '../viz/MemoryGraph.tsx'

const KIND_LABEL: Record<MemoryKind, string> = {
  fact: 'Fact',
  observation: 'Observation',
  decision: 'Decision',
}
type Sort = 'recent' | 'accessed' | 'title'

export function Memory() {
  const ws = useWorkspace()
  const { params } = useRoute()
  const selectedId = ws.memories.some((m) => m.id === params.item) ? params.item : undefined
  const mode: 'list' | 'graph' = params.view === 'graph' ? 'graph' : 'list'
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<MemoryKind | 'all'>('all')
  const [origin, setOrigin] = useState<MemoryOrigin | 'all'>('all')
  const [sort, setSort] = useState<Sort>('recent')

  const filtered = useMemo(() => {
    const list = ws.memories.filter(
      (m) =>
        (kind === 'all' || m.kind === kind) &&
        (origin === 'all' || m.origin === origin) &&
        includesText(
          [
            m.id,
            m.title,
            m.body,
            m.rationale,
            m.provenance.source,
            ...m.tags,
            ...m.taskIds,
            agentName(ws.agents, m.provenance.agentId ?? ''),
          ],
          q,
        ),
    )
    return [...list].sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title)
        : sort === 'accessed'
          ? b.lastAccessedAt - a.lastAccessedAt
          : b.createdAt - a.createdAt,
    )
  }, [ws.memories, ws.agents, q, kind, origin, sort])

  const inferred = ws.memories.filter((m) => m.origin === 'inferred').length
  const filtersActive = q !== '' || kind !== 'all' || origin !== 'all'
  const clear = () => {
    setQ('')
    setKind('all')
    setOrigin('all')
  }
  const select = (id: string | undefined) => setParams({ item: id })

  return (
    <div className={`split${selectedId ? ' split--open' : ''}`}>
      <div className="split__main page page--fill">
        <div className="page__head">
          <div>
            <h1>Persistent Memory</h1>
            <p>
              What agents have written down and concluded across runs. <strong>Stored</strong>{' '}
              memories come from a source; <strong>inferred</strong> ones are agent conclusions with
              a confidence and the memories they came from.
            </p>
          </div>
          <div className="page__actions">
            <DemoTag />
            <Segmented
              label="View"
              value={mode}
              onChange={(v) => setParams({ view: v === 'list' ? undefined : v })}
              options={[
                { value: 'list', label: 'List' },
                { value: 'graph', label: 'Graph' },
              ]}
            />
          </div>
        </div>

        <div className="filters">
          <div className="filters__search">
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Search memories, sources, tags, tasks"
              label="Search memory"
            />
          </div>
          <select
            className="select"
            value={kind}
            onChange={(e: { target: { value: string } }) =>
              setKind(e.target.value as MemoryKind | 'all')
            }
            aria-label="Filter by kind"
          >
            <option value="all">All kinds</option>
            <option value="fact">Facts</option>
            <option value="observation">Observations</option>
            <option value="decision">Decisions</option>
          </select>
          <select
            className="select"
            value={origin}
            onChange={(e: { target: { value: string } }) =>
              setOrigin(e.target.value as MemoryOrigin | 'all')
            }
            aria-label="Filter by origin"
          >
            <option value="all">Stored and inferred</option>
            <option value="stored">Stored only</option>
            <option value="inferred">Inferred only</option>
          </select>
          {mode === 'list' && (
            <select
              className="select"
              value={sort}
              onChange={(e: { target: { value: string } }) => setSort(e.target.value as Sort)}
              aria-label="Sort"
            >
              <option value="recent">Newest first</option>
              <option value="accessed">Recently accessed</option>
              <option value="title">Title</option>
            </select>
          )}
          {filtersActive && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={clear}>
              Clear filters
            </button>
          )}
          <span className="faint filters__count" aria-live="polite">
            {filtered.length} of {ws.memories.length} memories · {inferred} inferred
          </span>
        </div>

        {mode === 'list' ? (
          <div className="panel">
            {filtered.length === 0 ? (
              <Empty
                title="No memories match"
                action={
                  <button type="button" className="btn btn--sm" onClick={clear}>
                    Clear filters
                  </button>
                }
              >
                Search covers titles, text, sources, tags and task ids.
              </Empty>
            ) : (
              <ul className="rows">
                {filtered.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className="row-btn memrow"
                      aria-pressed={selectedId === m.id}
                      onClick={() => select(m.id)}
                    >
                      <span className="mono faint memrow__id">{m.id}</span>
                      <span className="memrow__main">
                        <span className="memrow__title">{m.title}</span>
                        <span className="memrow__meta muted">
                          <OriginBadge origin={m.origin} confidence={m.confidence} />
                          <span className="chip">{KIND_LABEL[m.kind]}</span>
                          <span className="faint truncate" title={m.provenance.source}>
                            {m.provenance.source}
                          </span>
                        </span>
                      </span>
                      <span
                        className="memrow__time faint"
                        title={`Created ${fmtDateTime(m.createdAt)}`}
                      >
                        <span>Created {relativeTime(m.createdAt, ws.now)}</span>
                        <span>Read {relativeTime(m.lastAccessedAt, ws.now)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="panel graphpanel">
            <MemoryGraph
              memories={filtered}
              layoutSource={ws.memories}
              selectedId={selectedId}
              onSelect={select}
            />
          </div>
        )}
      </div>
      {selectedId && (
        <MemoryInspector
          memoryId={selectedId}
          onClose={() => select(undefined)}
          onSelect={(id) => select(id)}
        />
      )}
    </div>
  )
}
