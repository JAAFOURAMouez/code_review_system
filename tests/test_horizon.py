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

    def test_current_run_shows_each_agent_status_and_result(self):
        ws = self.build({"static_analysis": "ok", "code_understanding": "failed", "test_generator": "running"})
        cur = ws["current"]["agents"]
        self.assertEqual(cur["static_analysis"]["status"], "ok")
        self.assertEqual(cur["static_analysis"]["result"]["findings"][0]["type"], "pylint")
        self.assertEqual((cur["code_understanding"]["status"], cur["code_understanding"]["problem"]),
                         ("failed", "API down"))
        self.assertEqual(cur["test_generator"]["status"], "running")
        self.assertIsNone(cur["test_generator"]["result"])
        self.assertEqual(cur["improvement_suggestion"]["status"], "pending")
        self.assertEqual(ws["current"]["outcome"], "in_progress")
        self.assertEqual([cur[n]["taskId"] for n in self.names][:2], ["T2.1", "T2.2"])
        self.assertEqual(cur["static_analysis"]["durationMs"], 1000)

    def test_results_hide_process_details_and_paths(self):
        run = make_run({n: "ok" for n in self.names})
        run["agents"]["code_correction"]["result"] = {
            "corrected_code": "print(1)\n", "file": "/srv/secret/path.py", "stderr": "trace",
            "verification": {"accepted": True}}
        ws = ad.build_workspace([run], self.names, "m", 5000)
        res = ws["current"]["agents"]["code_correction"]["result"]
        self.assertEqual(res, {"corrected_code": "print(1)\n", "verification": {"accepted": True}})
        self.assertNotIn("/srv/secret", json.dumps(ws))

    def test_agents_and_run_summaries(self):
        ws = self.build({n: "ok" for n in self.names})
        agents = {a["id"]: a for a in ws["agents"]}
        self.assertFalse(agents["static_analysis"]["llm"])
        self.assertIsNone(agents["static_analysis"]["model"])
        self.assertTrue(agents["code_correction"]["usesTools"])
        self.assertEqual(agents["code_correction"]["budgetMs"], ad.AGENT_TOOL_BUDGET_MS)
        self.assertEqual(agents["code_understanding"]["budgetMs"], ad.AGENT_BUDGET_MS)
        run = ws["runs"][0]
        self.assertEqual((run["outcome"], run["agentsOk"], run["agentsTotal"], run["lines"]),
                         ("succeeded", 6, 6, 9))

    def test_outcomes(self):
        run = make_run({n: "failed" for n in self.names})
        self.assertEqual(ad.run_outcome(run), "failed")
        run = make_run({**{n: "ok" for n in self.names}, "test_generator": "failed"})
        self.assertEqual(ad.run_outcome(run), "partial")

    def test_no_runs(self):
        ws = ad.build_workspace([], self.names, "m", 5000)
        self.assertEqual((ws["runs"], ws["current"], ws["events"]), ([], None, []))


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
        self.barrier = None

        def run_agent(agent, file_path, env=None):
            if self.gate:
                self.gate.wait(5)
            if self.barrier and agent["name"] != "static_analysis":
                self.barrier.wait(5)  # breaks (and the agent fails) unless all 5 run at once
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
        self.assertTrue(all(a["status"] == "ok" and not a["approved"]
                            for a in ws["current"]["agents"].values()))
        self.assertEqual(self.call("POST", "/api/agents/static_analysis/approve", {})[0], 200)
        self.assertEqual(self.call("POST", "/api/agents/static_analysis/approve", {})[0], 200)  # idempotent
        ws = self.call("GET", "/api/workspace")[1]
        self.assertTrue(ws["current"]["agents"]["static_analysis"]["approved"])
        self.assertEqual(sum(1 for e in ws["events"] if e["type"] == "human"), 1)
        self.assertEqual(self.call("POST", "/api/agents/nope/approve", {})[0], 422)
        self.assertEqual(self.call("POST", "/api/agents/static_analysis/frobnicate", {})[0], 404)

    def test_failed_agent_cannot_be_approved_and_a_rerun_recovers(self):
        self.fail_agents = {"test_generator"}
        self.call("POST", "/api/runs", {"file": "src/a.py"})
        self.wait_idle()
        ws = self.call("GET", "/api/workspace")[1]
        failed = ws["current"]["agents"]["test_generator"]
        self.assertEqual((failed["status"], failed["problem"]), ("failed", "API call failed"))
        self.assertEqual(ws["runs"][0]["outcome"], "partial")
        self.assertEqual(self.call("POST", "/api/agents/test_generator/approve", {})[0], 422)
        self.fail_agents = set()
        self.assertEqual(self.call("POST", "/api/agents/test_generator/rerun", {})[0], 200)
        self.wait_idle()
        ws = self.call("GET", "/api/workspace")[1]
        again = ws["current"]["agents"]["test_generator"]
        self.assertEqual((again["status"], again["attempts"]), ("ok", 2))
        self.assertEqual(ws["runs"][0]["outcome"], "succeeded")
        retry = [e for e in ws["events"] if e["type"] == "retry"]
        self.assertEqual([(e["recovered"], e["status"]) for e in retry], [(True, "success")])

    def test_llm_agents_run_in_parallel_after_static_analysis(self):
        self.gate = threading.Event()
        self.barrier = threading.Barrier(5)
        self.call("POST", "/api/runs", {"file": "src/a.py"})
        time.sleep(0.2)
        statuses = {n: a["status"] for n, a in self.call("GET", "/api/workspace")[1]["current"]["agents"].items()}
        self.assertEqual(statuses["static_analysis"], "running")  # first, and alone
        self.assertEqual(list(statuses.values()).count("running"), 1)
        self.gate.set()
        self.wait_idle()
        ws = self.call("GET", "/api/workspace")[1]
        self.assertEqual(ws["runs"][0]["outcome"], "succeeded")  # the barrier of 5 was reached

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
        self.assertTrue(all(a["status"] == "failed" for a in ws["current"]["agents"].values()))
        self.assertIn("stopped", ws["current"]["agents"]["static_analysis"]["problem"])
        self.gate.set()
        self.wait_idle()

    def test_the_token_is_never_served(self):
        _, body = self.call("GET", "/api/workspace")
        self.assertNotIn("secret-token", json.dumps(body))


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
        allowed = {"PATH", "LANG", "LC_ALL", "HF_API_TOKEN", "HF_MODEL", "PYTHONIOENCODING",
                   "PYTHONDONTWRITEBYTECODE", "HOME", "CODE_REVIEW_ALLOW_EXEC", server.LINT_ENV,
                   *server.AGENT_ENV_KEYS}
        for seen in self.seen_env:
            self.assertLessEqual(set(seen), allowed)
            self.assertNotIn("server-secret", json.dumps(seen))
            # Visitors' code is never executed by the generated tests unless the operator opts in.
            self.assertEqual(seen["CODE_REVIEW_ALLOW_EXEC"], "0")
        ws = self.call("GET", "/api/workspace", session=self.S1)[1]
        self.assertEqual(ws["runs"][0]["outcome"], "succeeded")
        self.assertEqual(ws["runs"][0]["model"], "org/some-model:fast")
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
        self.assertEqual([r["file"] for r in r1], ["one.py"])

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
        code, res = self.call("POST", "/api/agents/code_understanding/rerun", {}, session=self.S1)
        self.assertEqual(code, 422)
        self.assertIn("key", res["error"])
        code, _ = self.call("POST", "/api/agents/code_understanding/rerun", {}, {"X-HF-Token": self.TOKEN}, self.S1)
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
