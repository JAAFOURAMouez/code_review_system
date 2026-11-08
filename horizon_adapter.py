"""Translate stored review runs into the Workspace the front end reads.

Pure functions only (no I/O, no threads), so the mapping is easy to test. Everything in the
Workspace comes from what the agents really did:

* ``agents``: the pipeline's agents, with their tools and time budget.
* ``runs``: one summary per review, oldest first.
* ``current``: the latest review in detail: each agent's status, timing, problem and its
  result (the agent's JSON output, minus process noise).
* ``events``: what happened, for the history.
"""

from __future__ import annotations

import hashlib
import os
import re
from typing import Any


# Same value as orchestrator.run_agent's timeout (AGENT_TIMEOUT seconds, default 120).
AGENT_BUDGET_MS = int(os.getenv("AGENT_TIMEOUT", "120")) * 1000
# Same value as orchestrator.agent_timeout for agents with "uses_tools" (AGENT_TOOL_TIMEOUT).
AGENT_TOOL_BUDGET_MS = int(os.getenv("AGENT_TOOL_TIMEOUT", "300")) * 1000

# Display metadata for the agents shipped in agents/. Unknown agents fall back to defaults.
AGENT_INFO: dict[str, dict[str, Any]] = {
    "static_analysis": {
        "name": "Static Analysis",
        "role": "Finds bugs, style, security and complexity issues with linters",
        "tools": ["pylint", "flake8", "bandit", "radon"],
        "llm": False,
    },
    "code_understanding": {
        "name": "Code Understanding",
        "role": "Explains what the code does and flags complex sections",
        "tools": [],
        "llm": True,
    },
    "improvement_suggestion": {
        "name": "Improvements",
        "role": "Suggests refactorings and best practices",
        "tools": [],
        "llm": True,
    },
    "test_generator": {
        "name": "Test Generator",
        "role": "Writes unit tests and runs them against the file",
        "tools": ["run_tests", "check_syntax"],
        "llm": True,
        "uses_tools": True,
    },
    "documentation_agent": {
        "name": "Documentation",
        "role": "Drafts docstrings, an overview and usage examples",
        "tools": [],
        "llm": True,
    },
    "code_correction": {
        "name": "Code Correction",
        "role": "Corrects the file and checks the result with the linters",
        "tools": ["run_pylint", "run_flake8", "run_bandit", "run_radon", "check_syntax",
                  "run_tests"],
        "llm": True,
        "uses_tools": True,
    },
}

# The field each agent must fill for its output to count as "not empty".
OUTPUT_FIELD = {
    "static_analysis": "findings",
    "code_understanding": "explanation",
    "improvement_suggestion": "improvements",
    "test_generator": "tests",
    "documentation_agent": "documentation",
    "code_correction": "corrected_code",
}

# Keys the orchestrator puts in a result when the process itself failed.
PROCESS_FAILURE_KEYS = ("raw_output", "returncode", "timeout", "exception")


def info(agent_name: str) -> dict[str, Any]:
    return AGENT_INFO.get(
        agent_name,
        {
            "name": agent_name.replace("_", " ").title(),
            "role": "Custom agent",
            "tools": [],
            "llm": False,
            "artifact": "Agent output",
            "responsibilities": [],
        },
    )


def budget_ms(agent_name: str) -> int:
    """Time budget of an agent (its timeout)."""
    return AGENT_TOOL_BUDGET_MS if info(agent_name).get("uses_tools") else AGENT_BUDGET_MS


def evaluate_output(agent_name: str, result: Any) -> dict[str, Any]:
    """Judge an agent's result. Returns the three automated checks and a problem message.

    The LLM agents catch API failures and return ``{"error": true, ...}`` with exit code 0, and
    some return an empty string without flagging anything. Both count as failures here so a
    silent empty result is never shown as a success.
    """
    if not isinstance(result, dict):
        return {
            "process": False,
            "no_error": False,
            "non_empty": False,
            "problem": "The agent did not return a JSON object.",
        }
    process_ok = not any(k in result for k in PROCESS_FAILURE_KEYS)
    flagged = bool(result.get("error"))
    problem: str | None = None
    if not process_ok:
        if result.get("timeout"):
            problem = "The agent timed out."
        elif result.get("exception"):
            problem = f"The agent could not be started: {result['exception']}"
        elif "returncode" in result:
            stderr = str(result.get("stderr") or "").strip().splitlines()
            tail = stderr[-1] if stderr else "no error message"
            problem = f"The agent exited with code {result['returncode']}: {tail}"
        else:
            problem = "The agent did not return valid JSON."
    elif flagged:
        problem = str(result.get("note") or result.get("error") or "The agent reported an error.")
        if problem == "True":
            problem = "The agent reported an error."
        if result.get("detail"):
            problem = f"{problem} Detail: {result['detail']}"

    field = OUTPUT_FIELD.get(agent_name)
    value = result.get(field) if field else result
    if field == "findings":
        non_empty = isinstance(value, list)  # zero findings is a legitimate answer
    else:
        non_empty = bool(value)
    if problem is None and not non_empty:
        problem = (
            "The agent returned an empty result (it may have failed to reach its model "
            "without reporting an error)."
        )
    return {
        "process": process_ok,
        "no_error": process_ok and not flagged,
        "non_empty": process_ok and not flagged and non_empty,
        "problem": problem,
    }


