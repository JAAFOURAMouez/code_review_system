"""
How the agents pass results to each other (standard library only, so the orchestrator, the
dashboard server and the agents can all use it).

* ``schedule`` runs agents in dependency order: an agent that declares ``depends_on`` starts as
  soon as the agents it depends on have finished, while every other agent keeps running in
  parallel.
* ``apply_plan`` turns the planner's decisions into the agents to run and the agents to skip
  (with the reason). It fails open: a planner that failed, or an agent it did not mention, never
  removes an agent from the review.
* The results one agent hands to another travel in a small JSON file whose path is given in
  ``CODE_REVIEW_SHARED`` (the same mechanism as the linter findings in
  ``CODE_REVIEW_LINT_RESULTS``). Today it carries the tests written by the test generator, which
  the correction agent uses to check that its fix does not break anything.
"""

import json
import os
import tempfile
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

SHARED_ENV = "CODE_REVIEW_SHARED"
MAX_OUTPUT_CHARS = 2000
# Keys of the test generator's verification that the other agents may use.
BASELINE_KEYS = ("ran", "passed", "tests", "failures", "errors", "skipped", "cases")


def dependencies(agent: Dict[str, Any]) -> List[str]:
    """Names of the agents that must finish before ``agent`` starts."""
    return list(agent.get("depends_on") or [])


def schedule(agents: Sequence[Dict[str, Any]], indices: Sequence[int],
             run_one: Callable[[int], Any], max_parallel: int = 5) -> None:
    """Call ``run_one(index)`` for every index, at most ``max_parallel`` at a time, an agent
    starting only after the agents it depends on (the ones in ``indices``) have finished.
    Dependencies on agents that are not in ``indices`` are ignored (re-running one agent).
    Raises ValueError for circular dependencies, and whatever ``run_one`` raises."""
    by_name = {agents[i]["name"]: i for i in indices}
    deps: Dict[int, Set[int]] = {
        i: {by_name[d] for d in dependencies(agents[i]) if d in by_name and by_name[d] != i}
        for i in indices}

    left = {i: set(d) for i, d in deps.items()}
    while left:  # circular dependencies: fail before running anything
        free = [i for i, d in left.items() if not d]
        if not free:
            raise ValueError("circular dependencies between agents: "
                             + ", ".join(sorted(agents[i]["name"] for i in left)))
        for i in free:
            del left[i]
        for d in left.values():
            d.difference_update(free)

    pending = list(indices)
    done: Set[int] = set()
    running: Dict[Any, int] = {}
    with ThreadPoolExecutor(max_workers=max(1, max_parallel)) as pool:
        while pending or running:
            for i in [i for i in pending if deps[i] <= done]:
                pending.remove(i)
                running[pool.submit(run_one, i)] = i
            finished, _ = wait(list(running), return_when=FIRST_COMPLETED)
            for future in finished:
                done.add(running.pop(future))
                future.result()


def is_planner(agent: Dict[str, Any]) -> bool:
    """Whether ``agent`` is the planner, which decides which of the others run."""
    return bool(agent.get("planner"))


def apply_plan(agents: Sequence[Dict[str, Any]], indices: Sequence[int],
               plan: Optional[Dict[str, Any]]) -> Tuple[List[int], Dict[int, str]]:
    """Split ``indices`` into (to run, skipped with the reason) following the planner's result
    (``{"decisions": [{"agent", "run", "reason"}]}``). Everything runs when the plan is missing,
    failed or malformed, and so does any agent the plan does not decide on."""
    decisions = plan.get("decisions") if isinstance(plan, dict) and not plan.get("error") else None
    if not isinstance(decisions, list):
        return list(indices), {}
    verdicts: Dict[str, Tuple[bool, str]] = {}
    for d in decisions:
        if isinstance(d, dict) and isinstance(d.get("agent"), str) and isinstance(d.get("run"), bool):
            verdicts.setdefault(d["agent"], (d["run"], str(d.get("reason") or "").strip()))
    run: List[int] = []
    skipped: Dict[int, str] = {}
    for i in indices:
        verdict = verdicts.get(agents[i]["name"])
        if verdict and not verdict[0]:
            skipped[i] = verdict[1] or "Skipped by the planner."
        else:
            run.append(i)
    return run, skipped


def skipped_result(agent: Dict[str, Any], reason: str, file_path: str) -> Dict[str, Any]:
    """The result recorded for an agent the planner skipped."""
    return {"agent": agent["name"], "file": file_path, "skipped": True, "reason": reason}


def build_shared(results: Dict[str, Any]) -> Dict[str, Any]:
    """What the finished agents hand to the others, from their results by agent name.
    Empty when there is nothing usable (an agent failed or returned nothing)."""
    shared: Dict[str, Any] = {}
    gen = results.get("test_generator")
    if isinstance(gen, dict) and not gen.get("error") and gen.get("tests"):
        verification = gen.get("verification") or {}
        if verification.get("syntax_valid", True):
            baseline = {k: verification[k] for k in BASELINE_KEYS if k in verification}
            baseline["output"] = (verification.get("output") or "")[-MAX_OUTPUT_CHARS:]
            shared["tests"] = {
                "from": "test_generator",
                "code": gen["tests"],
                "module": gen.get("module"),
                "framework": gen.get("framework"),
                "notes": gen.get("notes") or "",
                "baseline": baseline,
            }
    return shared


def write_shared_file(results: Dict[str, Any]) -> Optional[str]:
    """Save ``build_shared(results)`` in a temporary file and return its path (the caller
    removes it), or None when there is nothing to share."""
    shared = build_shared(results)
    if not shared:
        return None
    fd, path = tempfile.mkstemp(prefix="review_shared_", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(shared, f)
    return path


def load_shared() -> Dict[str, Any]:
    """The results other agents handed to this one (empty when run on its own)."""
    path = os.getenv(SHARED_ENV)
    if not path or not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def env_with_shared(env: Optional[Dict[str, str]], path: Optional[str]) -> Optional[Dict[str, str]]:
    """The agent environment plus the path of the shared file (``env`` unchanged without one;
    None still means "inherit this process's environment")."""
    if not path:
        return env
    out = dict(os.environ if env is None else env)
    out[SHARED_ENV] = path
    return out
