#!/usr/bin/env python3
"""
Code Correction Agent: returns a corrected version of the file, checked with the linters.

1. The model receives the file and the linter findings from the static analysis agent.
2. It works in a loop with tools (function calling): ``run_pylint``, ``run_flake8``,
   ``run_bandit``, ``run_radon``, ``check_syntax`` and ``run_tests`` on its candidate, until it
   calls ``submit_correction``.
3. A submission is refused (and the reasons sent back to the model) when it does not compile,
   drops a public function or class, or has more linter findings than the original.
4. The accepted code is checked once more by this agent, and the before/after numbers are
   reported in ``verification``: they come from the linters, not from the model.

When the provider has no function calling, the agent asks for one structured answer and still
runs the same checks.

Output: {"corrected_code", "changes", "remaining_issues", "verification", "tool_calls"}
"""

import os
import sys
import time
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# pylint: disable=wrong-import-position
from agents import tools  # noqa: E402
from agents.common import lint_section, load_lint, run_agent_cli  # noqa: E402
from agents.hf_client import LLMError, ToolsUnsupported, generate_json, run_tool_loop  # noqa: E402
from agents.schema import normalize_code  # noqa: E402

SUBMIT_SCHEMA = {
    "type": "object",
    "properties": {
        "corrected_code": {"type": "string", "minLength": 1,
                           "description": "The complete corrected file (not a diff)."},
        "changes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": ["integer", "null"],
                             "description": "Line in the ORIGINAL file, or null."},
                    "description": {"type": "string", "minLength": 1},
                },
                "required": ["line", "description"],
                "additionalProperties": False,
            },
        },
        "remaining_issues": {
            "type": "array", "items": {"type": "string"},
            "description": "Findings deliberately left unfixed, with the reason."},
    },
    "required": ["corrected_code", "changes", "remaining_issues"],
    "additionalProperties": False,
}

SYSTEM = ("You are a careful Python engineer fixing a file. You keep its behaviour and public "
          "interface, fix real bugs and security problems, and verify every candidate with the "
          "tools before you submit it.")


def total(counts: Dict[str, int]) -> int:
    """Sum of the per-tool counts."""
    return sum(counts.values())


def assess(original: str, candidate: str, before: Dict[str, int],
           name: str = "module.py") -> Dict[str, Any]:
    """Check a candidate against the original with the real tools. ``before`` must come from
    ``tools.lint(original, name=name)`` so both are linted the same way (same folder, name)."""
    syntax = tools.check_syntax(candidate)
    if not syntax["valid"]:
        return {"syntax_valid": False, "syntax": syntax, "accepted": False,
                "problems": [f"the code does not compile (line {syntax.get('line')}: "
                             f"{syntax.get('message')})"]}
    missing = sorted(set(tools.public_api(original)) - set(tools.public_api(candidate)))
    after_findings, statuses = tools.lint(candidate, name=name)
    after = tools.counts(after_findings)
    problems: List[str] = []
    if missing:
        problems.append("public functions/classes were removed or renamed: " + ", ".join(missing))
    if total(after) > total(before):
        problems.append(f"the candidate has more linter findings than the original "
                        f"({total(after)} > {total(before)})")
    if after.get("bandit", 0) > before.get("bandit", 0):
        problems.append("the candidate has more security (bandit) findings than the original")
    return {
        "syntax_valid": True,
        "api_preserved": not missing,
        "missing_api": missing,
        "findings_before": before,
        "findings_after": after,
        "total_before": total(before),
        "total_after": total(after),
        "linters": statuses,
        "accepted": not problems,
        "problems": problems,
    }


