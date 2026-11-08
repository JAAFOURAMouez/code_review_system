#!/usr/bin/env python3
"""
Documentation Agent: an overview, docstrings for the public functions and classes, and a
usage example.

Input: the file and the linter findings (the missing-docstring ones tell it where to start).
Output (structured JSON, validated against SCHEMA) plus ``documentation``, the same content as
Markdown for people to read.
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
        "overview": {"type": "string", "minLength": 1},
        "docstrings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1,
                             "description": "`module`, `func`, `Class` or `Class.method`."},
                    "kind": {"type": "string", "enum": ["module", "function", "class", "method"]},
                    "docstring": {"type": "string", "minLength": 1,
                                  "description": "Docstring text without the triple quotes."},
                },
                "required": ["name", "kind", "docstring"],
                "additionalProperties": False,
            },
        },
        "usage_example": {"type": "string",
                          "description": "Short runnable Python example, or an empty string."},
    },
    "required": ["overview", "docstrings", "usage_example"],
    "additionalProperties": False,
}

SYSTEM = ("You are a technical writer for Python projects. Document only what the code really "
          "does, in Google-style docstrings (Args, Returns, Raises).")


def to_markdown(doc: Dict[str, Any], file_name: str) -> str:
    """The structured documentation as Markdown."""
    parts = [f"# {file_name}", "", doc["overview"].strip()]
    if doc["docstrings"]:
        parts += ["", "## API"]
        for d in doc["docstrings"]:
            parts += ["", f"### `{d['name']}` ({d['kind']})", "", d["docstring"].strip()]
    if doc["usage_example"].strip():
        parts += ["", "## Usage", "", "```python", doc["usage_example"].strip(), "```"]
    return "\n".join(parts) + "\n"


def generate_documentation(code: str, file_path: str = "module.py") -> Dict[str, Any]:
    """Document the code. Returns the SCHEMA fields plus ``documentation`` (Markdown)."""
    findings, source = load_lint(code, file_path)
    docstring_findings = [f for f in findings if "docstring" in str(f.get("symbol") or f.get("message"))]
    name = os.path.basename(file_path)
    prompt = f"""Write documentation for the Python file `{name}`:

1. `overview`: what the module is for and how its parts fit together (a short paragraph).
2. `docstrings`: one entry per public function, class and method, plus the module itself.
   Prioritise the ones pylint reports as missing below.
3. `usage_example`: a short example that would run against this module (import from
   `{os.path.splitext(name)[0]}`), or "" if an example makes no sense.

{lint_section(docstring_findings or findings, limit=40)}

Code (line numbers on the left are not part of the code):
{numbered(code)}
"""
    doc = generate_json(prompt, SCHEMA, name="documentation", system=SYSTEM, max_tokens=2500)
    doc["documentation"] = to_markdown(doc, name)
    doc["lint_source"] = source
    return doc


def analyze(code: str, file_path: str) -> Dict[str, Any]:
    """Agent entry point."""
    return generate_documentation(code, file_path)


if __name__ == "__main__":
    run_agent_cli("documentation_agent", analyze)
