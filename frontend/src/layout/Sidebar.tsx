import { Icon, type IconName } from '../design/ui.tsx'
import { navigate, useRoute, type ViewId } from '../state/router.ts'
import { useApp, useWorkspace } from '../state/store.ts'

const NAV: { id: ViewId; label: string; icon: IconName }[] = [
  { id: 'results', label: 'Results', icon: 'results' },
  { id: 'orchestration', label: 'Orchestration', icon: 'graph' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
]

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const route = useRoute()
  const { submitMode } = useApp()
  const ws = useWorkspace()
  const agents = Object.values(ws.current?.agents ?? {})
  const failed = agents.filter((a) => a.status === 'failed').length
  const toApprove = agents.filter((a) => a.status === 'ok' && !a.approved).length

  const badge = (id: ViewId): { n: number; title: string; kind: string } | null => {
    if (id !== 'results') return null
    if (failed) return { n: failed, title: `${failed} failed`, kind: 'failed' }
    if (toApprove) return { n: toApprove, title: `${toApprove} to approve`, kind: 'review' }
    return null
  }

  return (
    <>
      <div className={`scrim${open ? ' scrim--open' : ''}`} onClick={onClose} aria-hidden="true" />
      <nav className={`sidebar${open ? ' sidebar--open' : ''}`} aria-label="Primary">
        <div className="brand">
          <img src="favicon.svg" alt="" width="26" height="26" />
          <span>Horizon AI</span>
        </div>
        <ul className="nav">
          {NAV.map((item) => {
            const b = badge(item.id)
            const active = route.view === item.id
            return (
              <li key={item.id}>
                <a
                  href={`#/${item.id}`}
                  className={`nav__link${active ? ' nav__link--active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault()
                    navigate(item.id)
                    onClose()
                  }}
                >
                  <Icon name={item.icon} size={17} />
                  <span className="nav__label">{item.label}</span>
                  {b && (
                    <span className={`count nav__count count--${b.kind}`} title={b.title}>
                      {b.n}
                    </span>
                  )}
                </a>
              </li>
            )
          })}
        </ul>
        <div className="sidebar__foot">
          <p>
            {submitMode === 'upload'
              ? 'Your reviews, run with your own Hugging Face key.'
              : 'Reviews of the files in your project, run by server.py.'}
          </p>
        </div>
      </nav>
    </>
  )
}
