import { Component, useEffect, useState, type ReactNode } from 'react'
import { Spinner, Toasts } from '../design/ui.tsx'
import { useRoute, type ViewId } from '../state/router.ts'
import { store, useApp } from '../state/store.ts'
import { FirstRun } from './Landing.tsx'
import { Sidebar } from './Sidebar.tsx'
import { TopBar } from './TopBar.tsx'
import { History } from '../views/History.tsx'
import { Orchestration } from '../views/Orchestration.tsx'
import { Results } from '../views/Results.tsx'
import { Settings } from '../views/Settings.tsx'

export const VIEW_TITLE: Record<ViewId, string> = {
  results: 'Results',
  orchestration: 'Orchestration',
  history: 'History',
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
    case 'results':
      return <Results />
    case 'orchestration':
      return <Orchestration />
    case 'history':
      return <History />
    case 'settings':
      return <Settings />
  }
}

export function App() {
  const { status, error, ws } = useApp()
  if (status === 'error') return <ErrorScreen message={error ?? 'Unknown error'} />
  if (status === 'loading' || !ws) return <LoadingScreen />
  // Before the first review there is nothing to show but the landing page.
  if (ws.runs.length === 0) return <FirstRun />
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
        <Spinner label="Loading" />
        <div>
          <h2>Connecting to the review server</h2>
          <p className="muted">Loading your reviews.</p>
        </div>
      </div>
    </div>
  )
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="boot">
      <div className="boot__card boot__card--error" role="alert">
        <div>
          <h2>Can’t reach the review server</h2>
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
