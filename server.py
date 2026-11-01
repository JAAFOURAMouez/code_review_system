#!/usr/bin/env python3
"""Horizon AI backend for the Code Review & Improvement System.

Runs the agents in ``orchestrator.AGENTS`` on a file, stores every run under ``.horizon/`` and
serves the Horizon AI front end plus a small JSON API. Standard library only.

Two modes (``HORIZON_MODE``):

* ``local`` (default): your own machine. Reviews files in this project folder, uses the key in
  ``.env``, listens on localhost only, no login.
* ``public``: a deployed site. Each visitor gets a private session (a random id kept in their
  browser). They paste or upload the code to review and bring their own Hugging Face key, which is
  sent with each request, used for that run only and never stored or logged by the server.

API (JSON):
    GET  /api/health
    GET  /api/files                        local mode only: Python files in the project
    GET  /api/workspace                    full snapshot in the front end's model
    GET  /api/stream                       server-sent events: a snapshot on every change
    POST /api/runs                         local {"file": "src/a.py"}; public {"name","code","model"}
    POST /api/tasks/<id>/transition        {"to": "completed" | "running"}
    POST /api/tasks/<id>/criteria/<cid>    {"result": "passed" | "failed" | "pending"}
Public mode adds ``?s=<session id>`` to every call and the ``X-HF-Token`` header to POSTs.
"""

from __future__ import annotations

import argparse
import collections
import json
import mimetypes
import os
import re
import shutil
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, unquote, urlparse

import horizon_adapter as ad

ROOT = Path(__file__).resolve().parent
STATE_DIR_NAME = ".horizon"
MAX_RUNS = 50
SKIP_DIRS = {"venv", ".venv", ".git", ".horizon", "__pycache__", "node_modules", "frontend", "dist"}
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
DEFAULT_MODEL = "openai/gpt-oss-20b:groq"

# Public-mode limits (all overridable with environment variables).
MAX_CODE_BYTES = int(os.getenv("HORIZON_MAX_CODE_BYTES", "100000"))
RUNS_PER_HOUR = int(os.getenv("HORIZON_RUNS_PER_HOUR", "8"))
MAX_CONCURRENT_RUNS = int(os.getenv("HORIZON_MAX_CONCURRENT_RUNS", "2"))
MAX_SESSIONS = int(os.getenv("HORIZON_MAX_SESSIONS", "200"))
SESSION_TTL_MS = int(os.getenv("HORIZON_SESSION_TTL_HOURS", "24")) * 3_600_000
MAX_STREAMS = int(os.getenv("HORIZON_MAX_STREAMS", "100"))

SESSION_RE = re.compile(r"[A-Za-z0-9_-]{22,64}")
TOKEN_RE = re.compile(r"[\x21-\x7e]{8,200}")
MODEL_RE = re.compile(r"[A-Za-z0-9_.:/-]{1,100}")


def now_ms() -> int:
    return int(time.time() * 1000)


