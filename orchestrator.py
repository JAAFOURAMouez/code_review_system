#!/usr/bin/env python3
"""
Orchestrator for the Code Review & Improvement System.

Pipeline for one file:

1. The static analysis agent runs first (pylint, flake8, bandit, radon).
2. Its findings are written to a temporary JSON file whose path is given to the other agents
   in ``CODE_REVIEW_LINT_RESULTS``, so every LLM agent works from verified tool output.
3. The planner agent looks at the file and the findings and decides which of the other agents
   are worth running (``agents/planner.py``). An agent it skips gets a ``{"skipped": true,
   "reason": ...}`` result; if the planner fails, every agent runs.
4. The selected LLM agents run in parallel (``LLM_MAX_PARALLEL``, default 5), except that an agent
   with ``depends_on`` waits for the agents it names. The correction agent waits for the test
   generator: the tests are handed over in a file named in ``CODE_REVIEW_SHARED`` and the
   correction is refused when it breaks a test that passed on the original file. The test
   generator and the correction agent call tools (linters, tests) in a loop and get a longer
   timeout (``AGENT_TOOL_TIMEOUT``).

Each agent is a separate process that prints one JSON object. Results are returned in the
order of ``AGENTS``.

With a ``Memory`` (see ``agents/memory.py``) the pipeline also remembers each file between
reviews: after static analysis it looks up the file's earlier reviews and hands the agents a
short history (``CODE_REVIEW_HISTORY``), and it stores the finished review. The command line
uses the memory of ``.review_memory/``; ``run_pipeline`` uses none unless given one.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional

from dotenv import load_dotenv

from agents import flow
from agents import memory as review_memory

load_dotenv()  # Load environment variables from .env file

LINT_ENV = "CODE_REVIEW_LINT_RESULTS"


def get_python_executable():
    """Get the Python executable, preferring the venv if present."""
    venv_python = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".venv", "bin", "python")
    if os.path.isfile(venv_python):
        return venv_python
    return sys.executable


AGENTS = [
    {
        "name": "static_analysis",
        "script": "agents/static_analysis.py",
        "description": "Static Analysis Agent",
        "needs_lint": False,
    },
    {
        "name": "planner",
        "script": "agents/planner.py",
        "description": "Planner Agent",
        "needs_lint": True,
        "planner": True,  # decides which of the agents below run (see flow.apply_plan)
    },
    {
        "name": "code_understanding",
        "script": "agents/code_understanding.py",
        "description": "Code Understanding Agent",
        "needs_lint": True,
    },
    {
        "name": "improvement_suggestion",
        "script": "agents/improvement_suggestion.py",
        "description": "Improvement Suggestion Agent",
        "needs_lint": True,
    },
    {
        "name": "test_generator",
        "script": "agents/test_generator.py",
        "description": "Test Generator Agent",
        "needs_lint": True,
        "uses_tools": True,
    },
    {
        "name": "documentation_agent",
        "script": "agents/documentation_agent.py",
        "description": "Documentation Agent",
        "needs_lint": True,
    },
    {
        "name": "code_correction",
        "script": "agents/code_correction_agent.py",
        "description": "Code Correction Agent",
        "needs_lint": True,
        "uses_tools": True,
        # Receives the generated tests and must not break the ones that passed.
        "depends_on": ["test_generator"],
    },
]


def needs_lint(agent: Dict[str, Any]) -> bool:
    """Whether an agent runs after static analysis and receives its findings."""
    return bool(agent.get("needs_lint", agent.get("name") != "static_analysis"))


def agent_timeout(agent: Dict[str, Any]) -> int:
    """Seconds an agent may run: longer for agents that call tools in a loop."""
    if agent.get("uses_tools"):
        return int(os.getenv("AGENT_TOOL_TIMEOUT", "300"))
    return int(os.getenv("AGENT_TIMEOUT", "120"))


def _script_path(script: str) -> str:
    """Scripts are relative to this folder, wherever the orchestrator is started from."""
    if os.path.isabs(script):
        return script
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), script)


def run_agent(agent: Dict[str, str], file_path: str, env: Dict[str, str] = None) -> Dict[str, Any]:
    """Run a single agent and return its output."""
    try:
        result = subprocess.run(
            [get_python_executable(), _script_path(agent["script"]), file_path],
            capture_output=True,
            text=True,
            timeout=agent_timeout(agent),
            env=env,  # None = inherit this process's environment (the CLI default)
            check=False,
        )
        if result.returncode == 0:
            output = result.stdout.strip()
            try:
                return json.loads(output)
            except json.JSONDecodeError:
                # Tolerate stray text around the JSON object.
                start = output.find('{')
                end = output.rfind('}')
                if start != -1 and end != -1 and start < end:
                    try:
                        return json.loads(output[start:end + 1])
                    except json.JSONDecodeError:
                        pass
                return {
                    "file": file_path,
                    "agent": agent["name"],
                    "error": True,
                    "raw_output": output,
                    "stderr": result.stderr
                }
        return {
            "file": file_path,
            "agent": agent["name"],
            "error": True,
            "returncode": result.returncode,
            "stderr": result.stderr
        }
    except subprocess.TimeoutExpired:
        return {
            "file": file_path,
            "agent": agent["name"],
            "error": True,
            "timeout": True
        }
    except Exception as e:  # pylint: disable=broad-except
        return {
            "file": file_path,
            "agent": agent["name"],
            "error": True,
            "exception": str(e)
        }


def write_lint_file(static_result: Optional[Dict[str, Any]]) -> Optional[str]:
    """Save the static analysis findings for the LLM agents. Returns the path, or None when
    static analysis failed (the agents then run the linters themselves)."""
    if not isinstance(static_result, dict) or static_result.get("error"):
        return None
    findings = static_result.get("findings")
    if not isinstance(findings, list):
        return None
    fd, path = tempfile.mkstemp(prefix="review_lint_", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"file": static_result.get("file"), "findings": findings}, f)
    return path


def env_with_lint(env: Optional[Dict[str, str]], lint_path: Optional[str]) -> Optional[Dict[str, str]]:
    """The agent environment plus the path of the findings file."""
    if not lint_path:
        return env
    out = dict(os.environ if env is None else env)
    out[LINT_ENV] = lint_path
    return out


def run_pipeline(
    file_path: str,
    env: Optional[Dict[str, str]] = None,
    agents: Optional[List[Dict[str, Any]]] = None,
    runner: Callable[..., Dict[str, Any]] = run_agent,
    on_result: Optional[Callable[[Dict[str, Any], Dict[str, Any], float], None]] = None,
    max_parallel: Optional[int] = None,
    memory: Optional[review_memory.Memory] = None,
    on_history: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> List[Dict[str, Any]]:
    """Run static analysis, then the LLM agents in parallel (an agent with ``depends_on`` starts
    once the agents it names have finished and receives their results). Returns results in
    agent order. ``on_result(agent, result, seconds)`` is called as each agent finishes.
    With a ``memory`` the agents also get the history of earlier reviews of the file
    (``on_history(history)`` is called with it) and this review is stored when it is done."""
    agents = AGENTS if agents is None else agents
    max_parallel = max_parallel or int(os.getenv("LLM_MAX_PARALLEL", "5"))
    results: Dict[int, Dict[str, Any]] = {}

    def one(index: int, agent_env: Optional[Dict[str, str]]) -> None:
        started = time.monotonic()
        result = runner(agents[index], file_path, agent_env)
        if not isinstance(result, dict):
            result = {"error": True, "exception": "the agent did not return a JSON object"}
        result.setdefault("agent", agents[index]["name"])
        results[index] = result
        if on_result:
            on_result(agents[index], result, time.monotonic() - started)

    first = [i for i, a in enumerate(agents) if not needs_lint(a)]
    planners = [i for i, a in enumerate(agents) if needs_lint(a) and flow.is_planner(a)]
    rest = [i for i, a in enumerate(agents) if needs_lint(a) and i not in planners]
    for i in first:
        one(i, env)
    static = next((results[i] for i in first if agents[i]["name"] == "static_analysis"), None)
    lint_path = write_lint_file(static)
    lint_env = env_with_lint(env, lint_path)
    context = review_memory.review_context(memory, file_path, static)
    history = memory.recall(context["key"], context["hash"], context["findings"]) if context else None
    if history and on_history:
        on_history(history)
    history_path = review_memory.write_history_file(history)
    lint_env = review_memory.env_with_history(lint_env, history_path)

    def with_dependencies(i: int) -> None:
        shared_path = None
        agent_env = lint_env
        if flow.dependencies(agents[i]):
            done = {agents[j]["name"]: r for j, r in list(results.items())}
            shared_path = flow.write_shared_file(done)
            agent_env = flow.env_with_shared(lint_env, shared_path)
        try:
            one(i, agent_env)
        finally:
            _remove(shared_path)

    try:
        # The planner runs before the others and chooses which of them to run.
        for i in planners:
            one(i, lint_env)
        to_run, skipped = flow.apply_plan(agents, rest, results[planners[0]] if planners else None)
        for i, reason in skipped.items():
            results[i] = flow.skipped_result(agents[i], reason, file_path)
            if on_result:
                on_result(agents[i], results[i], 0.0)
        flow.schedule(agents, to_run, with_dependencies, max_parallel)
    finally:
        _remove(lint_path)
        _remove(history_path)
    ordered = [results[i] for i in range(len(agents))]
    if context:
        memory.record(context["key"], context["hash"], context["findings"], ordered)
    return ordered


def _remove(path: Optional[str]) -> None:
    """Delete a temporary file, ignoring a missing one."""
    if path:
        try:
            os.remove(path)
        except OSError:
            pass


def save_corrected_code(result: Dict[str, Any]) -> Optional[str]:
    """Write the corrected code next to the original, only when it compiled."""
    code = result.get("corrected_code")
    original = result.get("file")
    if result.get("error") or not code or not original:
        return None
    if not (result.get("verification") or {}).get("syntax_valid", True):
        return None
    name, ext = os.path.splitext(original)
    path = f"{name}_corrected{ext}"
    with open(path, "w", encoding="utf-8") as f:
        f.write(code)
    return path


def _print_result(result: Dict[str, Any]) -> None:
    agent_name = result.get("agent", "unknown")
    print(f"\n--- {agent_name.upper()} ---")
    if result.get("error"):
        print(f"Error: {result.get('note') or result.get('error')}")
        for key in ("detail", "raw_output", "stderr"):
            if result.get(key):
                print(f"{key}: {str(result[key])[:300]}...")
                break
        return
    for key, value in result.items():
        if key in ("file", "agent", "timestamp"):
            print(f"{key}: {value}")
        elif isinstance(value, str) and len(value) > 200:
            print(f"{key}: {value[:200]}... (truncated)")
        elif isinstance(value, list) and len(value) > 5:
            print(f"{key}: {value[:5]}... (truncated, {len(value)} total)")
        else:
            print(f"{key}: {value}")


def main():
    """Command line: python orchestrator.py <file_path>
    ``python orchestrator.py --forget [file_path]`` deletes the memory of a file (or of all)."""
    if len(sys.argv) < 2:
        print("Usage: python orchestrator.py <file_path>")
        sys.exit(1)

    memory = review_memory.Memory.from_env()
    if sys.argv[1] == "--forget":
        target = review_memory.file_key(sys.argv[2]) if len(sys.argv) > 2 else None
        print(f"Forgot {memory.forget(target)} review(s).")
        return

    file_path = sys.argv[1]
    if not os.path.isfile(file_path):
        print(f"Error: File '{file_path}' not found.")
        sys.exit(1)

    print(f"Running Code Review & Improvement System on {file_path}")
    print("=" * 60)
    print("Static analysis first, then the planner chooses the agents, which run in parallel "
          "(the correction waits for the generated tests)...")

    def report(agent, result, seconds):
        if result.get("skipped"):
            print(f"  {agent['description']}: Skipped ({result.get('reason')})", flush=True)
            return
        status = "Completed with errors" if result.get("error") else "Completed successfully"
        print(f"  {agent['description']}: {status} ({seconds:.1f}s)", flush=True)
        if flow.is_planner(agent) and result.get("summary"):
            print(f"    Plan: {result['summary']}", flush=True)

    started = time.monotonic()
    results = run_pipeline(file_path, on_result=report, memory=memory,
                           on_history=lambda h: print(review_memory.describe(h), flush=True))
    print(f"\nTotal time: {time.monotonic() - started:.1f}s")

    print("\n" + "=" * 60)
    print("AGGREGATED RESULTS")
    print("=" * 60)
    for result in results:
        _print_result(result)
        if result.get("agent") == "code_correction":
            try:
                saved = save_corrected_code(result)
                if saved:
                    print(f"\n💾 Corrected code saved to: {saved}")
            except OSError as e:
                print(f"\n❌ Failed to save corrected code: {e}")

    output_file = f"{file_path}_review_results.json"
    try:
        with open(output_file, 'w', encoding="utf-8") as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        print(f"\nFull results saved to {output_file}")
    except OSError as e:
        print(f"\nFailed to save results: {e}")


if __name__ == "__main__":
    main()
