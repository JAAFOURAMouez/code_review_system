# Horizon AI

A control center for long-horizon, multi-agent work: orchestration graph, execution timeline, task board, persistent memory, live feed and run evaluation.

> **Everything in this app is demonstration data.** No agents are executed and no metric is a measurement of a real system. A small simulator advances the sample run in your browser; every event it creates is labelled "Simulated", and it can never approve work.

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:5173 (esbuild watch + static server)
npm run build      # production bundle in dist/
npm test           # domain, simulator and layout tests (tsx + node:test)
npm run lint       # type check + prettier --check
```

Open `?fail=1` (for example `http://127.0.0.1:5173/?fail=1`) to see the load-error state; "Try again" recovers.

## What is in it

| View                     | What it shows                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview                 | What needs a person, objective progress against plan, task states, agents, phases and milestones, retries and recent errors                                                                      |
| Agent Orchestration      | Pan/zoom graph. Nodes show state, current task and progress; edges are handoffs derived from task dependencies. Select an agent for responsibilities, tasks, handoffs, recent actions and errors |
| Tasks & Planning         | Board (Backlog to Completed) with drag-and-drop, search and filters, plus a Gantt timeline with planned vs actual, projected finish, milestones and dependency highlighting                      |
| Persistent Memory        | Searchable list and relationship graph. Stored and inferred memories are visually distinct; inferred ones show confidence and what they were derived from                                        |
| Execution History        | Newest-first feed with filters by agent, type, status and run                                                                                                                                    |
| Evaluation & Reliability | Task and per-step success, retries and recovery, duration, tokens and estimated cost, interventions, run-to-run comparison                                                                       |
| Settings                 | Simulator controls, cost assumption, reset, limitations                                                                                                                                          |

Selection (agent, task, memory, milestone) and view modes live in the URL, so links are shareable and every view agrees on what is selected.

## How consistency is kept

One `Workspace` object (`src/domain/types.ts`) is the single source of truth. Everything else is derived from it in `src/domain/rules.ts`:

- **Agent state** comes from its tasks (running > failed > blocked > completed > idle). It is never stored.
- **Handoff edges** come from cross-agent task dependencies, and their status from the producing tasks.
- **Phases, milestones, progress and "needs attention"** come from tasks.
- **Metrics** are computed from the event log. A failed step is a tool call or verification that failed, or an error event.
- **Task transitions** (`applyTransition`) enforce dependencies, one running task per agent, and "all validation criteria passed before approval". Each transition appends events, releases dependents, and is logged as a human intervention when you cause it.

## Structure

```
src/
  domain/      types, pure rules, seed data, simulator   (no React, no I/O)
  data/        HorizonRepository interface + in-browser mock
  state/       store, hash router, settings
  design/      tokens.css, components.css, UI primitives
  layout/      shell, sidebar, top bar
  viz/         Viewport (pan/zoom), AgentGraph, Timeline, MemoryGraph, charts, layout algorithms
  inspectors/  task, agent, memory and milestone detail panels
  views/       one component per sidebar destination
tests/         domain rules, seed consistency, simulator invariants, layouts
```

### Connecting a backend

Views only talk to `HorizonRepository` (`src/data/repository.ts`): `load`, `subscribe`, `transitionTask`, `setCriterion`, `reset`. Implement it over REST/WebSocket/SSE and pass it to `store.init` in `src/main.tsx`. Domain rules stay the single place where states are derived; a real backend would replace the mock's command handling and event stream.

## Design system

Observability-console direction: charcoal surfaces, thin borders, small radii (4 to 6px), a restrained violet (selection, focus, primary action) and cyan (live work, data).

- **Tokens** in `src/design/tokens.css`: surfaces `--bg-0..3`, text `--text-1..3`, accents, semantic status colours, a 4px spacing scale, a 11.5 to 24px type scale, and a system font stack (no web fonts to load).
- **Status is never colour alone.** Each state has its own shape: dashed ring (backlog), open ring (idle, ready), half-filled (running), three-quarter (review), check (completed), pause square (blocked), cross (failed).
- **Contrast.** Body text is 7.9 to 14.9:1 on panels; muted text, violet and status colours are 4.8:1 or better on every surface they appear on; white on the primary button is 5.0:1.
- **Data viz.** One hue per series, bars start at zero, values labelled directly, the step-success axis fixed at 0 to 100%.
- **Responsive.** Sidebar becomes a drawer below 860px; the inspector overlays below 1280px and is full screen on phones; graphs start at a readable zoom and pan.
- **Accessibility.** Skip link, visible focus, semantic controls, keyboard operation of graph nodes and canvases (arrows pan, + and - zoom, 0 fits), Escape closes panels, reduced motion respected.

## Limitations

- All data is generated sample data; state lives in memory and resets on reload (settings persist in localStorage).
- No execution backend. The simulator is a demonstration aid, not an agent runtime.
- The cost figure uses a placeholder blended price, adjustable in Settings.
- Handoff edges are derived from dependencies; the three dashed "feedback" lines are sample data.
- Past runs have aggregate metrics and a short sample event history, not full logs.
- Drag-and-drop is mouse-only; the same transitions are available from the keyboard in the task inspector and on cards.
- The build uses esbuild directly (no Vite) so it needs nothing beyond React and esbuild.