def _prompt(code: str, module: str, findings: List[Dict[str, Any]], name: str) -> str:
    tests_line = ("- You may write a few quick tests and call `run_tests` to check the behaviour "
                  "is unchanged (your candidate is importable as "
                  f"`{module}`: `from {module} import ...`).\n"
                  if tools.execution_allowed() else "")
    return f"""Correct the Python file `{name}` (module `{module}`) below.

Fix, in this order: bugs, security problems (bandit), errors and warnings (pylint/flake8),
missing docstrings, naming, PEP 8 style, excessive complexity (radon). Keep the behaviour and
every public function and class name. Do not add dependencies.

How to work:
- Write a candidate, then call `run_pylint`, `run_flake8`, `run_bandit` (and `run_radon` if
  you refactored) on it. Fix what they report and check again.
{tests_line}- When the tools are clean enough, call `submit_correction` with the complete file. A
  submission that does not compile, removes a public name or has more findings than the
  original is refused with the reason.

{lint_section(findings)}

Original code:
```python
{code}
```
"""


def correct_code(code: str, file_path: str = "module.py") -> Dict[str, Any]:
    """Correct the code. Returns SUBMIT_SCHEMA fields plus verification and trace."""
    findings, source = load_lint(code, file_path)
    name = os.path.basename(file_path)
    # Compare like with like: lint the original exactly as candidates are linted (a temporary
    # copy), since findings such as import errors depend on the folder the file is in.
    before = tools.counts(tools.lint(code, name=name)[0])
    context = tools.package_context(file_path)
    module = tools.import_name(file_path, context)
    available = tools.linter_tools()
    if tools.execution_allowed():
        available.append(tools.tests_tool_for_code(module, context))
    best: Dict[str, Any] = {}

    def on_submit(args: Dict[str, Any]) -> List[str]:
        candidate = normalize_code(args["corrected_code"])
        report = assess(code, candidate, before, name)
        if report["syntax_valid"] and (not best or report.get("total_after", 1e9)
                                       < best["report"].get("total_after", 1e9)):
            best.update(args=args, report=report)
        return report["problems"]

    budget = float(os.getenv("AGENT_TOOL_TIMEOUT", "300"))
    prompt = _prompt(code, module, findings, name)
    mode = "tool_loop"
    result: Optional[Dict[str, Any]] = None
    trace: List[Dict[str, Any]] = []
    try:
        result, trace = run_tool_loop(
            SYSTEM, prompt, available, "submit_correction",
            "Submit the complete corrected file.", SUBMIT_SCHEMA,
            max_steps=int(os.getenv("AGENT_MAX_STEPS", "8")),
            deadline=time.monotonic() + budget * 0.6, on_submit=on_submit)
    except ToolsUnsupported as e:
        mode = f"single_call (no function calling: {e})"
    except LLMError as e:
        trace = e.trace
        if not best:
            mode = f"single_call ({e})"
        else:  # the model kept submitting refused candidates: report the best one
            mode = f"tool_loop, best refused candidate ({e})"
            result = best["args"]
    if result is None:
        result = generate_json(
            prompt.split("How to work:")[0] + lint_section(findings) + "\n\nOriginal code:\n"
            + f"```python\n{code}\n```\n",
            SUBMIT_SCHEMA, name="correction", system=SYSTEM, max_tokens=4000, temperature=0.1)

    corrected = normalize_code(result["corrected_code"])
    verification = assess(code, corrected, before, name)
    out: Dict[str, Any] = {
        "corrected_code": corrected,
        "changes": result.get("changes", []),
        "remaining_issues": result.get("remaining_issues", []),
        "verification": verification,
        "tool_calls": trace,
        "mode": mode,
        "lint_source": source,
    }
    if not verification["syntax_valid"]:
        # Never hand out code that does not compile (the orchestrator would save it).
        out.update(corrected_code="", rejected_code=corrected, error=True,
                   note="The corrected code does not compile, so it was not kept.")
    return out


def analyze(code: str, file_path: str) -> Dict[str, Any]:
    """Agent entry point."""
    return correct_code(code, file_path)


if __name__ == "__main__":
    run_agent_cli("code_correction", analyze)
