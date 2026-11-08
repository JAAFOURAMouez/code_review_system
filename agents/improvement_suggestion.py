#!/usr/bin/env python3
"""
Improvement Suggestion Agent: refactorings, best practices, performance and security fixes.

Input: the file and the linter findings, so suggestions build on verified tool output
instead of guessing (and can say which finding they address).
Output (structured JSON, validated against SCHEMA):
    {"improvements": [{"line", "category", "severity", "description", "related_findings"}]}
"""

import os
import sys
from typing import Any, Dict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# pylint: disable=wrong-import-position
from agents.common import lint_section, load_lint, numbered, run_agent_cli  # noqa: E402
from agents.hf_client import generate_json  # noqa: E402

CATEGORIES = ["bug", "security", "performance", "readability", "maintainability", "style",
              "testing", "other"]

SCHEMA = {
    "type": "object",
    "properties": {
        "improvements": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": ["integer", "null"],
                             "description": "Line the change applies to, or null for the whole file."},
                    "category": {"type": "string", "enum": CATEGORIES},
                    "severity": {"type": "string", "enum": ["high", "medium", "low"]},
                    "description": {"type": "string", "minLength": 1,
                                    "description": "What to change and why, concretely."},
                    "related_findings": {
                        "type": "array", "items": {"type": "string"},
                        "description": "Linter codes this addresses (e.g. W0612, B105), or []."},
                },
                "required": ["line", "category", "severity", "description", "related_findings"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["improvements"],
    "additionalProperties": False,
}

SYSTEM = ("You are a senior Python reviewer. Suggest changes that make a real difference "
          "(correctness and security first), each specific enough to act on.")


def suggest_improvements(code: str, file_path: str = "module.py") -> Dict[str, Any]:
    """Suggest improvements. Returns the SCHEMA fields plus ``lint_source``."""
    findings, source = load_lint(code, file_path)
    prompt = f"""Review the Python file `{os.path.basename(file_path)}` and list improvements:
bugs, security problems, refactorings, performance, readability and best practices.

- Start from the linter findings below: group related ones into one suggestion and put their
  codes in `related_findings`. Do not repeat trivial style findings one by one.
- Add what the linters cannot see (logic bugs, design, naming, missing error handling).
- Use the line numbers shown on the left; `line` is null for file-wide suggestions.
- Order from most to least important.

{lint_section(findings)}

Code (line numbers on the left are not part of the code):
{numbered(code)}
"""
    result = generate_json(prompt, SCHEMA, name="improvements", system=SYSTEM, max_tokens=2000)
    known = {str(f.get("code")) for f in findings if f.get("code")}
    for item in result["improvements"]:
        item["related_findings"] = [c for c in item["related_findings"] if c in known]
    result["lint_source"] = source
    return result


def analyze(code: str, file_path: str) -> Dict[str, Any]:
    """Agent entry point."""
    return suggest_improvements(code, file_path)


if __name__ == "__main__":
    run_agent_cli("improvement_suggestion", analyze)
