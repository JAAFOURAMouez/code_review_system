import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HttpRepository } from './data/httpRepository.ts'
import { MockRepository } from './data/mockRepository.ts'
import type { HorizonRepository } from './data/repository.ts'
import './design/tokens.css'
import './design/components.css'
import './layout/layout.css'
import './viz/viz.css'
import './views/views.css'
import { App } from './layout/Shell.tsx'
import { store } from './state/store.ts'

// Which data source to use:
//   ?demo                  sample data with a simulator (no backend)
//   ?api=http://host:port  a Horizon backend on another origin (e.g. the dev server)
//   otherwise              the backend named at build time (HORIZON_API_URL), or the server
//                          that served this page, if it answers /api/health,
//                          else the demo data.
// `?fail=1` rejects the first demo load so the error state can be seen.
async function chooseRepository(): Promise<HorizonRepository> {
  const q = new URLSearchParams(location.search)
  const demo = () => new MockRepository({ failFirstLoad: q.has('fail') })
  if (q.has('demo')) return demo()
  // ?api= wins, then the address baked in at build time (HORIZON_API_URL), then the same origin.
  const base = (q.get('api') ?? __HORIZON_API_URL__).replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) })
    const body = (await res.json()) as { app?: string; mode?: 'local' | 'public' }
    if (body.app === 'horizon-code-review') return new HttpRepository(base, body.mode ?? 'local')
  } catch {
    // No backend here. An explicit address still gets a live repository, so the error is visible.
    if (q.has('api') || __HORIZON_API_URL__) return new HttpRepository(base, 'public')
  }
  return demo()
}

void chooseRepository().then((repo) => store.init(repo))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
