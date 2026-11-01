"""Tests for the Horizon AI adapter and server. Run: python -m unittest discover tests

The agents are replaced by stubs, so no API key, linter or network access is needed.
"""

import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import horizon_adapter as ad  # noqa: E402
import server  # noqa: E402

AGENTS = [{"name": n, "script": f"agents/{n}.py", "description": ad.info(n)["name"] + " Agent"}
          for n in ad.AGENT_INFO]

GOOD = {
    "static_analysis": {"findings": [{"type": "pylint", "line": 3, "message": "x", "severity": "warning"},
                                     {"type": "flake8", "line": 1, "message": "y", "severity": "warning"}]},
    "code_understanding": {"explanation": "Adds numbers.", "complex_sections": [{"line": 2, "reason": "r"}]},
    "improvement_suggestion": {"improvements": [{"line": 1, "description": "Rename."}]},
    "test_generator": {"tests": "def test_x(): pass"},
    "documentation_agent": {"documentation": "Overview"},
    "code_correction": {"corrected_code": "print(1)"},
}


class AdapterTests(unittest.TestCase):
    def test_empty_llm_output_is_a_failure_not_a_success(self):
        # The real sample_review_results.json contains agents that returned '' without an error flag.
        v = ad.evaluate_output("code_understanding", {"explanation": "", "complex_sections": []})
        self.assertIsNotNone(v["problem"])
        self.assertTrue(v["no_error"])
        self.assertFalse(v["non_empty"])

    def test_error_flag_and_process_failures(self):
        v = ad.evaluate_output("test_generator", {"tests": "", "error": True, "note": "API down"})
        self.assertEqual(v["problem"], "API down")
        self.assertFalse(v["no_error"])
        v = ad.evaluate_output("static_analysis", {"returncode": 1, "stderr": "boom\nModuleNotFoundError: redis"})
        self.assertIn("ModuleNotFoundError", v["problem"])
        self.assertFalse(v["process"])
        self.assertIn("timed out", ad.evaluate_output("static_analysis", {"timeout": True})["problem"])

    def test_zero_static_findings_is_a_valid_result(self):
        self.assertIsNone(ad.evaluate_output("static_analysis", {"findings": []})["problem"])


def make_run(statuses):
    agents = {}
    for i, name in enumerate(ad.AGENT_INFO):
        st = statuses.get(name, "pending")
        rec = {"status": st, "attempts": 0 if st == "pending" else 1, "manual": "pending", "approved": False}
        if st in ("ok", "failed"):
            rec.update(startedAt=1000 + i, endedAt=2000 + i, result=GOOD[name] if st == "ok" else None,
                       problem=None if st == "ok" else "API down",
                       checks={"process": True, "no_error": st == "ok", "non_empty": st == "ok"})
        agents[name] = rec
    return {"id": "run-002", "file": "src/a.py", "startedAt": 1000, "fingerprint": {"lines": 9, "sha": "abc"},
            "agents": agents, "events": []}


