import { Icon, OutcomeBadge } from '../design/ui.tsx'
import { fmtDuration } from '../format.ts'
import { useApp, useServerNow, useWorkspace } from '../state/store.ts'
import { NewReview } from './NewReview.tsx'

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const ws = useWorkspace()
  const { connected } = useApp()
  const run = ws.current
  const running = run ? Object.values(run.agents).filter((a) => a.status === 'running').length : 0
  const now = useServerNow(run?.outcome === 'in_progress')

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
      {run && (
        <div className="topbar__run">
          <span className="topbar__file mono truncate" title={run.file}>
            {run.file}
          </span>
          <OutcomeBadge outcome={run.outcome} />
          <span className="topbar__meta muted">
            {run.outcome === 'in_progress'
              ? `${running} running, ${fmtDuration(now - run.startedAt)} so far`
              : `${run.agentsOk} of ${run.agentsTotal} agents in ${fmtDuration(run.durationMs)}`}
          </span>
        </div>
      )}
      <div className="topbar__spacer" />
      {!connected && (
        <span className="chip topbar__lost" role="status">
          Connection lost, retrying…
        </span>
      )}
      <NewReview />
    </header>
  )
}