class ReviewService:
    """One person's runs: stores them, executes agents, and applies the few human actions."""

    def __init__(
        self,
        root: Path,
        agents: list[dict[str, str]],
        run_agent: Callable[..., dict[str, Any]],
        model: str,
        clock: Callable[[], int] = now_ms,
        state_dir: Path | None = None,
        public: bool = False,
        gate: threading.BoundedSemaphore | None = None,
    ) -> None:
        self.root = root.resolve()
        self.agents = agents
        self.names = [a["name"] for a in agents]
        self._run_agent = run_agent
        self.model = model
        self.clock = clock
        self.public = public
        self.gate = gate
        self.state_dir = (state_dir or self.root / STATE_DIR_NAME).resolve()
        self.state_path = self.state_dir / "runs.json"
        self.work_dir = self.state_dir / "work"
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.version = 0
        self.busy = False
        self.last_used = clock()
        self.recent_starts: collections.deque[int] = collections.deque()
        self.runs: list[dict[str, Any]] = []
        self._load()

    # ---------------------------------------------------------------- persistence
    def _load(self) -> None:
        if self.state_path.is_file():
            try:
                self.runs = json.loads(self.state_path.read_text("utf-8")).get("runs", [])
            except (OSError, ValueError):
                self.runs = []
        # Anything still running belongs to a previous server process that is gone.
        for run in self.runs:
            touched = False
            for rec in run["agents"].values():
                if rec["status"] in ("running", "pending"):
                    rec.update(
                        status="failed",
                        endedAt=self.clock(),
                        problem="The server stopped before this agent finished.",
                        checks={"process": False, "no_error": False, "non_empty": False},
                    )
                    touched = True
            if touched:
                run["endedAt"] = self.clock()
                self._event(run, "system", "error", "failed", "Run interrupted",
                            "The server stopped while this review was in progress.")
        if self.runs:
            self._save()

    def _save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": 1, "runs": self.runs[-MAX_RUNS:]}), "utf-8")
        os.replace(tmp, self.state_path)

    def _bump(self) -> None:
        with self.changed:
            self.version += 1
            self._save()
            self.changed.notify_all()

    # ---------------------------------------------------------------- helpers
    def _event(self, run: dict[str, Any], actor: str, etype: str, status: str, title: str,
               detail: str | None = None, **extra: Any) -> None:
        ev: dict[str, Any] = {
            "id": f"{run['id']}-e{len(run['events']) + 1}",
            "at": self.clock(),
            "runId": run["id"],
            "actorId": actor,
            "type": etype,
            "status": status,
            "title": title,
        }
        if detail:
            ev["detail"] = detail
        ev.update({k: v for k, v in extra.items() if v is not None})
        run["events"].append(ev)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            self.last_used = self.clock()
            model = (self.runs[-1].get("model") if self.runs else None) or self.model
            return ad.build_workspace(self.runs, self.names, model, self.clock())

    def current(self) -> dict[str, Any] | None:
        return self.runs[-1] if self.runs else None

    def list_files(self) -> list[str]:
        found: list[str] = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for f in sorted(filenames):
                if f.endswith(".py"):
                    found.append(str(Path(dirpath, f).relative_to(self.root)))
            if len(found) >= 500:
                break
        return found

    def _resolve(self, raw: Any) -> tuple[str | None, str | None]:
        """Local mode: (relative path, error). Only .py files inside the project are accepted."""
        if not isinstance(raw, str) or not raw.strip():
            return None, "Choose a Python file to review."
        p = Path(raw)
        if p.is_absolute() or ".." in p.parts:
            return None, "The file must be inside the project folder."
        full = (self.root / p).resolve()
        try:
            rel = full.relative_to(self.root)
        except ValueError:
            return None, "The file must be inside the project folder."
        if any(part in SKIP_DIRS for part in rel.parts) or rel.suffix != ".py":
            return None, "Only Python files in your project can be reviewed."
        if not full.is_file():
            return None, f"File not found: {rel}"
        return str(rel), None

    def _env(self, token: str | None, model: str) -> dict[str, str] | None:
        """Environment for agent subprocesses. Public mode passes only what the agents need, so
        nothing from the server's own environment (other secrets) reaches them."""
        if not self.public:
            return None
        env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL") if k in os.environ}
        env.update(HF_API_TOKEN=token or "", HF_MODEL=model, PYTHONIOENCODING="utf-8",
                   PYTHONDONTWRITEBYTECODE="1", HOME=str(self.work_dir))
        for k in ("HF_MIN_TOKENS", "HF_REASONING_EFFORT", "AGENT_TIMEOUT"):
            if k in os.environ:
                env[k] = os.environ[k]
        return env

    # ---------------------------------------------------------------- starting runs
    def start_run(self, raw_file: Any) -> dict[str, Any]:
        """Local mode: review a file from the project folder."""
        if self.public:
            return {"error": "Send the code to review instead of a file path."}
        rel, err = self._resolve(raw_file)
        if err or rel is None:
            return {"error": err}
        try:
            text = (self.root / rel).read_text("utf-8")
        except (OSError, UnicodeDecodeError) as e:
            return {"error": f"Could not read {rel}: {e}"}
        return self._start(rel, rel, text, None, self.model)

    def start_upload(self, name: Any, code: Any, token: Any, model: Any) -> dict[str, Any]:
        """Public mode: review code the visitor sent, with their own Hugging Face key."""
        if not self.public:
            return {"error": "Uploads are only available on a public deployment."}
        if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
            return {"error": "Add your Hugging Face key in Settings first."}
        model = model if isinstance(model, str) and model.strip() else self.model
        if not MODEL_RE.fullmatch(model):
            return {"error": "The model name contains characters that are not allowed."}
        if not isinstance(code, str) or not code.strip():
            return {"error": "Paste or upload some Python code to review."}
        if len(code.encode("utf-8")) > MAX_CODE_BYTES:
            return {"error": f"The code is larger than {MAX_CODE_BYTES // 1000} KB."}
        stem = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(str(name or "snippet")).name)[:60] or "snippet"
        filename = stem if stem.endswith(".py") else stem + ".py"
        if filename.startswith("."):
            filename = "snippet" + filename
        res = self._reserve()
        if res:
            return res
        try:
            if self.work_dir.exists():
                shutil.rmtree(self.work_dir)  # bandit scans the folder: keep only this file
            self.work_dir.mkdir(parents=True)
            path = self.work_dir / filename
            path.write_text(code, "utf-8")
        except OSError as e:
            self._release()
            return {"error": f"Could not store the code: {e}"}
        return self._start(filename, str(path), code, token, model, reserved=True)

    def _reserve(self) -> dict[str, Any] | None:
        """Claim a run slot (one per person, a few for the whole server, N per hour)."""
        with self.lock:
            if self.busy:
                return {"error": "A review is already running. Wait for it to finish."}
            if self.public:
                cutoff = self.clock() - 3_600_000
                while self.recent_starts and self.recent_starts[0] < cutoff:
                    self.recent_starts.popleft()
                if len(self.recent_starts) >= RUNS_PER_HOUR:
                    return {"error": f"Limit reached: {RUNS_PER_HOUR} reviews per hour. Try again later."}
            if self.gate is not None and not self.gate.acquire(blocking=False):
                return {"error": "The server is busy with other reviews. Try again in a minute."}
            self.busy = True
            self.recent_starts.append(self.clock())
        return None

    def _release(self) -> None:
        with self.lock:
            self.busy = False
        if self.gate is not None:
            try:
                self.gate.release()
            except ValueError:
                pass

    def _start(self, display: str, fs_path: str, text: str, token: str | None, model: str,
               reserved: bool = False) -> dict[str, Any]:
        if not reserved:
            res = self._reserve()
            if res:
                return res
        with self.lock:
            n = max((ad.run_number(r["id"]) for r in self.runs), default=0) + 1
            run: dict[str, Any] = {
                "id": f"run-{n:03d}",
                "file": display,
                "path": fs_path,
                "model": model,
                "startedAt": self.clock(),
                "fingerprint": ad.file_fingerprint(text),
                "agents": {
                    a["name"]: {"status": "pending", "attempts": 0, "manual": "pending",
                                "approved": False}
                    for a in self.agents
                },
                "events": [],
            }
            self.runs.append(run)
            self._event(run, "system", "action", "info", "Review started", display)
            self._bump()
        threading.Thread(target=self._execute,
                         args=(run, list(range(len(self.agents))), token, model),
                         daemon=True).start()
        return {"runId": run["id"]}

    def _execute(self, run: dict[str, Any], indices: list[int], token: str | None,
                 model: str) -> None:
        try:
            for i in indices:
                self._run_one(run, i, token, model)
        finally:
            with self.lock:
                if all(r["status"] in ("ok", "failed") for r in run["agents"].values()):
                    run["endedAt"] = self.clock()
                    self._event(run, "system", "action", "info", "Review finished",
                                ad.run_outcome(run).replace("_", " "))
                self._bump()
            self._release()

    def _run_one(self, run: dict[str, Any], index: int, token: str | None, model: str) -> None:
        agent = self.agents[index]
        name = agent["name"]
        desc = agent.get("description", name)
        tid = ad.task_id(run["id"], index)
        with self.lock:
            rec = run["agents"][name]
            rec.update(status="running", startedAt=self.clock(), endedAt=None, problem=None,
                       result=None, checks=None, manual="pending", approved=False,
                       attempts=rec.get("attempts", 0) + 1)
            self._event(run, name, "transition", "info", f"{tid} moved to Running", desc, taskId=tid)
            self._bump()
        started = time.monotonic()
        try:
            result = self._run_agent(agent, run.get("path") or run["file"], self._env(token, model))
        except Exception as e:  # the orchestrator already catches most failures
            result = {"error": True, "exception": str(e)}
        duration = int((time.monotonic() - started) * 1000)
        verdict = ad.evaluate_output(name, result)
        ok = verdict["problem"] is None
        with self.lock:
            rec = run["agents"][name]
            stored = dict(result) if isinstance(result, dict) else {"value": str(result)}
            for key in ("raw_output", "stderr"):
                if isinstance(stored.get(key), str):
                    stored[key] = stored[key][-2000:]
            rec.update(
                status="ok" if ok else "failed",
                endedAt=self.clock(),
                problem=verdict["problem"],
                checks={k: verdict[k] for k in ("process", "no_error", "non_empty")},
                result=stored,
            )
            tool = agent.get("script")
            if ok:
                self._event(run, name, "tool_call", "success", f"{desc} returned output",
                            None, taskId=tid, tool=tool, durationMs=duration)
                self._event(run, name, "transition", "info", f"{tid} moved to Review", taskId=tid)
            else:
                self._event(run, name, "error", "failed", f"{desc} failed", verdict["problem"],
                            taskId=tid, tool=tool, durationMs=duration)
                self._event(run, name, "transition", "warning", f"{tid} moved to Blocked",
                            verdict["problem"], taskId=tid)
            if rec["attempts"] > 1:
                self._event(run, name, "retry", "success" if ok else "failed",
                            f"Retry {rec['attempts'] - 1} of {desc}",
                            "Recovered." if ok else "Still failing.", taskId=tid, recovered=ok)
            self._bump()

    # ---------------------------------------------------------------- human actions
    def _locate(self, task_id: str) -> tuple[dict[str, Any] | None, int, str | None]:
        run = self.current()
        m = re.fullmatch(r"T(\d+)\.(\d+)", task_id)
        if not run or not m or int(m.group(1)) != ad.run_number(run["id"]):
            return None, -1, "That task belongs to a run that is no longer current."
        idx = int(m.group(2)) - 1
        if not 0 <= idx < len(self.agents):
            return None, -1, "Unknown task."
        return run, idx, None

    def transition(self, task_id: str, to: str, token: str | None = None) -> dict[str, Any]:
        with self.lock:
            run, idx, err = self._locate(task_id)
            if err or run is None:
                return {"error": err}
            name = self.agents[idx]["name"]
            rec = run["agents"][name]
            if to == "completed":
                if rec["status"] != "ok":
                    return {"error": "Only an agent output that is waiting for review can be approved."}
                if rec.get("approved"):
                    return {}
                if rec.get("manual") != "passed":
                    return {"error": "Mark “A person has read the output and accepts it” as passed first."}
                rec["approved"] = True
                self._event(run, "human", "intervention", "success",
                            f"{task_id} moved to Completed", "Approved by a person.", taskId=task_id)
                if all(r.get("approved") for r in run["agents"].values()):
                    self._event(run, "human", "decision", "success", "All agents approved",
                                taskId=task_id)
                self._bump()
                return {}
            if to == "running":
                if rec["status"] not in ("ok", "failed"):
                    return {"error": "This agent has not finished yet."}
                model = run.get("model") or self.model
                if self.public:
                    if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
                        return {"error": "Add your Hugging Face key in Settings to re-run an agent."}
                    if not Path(run.get("path", "")).is_file():
                        return {"error": "The code for this run is no longer stored. Start a new review."}
                res = self._reserve()
                if res:
                    return res
                self._event(run, "human", "intervention", "info", f"Re-run requested for {task_id}",
                            None, taskId=task_id)
                run["endedAt"] = None
                self._bump()
                threading.Thread(target=self._execute, args=(run, [idx], token, model),
                                 daemon=True).start()
                return {}
        return {
            "error": "In live mode the backend sets this status. You can approve a reviewed "
            "task or re-run an agent."
        }

    def set_criterion(self, task_id: str, criterion_id: str, result: str) -> dict[str, Any]:
        if result not in ("pending", "passed", "failed"):
            return {"error": "Unknown result."}
        with self.lock:
            run, idx, err = self._locate(task_id)
            if err or run is None:
                return {"error": err}
            rec = run["agents"][self.agents[idx]["name"]]
            if not criterion_id.endswith(f":{ad.HUMAN_CRITERION}"):
                return {"error": "That check is computed from the agent's output and cannot be set by hand."}
            if rec["status"] != "ok":
                return {"error": "There is no output to review yet."}
            rec["manual"] = result
            if result != "passed":
                rec["approved"] = False
            self._event(run, "human", "intervention", "info",
                        f"{task_id}: review marked {result}", taskId=task_id)
            self._bump()
            return {}


