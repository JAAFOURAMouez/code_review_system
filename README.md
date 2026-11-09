# Code Review & Improvement System

## Dashboard (Horizon AI)

A web dashboard for this pipeline lives in `frontend/`, served by `server.py` (standard library only).

```bash
pip install -r requirements.txt     # the agents' dependencies (once)
python server.py                    # http://127.0.0.1:8787
```

Open the address, pick a file, press **Start review**. `server.py` runs the same agents as
`orchestrator.py` (it imports `orchestrator.AGENTS` and `run_agent`, so the CLI and the dashboard
behave identically) and shows each run live. Runs are stored in `.horizon/runs.json`.

What the dashboard shows, and where it comes from:

| View | Source |
|---|---|
| Results | Each agent's JSON output for the latest review. Numbers under "Checked with the linters" / "Checked with pytest" come from the tools, not from the model |
| Orchestration | The real pipeline: static analysis first, then the five model agents in parallel; statuses and the timeline come from the agents' start and end times |
| History | Every stored review and its events |
| Failed | Process error, timeout, `"error": true` in the output, **or an empty result** |
| Approve / Re-run | The only human actions: approve an agent's result, or run one agent again |

Developing the front end: `cd frontend && npm install && npm run dev`, then open the dev server with
`?api=http://127.0.0.1:8787` (keep `python server.py` running). `npm run build` refreshes
`frontend/dist`, which `server.py` serves.

Tests: `python -m unittest discover tests` (backend, no API key needed).

Putting it online for other people (each visitor brings their own Hugging Face key): see **DEPLOY.md**.

Security: the server only accepts requests from `localhost`/`127.0.0.1`, refuses other origins, only
reviews `.py` files inside this folder, and never serves `.env`. It has no login, so do not expose
it. The model-based agents send the file's contents to the Hugging Face API configured in `.env`.

---

A multi-agent AI system for automated code review, analysis, and improvement suggestions.
Built entirely with free LLMs (via Hugging Face Inference Providers or local Ollama) and free APIs.

## System Overview

This system consists of five specialized agents that work together to analyze code:

1. **Static Analysis Agent** - Uses open-source linters (pylint, flake8, bandit, radon) to find bugs, style issues, security vulnerabilities, and code quality problems.
2. **Code Understanding Agent** - Uses an LLM to explain what the code does and identify complex sections.
3. **Improvement Suggestion Agent** - Uses an LLM to suggest refactorings, optimizations, and best practices.
4. **Test Generator Agent** - Uses an LLM to generate unit tests for the code.
5. **Documentation Agent** - Uses an LLM to generate documentation (docstrings, overview, usage examples).

## Components

- `agents/static_analysis.py` - Static analysis agent (requires pylint, flake8, bandit, radon)
- `agents/code_understanding.py` - LLM-powered code explanation agent
- `agents/improvement_suggestion.py` - LLM-powered improvement suggestion agent
- `agents/test_generator.py` - LLM-powered test generation agent
- `agents/documentation_agent.py` - LLM-powered documentation agent
- `agents/code_correction_agent.py` - LLM-powered code correction agent, checks its candidates with the tools
- `agents/tools.py` - Tools for the LLM agents and the MCP server (linters, syntax check, test runner)
- `agents/flow.py` - Agent dependencies (`depends_on`) and the file agents use to hand results to each other
- `agents/memory.py` - Memory between reviews (SQLite): findings, tests that passed, outcomes, human verdicts
- `agents/hf_client.py` - LLM client: structured JSON output and the function-calling loop
- `orchestrator.py` - Runs static analysis, then the LLM agents in parallel, and aggregates results
- `mcp_server.py` - MCP server exposing the tools
- `eval/run_eval.py` - Evaluation on 20 files from 5 repositories
- `watcher.py` - Watches a directory for changes and triggers the orchestrator
- `src/sample.py` - Sample Python file with intentional issues for testing

## Setup

### Prerequisites

- Python 3.6+
- pip (Python package installer)

### Installation

1. Clone or copy this repository to your local machine.
2. Install the required Python packages for the static analysis agent:
   ```bash
   pip install pylint flake8 bandit radon
   ```
3. (Optional) Install watchdog for the file watcher:
   ```bash
   pip install watchdog
   ```
   If watchdog is not installed, the watcher will fall back to a polling mechanism.

