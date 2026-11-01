"""Translate stored review runs into the Workspace model the Horizon AI front end reads.

Pure functions only (no I/O, no threads), so the mapping is easy to test. Everything in
the Workspace is derived from what the agents really did. Nothing here invents numbers:

* Agent statuses come from the process results the orchestrator already collects.
* "Plan" for the timeline is the per-agent time budget (``AGENT_BUDGET_MS``), because the
  orchestrator runs agents one after another with a fixed timeout and has no other plan.
* Token usage is not reported by the agents, so it is left out and flagged in
  ``capabilities.tokens = False``.
"""

from __future__ import annotations

import hashlib
import os
import re
from typing import Any


# Same value as orchestrator.run_agent's timeout (AGENT_TIMEOUT seconds, default 120).
AGENT_BUDGET_MS = int(os.getenv("AGENT_TIMEOUT", "120")) * 1000

PHASE_ID = "pipeline"

# Display metadata for the agents shipped in agents/. Unknown agents fall back to defaults.
AGENT_INFO: dict[str, dict[str, Any]] = {
    "static_analysis": {
        "name": "Static Analysis",
        "role": "Finds bugs, style, security and complexity issues with linters",
        "tools": ["pylint", "flake8", "bandit", "radon"],
        "llm": False,
        "artifact": "Static analysis findings",
        "responsibilities": [
            "Run pylint, flake8, bandit and radon on the file",
            "Report findings with line, severity and message",
        ],
    },
    "code_understanding": {
        "name": "Code Understanding",
        "role": "Explains what the code does and flags complex sections",
        "tools": ["LLM"],
        "llm": True,
        "artifact": "Code explanation",
        "responsibilities": ["Explain the code", "List complex or hard-to-read sections"],
    },
    "improvement_suggestion": {
        "name": "Improvements",
        "role": "Suggests refactorings and best practices",
        "tools": ["LLM"],
        "llm": True,
        "artifact": "Improvement suggestions",
        "responsibilities": ["Suggest refactorings", "Point at lines that could be improved"],
    },
    "test_generator": {
        "name": "Test Generator",
        "role": "Drafts unit tests for the file",
        "tools": ["LLM"],
        "llm": True,
        "artifact": "Generated unit tests",
        "responsibilities": ["Generate unit tests for the file"],
    },
    "documentation_agent": {
        "name": "Documentation",
        "role": "Drafts docstrings, an overview and usage examples",
        "tools": ["LLM"],
        "llm": True,
        "artifact": "Generated documentation",
        "responsibilities": ["Write an overview", "Write docstrings and usage examples"],
    },
    "code_correction": {
        "name": "Code Correction",
        "role": "Proposes a corrected version of the file",
        "tools": ["LLM"],
        "llm": True,
        "artifact": "Corrected code",
        "responsibilities": ["Return a corrected version of the file"],
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

HUMAN_CRITERION = "human"


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


def _agent_status(rec: dict[str, Any]) -> str:
    return rec["status"]  # pending | running | ok | failed


def _task_status(rec: dict[str, Any]) -> str:
    s = _agent_status(rec)
    if s == "pending":
        return "backlog"
    if s == "running":
        return "running"
    if s == "failed":
        return "blocked"
    return "completed" if rec.get("approved") else "review"


def _criteria(tid: str, rec: dict[str, Any]) -> list[dict[str, Any]]:
    finished = rec["status"] in ("ok", "failed")
    checks = rec.get("checks") or {}

    def auto(key: str) -> str:
        if not finished:
            return "pending"
        return "passed" if checks.get(key) else "failed"

    manual = rec.get("manual", "pending")
    return [
        {
            "id": f"{tid}:process",
            "text": "The agent process exited normally and returned JSON",
            "kind": "automated",
            "result": auto("process"),
        },
        {
            "id": f"{tid}:no-error",
            "text": "The agent did not report an error",
            "kind": "automated",
            "result": auto("no_error"),
        },
        {
            "id": f"{tid}:non-empty",
            "text": "The agent returned a non-empty result",
            "kind": "automated",
            "result": auto("non_empty"),
        },
        {
            "id": f"{tid}:{HUMAN_CRITERION}",
            "text": "A person has read the output and accepts it",
            "kind": "manual",
            "result": manual if rec["status"] == "ok" else "pending",
        },
    ]


def _strip_fences(text: str) -> str:
    """Models often wrap code in ```python fences; show the code itself."""
    t = text.strip()
    m = re.fullmatch(r"```[a-zA-Z0-9_+-]*\n(.*?)\n?```", t, re.S)
    return m.group(1) if m else t


def agent_output(name: str, run: dict[str, Any], result: Any) -> dict[str, str] | None:
    """The agent's result as something a person can read, or None when there is nothing."""
    if not isinstance(result, dict):
        return None
    stem = re.sub(r"\.py$", "", run["file"].rsplit("/", 1)[-1])
    if name == "static_analysis":
        findings = result.get("findings") or []
        lines = [
            f"{f.get('type', '?'):8} line {f.get('line', '?'):<4} [{f.get('severity', '')}] {f.get('message', '')}"
            for f in sorted(findings, key=lambda f: (str(f.get("type")), f.get("line") or 0))
        ]
        return {"kind": "text", "text": "\n".join(lines) or "No findings.", "filename": f"{stem}_static.txt"}
    if name == "code_understanding" and result.get("explanation"):
        text = re.sub(r"^\s*EXPLANATION:\s*", "", str(result["explanation"]))
        for sec in result.get("complex_sections") or []:
            text += f"\n- line {sec.get('line')}: {sec.get('reason')}"
        return {"kind": "text", "text": text, "filename": f"{stem}_explanation.txt"}
    if name == "improvement_suggestion" and result.get("improvements"):
        text = "\n".join(f"line {i.get('line', '?')}: {i.get('description', '')}" for i in result["improvements"])
        return {"kind": "text", "text": text, "filename": f"{stem}_improvements.txt"}
    if name == "test_generator" and result.get("tests"):
        return {"kind": "code", "text": _strip_fences(str(result["tests"])), "filename": f"test_{stem}.py"}
    if name == "documentation_agent" and result.get("documentation"):
        return {"kind": "text", "text": str(result["documentation"]), "filename": f"{stem}_docs.md"}
    if name == "code_correction" and result.get("corrected_code"):
        return {"kind": "code", "text": _strip_fences(str(result["corrected_code"])), "filename": f"{stem}_corrected.py"}
    return None


def _task(run: dict[str, Any], index: int, name: str, now: int) -> dict[str, Any]:
    rec = run["agents"][name]
    meta = info(name)
    tid = task_id(run["id"], index)
    status = _task_status(rec)
    planned_start = run["startedAt"] + index * AGENT_BUDGET_MS
    task: dict[str, Any] = {
        "id": tid,
        "title": f"{meta['name']} on {run['file']}",
        "description": meta["role"] + ". "
        + (
            "Sends the file's contents to the Hugging Face inference API."
            if meta["llm"]
            else "Runs locally."
        ),
        "phaseId": PHASE_ID,
        "assigneeId": name,
        "status": status,
        "priority": "medium",
        "dependsOn": [],
        "artifact": meta["artifact"],
        "progress": 100 if status in ("review", "completed") else 0,
        "plannedStart": planned_start,
        "plannedEnd": planned_start + AGENT_BUDGET_MS,
        "attempts": rec.get("attempts", 0),
        "validation": _criteria(tid, rec),
    }
    if rec["status"] == "ok":
        out = agent_output(name, run, rec.get("result"))
        if out:
            task["output"] = out
    if rec.get("startedAt"):
        task["actualStart"] = rec["startedAt"]
    if rec.get("endedAt") and status in ("review", "completed"):
        task["actualEnd"] = rec["endedAt"]
    if status == "blocked":
        task["blocked"] = {
            "kind": "failure",
            "note": rec.get("problem") or "The agent failed.",
            "since": rec.get("endedAt") or now,
        }
    return task


def _file_memory_id(run_id: str) -> str:
    return f"{run_id}-file"


def _memories(run: dict[str, Any], agent_names: list[str], model: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    rid = run["id"]
    fp = run.get("fingerprint") or {}
    root = _file_memory_id(rid)

    def base(mid: str, **kw: Any) -> dict[str, Any]:
        item = {
            "id": mid,
            "createdAt": kw.pop("createdAt"),
            "lastAccessedAt": 0,
            "accessCount": 0,
            "runId": rid,
            "links": [],
            "tags": [],
            "taskIds": [],
        }
        item.update(kw)
        item["lastAccessedAt"] = item["createdAt"]
        return item

    out.append(
        base(
            root,
            createdAt=run["startedAt"],
            kind="fact",
            origin="stored",
            title=f"Reviewed file: {run['file']}",
            body=f"{fp.get('lines', '?')} lines, sha256 {fp.get('sha', '?')}… at review time.",
            provenance={"sourceType": "document", "source": run["file"]},
            tags=["file"],
        )
    )

    for index, name in enumerate(agent_names):
        rec = run["agents"][name]
        if rec["status"] != "ok" or not rec.get("result"):
            continue
        res = rec["result"]
        tid = task_id(rid, index)
        when = rec.get("endedAt") or run["startedAt"]
        link = [{"to": root, "relation": "derived_from"}]
        if name == "static_analysis":
            by_tool: dict[str, list[dict[str, Any]]] = {}
            for f in res.get("findings", []):
                by_tool.setdefault(str(f.get("type", "linter")), []).append(f)
            for tool, items in sorted(by_tool.items()):
                lines = [
                    f"line {f.get('line', '?')}: {f.get('message', '')}"
                    for f in sorted(items, key=lambda f: f.get("line") or 0)[:12]
                ]
                more = len(items) - len(lines)
                body = "\n".join(lines) + (f"\n… and {more} more" if more > 0 else "")
                out.append(
                    base(
                        f"{rid}-{tool}",
                        createdAt=when,
                        kind="observation",
                        origin="stored",
                        title=f"{tool}: {len(items)} finding{'s' if len(items) != 1 else ''}",
                        body=body,
                        provenance={"sourceType": "tool_output", "source": tool, "agentId": name},
                        taskIds=[tid],
                        links=link,
                        tags=["static-analysis", tool],
                    )
                )
        elif name == "code_understanding":
            sections = res.get("complex_sections") or []
            extra = "".join(f"\n- line {s.get('line')}: {s.get('reason')}" for s in sections)
            out.append(
                base(
                    f"{rid}-explanation",
                    createdAt=when,
                    kind="observation",
                    origin="inferred",
                    title="What the code does (model explanation)",
                    body=str(res.get("explanation", "")) + (f"\n\nComplex sections:{extra}" if extra else ""),
                    rationale="Written by a language model from the file contents. Not verified.",
                    derivedFrom=[root],
                    provenance={"sourceType": "agent", "source": model, "agentId": name},
                    taskIds=[tid],
                    links=link,
                    tags=["explanation"],
                )
            )
        elif name == "improvement_suggestion":
            items = res.get("improvements") or []
            body = "\n".join(f"- line {i.get('line', '?')}: {i.get('description', '')}" for i in items)
            out.append(
                base(
                    f"{rid}-improvements",
                    createdAt=when,
                    kind="decision",
                    origin="inferred",
                    title=f"{len(items)} suggested improvement{'s' if len(items) != 1 else ''}",
                    body=body,
                    rationale="Suggested by a language model. A person decides whether to apply them.",
                    derivedFrom=[root],
                    provenance={"sourceType": "agent", "source": model, "agentId": name},
                    taskIds=[tid],
                    links=link,
                    tags=["improvements"],
                )
            )
        elif name == "documentation_agent":
            out.append(
                base(
                    f"{rid}-documentation",
                    createdAt=when,
                    kind="observation",
                    origin="inferred",
                    title="Generated documentation",
                    body=str(res.get("documentation", ""))[:4000],
                    rationale="Written by a language model from the file contents. Not verified.",
                    derivedFrom=[root],
                    provenance={"sourceType": "agent", "source": model, "agentId": name},
                    taskIds=[tid],
                    links=link,
                    tags=["documentation"],
                )
            )
    return out


def run_outcome(run: dict[str, Any]) -> str:
    recs = list(run["agents"].values())
    if any(r["status"] in ("pending", "running") for r in recs):
        return "in_progress"
    ok = sum(1 for r in recs if r["status"] == "ok")
    if ok == len(recs):
        return "succeeded"
    return "failed" if ok == 0 else "partial"


def aggregates(run: dict[str, Any], now: int) -> dict[str, Any]:
    steps = [
        e
        for e in run["events"]
        if e["type"] in ("tool_call", "verification", "error") and e["status"] in ("success", "failed")
    ]
    recs = list(run["agents"].values())
    return {
        "tasksTotal": len(recs),
        "tasksCompleted": sum(1 for r in recs if r["status"] == "ok"),
        "stepsTotal": len(steps),
        "stepsSucceeded": sum(1 for e in steps if e["status"] == "success"),
        "retries": sum(1 for e in run["events"] if e["type"] == "retry"),
        "recovered": sum(1 for e in run["events"] if e["type"] == "retry" and e.get("recovered")),
        "interventions": sum(1 for e in run["events"] if e["type"] == "intervention"),
        "durationMs": max(0, (run.get("endedAt") or now) - run["startedAt"]),
        "tokens": 0,
    }


def build_workspace(
    runs: list[dict[str, Any]],
    agent_names: list[str],
    model: str,
    now: int,
    project_name: str = "Code review pipeline",
) -> dict[str, Any]:
    """Return a Workspace dict. ``runs`` is oldest first; the last run is the current one."""
    agents = []
    for name in agent_names:
        meta = info(name)
        agents.append(
            {
                "id": name,
                "name": meta["name"],
                "role": meta["role"],
                "model": model if meta["llm"] else "No model (local tools)",
                "responsibilities": meta["responsibilities"],
                "tools": meta["tools"],
            }
        )

    runs_out: list[dict[str, Any]] = []
    for run in runs:
        outcome = run_outcome(run)
        entry: dict[str, Any] = {
            "id": run["id"],
            "label": f"Review of {run['file']}",
            "config": f"{len(agent_names)} agents · {run.get('model') or model}",
            "startedAt": run["startedAt"],
            "outcome": outcome,
            "note": f"{run['file']} ({(run.get('fingerprint') or {}).get('lines', '?')} lines)",
        }
        if outcome != "in_progress":
            entry["endedAt"] = run.get("endedAt") or now
            entry["aggregates"] = aggregates(run, now)
        runs_out.append(entry)

    ws: dict[str, Any] = {
        "project": {
            "id": "code-review",
            "name": project_name,
            "objective": "Review Python files with static analysis and language-model agents.",
            "currentRunId": runs[-1]["id"] if runs else "",
        },
        "agents": agents,
        "phases": [
            {
                "id": PHASE_ID,
                "name": "Review pipeline",
                "summary": "The orchestrator runs each agent on the file, one after another.",
                "order": 1,
            }
        ],
        "milestones": [],
        "tasks": [],
        "events": [],
        "memories": [],
        "runs": runs_out,
        "now": now,
        # The backend runs the agents; a person may only approve reviewed output or re-run an agent.
        "capabilities": {
            "tokens": False,
            "transitions": {
                "review>completed": "Approve",
                "review>running": "Re-run agent",
                "blocked>running": "Retry",
            },
        },
    }

    for run in runs:
        ws["events"].extend(run["events"])
        ws["memories"].extend(_memories(run, agent_names, run.get("model") or model))

    if runs:
        cur = runs[-1]
        tasks = [_task(cur, i, n, now) for i, n in enumerate(agent_names)]
        ws["tasks"] = tasks
        ws["milestones"] = [
            {
                "id": f"{cur['id']}-done",
                "name": "All agents approved",
                "phaseId": PHASE_ID,
                "due": cur["startedAt"] + len(agent_names) * AGENT_BUDGET_MS,
                "dependsOn": [t["id"] for t in tasks],
            }
        ]
    ws["events"].sort(key=lambda e: (e["at"], e["id"]))
    return ws
