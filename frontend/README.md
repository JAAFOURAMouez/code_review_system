# Horizon AI (front end)

The dashboard of the code review system. It shows what the agents found and lets a person
approve each result. All data comes from the review server (`../server.py`); the browser keeps
only your key (public mode) and the current view in the address bar.

## Run it

```bash
npm install
npm run build      # bundle in dist/, served by ../server.py
npm run dev        # http://127.0.0.1:5173 with ?api=http://127.0.0.1:8787 (keep server.py running)
npm test           # pipeline and formatting tests (tsx + node:test)
npm run lint       # type check + prettier --check
```

## Views

| View          | What it shows                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing       | Shown before the first review: what the agents do, then your key (public mode) and the code to review                                                            |
| Results       | Each agent's result for the latest review: linter findings, explanation, suggestions, documentation, tests with their pytest run, corrected code with its checks |
| Orchestration | The pipeline as it ran: static analysis, then the five model agents in parallel, their tool loops, live statuses and a timeline of when each agent ran           |
| History       | Every review with its outcome, and the events of the selected one                                                                                                |
| Settings      | Your Hugging Face key and model (public mode), the server, and each agent's model, tools and time limit                                                          |

The only actions are the ones the backend allows: start a review, approve an agent's result,
re-run an agent.

## Code

- `src/api.ts`: talks to the server (snapshot, live stream, commands).
- `src/types.ts`: the data the server sends, including each agent's result.
- `src/pipeline.ts`: pure helpers (agent order, finding counts, timeline), tested in `tests/`.
- `src/views/`: the four views; `src/layout/`: shell, landing page and the review form.
