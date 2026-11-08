#!/usr/bin/env python3
"""
MCP server exposing the review tools: pylint, flake8, bandit, radon, a syntax check and test
execution. They are the same functions the agents call through function calling
(``agents/tools.py``), so any MCP client (Claude Desktop, Claude Code, Cursor, an IDE...) can
use them on code it is writing.

Run (stdio transport, the default for local clients):

    python mcp_server.py

Example client configuration:

    {"mcpServers": {"code-review": {"command": "python", "args": ["/path/to/mcp_server.py"]}}}

Every tool takes the code as a string and works in a temporary folder. ``run_tests`` executes
the code and the tests in a separate process with a timeout and without this process's
environment variables; set ``CODE_REVIEW_ALLOW_EXEC=0`` to disable it.

Requires the ``mcp`` package (``pip install mcp``); works with the 1.x and 2.x SDKs.
"""

import os
import sys
from typing import Any, Dict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agents import tools  # noqa: E402  pylint: disable=wrong-import-position

try:  # mcp >= 2
    from mcp.server.mcpserver import MCPServer as _Server  # pylint: disable=import-error
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server  # pylint: disable=import-error,no-name-in-module

INSTRUCTIONS = (
    "Static analysis and test tools for Python code. Pass the complete source code as `code`. "
    "Use run_pylint/run_flake8/run_bandit/run_radon to find issues, check_syntax before "
    "anything else when unsure, and run_tests to run a pytest file against the code "
    "(the code is importable as `module`, default `module_under_test`)."
)

server = _Server("code-review-tools", instructions=INSTRUCTIONS)


@server.tool()
def run_pylint(code: str) -> Dict[str, Any]:
    """Run pylint (bugs, code smells, naming, missing docstrings) on Python code.
    Returns the findings, most severe first."""
    return tools.run_pylint(code)


@server.tool()
def run_flake8(code: str) -> Dict[str, Any]:
    """Run flake8 (PEP 8 style, unused imports/variables, undefined names) on Python code."""
    return tools.run_flake8(code)


@server.tool()
def run_bandit(code: str) -> Dict[str, Any]:
    """Run the bandit security scanner (hard-coded secrets, eval, shell injection, weak
    crypto...) on Python code."""
    return tools.run_bandit(code)


@server.tool()
def run_radon(code: str) -> Dict[str, Any]:
    """Measure the cyclomatic complexity of each function with radon (blocks above 5 are
    listed)."""
    return tools.run_radon(code)


@server.tool()
def check_syntax(code: str) -> Dict[str, Any]:
    """Check that Python code compiles; returns the line and message of a syntax error."""
    return tools.check_syntax(code)


@server.tool()
def run_tests(code: str, tests: str, module: str = "module_under_test") -> Dict[str, Any]:
    """Run a pytest/unittest file (`tests`) against `code`, saved as `<module>.py` so the tests
    can `from <module> import ...`. Returns the number of tests, failures and errors and the end
    of the output. Executes the code (in a separate process, with a timeout)."""
    return tools.run_tests(code, tests, module)


if __name__ == "__main__":
    server.run()
