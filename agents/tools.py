"""
Tools the LLM agents can call (OpenAI-style function calling) and that ``mcp_server.py``
exposes over MCP.

Every tool takes code as a string, writes it to a fresh temporary folder, runs the real tool
there and returns a JSON-serialisable dict. Nothing is written next to the user's files.

* ``run_pylint`` / ``run_flake8`` / ``run_bandit`` / ``run_radon``: the linters of the
  static analysis agent, with the same finding format.
* ``check_syntax``: compiles the code.
* ``run_tests``: runs a test file against the code with pytest (or unittest when pytest is not
  installed) in a separate process with a timeout and an environment without secrets.
  Running tests executes the code, so it can be switched off with ``CODE_REVIEW_ALLOW_EXEC=0``
  (the public server does this by default).
"""

import ast
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from agents import static_analysis as sa  # noqa: E402  pylint: disable=wrong-import-position

TEST_TIMEOUT = int(os.getenv("TEST_TIMEOUT", "60"))
MAX_PACKAGE_BYTES = int(os.getenv("MAX_PACKAGE_BYTES", str(30 * 1024 * 1024)))
COPY_IGNORE = shutil.ignore_patterns(  # pylint: disable=invalid-name
    "__pycache__", "*.pyc", ".git", "node_modules", ".venv", "venv", ".tox", ".mypy_cache",
    ".pytest_cache")
MAX_TOOL_FINDINGS = int(os.getenv("MAX_TOOL_FINDINGS", "40"))
MAX_OUTPUT_CHARS = 3000
SEVERITY_ORDER = {"error": 0, "high": 0, "warning": 1, "medium": 1, "refactor": 2,
                  "convention": 3, "low": 3, "info": 4}
_MODULE_RE = re.compile(r"[^A-Za-z0-9_]")


def execution_allowed() -> bool:
    """Whether ``run_tests`` may execute code (off when CODE_REVIEW_ALLOW_EXEC=0)."""
    return os.getenv("CODE_REVIEW_ALLOW_EXEC", "1").strip().lower() not in ("0", "false", "no", "")


def module_name(file_path: str) -> str:
    """A valid Python module name for a file (``src/my-file.py`` -> ``my_file``)."""
    stem = os.path.splitext(os.path.basename(file_path or "module"))[0]
    name = _MODULE_RE.sub("_", stem) or "module"
    if name[0].isdigit():
        name = "m_" + name
    return "module_under_test" if name.startswith("test") else name


def package_context(file_path: str) -> Optional[Dict[str, str]]:
    """When the file is inside a package (folders with ``__init__.py``), where that package is
    and the module's dotted name, so tests can import it with its relative imports working:
    ``src/requests/auth.py`` -> {"root": "src", "package": "requests", "rel": "requests/auth.py",
    "module": "requests.auth"}. None for a standalone file or a package too big to copy."""
    path = os.path.abspath(file_path or "")
    folder = os.path.dirname(path)
    if not os.path.isfile(os.path.join(folder, "__init__.py")):
        return None
    top = folder
    while os.path.isfile(os.path.join(os.path.dirname(top), "__init__.py")):
        top = os.path.dirname(top)
    root = os.path.dirname(top)
    size = 0
    for dirpath, dirnames, filenames in os.walk(top):
        dirnames[:] = [d for d in dirnames if d not in ("__pycache__", ".git", "node_modules")]
        size += sum(os.path.getsize(os.path.join(dirpath, f)) for f in filenames)
        if size > MAX_PACKAGE_BYTES:
            return None
    rel = os.path.relpath(path, root)
    parts = os.path.splitext(rel)[0].split(os.sep)
    if not all(p.isidentifier() for p in parts):
        return None
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return {"root": root, "package": os.path.basename(top), "rel": rel,
            "module": ".".join(parts)}


def import_name(file_path: str, context: Optional[Dict[str, str]] = None) -> str:
    """The name tests use to import the file: dotted inside a package, else a module name."""
    return context["module"] if context else module_name(file_path)


# ------------------------------------------------------------------ code checks

def check_syntax(code: str) -> Dict[str, Any]:
    """Compile the code. Returns {"valid": True} or {"valid": False, "line", "message"}."""
    try:
        compile(code, "<code>", "exec")
        return {"valid": True}
    except SyntaxError as e:
        return {"valid": False, "line": e.lineno, "message": str(e.msg)}
    except ValueError as e:  # e.g. null bytes
        return {"valid": False, "line": None, "message": str(e)}


def public_api(code: str) -> List[str]:
    """Names of the top-level functions and classes (the module's public interface)."""
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError):
        return []
    return sorted(
        node.name for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        and not node.name.startswith("_")
    )


def lint(code: str, tools=sa.TOOLS, name: str = "module.py") -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """Run linters on code given as a string. Returns (findings, {tool: status})."""
    with tempfile.TemporaryDirectory(prefix="review_lint_") as tmp:
        path = os.path.join(tmp, module_name(name) + ".py")
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)
        return sa.analyze(path, display=name, tools=tools)