class WorkspaceTests(unittest.TestCase):
    names = list(ad.AGENT_INFO)

    def build(self, statuses):
        return ad.build_workspace([make_run(statuses)], self.names, "m", 5000)

    def test_task_status_follows_agent_status(self):
        ws = self.build({"static_analysis": "ok", "code_understanding": "failed", "test_generator": "running"})
        by_agent = {t["assigneeId"]: t for t in ws["tasks"]}
        self.assertEqual(by_agent["static_analysis"]["status"], "review")
        self.assertEqual(by_agent["code_understanding"]["status"], "blocked")
        self.assertEqual(by_agent["code_understanding"]["blocked"]["kind"], "failure")
        self.assertEqual(by_agent["test_generator"]["status"], "running")
        self.assertEqual(by_agent["improvement_suggestion"]["status"], "backlog")
        self.assertEqual(ws["runs"][0]["outcome"], "in_progress")
        self.assertEqual([t["id"] for t in ws["tasks"]][:2], ["T2.1", "T2.2"])

    def test_no_invented_dependencies_or_tokens(self):
        ws = self.build({n: "ok" for n in self.names})
        self.assertTrue(all(t["dependsOn"] == [] for t in ws["tasks"]))
        self.assertFalse(ws["capabilities"]["tokens"])
        self.assertEqual(set(ws["capabilities"]["transitions"]), {"review>completed", "review>running", "blocked>running"})
        self.assertEqual(ws["runs"][0]["outcome"], "succeeded")

    def test_memory_marks_tool_output_stored_and_model_output_inferred_without_confidence(self):
        ws = self.build({n: "ok" for n in self.names})
        mem = {m["id"]: m for m in ws["memories"]}
        self.assertEqual(mem["run-002-pylint"]["origin"], "stored")
        self.assertEqual(mem["run-002-flake8"]["provenance"]["sourceType"], "tool_output")
        for mid in ("run-002-explanation", "run-002-improvements", "run-002-documentation"):
            self.assertEqual(mem[mid]["origin"], "inferred")
            self.assertNotIn("confidence", mem[mid])
            self.assertEqual(mem[mid]["derivedFrom"], ["run-002-file"])
        for m in mem.values():
            for link in m["links"]:
                self.assertIn(link["to"], mem)

    def test_agent_output_is_readable_and_fences_are_stripped(self):
        run = make_run({n: "ok" for n in self.names})
        run["agents"]["code_correction"]["result"] = {"corrected_code": "```python\nprint(1)\n```"}
        ws = ad.build_workspace([run], self.names, "m", 5000)
        out = {t["assigneeId"]: t.get("output") for t in ws["tasks"]}
        self.assertEqual(out["code_correction"], {"kind": "code", "text": "print(1)", "filename": "a_corrected.py"})
        self.assertIn("pylint", out["static_analysis"]["text"])
        self.assertIn("Adds numbers.", out["code_understanding"]["text"])
        self.assertEqual(out["test_generator"]["filename"], "test_a.py")
        failed = ad.build_workspace([make_run({"test_generator": "failed"})], self.names, "m", 5000)
        self.assertNotIn("output", failed["tasks"][3])

    def test_outcomes(self):
        run = make_run({n: "failed" for n in self.names})
        self.assertEqual(ad.run_outcome(run), "failed")
        run = make_run({**{n: "ok" for n in self.names}, "test_generator": "failed"})
        self.assertEqual(ad.run_outcome(run), "partial")

    def test_manual_criterion_only_counts_after_ok(self):
        ws = self.build({"code_understanding": "failed"})
        task = next(t for t in ws["tasks"] if t["assigneeId"] == "code_understanding")
        self.assertEqual([c["result"] for c in task["validation"]], ["passed", "failed", "failed", "pending"])