class Hub:
    """Maps a request to the ReviewService it belongs to."""

    def __init__(self, root: Path, agents: list[dict[str, str]], run_agent: Callable[..., Any],
                 model: str, mode: str = "local", clock: Callable[[], int] = now_ms) -> None:
        self.root, self.agents, self.run_agent, self.model = root.resolve(), agents, run_agent, model
        self.mode, self.clock = mode, clock
        self.public = mode == "public"
        self.lock = threading.Lock()
        self.sessions: dict[str, ReviewService] = {}
        self.gate = threading.BoundedSemaphore(MAX_CONCURRENT_RUNS) if self.public else None
        self.streams = 0
        self.local: ReviewService | None = None
        if not self.public:
            self.local = self._make(None)

    def _make(self, state_dir: Path | None) -> ReviewService:
        return ReviewService(self.root, self.agents, self.run_agent, self.model, self.clock,
                             state_dir, self.public, self.gate)

    def get(self, session: str | None) -> tuple[ReviewService | None, str | None]:
        if not self.public:
            return self.local, None
        if not session or not SESSION_RE.fullmatch(session):
            return None, "Missing or invalid session."
        with self.lock:
            svc = self.sessions.get(session)
            if svc is None:
                if len(self.sessions) >= MAX_SESSIONS:
                    self._evict(force=True)
                if len(self.sessions) >= MAX_SESSIONS:
                    return None, "The server is full right now. Try again later."
                svc = self._make(self.root / STATE_DIR_NAME / "sessions" / session)
                self.sessions[session] = svc
            svc.last_used = self.clock()
            return svc, None

    def _evict(self, force: bool = False) -> None:
        """Forget idle sessions (and delete their stored code and runs). Caller holds the lock."""
        now = self.clock()
        idle = sorted((s for s in self.sessions.items() if not s[1].busy),
                      key=lambda kv: kv[1].last_used)
        for sid, svc in idle:
            if now - svc.last_used > SESSION_TTL_MS or (force and len(self.sessions) >= MAX_SESSIONS):
                shutil.rmtree(svc.state_dir, ignore_errors=True)
                del self.sessions[sid]
                if force and len(self.sessions) < MAX_SESSIONS:
                    break

    def sweep(self) -> None:
        with self.lock:
            self._evict()

    def start_sweeper(self) -> None:
        def loop() -> None:
            while True:
                time.sleep(600)
                self.sweep()
        threading.Thread(target=loop, daemon=True).start()


