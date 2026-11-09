#!/usr/bin/env python3
"""
Test Generator Agent: writes pytest tests for the file and checks them by running them.

The model works in a loop with tools (function calling): it writes tests, calls ``run_tests``
to run them against the file, reads the failures, fixes the tests and finally calls
``submit_tests``. The submitted tests are then run once more by this agent, and the result is
reported in ``verification`` (so the numbers come from pytest, not from the model).

When running code is disabled (``CODE_REVIEW_ALLOW_EXEC=0``) the model only gets the syntax
check, and ``verification`` says the tests were not run.

The orchestrator hands the submitted tests, and how each one fares on the original file
(``verification["cases"]``), to the correction agent.

Output: {"tests", "framework", "notes", "verification", "tool_calls"}
"""

import os
import sys
import time
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# pylint: disable=wrong-import-position
from agents import tools  # noqa: E402
from agents.common import history_text, lint_section, load_lint, run_agent_cli  # noqa: E402
from agents.hf_client import LLMError, ToolsUnsupported, generate_json, run_tool_loop  # noqa: E402
from agents.schema import normalize_code  # noqa: E402

SUBMIT_SCHEMA = {
    "type": "object",
    "properties": {
        "tests": {"type": "string", "minLength": 1, "description": "The complete test file."},
        "framework": {"type": "string", "enum": ["pytest", "unittest"]},
        "notes": {"type": "string",
                  "description": "Tests that fail on purpose because they expose a real bug, "
                                 "and anything left untested. Empty string if none."},
    },
    "required": ["tests", "framework", "notes"],
    "additionalProperties": False,
}

SYSTEM = ("You are a Python test engineer. You write focused, deterministic pytest tests "
          "(no network, no sleeping, no files outside tmp_path) and you check them with the "
          "tools before submitting.")


def _prompt(code: str, module: str, findings: List[Dict[str, Any]], can_run: bool) -> str:
    check = ("Call `run_tests` with your test file, read the failures and fix the tests until "
             "they pass. If a test fails because the code itself is wrong, keep it and explain "
             "it in `notes`." if can_run else
             "Running code is disabled here: use `check_syntax` on your test file.")
    return f"""Write a pytest test file for the module `{module}` (the code is below; its package,
if any, and the installed dependencies are importable).

- The module is importable as `{module}`: use `from {module} import ...`.
- Cover normal behaviour, edge cases and error cases of each public function and class.
- The module may run code at import time; do not rely on its `if __name__ == "__main__"` block.
- {check}
- Finish by calling `submit_tests` with the final file.

{history_text("test_generator")}{lint_section(findings, limit=30)}

Code of `{module}.py`:
```python
{code}
```
"""


def _verify(code: str, tests_code: str, module: str,
            context: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    syntax = tools.check_syntax(tests_code)
    if not syntax["valid"]:
        return {"ran": False, "syntax_valid": False, "syntax": syntax}
    if not tools.execution_allowed():
        return {"ran": False, "syntax_valid": True, "reason": "code execution is disabled"}
    res = tools.run_tests(code, tests_code, module, context, with_cases=True)
    if res.get("status") != "ok":
        return {"ran": False, "syntax_valid": True, "reason": res.get("message") or res.get("status")}
    keys = ("runner", "passed", "tests", "failures", "errors", "skipped", "output")
    # ``cases`` (outcome of each test on the original file) is what the correction agent
    # compares its fix against.
    return {"ran": True, "syntax_valid": True, **{k: res[k] for k in keys},
            "cases": res.get("cases")}


def generate_tests(code: str, file_path: str = "module.py") -> Dict[str, Any]:
    """Generate and check tests. Returns SUBMIT_SCHEMA fields plus verification and trace."""
    findings, source = load_lint(code, file_path)
    context = tools.package_context(file_path)
    module = tools.import_name(file_path, context)
    can_run = tools.execution_allowed()
    available = ([tools.tests_tool_for_fixed_code(code, module, context)] if can_run else [])
    available.append(next(t for t in tools.linter_tools() if t.name == "check_syntax"))

    def on_submit(args: Dict[str, Any]) -> List[str]:
        syntax = tools.check_syntax(normalize_code(args["tests"]))
        return [] if syntax["valid"] else [
            f"the test file does not compile (line {syntax.get('line')}: {syntax.get('message')})"]

    budget = float(os.getenv("AGENT_TOOL_TIMEOUT", "300"))
    prompt = _prompt(code, module, findings, can_run)
    mode = "tool_loop"
    try:
        result, trace = run_tool_loop(
            SYSTEM, prompt, available, "submit_tests", "Submit the final test file.",
            SUBMIT_SCHEMA, max_steps=int(os.getenv("AGENT_MAX_STEPS", "8")),
            deadline=time.monotonic() + budget * 0.6, on_submit=on_submit)
    except (ToolsUnsupported, LLMError) as e:
        # No function calling (or the loop did not converge): one structured answer instead,
        # still checked below by running it.
        mode = f"single_call ({e})"
        trace = getattr(e, "trace", [])
        result = generate_json(prompt.replace("Finish by calling `submit_tests` with the final file.",
                                              "Return the final file."),
                               SUBMIT_SCHEMA, name="tests", system=SYSTEM, max_tokens=3000)
    result["tests"] = normalize_code(result["tests"])
    verification = _verify(code, result["tests"], module, context)
    out: Dict[str, Any] = {**result, "module": module, "verification": verification,
                           "tool_calls": trace, "mode": mode, "lint_source": source}
    if not verification["syntax_valid"]:
        out.update(error=True, note="The generated tests do not compile.")
    return out


def analyze(code: str, file_path: str) -> Dict[str, Any]:
    """Agent entry point."""
    return generate_tests(code, file_path)


if __name__ == "__main__":
    run_agent_cli("test_generator", analyze)
