import { Component, useEffect, useState, type ReactNode } from 'react'
import { Spinner, Toasts } from '../design/ui.tsx'
import { useRoute, type ViewId } from '../state/router.ts'
import { store, useApp } from '../state/store.ts'
import { FirstRun } from './NewReview.tsx'
import { Sidebar } from './Sidebar.tsx'
import { TopBar } from './TopBar.tsx'
import { Evaluation } from '../views/Evaluation.tsx'
import { History } from '../views/History.tsx'
import { Memory } from '../views/Memory.tsx'
import { Orchestration } from '../views/Orchestration.tsx'
import { Overview } from '../views/Overview.tsx'
import { Settings } from '../views/Settings.tsx'
import { Tasks } from '../views/Tasks.tsx'

const VIEW_TITLE: Record<ViewId, string> = {
  overview: 'Overview',
  orchestration: 'Agent Orchestration',
  tasks: 'Tasks & Planning',
  memory: 'Persistent Memory',
  history: 'Execution History',
  evaluation: 'Evaluation & Reliability',
  settings: 'Settings',
}

class ViewBoundary extends Component<
  { children?: ReactNode; resetKey: string },
  { error?: Error; key: string }
> {
  state: { error?: Error; key: string } = { error: undefined, key: this.props.resetKey }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error?: Error; key: string },
  ) {
    return props.resetKey !== state.key ? { error: undefined, key: props.resetKey } : null
  }
  render() {
    if (this.state.error) {
      return (
        <div className="page">
          <div className="callout callout--failed" role="alert">
            <div>
              <h2>This view could not be displayed</h2>
              <p className="muted">{this.state.error.message}</p>
              <p className="muted">Switch to another view and back, or reload the page.</p>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function CurrentView({ view }: { view: ViewId }) {
  switch (view) {
    case 'overview':
      return <Overview />
    case 'orchestration':
      return <Orchestration />
    case 'tasks':
      return <Tasks />
    case 'memory':
      return <Memory />
    case 'history':
      return <History />
    case 'evaluation':
      return <Evaluation />
    case 'settings':
      return <Settings />
  }
}

export function App() {
  const { status, error, ws, repoKind } = useApp()
  if (status === 'loading') return <LoadingScreen />
  if (status === 'error') return <ErrorScreen message={error ?? 'Unknown error'} />
  // A live backend starts empty: there is nothing to show until the first review exists.
  if (repoKind === 'live' && ws && ws.runs.length === 0) return <FirstRun />
  return <Shell />
}

function Shell() {
  const route = useRoute()
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    document.title = `${VIEW_TITLE[route.view]} | Horizon AI`
  }, [route.view])

  return (
    <div className="app">
      <a
        className="skip"
        href="#main"
        onClick={(e: { preventDefault: () => void }) => {
          e.preventDefault()
          document.getElementById('main')?.focus()
        }}
      >
        Skip to content
      </a>
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="app__main">
        <TopBar onMenu={() => setNavOpen(true)} />
        <main id="main" className="app__content" tabIndex={-1}>
          <ViewBoundary resetKey={route.view}>
            <CurrentView view={route.view} />
          </ViewBoundary>
        </main>
      </div>
      <Toasts />
    </div>
  )
}

function LoadingScreen() {
  return (
    <div className="boot" aria-busy="true">
      <div className="boot__card">
        <Spinner label="Loading workspace" />
        <div>
          <h2>Loading workspace</h2>
          <p className="muted">Fetching agents, tasks and run history.</p>
        </div>
      </div>
      <div className="boot__skeleton" aria-hidden="true">
        <div className="skeleton" style={{ height: 14, width: '40%' }} />
        <div className="skeleton" style={{ height: 14, width: '70%' }} />
        <div className="skeleton" style={{ height: 14, width: '55%' }} />
      </div>
    </div>
  )
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="boot">
      <div className="boot__card boot__card--error" role="alert">
        <div>
          <h2>Couldn’t load the workspace</h2>
          <p className="muted">{message}</p>
          <div className="boot__actions">
            <button type="button" className="btn btn--primary" onClick={() => void store.load()}>
              Try again
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
