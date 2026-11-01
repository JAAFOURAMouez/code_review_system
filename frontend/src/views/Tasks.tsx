import { useMemo, useState } from 'react'
import {
  DemoTag,
  Empty,
  Glyph,
  Meter,
  PriorityMark,
  SearchInput,
  Segmented,
  taskGlyphKind,
} from '../design/ui.tsx'
import { includesText } from '../design/format.ts'
import {
  agentName,
  checkTransition,
  indexById,
  transitionOptions,
  unmetDependencies,
} from '../domain/rules.ts'
import {
  PRIORITY_ORDER,
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  type Priority,
  type Task,
  type TaskStatus,
} from '../domain/types.ts'
import { MilestoneInspector } from '../inspectors/MilestoneInspector.tsx'
import { TaskInspector } from '../inspectors/TaskInspector.tsx'
import { setParams, useRoute } from '../state/router.ts'
import { store, useWorkspace } from '../state/store.ts'
import { Timeline } from '../viz/Timeline.tsx'

const NEXT: Partial<Record<TaskStatus, TaskStatus>> = {
  backlog: 'ready',
  ready: 'running',
  running: 'review',
  blocked: 'ready',
  review: 'completed',
}

export function Tasks() {
  const ws = useWorkspace()
  const { params } = useRoute()
  const mode: 'board' | 'timeline' = params.view === 'timeline' ? 'timeline' : 'board'
  const taskId = params.task && ws.tasks.some((t) => t.id === params.task) ? params.task : undefined
  const milestoneId = params.ms
  const statusFilter = TASK_STATUSES.includes(params.status as TaskStatus)
    ? (params.status as TaskStatus)
    : undefined

  const [q, setQ] = useState('')
  const [agent, setAgent] = useState('all')
  const [priority, setPriority] = useState<Priority | 'all'>('all')
  const [dragId, setDragId] = useState<string | undefined>()
  const [overCol, setOverCol] = useState<TaskStatus | undefined>()

  const byId = useMemo(() => indexById(ws.tasks), [ws.tasks])
  const filtered = useMemo(
    () =>
      ws.tasks.filter(
        (t) =>
          (agent === 'all' || t.assigneeId === agent) &&
          (priority === 'all' || t.priority === priority) &&
          (!statusFilter || t.status === statusFilter) &&
          includesText(
            [
              t.id,
              t.title,
              t.description,
              t.artifact,
              agentName(ws.agents, t.assigneeId),
              ...t.validation.map((c) => c.text),
            ],
            q,
          ),
      ),
    [ws.tasks, ws.agents, q, agent, priority, statusFilter],
  )
  const visibleIds = useMemo(() => new Set(filtered.map((t) => t.id)), [filtered])
  const filtersActive = q !== '' || agent !== 'all' || priority !== 'all' || !!statusFilter
  const clear = () => {
    setQ('')
    setAgent('all')
    setPriority('all')
    setParams({ status: undefined })
  }

  const selectTask = (id: string | undefined) => setParams({ task: id, ms: undefined })
  const dragTask = dragId ? byId.get(dragId) : undefined

  const drop = async (to: TaskStatus) => {
    const id = dragId
    setDragId(undefined)
    setOverCol(undefined)
    if (!id) return
    const t = byId.get(id)
    if (!t || t.status === to) return
    await store.transitionTask({
      taskId: id,
      to,
      blockKind: to === 'blocked' ? 'human' : undefined,
    })
  }

  const open = !!(taskId || milestoneId)

  return (
    <div className={`split${open ? ' split--open' : ''}`}>
      <div className="split__main page page--fill">
        <div className="page__head">
          <div>
            <h1>Tasks & Planning</h1>
            <p>
              Move work between states by dragging a card or from its details. A move is refused,
              with the reason, when dependencies or validation do not allow it.
            </p>
          </div>
          <div className="page__actions">
            <DemoTag />
            <Segmented
              label="View"
              value={mode}
              onChange={(v) => setParams({ view: v === 'board' ? undefined : v })}
              options={[
                { value: 'board', label: 'Board' },
                { value: 'timeline', label: 'Timeline' },
              ]}
            />
          </div>
        </div>

        <div className="filters">
          <div className="filters__search">
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Search tasks, outputs, criteria"
              label="Search tasks"
            />
          </div>
          <label className="field filters__f">
            <span className="sr-only">Agent</span>
            <select
              className="select"
              value={agent}
              onChange={(e: { target: { value: string } }) => setAgent(e.target.value)}
              aria-label="Filter by agent"
            >
              <option value="all">All agents</option>
              {ws.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field filters__f">
            <span className="sr-only">Priority</span>
            <select
              className="select"
              value={priority}
              onChange={(e: { target: { value: string } }) =>
                setPriority(e.target.value as Priority | 'all')
              }
              aria-label="Filter by priority"
            >
              <option value="all">All priorities</option>
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {p[0]!.toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="field filters__f">
            <span className="sr-only">Status</span>
            <select
              className="select"
              value={statusFilter ?? 'all'}
              onChange={(e: { target: { value: string } }) =>
                setParams({ status: e.target.value === 'all' ? undefined : e.target.value })
              }
              aria-label="Filter by status"
            >
              <option value="all">All statuses</option>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          {filtersActive && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={clear}>
              Clear filters
            </button>
          )}
          <span className="faint filters__count" aria-live="polite">
            {filtered.length} of {ws.tasks.length} tasks
          </span>
        </div>

        {mode === 'board' ? (
          filtered.length === 0 ? (
            <div className="panel">
              <Empty
                title="No tasks match these filters"
                action={
                  <button type="button" className="btn btn--sm" onClick={clear}>
                    Clear filters
                  </button>
                }
              >
                Try a different search term, or clear the filters to see all {ws.tasks.length}{' '}
                tasks.
              </Empty>
            </div>
          ) : (
            <div className="board" role="list" aria-label="Task board">
              {TASK_STATUSES.map((s) => {
                const col = filtered.filter((t) => t.status === s)
                const check = dragTask ? checkTransition(dragTask, s, ws) : undefined
                const droppable = !!dragTask && dragTask.status !== s
                return (
                  <section
                    key={s}
                    role="listitem"
                    className={`col${droppable ? (check?.ok ? ' col--ok' : ' col--no') : ''}${overCol === s && droppable ? ' col--over' : ''}`}
                    aria-label={`${TASK_STATUS_LABEL[s]}, ${col.length} tasks`}
                    onDragOver={(e: {
                      preventDefault: () => void
                      dataTransfer: { dropEffect: string }
                    }) => {
                      if (!dragTask) return
                      e.preventDefault()
                      // Always accept the drop so a refused move can explain itself in a toast.
                      e.dataTransfer.dropEffect = 'move'
                      setOverCol(s)
                    }}
                    onDragLeave={() => setOverCol((c) => (c === s ? undefined : c))}
                    onDrop={(e: { preventDefault: () => void }) => {
                      e.preventDefault()
                      void drop(s)
                    }}
                  >
                    <header className="col__head">
                      <Glyph kind={s} size={13} />
                      <h2>{TASK_STATUS_LABEL[s]}</h2>
                      <span className="count">{col.length}</span>
                    </header>
                    {droppable && !check?.ok && overCol === s && (
                      <p className="col__why">{check?.reason}</p>
                    )}
                    <ul className="col__list">
                      {col.map((t) => (
                        <li key={t.id}>
                          <TaskCard
                            task={t}
                            selected={taskId === t.id}
                            onSelect={() => selectTask(t.id)}
                            onDragStart={() => setDragId(t.id)}
                            onDragEnd={() => {
                              setDragId(undefined)
                              setOverCol(undefined)
                            }}
                          />
                        </li>
                      ))}
                      {col.length === 0 && (
                        <li className="col__empty faint">
                          {filtersActive ? 'No matching tasks' : 'No tasks'}
                        </li>
                      )}
                    </ul>
                  </section>
                )
              })}
            </div>
          )
        ) : (
          <div className="panel tlpanel">
            <Timeline
              ws={ws}
              visibleTaskIds={visibleIds}
              selectedTaskId={taskId}
              selectedMilestoneId={milestoneId}
              onSelectTask={(id) => setParams({ task: id, ms: undefined })}
              onSelectMilestone={(id) => setParams({ ms: id, task: undefined })}
            />
          </div>
        )}
      </div>

      {taskId ? (
        <TaskInspector
          taskId={taskId}
          onClose={() => selectTask(undefined)}
          onSelectTask={(id) => selectTask(id)}
        />
      ) : milestoneId ? (
        <MilestoneInspector
          milestoneId={milestoneId}
          onClose={() => setParams({ ms: undefined })}
          onSelectTask={(id) => setParams({ task: id, ms: undefined })}
        />
      ) : null}
    </div>
  )
}

function TaskCard({
  task,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  task: Task
  selected: boolean
  onSelect: () => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const ws = useWorkspace()
  const unmet = unmetDependencies(task, ws.tasks)
  const passed = task.validation.filter((c) => c.result === 'passed').length
  const failedCrit = task.validation.some((c) => c.result === 'failed')
  const next = NEXT[task.status]
  const opts = transitionOptions(task, ws)
  // With a live backend only a few moves exist; offer the first one that is allowed.
  const nextOpt = ws.capabilities?.transitions
    ? opts.find((o) => o.ok && (task.status === 'blocked' || o.to === 'completed'))
    : next
      ? opts.find((o) => o.to === next)
      : undefined
  const showAction = !!nextOpt?.ok

  return (
    <article
      className={`card${selected ? ' card--selected' : ''}${task.status === 'blocked' ? (task.blocked?.kind === 'failure' ? ' card--failed' : ' card--blocked') : ''}`}
      draggable
      onDragStart={(e: {
        dataTransfer: { setData: (t: string, v: string) => void; effectAllowed: string }
      }) => {
        e.dataTransfer.setData('text/plain', task.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className="card__main"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`${task.id} ${task.title}`}
      >
        <div className="card__top">
          <Glyph kind={taskGlyphKind(task)} size={13} />
          <span className="mono faint">{task.id}</span>
          <span className="spacer" />
          <PriorityMark priority={task.priority} />
        </div>
        <div className="card__title">{task.title}</div>
        {task.status === 'blocked' && task.blocked && (
          <p className="card__why">{task.blocked.note}</p>
        )}
        {(task.status === 'running' || task.status === 'review') && (
          <Meter value={task.progress} small label={`${task.id} progress`} />
        )}
        <div className="card__meta">
          <span className="chip">{agentName(ws.agents, task.assigneeId)}</span>
          {task.dependsOn.length > 0 && (
            <span
              className={`chip${unmet.length ? ' chip--warn' : ''}`}
              title={
                unmet.length
                  ? `Waiting on ${unmet.map((u) => u.id).join(', ')}`
                  : 'All prerequisites complete'
              }
            >
              <Icon14 />
              {unmet.length
                ? `Waiting on ${unmet.length}`
                : `${task.dependsOn.length} prerequisite${task.dependsOn.length === 1 ? '' : 's'} met`}
            </span>
          )}
          <span
            className={`chip${failedCrit ? ' chip--bad' : ''}`}
            title="Validation criteria passed"
          >
            {passed}/{task.validation.length} checks
          </span>
        </div>
      </button>
      {showAction && (
        <button
          type="button"
          className="btn btn--sm card__act"
          onClick={() => void store.transitionTask({ taskId: task.id, to: next! })}
        >
          {nextOpt!.label}
        </button>
      )}
    </article>
  )
}

function Icon14() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" />
    </svg>
  )
}
