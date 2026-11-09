#!/usr/bin/env python3
"""
Planner Agent: decides which agents are worth running on this file.

It runs right after static analysis, looks at the file (size, whether it compiles, public
functions and classes, docstring coverage, whether it is itself a test file) and at the linter
findings, and answers one decision per agent: run it or skip it, with the reason. Running
an agent that has nothing to do costs model calls and time, and its empty result is noise
in the review.

Two modes (``PLANNER_MODE``):

* ``rules`` (default): fixed rules, no model call, same answer every time.
* ``llm``: the model starts from the rules' plan and may change a decision when it has a
  reason. Its answer is checked: unknown agents are ignored, and the hard rules (a file that
  does not compile has no tests, a test file gets no new tests) are applied again after it. If
  the model fails, the rules' plan is used.

The memory of earlier reviews (``agents/memory.py``) is used too: an agent whose result a
person approved on this exact version of the file is not run again.

The planner never makes a review smaller by failing: if it errors, or an agent is not
mentioned, the orchestrator runs that agent (see ``flow.apply_plan``).

Output: {"decisions": [{"agent", "run", "reason"}], "source", "facts", "summary"}
"""

import ast
import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# pylint: disable=wrong-import-position
from agents import memory  # noqa: E402
from agents.common import load_lint, run_agent_cli  # noqa: E402

# The agents the planner chooses among (static analysis and the planner always run).
SELECTABLE = ("code_understanding", "improvement_suggestion", "documentation_agent",
              "test_generator", "code_correction")
TINY_LINES = 6          # fewer code lines than this: nothing to explain
SHORT_LINES = 25        # a short file with no findings needs no improvement pass

DECISION_SCHEMA = {
    "type": "object",
    "properties": {
        "decisions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "agent": {"type": "string", "enum": list(SELECTABLE)},
                    "run": {"type": "boolean"},
                    "reason": {"type": "string", "minLength": 1},
                },
                "required": ["agent", "run", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["decisions"],
    "additionalProperties": False,
}

SYSTEM = ("You plan a code review. You decide which agents are worth running on a Python "
          "file, each decision with a short concrete reason. You skip an agent only when "
          "it would have nothing useful to do.")


# ------------------------------------------------------------------ facts about the file

def _documented(node: ast.AST) -> bool:
    return bool(ast.get_docstring(node))  # type: ignore[arg-type]


def _public_items(tree: ast.Module) -> List[ast.AST]:
    """Top-level public functions and classes, and the public methods of those classes."""
    items: List[ast.AST] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) \
                and not node.name.startswith("_"):
            items.append(node)
            if isinstance(node, ast.ClassDef):
                items += [m for m in node.body
                          if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))
                          and not m.name.startswith("_")]
    return items


def _is_test_file(file_path: str, tree: Optional[ast.Module]) -> bool:
    name = os.path.basename(file_path)
    if name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py":
        return True
    if tree is None:
        return False
    top = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    tests = [n for n in top if n.name.startswith("test")]
    return bool(tests) and len(tests) * 2 >= len(top)