4. Set up API access for the LLM-powered agents:
   - The LLM-powered agents use the Hugging Face Inference Providers by default.
   - Get a free API token from [Hugging Face](https://huggingface.co/settings/tokens).
   - Set the `HF_API_TOKEN` environment variable:
     ```bash
     export HF_API_TOKEN=your_hugging_face_token_here
     ```
   - Alternatively, you can modify the agents to use a local Ollama instance (see below).

### Using Local Ollama (Alternative to Hugging Face)

The client speaks the OpenAI API, so any OpenAI-compatible server works, Ollama included:

```bash
ollama pull qwen2.5-coder:7b      # a model with tool (function calling) support
export HF_BASE_URL=http://localhost:11434/v1 HF_API_TOKEN=ollama HF_MODEL=qwen2.5-coder:7b
```

## Usage

### Analyze a Single File

Run the orchestrator on a specific file:
```bash
python orchestrator.py path/to/your/file.py
```

### Watch for Changes

Start the file watcher to automatically analyze files when they change:
```bash
python watcher.py path/to/watch
```
Defaults to watching the `src` directory.

### Example Output

When you run the orchestrator on the included `src/sample.py` file, you should see output similar to:

```
Running Code Review & Improvement System on src/sample.py
============================================================
Running Static Analysis Agent...
  Static Analysis Agent: Completed successfully
Running Code Understanding Agent...
  Code Understanding Agent: Completed with errors
...
============================================================
AGGREGATED RESULTS
============================================================

--- STATIC_ANALYSIS ---
file: src/sample.py
findings: [...]
timestamp: ...
agent: static_analysis
```

## How It Works

```
                       ┌──────────────────────────┐
  file.py ───────────▶ │ 1. static_analysis       │  pylint, flake8, bandit, radon
                       └────────────┬─────────────┘
                                    │ findings (JSON file, CODE_REVIEW_LINT_RESULTS)
        ┌───────────────┬───────────┼──────────────┬────────────────┐   2. in parallel
        ▼               ▼           ▼              ▼                ▼
  understanding   improvements   documentation   test_generator   code_correction
  (JSON schema)   (JSON schema)  (JSON schema)   (tool loop)      (tool loop)
                                                  run_tests        run_pylint / run_flake8 /
                                                  check_syntax     run_bandit / run_radon /
                                                                   check_syntax / run_tests
```

1. **Linter findings go to the LLM agents.** The orchestrator runs static analysis first and
   passes its findings to the other agents (a temporary JSON file named in
   `CODE_REVIEW_LINT_RESULTS`). Run on its own, an agent runs the linters itself.
2. **Tools through function calling.** The test generator and the correction agent work in a
   loop: the model calls tools (`agents/tools.py`), reads their results, fixes its work and
   finishes by calling a `submit_*` function. A correction is refused (and the reason sent back)
   when it does not compile, removes a public function or class, or has more linter findings
   than the original. The final result is checked again by the agent and reported in
   `verification` (numbers from the tools, not from the model). Providers without function
   calling get one structured answer instead, with the same checks.
3. **Parallel, with dependencies.** The LLM agents run at the same time (`LLM_MAX_PARALLEL`,
   default 5), in the CLI and in the dashboard, except that an agent can declare
   `depends_on` in `orchestrator.AGENTS` and starts once the agents it names have finished
   (`agents/flow.py`). The correction agent depends on the test generator, so in the diagram above
   it starts when `test_generator` ends while the other three keep running.
4. **Agents exchange results.** The test generator's tests, and how each one fares on the
   original file, are handed to the correction agent in a small JSON file
   (`CODE_REVIEW_SHARED`, like the linter findings). The correction agent can run them with
   `run_shared_tests`, is told which ones fail on the original (possible bugs to fix), and a
   candidate is **refused when it breaks a test that passed on the original**. `verification.tests`
   in its result lists the `regressions`, the tests it `fixed` and the ones `still_failing` (these
   never block a fix, since a generated test can be wrong). Without the tests (agent run on its
   own, generator failed, `CODE_REVIEW_ALLOW_EXEC=0`) the other checks apply and
   `verification.tests.reason` says why. Per-test outcomes need pytest; without it only "all
   passed before, not now" is detected. Re-running the correction agent alone in the dashboard
   reuses the generator's stored result.
5. **Memory between reviews.** After each review of a file the orchestrator stores in
   `.review_memory/memory.sqlite3` (ignored by git) the linter findings as fingerprints (tool,
   code, symbol, message with its numbers removed, never the line, so moving code does not make a
   finding look new), a hash of the file, the tests that passed, the outcome of the correction and
   a person's verdicts (`Memory.set_verdict`). On the next review of the same file the command
   line prints what changed ("3 new, 5 fixed, 2 still there") and the improvement, test and
   correction agents get a short history in their prompt (`CODE_REVIEW_HISTORY`): findings that
   persist get priority, fixed ones are not suggested again, the test generator starts from the
   earlier passing tests, the correction agent knows what it left unfixed last time. The history is
   data from earlier runs, never instructions, and is capped in size. Memory is best effort: if
   the database cannot be read or written the review goes on without it. It holds code and
   findings of your files; `python orchestrator.py --forget [file]` deletes the memory of a file
   (or of all of them). `run_pipeline` uses no memory unless given a `Memory`, which the command
   line does.
6. **Structured outputs.** Every LLM answer is JSON validated against a schema
   (`response_format=json_schema`, falling back to `json_object` and then to plain text for
   providers that do not support it; one repair round trip when the JSON does not match).

Tests are run with pytest in a temporary folder, in a separate process, with a timeout and
without the API key or other environment variables. For a file inside a package, a copy of the
package is used so relative imports work; the file's third-party dependencies must be installed.
`CODE_REVIEW_ALLOW_EXEC=0` turns test execution off; the public server turns it off unless
`HORIZON_ALLOW_CODE_EXECUTION=1`.

### MCP server

The same tools are available to any MCP client (Claude Desktop, Claude Code, Cursor...):

```bash
pip install mcp
python mcp_server.py        # stdio transport
```

```json
{"mcpServers": {"code-review": {"command": "python", "args": ["/path/to/mcp_server.py"]}}}
```

Tools: `run_pylint`, `run_flake8`, `run_bandit`, `run_radon`, `check_syntax`, `run_tests`.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `HF_API_TOKEN` | – | Hugging Face key |
| `HF_MODEL` | `openai/gpt-oss-20b:groq` | Model (must support function calling for the tool loop) |
| `HF_STRUCTURED_MODE` | `json_schema` | `json_schema`, `json_object` or `none` |
| `LLM_MAX_PARALLEL` | `5` | LLM agents run at the same time |
| `AGENT_TIMEOUT` / `AGENT_TOOL_TIMEOUT` | `120` / `300` | Seconds per agent (tool-loop agents get the second) |
| `AGENT_MAX_STEPS` | `8` | Model turns in a tool loop |
| `TEST_TIMEOUT` | `60` | Seconds for one test run |
| `CODE_REVIEW_ALLOW_EXEC` | `1` | `0` disables `run_tests` |
| `CODE_REVIEW_MEMORY_DB` | `.review_memory/memory.sqlite3` | Memory database; `0` turns memory off |
| `CODE_REVIEW_MEMORY_KEEP` | `20` | Reviews kept per file |

### Evaluation

`eval/run_eval.py` runs the pipeline on 20 files from 5 public repositories (psf/requests,
pallets/click, pallets/itsdangerous, httpie/cli, tqdm/tqdm; 4 files each, chosen
deterministically) and checks the outputs with tools: success and schema validity per agent,
whether the correction compiles, keeps the public names and reduces linter findings, whether
the generated tests pass, wall time against the sum of agent times.

```bash
python eval/run_eval.py             # with your HF_API_TOKEN: real quality numbers
python eval/run_eval.py --fake      # no key: scripted fake model, checks the plumbing only
```

Reports go to `eval/results/`. With `--fake` the quality numbers mean nothing (the fake model
only adds a module docstring and writes an import test).

Tests: `python -m unittest discover tests` (no key or network; the model is faked).

## Extending the System

- Add more agents by following the pattern in the `agents/` directory.
- Modify the orchestrator to include additional agents.
- Change the file watcher to watch different file types or directories.
- Replace the Hugging Face API with other free LLM APIs or local models.

## Notes

- The LLM-powered agents require an API key for the Hugging Face Inference Providers (or a local LLM server).
- Without a valid API token or network access to the API, these agents will fall back to returning explanatory error messages.
- The static analysis agent does not require an API key and works offline once its dependencies are installed.
- For best results, ensure you have a valid Hugging Face token and network access to `router.huggingface.co`.
- Note: The code correction agent has been fixed to properly import its dependencies. Ensure you have set the HF_API_TOKEN environment variable for the LLM-powered agents to work.

## License

This project is built for educational purposes and uses free and open-source tools.