def sort_findings(findings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Most severe first, then by line."""
    return sorted(findings, key=lambda f: (SEVERITY_ORDER.get(str(f.get("severity")), 5),
                                           f.get("line") or 0))


def compact(finding: Dict[str, Any]) -> Dict[str, Any]:
    """The fields a model needs, without the noise."""
    return {k: finding[k] for k in ("type", "line", "code", "severity", "message")
            if finding.get(k) is not None}


def counts(findings: List[Dict[str, Any]]) -> Dict[str, int]:
    """Number of findings per tool, ignoring radon's informational complexity reports."""
    out = {t: 0 for t in sa.TOOLS}
    for f in findings:
        if f.get("type") == "radon" and f.get("severity") == "info":
            continue
        out[str(f.get("type"))] = out.get(str(f.get("type")), 0) + 1
    return out


def format_findings(findings: List[Dict[str, Any]], limit: int = 60) -> str:
    """Findings as short text lines for a prompt, most severe first."""
    useful = [f for f in findings if not (f.get("type") == "radon" and f.get("severity") == "info")]
    if not useful:
        return "No issues reported by pylint, flake8, bandit or radon."
    lines = []
    for f in sort_findings(useful)[:limit]:
        code = f" {f['code']}" if f.get("code") else ""
        lines.append(f"- line {f.get('line', '?')} [{f.get('type')}{code}, {f.get('severity')}] "
                     f"{f.get('message')}")
    if len(useful) > limit:
        lines.append(f"- ... and {len(useful) - limit} more")
    return "\n".join(lines)


def _linter_result(tool: str, code: str) -> Dict[str, Any]:
    syntax = check_syntax(code)
    if not syntax["valid"]:
        return {"tool": tool, "status": "syntax_error", "syntax": syntax}
    findings, statuses = lint(code, tools=(tool,))
    if tool == "radon":  # complexity per block, the model needs every score
        findings = [f for f in findings if f.get("complexity_score", 0) > 5] or findings
    ordered = sort_findings(findings)
    return {
        "tool": tool,
        "status": statuses.get(tool, "error"),
        "count": len(findings),
        "findings": [compact(f) for f in ordered[:MAX_TOOL_FINDINGS]],
        "truncated": len(findings) > MAX_TOOL_FINDINGS,
    }


def run_pylint(code: str) -> Dict[str, Any]:
    """Run pylint on the code."""
    return _linter_result("pylint", code)


def run_flake8(code: str) -> Dict[str, Any]:
    """Run flake8 (PEP 8 style and pyflakes errors) on the code."""
    return _linter_result("flake8", code)


def run_bandit(code: str) -> Dict[str, Any]:
    """Run the bandit security scanner on the code."""
    return _linter_result("bandit", code)


def run_radon(code: str) -> Dict[str, Any]:
    """Measure cyclomatic complexity with radon (blocks scoring above 5 are listed)."""
    return _linter_result("radon", code)


# ------------------------------------------------------------------ test execution

def _sandbox_env(home: str) -> Dict[str, str]:
    """Environment for test processes: no API keys or other secrets from this process."""
    env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "SYSTEMROOT") if k in os.environ}
    env.update(HOME=home, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8",
               PYTHONHASHSEED="0", NO_COLOR="1")
    return env


def _junit_counts(path: str) -> Optional[Dict[str, int]]:
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError):
        return None
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    total = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0}
    for s in suites:
        for key in total:
            total[key] += int(s.get(key, 0) or 0)
    return total


def _unittest_counts(output: str) -> Dict[str, int]:
    ran = re.search(r"Ran (\d+) tests?", output)
    out = {"tests": int(ran.group(1)) if ran else 0, "failures": 0, "errors": 0, "skipped": 0}
    for key in ("failures", "errors", "skipped"):
        m = re.search(rf"{key}=(\d+)", output)
        if m:
            out[key] = int(m.group(1))
    return out