def file_facts(code: str, file_path: str, findings: List[Dict[str, Any]],
               history: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """What the planner knows about the file. ``history`` is the memory of earlier reviews."""
    try:
        tree: Optional[ast.Module] = ast.parse(code)
    except (SyntaxError, ValueError):
        tree = None
    issues = [f for f in findings if not (f.get("type") == "radon" and f.get("severity") == "info")]
    items = _public_items(tree) if tree else []
    documented = sum(1 for n in items if _documented(n)) + (1 if tree and _documented(tree) else 0)
    total_docs = len(items) + (1 if tree else 0)
    verdicts = (history or {}).get("verdicts") or {}
    unchanged = bool(history and (history.get("previous") or {}).get("same_content"))
    return {
        "lines": sum(1 for line in code.splitlines() if line.strip()),
        "syntax_valid": tree is not None,
        "is_test_file": _is_test_file(file_path, tree),
        "public_items": sum(1 for n in (tree.body if tree else [])
                            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                            and not n.name.startswith("_")),
        "docstring_coverage": round(documented / total_docs, 2) if total_docs else 1.0,
        "issues": len(issues),
        "security_issues": sum(1 for f in issues if f.get("type") == "bandit"),
        "errors": sum(1 for f in issues if f.get("severity") == "error"),
        "unchanged_since_last_review": unchanged,
        "approved_before": sorted(a for a, v in verdicts.items() if v == "approved") if unchanged else [],
    }


# ------------------------------------------------------------------ the rules

def _decision(agent: str, run: bool, reason: str) -> Dict[str, Any]:
    return {"agent": agent, "run": run, "reason": reason}


def plan_by_rules(facts: Dict[str, Any]) -> List[Dict[str, Any]]:
    """One decision per selectable agent, from the facts alone."""
    n, issues = facts["lines"], facts["issues"]
    approved = set(facts["approved_before"])
    out: List[Dict[str, Any]] = []

    def decide(agent: str, run: bool, reason: str) -> None:
        if run and agent in approved:
            run, reason = False, ("A person approved its result on this exact version of the "
                                  "file, so it is not run again.")
        out.append(_decision(agent, run, reason))

    if not facts["syntax_valid"]:
        skip = "The file does not compile: this agent needs working code."
        decide("code_understanding", False, skip)
        decide("improvement_suggestion", False, skip)
        decide("documentation_agent", False, skip)
        decide("test_generator", False, "The tests could not import a file that does not compile.")
        decide("code_correction", True, "It can fix what stops the file from compiling.")
        return out

    if n < TINY_LINES:
        decide("code_understanding", False, f"Only {n} line(s) of code: nothing to explain.")
    else:
        decide("code_understanding", True, f"{n} lines of code to explain.")

    if issues == 0 and n < SHORT_LINES:
        decide("improvement_suggestion", False, "No linter findings in a short file.")
    elif issues:
        decide("improvement_suggestion", True, f"{issues} linter finding(s) to turn into suggestions.")
    else:
        decide("improvement_suggestion", True, "No findings, but design problems are not visible to linters.")

    if facts["is_test_file"]:
        decide("documentation_agent", False, "It is a test file: documentation adds little.")
    elif facts["docstring_coverage"] >= 1.0:
        decide("documentation_agent", False, "Every public item and the module already have a docstring.")
    else:
        missing = round((1 - facts["docstring_coverage"]) * 100)
        decide("documentation_agent", True, f"About {missing}% of the public items have no docstring.")

    if facts["is_test_file"]:
        decide("test_generator", False, "It is a test file: it is not tested again.")
    elif facts["public_items"] == 0:
        decide("test_generator", False, "No public function or class to test.")
    else:
        decide("test_generator", True, f"{facts['public_items']} public function(s) or class(es) to test.")

    if issues == 0:
        decide("code_correction", False, "The linters found nothing to correct.")
    else:
        extra = f", {facts['security_issues']} of them security findings" if facts["security_issues"] else ""
        decide("code_correction", True, f"{issues} finding(s) to fix{extra}.")
    return out


def enforce_hard_rules(decisions: List[Dict[str, Any]], facts: Dict[str, Any]) -> List[Dict[str, Any]]:
    """What no plan may override, so a model's plan cannot cause a pointless or wrong run."""
    out = []
    for d in decisions:
        d = dict(d)
        if d["agent"] == "test_generator" and d["run"] and (
                not facts["syntax_valid"] or facts["is_test_file"]):
            d.update(run=False, reason="Not possible or pointless on this file (it does not "
                                        "compile, or it is a test file).")
        if d["agent"] == "code_correction" and not d["run"] and facts["errors"]:
            d.update(run=True, reason=f"The linters report {facts['errors']} error(s) to fix.")
        out.append(d)
    return out


def complete(decisions: List[Dict[str, Any]], fallback: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The model's decisions in agent order; an agent it left out gets the rules' decision, and
    one it mentioned twice keeps the first."""
    by_agent: Dict[str, Dict[str, Any]] = {}
    for d in decisions:
        if isinstance(d, dict) and d.get("agent") in SELECTABLE and d["agent"] not in by_agent \
                and isinstance(d.get("run"), bool) and str(d.get("reason") or "").strip():
            by_agent[d["agent"]] = {"agent": d["agent"], "run": d["run"], "reason": str(d["reason"]).strip()}
    return [by_agent.get(f["agent"], f) for f in fallback]


def plan_with_model(code: str, file_path: str, facts: Dict[str, Any],
                    rules: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The rules' plan, adjusted by the model. Raises when the model gives no usable answer."""
    from agents.hf_client import generate_json  # pylint: disable=import-outside-toplevel
    lines = "\n".join(f"- {d['agent']}: {'run' if d['run'] else 'skip'} ({d['reason']})" for d in rules)
    prompt = f"""Plan the review of the Python file `{os.path.basename(file_path)}`.

Facts: {facts}

Plan from the fixed rules:
{lines}

Agents: code_understanding (explains the code), improvement_suggestion (refactorings and best
practices), documentation_agent (docstrings), test_generator (writes and runs pytest tests),
code_correction (fixes the file and checks it with the linters).

Return one decision per agent. Keep the rules' plan unless you have a concrete reason to
change a decision, and give the reason. Never skip code_correction when there are linter errors.
"""
    result = generate_json(prompt, DECISION_SCHEMA, name="plan", system=SYSTEM, max_tokens=800)
    return complete(result["decisions"], rules)


def summary(decisions: List[Dict[str, Any]]) -> str:
    """One line for people."""
    skipped = [d["agent"] for d in decisions if not d["run"]]
    text = f"Runs {len(decisions) - len(skipped)} of {len(decisions)} agents"
    return text + (f"; skips {', '.join(skipped)}." if skipped else ".")


def plan(code: str, file_path: str = "module.py") -> Dict[str, Any]:
    """Plan the review of a file. Returns the output fields described at the top."""
    findings, source = load_lint(code, file_path)
    facts = file_facts(code, file_path, findings, memory.load_history())
    decisions = plan_by_rules(facts)
    how = "rules"
    if os.getenv("PLANNER_MODE", "rules").strip().lower() == "llm":
        try:
            decisions = enforce_hard_rules(plan_with_model(code, file_path, facts, decisions), facts)
            how = "llm"
        except Exception as e:  # pylint: disable=broad-except
            how = f"rules (the model gave no usable plan: {type(e).__name__})"
    return {"decisions": decisions, "source": how, "facts": facts, "summary": summary(decisions),
            "lint_source": source}


def analyze(code: str, file_path: str) -> Dict[str, Any]:
    """Agent entry point."""
    return plan(code, file_path)


if __name__ == "__main__":
    run_agent_cli("planner", analyze)