class FakeClock:
    def __init__(self):
        self.t = 1_000_000

    def __call__(self):
        self.t += 7
        return self.t


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "src").mkdir()
        (self.root / "src" / "a.py").write_text("print('a')\n")
        (self.root / "venv").mkdir()
        (self.root / "venv" / "skip.py").write_text("x = 1\n")
        (self.root / ".env").write_text("HF_API_TOKEN=secret-token\n")
        self.fail_agents = set()
        self.gate = None

        def run_agent(agent, file_path, env=None):
            if self.gate:
                self.gate.wait(5)
            if agent["name"] in self.fail_agents:
                return {"error": True, "note": "API call failed", "file": file_path}
            return dict(GOOD[agent["name"]], file=file_path)

        self.hub = server.Hub(self.root, AGENTS, run_agent, "test-model", "local", FakeClock())
        self.service = self.hub.local
        self.httpd = server.make_server(self.hub, "127.0.0.1", 0, None)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.tmp.cleanup()

    def call(self, method, path, body=None, headers=None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def wait_idle(self):
        for _ in range(200):
            if not self.service.busy:
                return
            time.sleep(0.02)
        self.fail("run did not finish")

    def test_lists_only_reviewable_files(self):
        _, body = self.call("GET", "/api/files")
        self.assertEqual(body["files"], ["src/a.py"])

    def test_full_review_then_human_approval(self):
        code, res = self.call("POST", "/api/runs", {"file": "src/a.py"})
        self.assertEqual((code, res["runId"]), (200, "run-001"))
        self.wait_idle()
        ws = self.call("GET", "/api/workspace")[1]
        self.assertEqual(ws["runs"][0]["outcome"], "succeeded")
        self.assertTrue(all(t["status"] == "review" for t in ws["tasks"]))
        agg = ws["runs"][0]["aggregates"]
        self.assertEqual((agg["stepsTotal"], agg["stepsSucceeded"], agg["tasksCompleted"]), (6, 6, 6))
        # approving without the manual check is refused with a reason
        code, res = self.call("POST", "/api/tasks/T1.1/transition", {"to": "completed"})
        self.assertEqual(code, 422)
        self.assertIn("passed first", res["error"])
        # the browser sends the criterion id URL-encoded (":" -> %3A)
        self.assertEqual(self.call("POST", "/api/tasks/T1.1/criteria/T1.1%3Ahuman", {"result": "passed"})[0], 200)
        self.assertEqual(self.call("POST", "/api/tasks/T1.1/transition", {"to": "completed"})[0], 200)
        ws = self.call("GET", "/api/workspace")[1]
        self.assertEqual(ws["tasks"][0]["status"], "completed")
        self.assertEqual(sum(1 for e in ws["events"] if e["type"] == "intervention"), 2)
        # automated checks cannot be set by hand
        self.assertEqual(self.call("POST", "/api/tasks/T1.2/criteria/T1.2:process", {"result": "passed"})[0], 422)
        # arbitrary drags are explained, not silently applied
        code, res = self.call("POST", "/api/tasks/T1.2/transition", {"to": "backlog"})
        self.assertEqual(code, 422)
        self.assertIn("backend sets this status", res["error"])

    def test_failed_agent_blocks_then_retry_recovers(self):
        self.fail_agents = {"test_generator"}
        self.call("POST", "/api/runs", {"file": "src/a.py"})
        self.wait_idle()
        ws = self.call("GET", "/api/workspace")[1]
        failed = next(t for t in ws["tasks"] if t["assigneeId"] == "test_generator")
        self.assertEqual((failed["status"], failed["blocked"]["note"]), ("blocked", "API call failed"))
        self.assertEqual(ws["runs"][0]["outcome"], "partial")
        self.fail_agents = set()
        self.assertEqual(self.call("POST", f"/api/tasks/{failed['id']}/transition", {"to": "running"})[0], 200)
        self.wait_idle()
        ws = self.call("GET", "/api/workspace")[1]
        again = next(t for t in ws["tasks"] if t["id"] == failed["id"])
        self.assertEqual((again["status"], again["attempts"]), ("review", 2))
        self.assertEqual(ws["runs"][0]["outcome"], "succeeded")
        retry = [e for e in ws["events"] if e["type"] == "retry"]
        self.assertEqual([(e["recovered"], e["status"]) for e in retry], [(True, "success")])

    def test_one_review_at_a_time_and_path_safety(self):
        self.gate = threading.Event()
        self.assertEqual(self.call("POST", "/api/runs", {"file": "src/a.py"})[0], 200)
        code, res = self.call("POST", "/api/runs", {"file": "src/a.py"})
        self.assertEqual(code, 422)
        self.assertIn("already running", res["error"])
        self.gate.set()
        self.wait_idle()
        for bad in ("../x.py", "/etc/passwd", ".env", "venv/skip.py", "src/missing.py", "", None, "src"):
            self.assertEqual(self.call("POST", "/api/runs", {"file": bad})[0], 422, bad)

    def test_rejects_other_origins_and_hosts(self):
        code, _ = self.call("POST", "/api/runs", {"file": "src/a.py"}, {"Origin": "https://evil.example"})
        self.assertEqual(code, 403)
        code, _ = self.call("GET", "/api/workspace", None, {"Host": "evil.example"})
        self.assertEqual(code, 403)
        self.assertEqual(self.call("GET", "/api/workspace", None, {"Origin": "http://localhost:5173"})[0], 200)

    def test_runs_survive_a_restart_and_interrupted_runs_are_marked_failed(self):
        self.gate = threading.Event()
        self.call("POST", "/api/runs", {"file": "src/a.py"})
        time.sleep(0.1)
        svc2 = server.ReviewService(self.root, AGENTS, lambda a, f, e=None: {}, "m", FakeClock())
        ws = svc2.snapshot()
        self.assertEqual(ws["runs"][0]["outcome"], "failed")
        self.assertTrue(all(t["status"] == "blocked" for t in ws["tasks"]))
        self.assertIn("stopped", ws["tasks"][0]["blocked"]["note"])
        self.gate.set()
        self.wait_idle()

    def test_the_token_is_never_served(self):
        _, body = self.call("GET", "/api/workspace")
        self.assertNotIn("secret-token", json.dumps(body))


@unittest.skip("Stray tests for a shared-access-token design (server.Access, /api/login) that server.py "
                "does not implement. Public mode is bring-your-own-key; see PublicTests below.")
class PublicModeTests(unittest.TestCase):
    TOKEN = "correct-horse-battery"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "secret.py").write_text("password = 'owner-file'\n")
        self.seen_paths = []

        def run_agent(agent, file_path, env=None):
            self.seen_paths.append(file_path)
            return dict(GOOD[agent["name"]], file=file_path)

        self.service = server.ReviewService(self.root, AGENTS, run_agent, "m", FakeClock(),
                                            public=True, max_runs_per_hour=2)
        self.httpd = server.make_server(self.service, "127.0.0.1", 0, None,
                                        server.Access(True, self.TOKEN))
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.cookie = None

    def tearDown(self):
        self.httpd.shutdown()
        self.tmp.cleanup()

    def call(self, method, path, body=None, headers=None, cookie=True):
        h = {"Content-Type": "application/json", **(headers or {})}
        if cookie and self.cookie:
            h["Cookie"] = self.cookie
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers=h)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read() or b"{}"), r.headers
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}"), e.headers

    def login(self):
        code, _, headers = self.call("POST", "/api/login", {"token": self.TOKEN})
        self.assertEqual(code, 200)
        raw = headers["Set-Cookie"]
        self.assertIn("HttpOnly", raw)
        self.assertIn("SameSite=Strict", raw)
        self.cookie = raw.split(";")[0]

    def wait_idle(self):
        for _ in range(200):
            if not self.service.busy:
                return
            time.sleep(0.02)
        self.fail("run did not finish")

    def test_needs_a_token_of_reasonable_length(self):
        with self.assertRaises(ValueError):
            server.Access(True, "short")

    def test_api_is_closed_until_login_and_health_leaks_nothing(self):
        code, body, _ = self.call("GET", "/api/health")
        self.assertEqual((code, body["authRequired"], body["authenticated"], body["mode"]),
                         (200, True, False, "public"))
        self.assertNotIn("agents", body)
        for path in ("/api/workspace", "/api/files", "/api/stream"):
            self.assertEqual(self.call("GET", path)[0], 401, path)
        self.assertEqual(self.call("POST", "/api/runs", {"filename": "a.py", "code": "x=1"})[0], 401)
        self.login()
        self.assertEqual(self.call("GET", "/api/workspace")[0], 200)
        self.assertEqual(self.call("GET", "/api/health")[1]["authenticated"], True)
        # a forged cookie is not accepted
        self.cookie = "horizon_session=" + "0" * 64
        self.assertEqual(self.call("GET", "/api/workspace")[0], 401)

    def test_wrong_token_is_refused_and_brute_force_is_limited(self):
        for _ in range(8):
            self.assertEqual(self.call("POST", "/api/login", {"token": "nope"})[0], 401)
        code, body, _ = self.call("POST", "/api/login", {"token": self.TOKEN})
        self.assertEqual(code, 429)  # even the right token is refused while locked out
        self.assertIn("Too many", body["error"])

    def test_reviews_uploaded_code_only_and_never_the_servers_files(self):
        self.login()
        self.assertEqual(self.call("GET", "/api/files")[1]["files"], [])
        code, body, _ = self.call("POST", "/api/runs", {"file": "secret.py"})
        self.assertEqual(code, 422)
        self.assertIn("Send the code", body["error"])
        code, body, _ = self.call("POST", "/api/runs", {"filename": "mine.py", "code": "x = 1\n"})
        self.assertEqual((code, body["runId"]), (200, "run-001"))
        self.wait_idle()
        self.assertTrue(all(p.endswith("uploads/run-001/mine.py") for p in self.seen_paths))
        self.assertEqual((self.root / ".horizon/uploads/run-001/mine.py").read_text(), "x = 1\n")
        ws = self.call("GET", "/api/workspace")[1]
        self.assertEqual(ws["tasks"][0]["title"], "Static Analysis on mine.py")
        self.assertNotIn(str(self.root), json.dumps(ws))  # server paths are not shown

    def test_upload_validation(self):
        self.login()
        for name, code in [("a.txt", "x=1"), (".hidden.py", "x=1"),
                           ("ok.py", ""), ("ok.py", "a\x00b"), ("ok.py", "x" * 100_001)]:
            self.assertEqual(self.call("POST", "/api/runs", {"filename": name, "code": code})[0], 422,
                             name)
        # a path in the file name is reduced to its base name, never written outside uploads/
        code, _, _ = self.call("POST", "/api/runs", {"filename": "sub/dir/ok.py", "code": "x = 1"})
        self.assertEqual(code, 200)
        self.wait_idle()
        self.assertTrue((self.root / ".horizon/uploads/run-001/ok.py").is_file())

    def test_hourly_quota_protects_the_model_token(self):
        self.login()
        for i in range(2):
            self.assertEqual(self.call("POST", "/api/runs", {"filename": "a.py", "code": "x=1"})[0], 200)
            self.wait_idle()
        code, body, _ = self.call("POST", "/api/runs", {"filename": "a.py", "code": "x=1"})
        self.assertEqual(code, 422)
        self.assertIn("2 reviews per hour", body["error"])

    def test_only_same_origin_posts_and_security_headers(self):
        self.login()
        code, _, _ = self.call("POST", "/api/runs", {"filename": "a.py", "code": "x=1"},
                               {"Origin": "https://evil.example"})
        self.assertEqual(code, 403)
        _, _, headers = self.call("GET", "/api/health")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertIsNone(headers["Access-Control-Allow-Origin"])

    def test_old_uploads_are_deleted_when_a_new_run_starts(self):
        self.login()
        self.call("POST", "/api/runs", {"filename": "a.py", "code": "x=1"})
        self.wait_idle()
        self.call("POST", "/api/runs", {"filename": "b.py", "code": "y=2"})
        self.wait_idle()
        self.assertFalse((self.root / ".horizon/uploads/run-001").exists())
        self.assertTrue((self.root / ".horizon/uploads/run-002/b.py").exists())

    def test_logout_clears_the_cookie(self):
        self.login()
        _, _, headers = self.call("POST", "/api/logout", {})
        self.assertIn("Max-Age=0", headers["Set-Cookie"])


