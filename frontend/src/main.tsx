import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { connect } from './api.ts'
import './design/tokens.css'
import './design/components.css'
import './layout/layout.css'
import './views/views.css'
import { App } from './layout/Shell.tsx'
import { store } from './state/store.ts'

// The backend is `?api=<address>`, else the address set at build time (HORIZON_API_URL), else
// the server that served this page.
connect()
  .then((api) => store.init(api))
  .catch((e: unknown) => store.fail(e instanceof Error ? e.message : String(e)))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
