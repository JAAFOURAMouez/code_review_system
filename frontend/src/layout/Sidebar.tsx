import { Icon, type IconName } from '../design/ui.tsx'
import { attentionItems } from '../domain/rules.ts'
import { navigate, useRoute, type ViewId } from '../state/router.ts'
import { useApp, useWorkspace } from '../state/store.ts'

const NAV: { id: ViewId; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'orchestration', label: 'Agent Orchestration', icon: 'graph' },
  { id: 'tasks', label: 'Tasks & Planning', icon: 'tasks' },
  { id: 'memory', label: 'Persistent Memory', icon: 'memory' },
  { id: 'history', label: 'Execution History', icon: 'history' },
  { id: 'evaluation', label: 'Evaluation & Reliability', icon: 'evaluation' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
]

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const route = useRoute()
  const { repoKind, submitMode } = useApp()
  const ws = useWorkspace()
  const needsYou = attentionItems(ws).filter((i) => i.severity !== 'info').length
  const failedAgents = ws.agents.length
    ? ws.tasks.filter((t) => t.status === 'blocked' && t.blocked?.kind === 'failure').length
    : 0

  const badge = (id: ViewId): number => {
    if (id === 'tasks') return needsYou
    if (id === 'orchestration') return failedAgents
    return 0
  }

  return (
    <>
      <div className={`scrim${open ? ' scrim--open' : ''}`} onClick={onClose} aria-hidden="true" />
      <nav className={`sidebar${open ? ' sidebar--open' : ''}`} aria-label="Primary">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="6" fill="#1a1e25" />
            <path d="M5 21h22" stroke="#8b7cf6" strokeWidth="2.4" strokeLinecap="round" />
            <path
              d="M9 21a7 7 0 0 1 14 0"
              fill="none"
              stroke="#4cc9e0"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          </svg>
          <span>Horizon AI</span>
        </div>
        <ul className="nav">
          {NAV.map((item) => {
            const n = badge(item.id)
            const active = route.view === item.id
            return (
              <li key={item.id}>
                <a
                  href={`#/${item.id}`}
                  className={`nav__link${active ? ' nav__link--active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={(e: { preventDefault: () => void }) => {
                    e.preventDefault()
                    navigate(item.id)
                    onClose()
                  }}
                >
                  <Icon name={item.icon} size={17} />
                  <span className="nav__label">{item.label}</span>
                  {n > 0 && (
                    <span className="count nav__count" title={`${n} need attention`}>
                      {n}
                    </span>
                  )}
                </a>
              </li>
            )
          })}
        </ul>
        <div className="sidebar__foot">
          <p>
            {repoKind === 'live'
              ? submitMode === 'upload'
                ? 'Live data from your own reviews. Statuses come from real agent runs.'
                : 'Live data from the agents in your project. Statuses come from real runs.'
              : 'Sample data generated in this browser. No agents are executing; activity is simulated.'}
          </p>
        </div>
      </nav>
    </>
  )
}
