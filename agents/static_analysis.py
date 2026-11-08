#!/usr/bin/env python3
"""
Static Analysis Agent.

Runs pylint, flake8, bandit and radon on one Python file and prints a JSON object:

    {"file": ..., "findings": [...], "tools": {"pylint": "ok", ...}, "agent": "static_analysis"}

The same functions are used as tools by the LLM agents (see ``agents/tools.py``), so a
finding looks the same whether it comes from this agent or from a tool call.

Only the JSON goes to stdout; progress and errors go to stderr. Redis is optional: when a
Redis server is reachable the result is also pushed to the ``static_analysis_results`` list,
and without a file argument the agent works as a Redis worker (``static_analysis_tasks``).
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time

TOOL_TIMEOUT = int(os.getenv("LINTER_TIMEOUT", "60"))
TOOLS = ("pylint", "flake8", "bandit", "radon")
PYLINT_SEVERITIES = {"error", "warning", "refactor", "convention", "fatal"}


def log(message):
    """Progress messages go to stderr so stdout stays valid JSON."""
    print(message, file=sys.stderr)


def _command(tool):
    """Run the linter with the current interpreter when it is installed there (works in a venv
    even when its bin/ folder is not on PATH), otherwise fall back to the executable on PATH."""
    if importlib.util.find_spec(tool) is not None:
        return [sys.executable, "-m", tool]
    exe = shutil.which(tool)
    return [exe] if exe else None


def _run(tool, args):
    """Run a linter. Returns (stdout, status) where status is "ok" or an error message."""
    cmd = _command(tool)
    if cmd is None:
        return "", f"{tool} is not installed"
    try:
        result = subprocess.run(cmd + args, capture_output=True, text=True,
                                timeout=TOOL_TIMEOUT, check=False)
    except subprocess.TimeoutExpired:
        return "", f"{tool} timed out after {TOOL_TIMEOUT}s"
    except OSError as e:
        return "", f"{tool} could not be started: {e}"
    return result.stdout, "ok"


def run_pylint(file_path, display=None):
    """Run pylint. Returns (findings, status)."""
    out, status = _run("pylint", ["--output-format=json", "--persistent=n", "--score=n", file_path])
    if status != "ok":
        return [], status
    try:
        items = json.loads(out) if out.strip() else []
    except json.JSONDecodeError:
        return [], "pylint returned output that is not JSON"
    findings = []
    for item in items:
        kind = str(item.get("type", "")).lower()
        findings.append({
            "type": "pylint",
            "file": display or item.get("path"),
            "line": item.get("line"),
            "column": item.get("column"),
            "code": item.get("message-id"),
            "symbol": item.get("symbol"),
            "message": item.get("message"),
            "severity": "error" if kind == "fatal" else (kind if kind in PYLINT_SEVERITIES else "info"),
        })
    return findings, "ok"


def run_flake8(file_path, display=None):
    """Run flake8. Returns (findings, status)."""
    out, status = _run("flake8", ["--format=%(row)d:%(col)d:%(code)s:%(text)s", file_path])
    if status != "ok":
        return [], status
    findings = []
    for line in out.splitlines():
        parts = line.split(":", 3)
        if len(parts) < 4 or not parts[0].isdigit():
            continue
        code = parts[2].strip()
        findings.append({
            "type": "flake8",
            "file": display or file_path,
            "line": int(parts[0]),
            "column": int(parts[1]) if parts[1].isdigit() else 0,
            "code": code,
            "message": f"{code} {parts[3].strip()}",
            "severity": "error" if code.startswith(("E9", "F")) else "warning",
        })
    return findings, "ok"


def run_bandit(file_path, display=None):
    """Run bandit on this file only (not on the whole folder). Returns (findings, status)."""
    out, status = _run("bandit", ["-f", "json", "-q", file_path])
    if status != "ok":
        return [], status
    try:
        data = json.loads(out) if out.strip() else {}
    except json.JSONDecodeError:
        return [], "bandit returned output that is not JSON"
    findings = []
    for item in data.get("results", []):
        findings.append({
            "type": "bandit",
            "file": display or item.get("filename"),
            "line": item.get("line_number"),
            "column": item.get("col_offset", 0),
            "code": item.get("test_id"),
            "message": item.get("issue_text"),
            "severity": str(item.get("issue_severity", "low")).lower(),
            "confidence": str(item.get("issue_confidence", "low")).lower(),
        })
    return findings, "ok"


def run_radon(file_path, display=None):
    """Run radon cyclomatic complexity. Returns (findings, status)."""
    out, status = _run("radon", ["cc", "-j", file_path])
    if status != "ok":
        return [], status
    try:
        data = json.loads(out) if out.strip() else {}
    except json.JSONDecodeError:
        return [], "radon returned output that is not JSON"
    findings = []
    for file_key, blocks in data.items():
        if not isinstance(blocks, list):  # radon reports a parse error as {"error": "..."}
            return [], f"radon could not parse the file: {blocks.get('error', blocks)}"
        for block in blocks:
            score = block.get("complexity", 0)
            findings.append({
                "type": "radon",
                "file": display or file_key,
                "line": block.get("lineno"),
                "column": block.get("col_offset", 0),
                "code": f"CC-{block.get('rank', '?')}",
                "symbol": block.get("name"),
                "message": (f"Complexity of {block.get('type', 'block')} "
                            f"'{block.get('name', '?')}': {score} (rank {block.get('rank', '?')})"),
                "severity": "info" if score <= 5 else ("warning" if score <= 10 else "error"),
                "complexity_score": score,
            })
    return findings, "ok"


RUNNERS = {"pylint": run_pylint, "flake8": run_flake8, "bandit": run_bandit, "radon": run_radon}


def analyze(file_path, display=None, tools=TOOLS):
    """Run the selected linters. Returns (findings, {tool: status})."""
    findings, statuses = [], {}
    for tool in tools:
        found, status = RUNNERS[tool](file_path, display)
        findings.extend(found)
        statuses[tool] = status
        if status != "ok":
            log(f"{tool}: {status}")
    return findings, statuses


def analyze_file(file_path):
    """Run all static analysis tools on a file. Returns the list of findings."""
    if not os.path.isfile(file_path):
        log(f"File not found: {file_path}")
        return []
    log(f"Analyzing {file_path}...")
    return analyze(file_path)[0]


def build_result(file_path):
    """The JSON object this agent prints."""
    if not os.path.isfile(file_path):
        return {"file": file_path, "agent": "static_analysis", "findings": [],
                "error": True, "note": f"File not found: {file_path}", "timestamp": time.time()}
    findings, statuses = analyze(file_path)
    result = {"file": file_path, "agent": "static_analysis", "findings": findings,
              "tools": statuses, "timestamp": time.time()}
    if all(s != "ok" for s in statuses.values()):
        result.update(error=True, note="No linter could run: " + "; ".join(statuses.values()))
    return result


def _redis():
    """A connected Redis client, or None (Redis is optional)."""
    try:
        import redis  # pylint: disable=import-outside-toplevel
    except ImportError:
        return None, None
    try:
        r = redis.Redis(host=os.getenv("REDIS_HOST", "localhost"),
                        port=int(os.getenv("REDIS_PORT", "6379")), db=0,
                        socket_connect_timeout=1)
        r.ping()
        return r, redis
    except redis.RedisError:
        return None, redis


def worker(r, redis_mod):
    """Listen for tasks on the ``static_analysis_tasks`` Redis list."""
    log("Static Analysis Agent started. Waiting for tasks...")
    while True:
        try:
            item = r.brpop("static_analysis_tasks", timeout=1)
            if item is None:
                continue
            task = json.loads(item[1])
            file_path = task.get("file")
            result = build_result(file_path) if file_path else {"error": True, "note": "No file"}
            result["task_id"] = task.get("task_id")
            r.lpush("static_analysis_results", json.dumps(result))
        except redis_mod.ConnectionError:
            log("Lost connection to Redis. Retrying in 5 seconds...")
            time.sleep(5)
        except (ValueError, TypeError) as e:
            log(f"Bad task: {e}")


def main():
    """Analyze the file given on the command line, or work as a Redis worker."""
    if len(sys.argv) > 1:
        result = build_result(sys.argv[1])
        print(json.dumps(result, indent=2))
        if os.getenv("STATIC_ANALYSIS_REDIS", "1") != "0":
            r, _ = _redis()
            if r is not None:
                r.lpush("static_analysis_results", json.dumps(result))
        return
    r, redis_mod = _redis()
    if r is None:
        sys.exit("Usage: python static_analysis.py <file_path>  (worker mode needs a Redis server)")
    worker(r, redis_mod)


if __name__ == "__main__":
    main()
