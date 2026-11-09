"""
Code shared by the LLM agents: reading the file, getting the linter findings, the JSON result
envelope and the command-line entry point.

Linter findings: the orchestrator runs the static analysis agent first and passes its result
to the other agents through the file named in ``CODE_REVIEW_LINT_RESULTS``. When an agent runs
on its own (no such file), it runs the linters itself, so every agent always sees them.
"""

import json
import os
import sys
import time
import traceback
from typing import Any, Callable, Dict, List, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# pylint: disable=wrong-import-position
from agents import hf_client  # noqa: E402
from agents import memory, tools  # noqa: E402

LINT_ENV = "CODE_REVIEW_LINT_RESULTS"


def read_code(file_path: str) -> str:
    """The file's text."""
    with open(file_path, "r", encoding="utf-8") as f:
        return f.read()


def numbered(code: str) -> str:
    """The code with line numbers, so the model can cite lines accurately."""
    lines = code.splitlines()
    width = len(str(len(lines)))
    return "\n".join(f"{i:>{width}} | {line}" for i, line in enumerate(lines, 1))


def load_lint(code: str, file_path: str) -> Tuple[List[Dict[str, Any]], str]:
    """(findings, source). Source is ``static_analysis`` when they come from the orchestrator,
    ``computed`` when this agent ran the linters itself."""
    path = os.getenv(LINT_ENV)
    if path and os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("findings"), list):
                return data["findings"], "static_analysis"
        except (OSError, ValueError):
            pass
    findings, _ = tools.lint(code, name=os.path.basename(file_path))
    return findings, "computed"


def lint_section(findings: List[Dict[str, Any]], limit: int = 60) -> str:
    """The prompt section with the linter findings."""
    return ("Findings from pylint, flake8, bandit and radon (verified tool output):\n"
            + tools.format_findings(findings, limit))


def history_text(agent: str) -> str:
    """The prompt section with what earlier reviews of this file found ("" for a first review,
    when run on its own, or when ``agent`` does not use it). See ``agents/memory.py``."""
    return memory.history_section(memory.load_history(), agent)


def run_agent_cli(agent: str, analyze: Callable[[str, str], Dict[str, Any]]) -> None:
    """Command-line entry point: ``python agents/<agent>.py <file>``. Always prints one JSON
    object on stdout, even when something unexpected fails."""
    if len(sys.argv) < 2:
        print(f"Usage: python {agent}.py <file_path>", file=sys.stderr)
        sys.exit(1)
    file_path = sys.argv[1]
    started = time.monotonic()
    try:
        code = read_code(file_path)
    except (OSError, UnicodeDecodeError) as e:
        result: Dict[str, Any] = {"error": True, "note": f"Could not read file: {e}"}
    else:
        try:
            result = analyze(code, file_path)
        except hf_client.LLMError as e:
            result = {"error": True, "note": "The language model could not produce an answer.",
                      "detail": str(e)}
        except Exception as e:  # pylint: disable=broad-except
            traceback.print_exc(file=sys.stderr)
            result = {"error": True, "note": "The agent failed unexpectedly.",
                      "detail": f"{type(e).__name__}: {e}"}
    result.update(file=file_path, agent=agent, timestamp=time.time(),
                  duration_s=round(time.monotonic() - started, 2))
    if hf_client.USAGE["requests"]:
        result["usage"] = dict(hf_client.USAGE)
    print(json.dumps(result, indent=2, ensure_ascii=False))