# -------------------------------------------------------------------- HTTP layer
class Handler(BaseHTTPRequestHandler):
    server_version = "HorizonServer/1"
    hub: Hub
    static_dir: Path | None
    allowed_origins: frozenset[str] = frozenset()

    def log_message(self, fmt: str, *args: Any) -> None:  # quiet: request lines can carry session ids
        if os.getenv("HORIZON_VERBOSE"):
            super().log_message(fmt, *args)

    # -- guards
    def _host_ok(self) -> bool:
        if self.hub.public:
            return True  # behind the platform's proxy; protection comes from origin checks + limits
        hostname = urlparse("//" + (self.headers.get("Host") or "")).hostname or ""
        return hostname in LOCAL_HOSTS

    def _origin(self) -> str | None:
        """None when absent, the origin when allowed, "forbidden" otherwise."""
        origin = self.headers.get("Origin")
        if not origin:
            return None
        if self.hub.public:
            same = urlparse(origin).netloc == (self.headers.get("Host") or "")
            return origin if same or origin.rstrip("/") in self.allowed_origins else "forbidden"
        return origin if (urlparse(origin).hostname or "") in LOCAL_HOSTS else "forbidden"

    def _send(self, status: int, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        origin = self._origin()
        if origin and origin != "forbidden":
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json; charset=utf-8")

    def _guard(self) -> bool:
        if not self._host_ok():
            self._json(HTTPStatus.FORBIDDEN, {"error": "Only local requests are accepted."})
            return False
        if self._origin() == "forbidden":
            self._json(HTTPStatus.FORBIDDEN, {"error": "Requests from other websites are refused."})
            return False
        return True

    def _service(self, query: dict[str, list[str]]) -> ReviewService | None:
        svc, err = self.hub.get((query.get("s") or [None])[0])
        if svc is None:
            self._json(400, {"error": err})
        return svc

    def do_OPTIONS(self) -> None:  # CORS preflight when the front end is on another origin
        if not self._guard():
            return
        self._send(HTTPStatus.NO_CONTENT, b"", "text/plain",
                   {"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, X-HF-Token",
                    "Access-Control-Max-Age": "600"})

    # -- routes
    def do_GET(self) -> None:
        if not self._guard():
            return
        url = urlparse(self.path)
        path, query = url.path, parse_qs(url.query)
        if path == "/api/health":
            return self._json(200, {"ok": True, "app": "horizon-code-review", "mode": self.hub.mode,
                                    "agents": [a["name"] for a in self.hub.agents]})
        if path.startswith("/api/"):
            if path == "/api/files" and self.hub.public:
                return self._json(404, {"error": "Not available on a public deployment."})
            svc = self._service(query)
            if svc is None:
                return
            if path == "/api/files":
                return self._json(200, {"files": svc.list_files()})
            if path == "/api/workspace":
                return self._json(200, svc.snapshot())
            if path == "/api/stream":
                return self._stream(svc)
            return self._json(404, {"error": "Unknown endpoint."})
        self._static(path)

    def do_POST(self) -> None:
        if not self._guard():
            return
        url = urlparse(self.path)
        path, query = url.path, parse_qs(url.query)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_CODE_BYTES * 6 + 4096:  # JSON can escape one byte into six
                return self._json(413, {"error": "The request is too large."})
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self._json(400, {"error": "The request body must be a JSON object."})
        svc = self._service(query)
        if svc is None:
            return
        token = self.headers.get("X-HF-Token")
        if path == "/api/runs":
            if self.hub.public:
                res = svc.start_upload(body.get("name"), body.get("code"), token, body.get("model"))
            else:
                res = svc.start_run(body.get("file"))
        elif m := re.fullmatch(r"/api/tasks/([^/]+)/transition", path):
            res = svc.transition(unquote(m.group(1)), str(body.get("to", "")), token)
        elif m := re.fullmatch(r"/api/tasks/([^/]+)/criteria/([^/]+)", path):
            res = svc.set_criterion(unquote(m.group(1)), unquote(m.group(2)), str(body.get("result", "")))
        else:
            return self._json(404, {"error": "Unknown endpoint."})
        self._json(422 if res.get("error") else 200, res)

    def _stream(self, svc: ReviewService) -> None:
        hub = self.hub
        with hub.lock:
            if hub.streams >= MAX_STREAMS:
                return self._json(503, {"error": "Too many open connections."})
            hub.streams += 1
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            origin = self._origin()
            if origin and origin != "forbidden":
                self.send_header("Access-Control-Allow-Origin", origin)
            self.end_headers()
            seen = -1
            while True:
                with svc.changed:
                    if svc.version == seen:
                        svc.changed.wait(timeout=15)
                    current = svc.version
                if current != seen:
                    seen = current
                    self.wfile.write(b"data: " + json.dumps(svc.snapshot()).encode() + b"\n\n")
                else:
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        finally:
            with hub.lock:
                hub.streams -= 1

    def _static(self, path: str) -> None:
        base = self.static_dir
        if base is None or not base.is_dir():
            msg = ("<h1>Horizon AI</h1><p>The front end has not been built yet. "
                   "Run <code>npm install &amp;&amp; npm run build</code> in <code>frontend/</code>, "
                   "or open the dev server with <code>?api=http://127.0.0.1:8787</code>.</p>")
            return self._send(404, msg.encode(), "text/html; charset=utf-8")
        rel = path.lstrip("/") or "index.html"
        target = (base / rel).resolve()
        try:
            target.relative_to(base.resolve())
        except ValueError:
            return self._json(403, {"error": "Forbidden."})
        if not target.is_file():
            target = base / "index.html"  # single-page app
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)