class PublicTests(unittest.TestCase):
    """Public deployment: private sessions, visitor-supplied code and key, limits."""

    TOKEN = "hf_test_secret_token_123456"
    S1 = "a" * 24
    S2 = "b" * 24

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / ".env").write_text("HF_API_TOKEN=server-secret\n")
        self.seen_env = []
        self.gate = None
        self.paths = []

        def run_agent(agent, file_path, env=None):
            self.seen_env.append(env)
            self.paths.append(file_path)
            if self.gate:
                self.gate.wait(5)
            return dict(GOOD[agent["name"]], file=file_path)

        self.run_agent = run_agent
        self.start()

    def start(self, **env):
        self.hub = server.Hub(self.root, AGENTS, self.run_agent, "test-model", "public", FakeClock())
        self.httpd = server.make_server(self.hub, "127.0.0.1", 0, None, frozenset({"https://front.example"}))
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.tmp.cleanup()

    def call(self, method, path, body=None, headers=None, session=None):
        sep = "&" if "?" in path else "?"
        url = f"http://127.0.0.1:{self.port}{path}" + (f"{sep}s={session}" if session else "")
        req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def wait_idle(self, session):
        svc = self.hub.sessions[session]
        for _ in range(300):
            if not svc.busy:
                return
            time.sleep(0.02)
        self.fail("run did not finish")

    def run_review(self, session, code="print('a')\n", name="demo.py", token=None, model=None):
        return self.call("POST", "/api/runs", {"name": name, "code": code, "model": model}, {"X-HF-Token": token or self.TOKEN}, session)

    def test_requires_a_session_and_hides_local_files(self):
        self.assertEqual(self.call("GET", "/api/workspace")[0], 400)
        self.assertEqual(self.call("GET", "/api/workspace", session="short")[0], 400)
        self.assertEqual(self.call("GET", "/api/files", session=self.S1)[0], 404)
        self.assertEqual(self.call("GET", "/api/health")[1]["mode"], "public")

    def test_review_uses_the_visitors_key_only_for_the_agents_and_never_stores_it(self):
        code, res = self.run_review(self.S1, model="org/some-model:fast")
        self.assertEqual((code, res["runId"]), (200, "run-001"))
        self.wait_idle(self.S1)
        env = self.seen_env[0]
        self.assertEqual((env["HF_API_TOKEN"], env["HF_MODEL"]), (self.TOKEN, "org/some-model:fast"))
        self.assertNotIn("server-secret", json.dumps(env))
        self.assertLessEqual(set(env), {"PATH", "LANG", "LC_ALL", "HF_API_TOKEN", "HF_MODEL", "PYTHONIOENCODING",
                                        "PYTHONDONTWRITEBYTECODE", "HOME", "HF_MIN_TOKENS", "HF_REASONING_EFFORT", "AGENT_TIMEOUT"})
        ws = self.call("GET", "/api/workspace", session=self.S1)[1]
        self.assertEqual(ws["runs"][0]["outcome"], "succeeded")
        self.assertIn("org/some-model:fast", ws["runs"][0]["config"])
        blob = json.dumps(ws)
        on_disk = "".join(p.read_text(errors="ignore") for p in (self.root / ".horizon").rglob("*") if p.is_file())
        self.assertNotIn(self.TOKEN, blob)
        self.assertNotIn(self.TOKEN, on_disk)
        self.assertTrue(all(p.startswith(str(self.root)) and p.endswith("demo.py") for p in self.paths))

    def test_missing_or_malformed_key_is_refused_with_a_reason(self):
        for bad in ("", "short", "has space in it", "x" * 300):
            code, res = self.call("POST", "/api/runs", {"name": "a.py", "code": "x=1"}, {"X-HF-Token": bad}, self.S1)
            self.assertEqual(code, 422, bad)
            self.assertIn("Hugging Face key", res["error"])
        code, res = self.call("POST", "/api/runs", {"name": "a.py", "code": "x=1"}, session=self.S1)
        self.assertEqual(code, 422)

    def test_sessions_are_isolated(self):
        self.run_review(self.S1, name="one.py")
        self.wait_idle(self.S1)
        ws2 = self.call("GET", "/api/workspace", session=self.S2)[1]
        self.assertEqual(ws2["runs"], [])
        self.run_review(self.S2, name="two.py")
        self.wait_idle(self.S2)
        r1 = self.call("GET", "/api/workspace", session=self.S1)[1]["runs"]
        self.assertEqual([r["label"] for r in r1], ["Review of one.py"])

    def test_input_validation(self):
        big = "x = 1\n" * 30000
        self.assertIn("100 KB", self.run_review(self.S1, code=big)[1]["error"])
        self.assertEqual(self.run_review(self.S1, code="  \n")[0], 422)
        self.assertEqual(self.run_review(self.S1, code="x=1", model="bad model; rm -rf")[0], 422)
        # names are sanitised: no path traversal, always a .py file inside the session's folder
        self.assertEqual(self.run_review(self.S1, name="../../etc/passwd")[0], 200)
        self.wait_idle(self.S1)
        self.assertTrue(self.paths[0].endswith("passwd.py") and ".." not in self.paths[0])
        self.assertEqual(self.call("POST", "/api/runs", {"file": "src/a.py"}, {"X-HF-Token": self.TOKEN}, self.S2)[0], 422)

    def test_only_the_latest_code_is_kept_so_static_analysis_sees_one_file(self):
        self.run_review(self.S1, name="first.py")
        self.wait_idle(self.S1)
        self.run_review(self.S1, name="second.py")
        self.wait_idle(self.S1)
        work = self.root / ".horizon" / "sessions" / self.S1 / "work"
        self.assertEqual([p.name for p in work.iterdir()], ["second.py"])

    def test_hourly_and_concurrent_limits(self):
        server.RUNS_PER_HOUR, old = 2, server.RUNS_PER_HOUR
        try:
            for _ in range(2):
                self.assertEqual(self.run_review(self.S1)[0], 200)
                self.wait_idle(self.S1)
            code, res = self.run_review(self.S1)
            self.assertEqual(code, 422)
            self.assertIn("per hour", res["error"])
        finally:
            server.RUNS_PER_HOUR = old

    def test_server_wide_concurrency_cap(self):
        self.hub.gate = threading.BoundedSemaphore(1)
        for svc in self.hub.sessions.values():
            svc.gate = self.hub.gate
        self.gate = threading.Event()
        self.hub.get(self.S1)
        self.hub.get(self.S2)
        for svc in self.hub.sessions.values():
            svc.gate = self.hub.gate
        self.assertEqual(self.run_review(self.S1)[0], 200)
        code, res = self.run_review(self.S2)
        self.assertEqual(code, 422)
        self.assertIn("busy", res["error"])
        self.gate.set()
        self.wait_idle(self.S1)
        self.assertEqual(self.run_review(self.S2)[0], 200)
        self.wait_idle(self.S2)

    def test_rerun_needs_the_key_again(self):
        self.run_review(self.S1)
        self.wait_idle(self.S1)
        code, res = self.call("POST", "/api/tasks/T1.2/transition", {"to": "running"}, session=self.S1)
        self.assertEqual(code, 422)
        self.assertIn("key", res["error"])
        code, _ = self.call("POST", "/api/tasks/T1.2/transition", {"to": "running"}, {"X-HF-Token": self.TOKEN}, self.S1)
        self.assertEqual(code, 200)
        self.wait_idle(self.S1)

    def test_origin_policy_and_cors(self):
        h = {"X-HF-Token": self.TOKEN}
        code, _ = self.call("POST", "/api/runs", {"name": "a.py", "code": "x=1"}, {**h, "Origin": "https://evil.example"}, self.S1)
        self.assertEqual(code, 403)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/workspace?s={self.S1}", headers={"Origin": "https://front.example"})
        with urllib.request.urlopen(req, timeout=5) as r:
            self.assertEqual(r.headers["Access-Control-Allow-Origin"], "https://front.example")
        pre = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/runs", method="OPTIONS", headers={"Origin": "https://front.example"})
        with urllib.request.urlopen(pre, timeout=5) as r:
            self.assertIn("X-HF-Token", r.headers["Access-Control-Allow-Headers"])

    def test_idle_sessions_are_deleted(self):
        self.run_review(self.S1)
        self.wait_idle(self.S1)
        svc = self.hub.sessions[self.S1]
        svc.last_used -= server.SESSION_TTL_MS + 1000
        self.hub.sweep()
        self.assertNotIn(self.S1, self.hub.sessions)
        self.assertFalse((self.root / ".horizon" / "sessions" / self.S1).exists())


if __name__ == "__main__":
    unittest.main()