def file_fingerprint(text: str) -> dict[str, Any]:
    return {
        "lines": len(text.splitlines()),
        "sha": hashlib.sha256(text.encode("utf-8")).hexdigest()[:12],
    }


def run_number(run_id: str) -> int:
    m = re.search(r"(\d+)$", run_id)
    return int(m.group(1)) if m else 0


def task_id(run_id: str, index: int) -> str:
    return f"T{run_number(run_id)}.{index + 1}"


# Keys of an agent's JSON that are process details, not results.
_RESULT_NOISE = ("file", "agent", "timestamp", "raw_output", "stderr", "returncode", "exception")


def public_result(result: Any) -> dict[str, Any] | None:
    """An agent's result as shown to people: its JSON output without process details (and
    without the server-side file path)."""
    if not isinstance(result, dict):
        return None
    return {k: v for k, v in result.items() if k not in _RESULT_NOISE}


def agent_view(run: dict[str, Any], index: int, name: str) -> dict[str, Any]:
    """One agent of a run: status, timing, human review state and result."""
    rec = run["agents"][name]
    started, ended = rec.get("startedAt"), rec.get("endedAt")
    view: dict[str, Any] = {
        "id": name,
        "taskId": task_id(run["id"], index),
        "status": rec["status"],  # pending | running | ok | failed
        "attempts": rec.get("attempts", 0),
        "approved": bool(rec.get("approved")),
        "startedAt": started,
        "endedAt": ended,
        "durationMs": (ended - started) if started and ended and ended >= started else None,
        "problem": rec.get("problem"),
        "result": public_result(rec.get("result")) if rec["status"] in ("ok", "failed") else None,
    }
    return view


def run_outcome(run: dict[str, Any]) -> str:
    recs = list(run["agents"].values())
    if any(r["status"] in ("pending", "running") for r in recs):
        return "in_progress"
    ok = sum(1 for r in recs if r["status"] == "ok")
    if ok == len(recs):
        return "succeeded"
    return "failed" if ok == 0 else "partial"


def run_summary(run: dict[str, Any], now: int) -> dict[str, Any]:
    """A review in one line: file, model, outcome, timing, agents that succeeded."""
    recs = list(run["agents"].values())
    outcome = run_outcome(run)
    ended = run.get("endedAt") if outcome != "in_progress" else None
    return {
        "id": run["id"],
        "file": run["file"],
        "model": run.get("model"),
        "lines": (run.get("fingerprint") or {}).get("lines"),
        "startedAt": run["startedAt"],
        "endedAt": ended,
        "durationMs": max(0, (ended or now) - run["startedAt"]),
        "outcome": outcome,
        "agentsOk": sum(1 for r in recs if r["status"] == "ok"),
        "agentsFailed": sum(1 for r in recs if r["status"] == "failed"),
        "agentsTotal": len(recs),
        "approved": sum(1 for r in recs if r.get("approved")),
    }


def build_workspace(
    runs: list[dict[str, Any]],
    agent_names: list[str],
    model: str,
    now: int,
) -> dict[str, Any]:
    """Return the Workspace. ``runs`` is oldest first; the last run is the current one."""
    agents = []
    for name in agent_names:
        meta = info(name)
        agents.append({
            "id": name,
            "name": meta["name"],
            "role": meta["role"],
            "llm": meta["llm"],
            "usesTools": bool(meta.get("uses_tools")),
            "tools": meta["tools"],
            "model": model if meta["llm"] else None,
            "budgetMs": budget_ms(name),
        })
    current = None
    if runs:
        cur = runs[-1]
        current = {
            **run_summary(cur, now),
            "agents": {n: agent_view(cur, i, n) for i, n in enumerate(agent_names)
                       if n in cur["agents"]},
        }
    events = [e for run in runs for e in run["events"]]
    events.sort(key=lambda e: (e["at"], e["id"]))
    return {
        "agents": agents,
        "runs": [run_summary(r, now) for r in runs],
        "current": current,
        "events": events,
        "now": now,
    }