def run_tests(code: str, tests: str, module: str = "module_under_test",
              context: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Run ``tests`` against ``code``. Standalone: the code is saved as ``<module>.py``. With a
    ``context`` from ``package_context``, a copy of the whole package is made and the code
    replaces the file in it, so relative imports work and tests import ``context["module"]``.
    Returns pass/fail counts and the end of the test output."""
    if not execution_allowed():
        return {"tool": "run_tests", "status": "disabled",
                "message": "Running code is disabled on this server (CODE_REVIEW_ALLOW_EXEC=0)."}
    for label, text in (("code", code), ("tests", tests)):
        syntax = check_syntax(text)
        if not syntax["valid"]:
            return {"tool": "run_tests", "status": "syntax_error", "where": label, "syntax": syntax}
    with tempfile.TemporaryDirectory(prefix="review_tests_") as tmp:
        if context:
            shutil.copytree(os.path.join(context["root"], context["package"]),
                            os.path.join(tmp, context["package"]), ignore=COPY_IGNORE)
            target = os.path.join(tmp, context["rel"])
            short = context["module"].rsplit(".", 1)[-1]
        else:
            short = module_name(module + ".py")
            target = os.path.join(tmp, short + ".py")
        with open(target, "w", encoding="utf-8") as f:
            f.write(code)
        test_file = os.path.join(tmp, f"test_{short}.py")
        with open(test_file, "w", encoding="utf-8") as f:
            f.write(tests)
        junit = os.path.join(tmp, "report.xml")
        use_pytest = importlib.util.find_spec("pytest") is not None
        if use_pytest:
            cmd = [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
                   "--rootdir", tmp, f"--junitxml={junit}", test_file]
        else:
            cmd = [sys.executable, "-m", "unittest", "discover", "-s", tmp, "-p", "test_*.py"]
        try:
            env = _sandbox_env(tmp)
            env["PYTHONPATH"] = tmp
            proc = subprocess.run(cmd, cwd=tmp, capture_output=True, text=True,
                                  timeout=TEST_TIMEOUT, env=env, check=False)
        except subprocess.TimeoutExpired:
            return {"tool": "run_tests", "status": "timeout",
                    "message": f"The tests did not finish within {TEST_TIMEOUT}s."}
        output = (proc.stdout + "\n" + proc.stderr).replace(tmp + os.sep, "")
        stats = (_junit_counts(junit) if use_pytest else None) or _unittest_counts(output)
    passed = proc.returncode == 0 and stats["tests"] > 0
    return {
        "tool": "run_tests",
        "status": "ok",
        "runner": "pytest" if use_pytest else "unittest",
        "passed": passed,
        **stats,
        "exit_code": proc.returncode,
        "output": output.strip()[-MAX_OUTPUT_CHARS:],
    }


# ------------------------------------------------------------------ function-calling specs

@dataclass
class Tool:
    """A function the model may call: name, description, JSON-schema parameters, Python code."""
    name: str
    description: str
    parameters: Dict[str, Any]
    func: Callable[..., Dict[str, Any]]

    def spec(self) -> Dict[str, Any]:
        """OpenAI ``tools=[...]`` entry."""
        return {"type": "function",
                "function": {"name": self.name, "description": self.description,
                             "parameters": self.parameters}}

    def call(self, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Run the tool with arguments the model sent (already checked against the schema)."""
        return self.func(**arguments)


def _params(**props: str) -> Dict[str, Any]:
    return {"type": "object",
            "properties": {k: {"type": "string", "description": v} for k, v in props.items()},
            "required": list(props), "additionalProperties": False}


CODE_PARAM = "The complete Python source code to check."


def linter_tools() -> List[Tool]:
    """pylint, flake8, bandit, radon and a syntax check, each taking the code to check."""
    return [
        Tool("run_pylint", "Run pylint (bugs, code smells, naming, docstrings) on Python code. "
             "Returns the findings, most severe first.", _params(code=CODE_PARAM),
             run_pylint),
        Tool("run_flake8", "Run flake8 (PEP 8 style, unused imports and variables, undefined "
             "names) on Python code.", _params(code=CODE_PARAM), run_flake8),
        Tool("run_bandit", "Run the bandit security scanner (hard-coded secrets, eval, shell "
             "injection, weak crypto...) on Python code.", _params(code=CODE_PARAM), run_bandit),
        Tool("run_radon", "Measure the cyclomatic complexity of each function with radon. "
             "Lists blocks with a score above 5.", _params(code=CODE_PARAM), run_radon),
        Tool("check_syntax", "Check that Python code compiles.", _params(code=CODE_PARAM),
             check_syntax),
    ]


def tests_tool_for_code(module: str, context: Optional[Dict[str, str]] = None) -> Tool:
    """``run_tests`` taking both the code and the tests (used by the correction agent)."""
    return Tool(
        "run_tests",
        f"Run a pytest test file against your candidate code, importable as `{module}`. "
        "Returns the number of tests, failures and errors and the end of the output.",
        _params(code=CODE_PARAM,
                tests=f"Test file content. Import the code with `from {module} import ...`."),
        lambda code, tests: run_tests(code, tests, module, context),
    )


def tests_tool_for_fixed_code(code: str, module: str,
                              context: Optional[Dict[str, str]] = None) -> Tool:
    """``run_tests`` bound to the file under review (used by the test generator)."""
    return Tool(
        "run_tests",
        f"Run your test file against the file under review, importable as `{module}`. Returns "
        "the number of tests, failures and errors and the end of the output.",
        _params(tests=f"Test file content. Import the code with `from {module} import ...`."),
        lambda tests: run_tests(code, tests, module, context),
    )


def to_json(result: Any) -> str:
    """Tool result as the string sent back to the model."""
    return json.dumps(result, ensure_ascii=False, default=str)