def make_server(hub: Hub, host: str, port: int, static_dir: Path | None,
                allowed_origins: frozenset[str] = frozenset()) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"hub": hub, "static_dir": static_dir,
                                                "allowed_origins": allowed_origins})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    if hub.public:
        hub.start_sweeper()
    return server


def main() -> None:
    mode = os.getenv("HORIZON_MODE", "local")
    if mode not in ("local", "public"):
        sys.exit("HORIZON_MODE must be 'local' or 'public'.")
    parser = argparse.ArgumentParser(description="Horizon AI backend for the code review agents")
    parser.add_argument("--host", default="0.0.0.0" if mode == "public" else "127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8787")))
    parser.add_argument("--static", default=str(ROOT / "frontend" / "dist"))
    args = parser.parse_args()
    if mode == "local" and args.host not in LOCAL_HOSTS:
        sys.exit("Refusing to bind to a non-local address in local mode: there is no login and it "
                 "reads your files. Use HORIZON_MODE=public for a deployment.")

    os.chdir(ROOT)  # the agents are launched with project-relative script paths
    sys.path.insert(0, str(ROOT))
    try:
        import orchestrator
    except ImportError as e:
        sys.exit(f"Could not import orchestrator.py ({e}). Install the requirements first: "
                 "pip install -r requirements.txt")

    model = os.getenv("HF_MODEL", DEFAULT_MODEL)
    hub = Hub(ROOT, orchestrator.AGENTS, orchestrator.run_agent, model, mode)
    origins = frozenset(o.strip().rstrip("/") for o in os.getenv("HORIZON_ALLOWED_ORIGINS", "").split(",")
                        if o.strip())
    server = make_server(hub, args.host, args.port, Path(args.static), origins)
    print(f"Horizon AI ({mode} mode): http://{args.host}:{args.port}  (project: {ROOT})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
