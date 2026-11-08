#!/usr/bin/env python3
"""
Code Understanding Agent: explains what the code does and lists the complex sections.

Input: the file and the linter findings (radon complexity in particular).
Output (structured JSON, validated against SCHEMA):
    {"explanation": str, "complex_sections": [{"line", "end_line", "reason"}]}
"""

import os
import sys
from typing import Any, Dict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# pylint: disable=wrong-import-position
from agents.common import lint_section, load_lint, numbered, run_agent_cli  # noqa: E402
from agents.hf_client import generate_json  # noqa: E402

SCHEMA = {
    "type": "object",
    "properties": {
        "explanation": {"type": "string", "minLength": 1,
                        "description": "What the code does, its main parts and how they fit."},
        "complex_sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": "integer", "minimum": 1},
                    "end_line": {"type": "integer", "minimum": 1},
                    "reason": {"type": "string", "minLength": 1},
                },
                "required": ["line", "end_line", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["explanation", "complex_sections"],
    "additionalProperties": False,
}

SYSTEM = ("You are a senior Python engineer who explains code to a colleague. Be accurate and "
          "concrete; never describe behaviour the code does not have.")


def explain_code(code: str, file_path: str = "module.py") -> Dict[str, Any]:
    """Explain the code. Returns the SCHEMA fields plus ``lint_source``."""
    findings, source = load_lint(code, file_path)
    prompt = f"""Explain the Python file `{os.path.basename(file_path)}`.

1. `explanation`: what the code does, its main functions/classes and how they work together.
2. `complex_sections`: the parts that are hard to understand (deep nesting, high cyclomatic
   complexity, tricky logic). Use the line numbers shown on the left. Use the radon complexity
   scores below as evidence when they apply. Return an empty list if nothing is complex.

{lint_section(findings)}

Code (line numbers on the left are not part of the code):
{numbered(code)}
"""
    result = generate_json(prompt, SCHEMA, name="code_explanation", system=SYSTEM, max_tokens=1500)
    n_lines = max(1, len(code.splitlines()))
    for sec in result["complex_sections"]:
        sec["line"] = min(sec["line"], n_lines)
        sec["end_line"] = min(max(sec["end_line"], sec["line"]), n_lines)
    result["lint_source"] = source
    return result


def analyze(code: str, file_path: str) -> Dict[str, Any]:
    """Agent entry point."""
    return explain_code(code, file_path)


if __name__ == "__main__":
    run_agent_cli("code_understanding", analyze)
