import { useState } from 'react'
import { DemoTag, Glyph, Icon, useDismiss } from '../design/ui.tsx'
import { attentionItems, relativeTime } from '../domain/rules.ts'
import { navigate } from '../state/router.ts'
import { NewReview } from './NewReview.tsx'
import { store, useApp, useWorkspace } from '../state/store.ts'

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const ws = useWorkspace()
  const { settings, repoKind, canStartRun, connected } = useApp()
  const run = ws.runs.find((r) => r.id === ws.project.currentRunId)!
  const items = attentionItems(ws)
  const critical = items.filter((i) => i.severity === 'critical').length
  const running = ws.tasks.filter((t) => t.status === 'running').length
  const status =
    critical > 0
      ? { kind: 'failed' as const, label: `Needs attention: ${critical} failed` }
      : items.some((i) => i.severity === 'warning')
        ? { kind: 'blocked' as const, label: 'Needs attention' }
        : running > 0
          ? {
              kind: 'running' as const,
              label: `Running ${running} ${running === 1 ? 'task' : 'tasks'}`,
            }
          : { kind: 'idle' as const, label: 'Idle' }

  return (
    <header className="topbar">
      <button
        type="button"
        className="btn btn--ghost btn--icon topbar__menu"
        aria-label="Open navigation"
        onClick={onMenu}
      >
        <Icon name="menu" />
      </button>
      <div className="topbar__project">
        <span className="topbar__name truncate">{ws.project.name}</span>
        <span className="chip mono" title={run.config}>
          {run.id}
        </span>
      </div>
      <span className={`badge badge--${status.kind}`} role="status">
        <Glyph kind={status.kind} />
        <span className="truncate">{status.label}</span>
      </span>
      <div className="topbar__spacer" />
      {repoKind === 'demo' && (
        <button
          type="button"
          className="chip chip--btn topbar__sim"
          onClick={() => navigate('settings')}
          title="Open simulation settings"
        >
          {settings.simulate ? 'Simulated updates on' : 'Simulated updates paused'}
        </button>
      )}
      {repoKind === 'live' && !connected && (
        <span className="chip topbar__lost" role="status">
          Connection lost, retrying…
        </span>
      )}
      {repoKind === 'live' && connected && (
        <span className="chip topbar__live" title="Showing real runs from your project">
          Live
        </span>
      )}
      <span className="topbar__demo">
        <DemoTag />
      </span>
      {canStartRun && <NewReview />}
      <Notifications />
      <UserMenu />
    </header>
  )
}

function Notifications() {
  const ws = useWorkspace()
  const { readNotifications } = useApp()
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const items = attentionItems(ws).filter((i) => i.severity !== 'info' || i.kind === 'review')
  const unread = items.filter((i) => !readNotifications.includes(i.id))

  return (
    <div className="popwrap" ref={ref}>
      <button
        type="button"
        className="btn btn--ghost btn--icon bell"
        aria-label={`Notifications, ${unread.length} unread`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(!open)}
      >
        <Icon name="bell" />
        {unread.length > 0 && <span className="bell__dot">{unread.length}</span>}
      </button>
      {open && (
        <div className="pop pop--notif" role="dialog" aria-label="Notifications">
          <div className="pop__head">
            <h3>Needs your attention</h3>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={unread.length === 0}
              onClick={() => store.markNotificationsRead(items.map((i) => i.id))}
            >
              Mark all read
            </button>
          </div>
          {items.length === 0 ? (
            <div className="empty">
              <h3>Nothing needs you</h3>
              <p>Failures, blocked tasks and reviews appear here.</p>
            </div>
          ) : (
            <ul className="rows notif__list">
              {items.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    className="row-btn notif__row"
                    onClick={() => {
                      store.markNotificationsRead([i.id])
                      setOpen(false)
                      if (i.taskId) navigate('tasks', { task: i.taskId })
                      else navigate('tasks', { view: 'timeline' })
                    }}
                  >
                    <Glyph
                      kind={
                        i.severity === 'critical'
                          ? 'failed'
                          : i.kind === 'review'
                            ? 'review'
                            : 'blocked'
                      }
                    />
                    <span className="notif__text">
                      <strong className={readNotifications.includes(i.id) ? 'faint' : ''}>
                        {i.title}
                      </strong>
                      <span className="muted notif__detail">{i.detail}</span>
                    </span>
                    <span className="faint notif__time">{relativeTime(i.since, ws.now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function UserMenu() {
  const { repoKind } = useApp()
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div className="popwrap" ref={ref}>
      <button
        type="button"
        className="avatar"
        aria-label="User menu"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(!open)}
      >
        OP
      </button>
      {open && (
        <div className="pop pop--menu" role="menu">
          <div className="pop__head">
            <div>
              <strong>Operator</strong>
              <div className="muted">{repoKind === 'live' ? 'Live session' : 'Demo session'}</div>
            </div>
          </div>
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              navigate('settings')
            }}
          >
            Settings
          </button>
          {repoKind === 'demo' && (
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                void store.resetDemo()
              }}
            >
              Reset demo data
            </button>
          )}
        </div>
      )}
    </div>
  )
}
