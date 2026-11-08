#!/usr/bin/env python3
"""
A scripted, OpenAI-compatible ``/v1/chat/completions`` server for testing the pipeline without
a Hugging Face key or network: ``HF_BASE_URL=http://127.0.0.1:<port>/v1``.

It is NOT a language model. It answers each agent with the right *shape* (valid JSON for the
schema, or tool calls followed by a submit call) so the plumbing can be tested end to end:
structured outputs, the function-calling loop, tool execution, the checks on submissions,
the linter context and parallel execution. Its "corrections" only add a module docstring
when one is missing, and its tests only import the module; quality numbers produced with it
mean nothing.

Every request is appended to ``FAKE_LLM_LOG`` (JSON lines) when that variable is set.
"""

import argparse
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

_LOCK = threading.Lock()
_COUNTER = [0]


def _code_block(text: str, after: str) -> Optional[str]:
    i = text.find(after)
    if i < 0:
        return None
    m = re.search(r"```python\n(.*?)\n```", text[i:], re.S)
    return m.group(1) if m else None


def _module(text: str) -> str:
    m = re.search(r"importable as `([A-Za-z0-9_.]+)`", text)
    return m.group(1) if m else "module_under_test"


def _call(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    with _LOCK:
        _COUNTER[0] += 1
        n = _COUNTER[0]
    return {"id": f"call_{n}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)}}


def _with_docstring(code: str) -> str:
    stripped = code.lstrip()
    if stripped.startswith(('"""', "'''", "#!")) or not stripped:
        return code
    return '"""Module corrected by the fake model (adds this docstring only)."""\n\n\n' + code


def answer(body: Dict[str, Any]) -> Dict[str, Any]:
    """The assistant message (content and/or tool_calls) for a request."""
    messages: List[Dict[str, Any]] = body.get("messages", [])
    user = next((m.get("content") or "" for m in messages if m.get("role") == "user"), "")
    tool_names = [t["function"]["name"] for t in body.get("tools") or []]
    done_tools = [m for m in messages if m.get("role") == "tool"]
    fmt = (body.get("response_format") or {}).get("json_schema", {}).get("name") \
        or (body.get("response_format") or {}).get("type")

    if "submit_correction" in tool_names:
        original = _code_block(user, "Original code:") or ""
        fixed = _with_docstring(original)
        if not done_tools:
            return {"tool_calls": [_call("run_flake8", {"code": fixed}),
                                   _call("run_bandit", {"code": fixed})]}
        return {"tool_calls": [_call("submit_correction", {
            "corrected_code": fixed,
            "changes": [{"line": 1, "description": "Added a module docstring."}],
            "remaining_issues": ["Other findings were left as they are by the fake model."]})]}

    if "submit_tests" in tool_names:
        module = _module(user)
        tests = f"import {module}\n\n\ndef test_module_imports():\n    assert {module} is not None\n"
        if not done_tools and "run_tests" in tool_names:
            return {"tool_calls": [_call("run_tests", {"tests": tests})]}
        return {"tool_calls": [_call("submit_tests", {
            "tests": tests, "framework": "pytest", "notes": "Import test only (fake model)."})]}

    if fmt == "code_explanation" or "complex_sections" in user:
        data: Dict[str, Any] = {"explanation": "Fake explanation of the module.",
                                "complex_sections": [{"line": 1, "end_line": 1, "reason": "fake"}]}
    elif fmt == "improvements" or "related_findings" in user:
        codes = re.findall(r"\[(?:pylint|flake8|bandit) ([A-Z]+\d+)", user)
        data = {"improvements": [{"line": 1, "category": "maintainability", "severity": "low",
                                  "description": "Fake suggestion.",
                                  "related_findings": codes[:2]}]}
    elif fmt == "documentation" or "usage_example" in user:
        data = {"overview": "Fake overview.",
                "docstrings": [{"name": "module", "kind": "module", "docstring": "Fake."}],
                "usage_example": ""}
    else:
        data = {"message": "unrecognised request"}
    return {"content": json.dumps(data)}


class Handler(BaseHTTPRequestHandler):
    """Serves POST /v1/chat/completions."""

    def log_message(self, format, *args):  # pylint: disable=redefined-builtin
        return

    def do_POST(self):  # pylint: disable=invalid-name
        """Answer one chat completion."""
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        log = os.getenv("FAKE_LLM_LOG")
        if log:
            with _LOCK, open(log, "a", encoding="utf-8") as f:
                f.write(json.dumps(body) + "\n")
        delay = float(os.getenv("FAKE_LLM_DELAY", "0"))
        if delay:
            time.sleep(delay)
        msg = answer(body)
        payload = {
            "id": "fake", "object": "chat.completion", "created": int(time.time()),
            "model": body.get("model", "fake"),
            "choices": [{
                "index": 0,
                "finish_reason": "tool_calls" if msg.get("tool_calls") else "stop",
                "message": {"role": "assistant", "content": msg.get("content"),
                            **({"tool_calls": msg["tool_calls"]} if msg.get("tool_calls") else {})},
            }],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
        }
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def start(port: int = 0) -> ThreadingHTTPServer:
    """Start the server in a background thread; returns it (``server.server_address``)."""
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--port", type=int, default=8799)
    a = parser.parse_args()
    print(f"Fake LLM on http://127.0.0.1:{a.port}/v1")
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
