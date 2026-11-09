"""Tests for the agents, the tools, structured output, the function-calling loop and the
parallel pipeline. Run: python -m unittest discover tests

No API key or network is needed: the model is replaced by a scripted fake (in-process, or the
OpenAI-compatible server in eval/fake_llm_server.py for the end-to-end test). The linters must
be installed (pip install -r requirements.txt); those tests are skipped otherwise.
"""

import copy
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "eval"))

# pylint: disable=wrong-import-position
import orchestrator  # noqa: E402
from agents import code_correction_agent as correction  # noqa: E402
from agents import code_understanding, common, hf_client, schema, tools  # noqa: E402
from agents import improvement_suggestion, test_generator  # noqa: E402

HAVE_LINTERS = all(importlib.util.find_spec(m) for m in ("pylint", "flake8", "bandit", "radon"))
SAMPLE = (ROOT / "src" / "sample.py").read_text(encoding="utf-8")


# ---------------------------------------------------------------- fake model

class BadRequest(Exception):
    """Looks like openai.BadRequestError to hf_client."""
    status_code = 400


def message(content=None, calls=None, finish="stop"):
    tool_calls = None
    if calls:
        tool_calls = [SimpleNamespace(id=f"c{i}", type="function",
                                      function=SimpleNamespace(name=n, arguments=json.dumps(a)))
                      for i, (n, a) in enumerate(calls)]
        finish = "tool_calls"
    return SimpleNamespace(
        choices=[SimpleNamespace(finish_reason=finish,
                                 message=SimpleNamespace(content=content, tool_calls=tool_calls))],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5))


class FakeClient:
    """``script(kwargs, n)`` returns a response (or raises) for the n-th request."""

    def __init__(self, script):
        self.requests = []
        self.script = script
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **kwargs):
        kwargs = copy.deepcopy(kwargs)  # the caller keeps appending to the same message list
        self.requests.append(kwargs)
        return self.script(kwargs, len(self.requests))


class FakeModelTest(unittest.TestCase):
    def use(self, script):
        fake = FakeClient(script)
        hf_client.set_client(fake)
        self.addCleanup(hf_client.set_client, None)
        patcher = mock.patch.object(hf_client, "_structured_mode", "json_schema")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(setattr, hf_client, "_effort_supported", True)
        return fake


# ---------------------------------------------------------------- schema helpers

class SchemaTests(unittest.TestCase):
    def test_validate(self):
        s = code_understanding.SCHEMA
        self.assertEqual(schema.validate({"explanation": "x", "complex_sections": []}, s), [])
        self.assertTrue(schema.validate({"explanation": "", "complex_sections": []}, s))
        self.assertTrue(schema.validate({"explanation": "x"}, s))
        self.assertTrue(schema.validate({"explanation": "x", "complex_sections": [{"line": "3"}]}, s))
        self.assertTrue(schema.validate({"explanation": "x", "complex_sections": [], "extra": 1}, s))
        self.assertTrue(schema.validate(True, {"type": "integer"}))  # bool is not an int
        self.assertEqual(schema.validate(None, {"type": ["integer", "null"]}), [])

    def test_extract_json(self):
        self.assertEqual(schema.extract_json('{"a": 1}'), {"a": 1})
        self.assertEqual(schema.extract_json('Sure:\n```json\n{"a": 2}\n```'), {"a": 2})
        self.assertEqual(schema.extract_json('text {"a": 3} text'), {"a": 3})
        with self.assertRaises(ValueError):
            schema.extract_json("no json here")


# ---------------------------------------------------------------- tools

@unittest.skipUnless(HAVE_LINTERS, "linters not installed")
class ToolTests(unittest.TestCase):
    def test_linters_on_code_strings(self):
        self.assertGreater(tools.run_pylint(SAMPLE)["count"], 0)
        self.assertEqual(tools.run_bandit(SAMPLE)["findings"][0]["code"], "B105")
        self.assertEqual(tools.run_flake8("x = 1\n")["count"], 0)
        radon = tools.run_radon(SAMPLE)
        self.assertTrue(any("complex_function" in f["message"] for f in radon["findings"]))
        self.assertEqual(tools.run_pylint("def x(:\n")["status"], "syntax_error")

    def test_static_agent_scans_only_its_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "a.py").write_text("x = 1\n")
            Path(tmp, "other.py").write_text("password = 'hunter2'\n")
            findings, statuses = tools.sa.analyze(str(Path(tmp, "a.py")))
        self.assertEqual(set(statuses.values()), {"ok"})
        self.assertFalse([f for f in findings if f["type"] == "bandit"])

    def test_run_tests_counts_and_has_no_secrets(self):
        code = "import os\nTOKEN = os.getenv('HF_API_TOKEN')\n\ndef add(a, b):\n    return a + b\n"
        tests_ok = "from m import add, TOKEN\n\ndef test_add():\n    assert add(1, 2) == 3\n\n" \
                   "def test_no_secret():\n    assert TOKEN is None\n"
        with mock.patch.dict(os.environ, {"HF_API_TOKEN": "secret"}):
            res = tools.run_tests(code, tests_ok, "m")
        self.assertTrue(res["passed"], res.get("output"))
        self.assertEqual((res["tests"], res["failures"]), (2, 0))
        res = tools.run_tests(code, "from m import add\n\ndef test_bad():\n    assert add(1, 1) == 3\n", "m")
        self.assertFalse(res["passed"])
        self.assertEqual(res["failures"], 1)
        self.assertEqual(tools.run_tests(code, "def broken(:\n", "m")["status"], "syntax_error")

    def test_run_tests_can_be_disabled_and_times_out(self):
        with mock.patch.dict(os.environ, {"CODE_REVIEW_ALLOW_EXEC": "0"}):
            self.assertEqual(tools.run_tests("x = 1\n", "def test_x():\n    pass\n")["status"], "disabled")
        with mock.patch.object(tools, "TEST_TIMEOUT", 2):
            res = tools.run_tests("import time\n", "import time\n\ndef test_slow():\n    time.sleep(10)\n")
        self.assertEqual(res["status"], "timeout")

    def test_run_tests_inside_a_package_keeps_relative_imports(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = Path(tmp, "src", "mypkg")
            (pkg / "sub").mkdir(parents=True)
            (pkg / "__init__.py").write_text("")
            (pkg / "sub" / "__init__.py").write_text("")
            (pkg / "helpers.py").write_text("def double(x):\n    return 2 * x\n")
            target = pkg / "sub" / "calc.py"
            target.write_text("from ..helpers import double\n\ndef quad(x):\n    return double(double(x))\n")
            ctx = tools.package_context(str(target))
            self.assertEqual(ctx["module"], "mypkg.sub.calc")
            self.assertEqual(tools.import_name(str(target), ctx), "mypkg.sub.calc")
            tests = "from mypkg.sub.calc import quad\n\ndef test_quad():\n    assert quad(3) == 12\n"
            res = tools.run_tests(target.read_text(), tests, ctx["module"], ctx)
            self.assertTrue(res["passed"], res.get("output"))
            # A candidate replaces the file inside the copied package; the original is untouched.
            res = tools.run_tests("from ..helpers import double\n\ndef quad(x):\n    return x\n", tests,
                                  ctx["module"], ctx)
            self.assertEqual(res["failures"], 1)
            self.assertIn("double(double(x))", target.read_text())
            self.assertIsNone(tools.package_context(str(Path(tmp, "src", "loose.py"))))

    def test_helpers(self):
        self.assertEqual(tools.module_name("src/my-file.py"), "my_file")
        self.assertEqual(tools.module_name("3d.py"), "m_3d")
        self.assertEqual(tools.public_api(SAMPLE), ["calculate_factorial", "complex_function", "process_data"])


# ---------------------------------------------------------------- structured output

class StructuredOutputTests(FakeModelTest):
    GOOD = {"explanation": "Adds.", "complex_sections": [{"line": 99, "end_line": 1, "reason": "r"}]}

    def test_json_schema_is_requested_and_line_numbers_are_clamped(self):
        fake = self.use(lambda kw, n: message(json.dumps(self.GOOD)))
        with mock.patch.object(common, "load_lint", return_value=([], "computed")):
            out = code_understanding.explain_code("a = 1\nb = 2\n", "a.py")
        fmt = fake.requests[0]["response_format"]
        self.assertEqual(fmt["type"], "json_schema")
        self.assertTrue(fmt["json_schema"]["strict"])
        self.assertEqual(out["complex_sections"], [{"line": 2, "end_line": 2, "reason": "r"}])
        self.assertNotIn("minLength", json.dumps(fmt["json_schema"]["schema"]))  # strict-mode safe

    def test_falls_back_when_json_schema_is_refused_then_repairs_invalid_json(self):
        def script(kw, n):
            fmt = kw.get("response_format", {}).get("type")
            if fmt == "json_schema":
                raise BadRequest("response_format json_schema not supported")
            if n <= 3:  # first answers: not valid for the schema
                return message('{"explanation": ""}')
            return message(json.dumps(self.GOOD))
        fake = self.use(script)
        out = hf_client.generate_json("p", code_understanding.SCHEMA, "x")
        self.assertEqual(out["explanation"], "Adds.")
        self.assertEqual(hf_client._structured_mode, "json_object")  # pylint: disable=protected-access
        self.assertIn("does not match the schema", fake.requests[-1]["messages"][-1]["content"])

    def test_gives_up_with_an_error_after_one_repair(self):
        self.use(lambda kw, n: message("not json"))
        with self.assertRaises(hf_client.LLMError):
            hf_client.generate_json("p", code_understanding.SCHEMA, "x")

    def test_reasoning_effort_kept_when_the_400_is_about_something_else(self):
        def script(kw, n):
            raise BadRequest("bad request")
        self.use(script)
        with self.assertRaises(hf_client.LLMError):
            hf_client.generate_json("p", code_understanding.SCHEMA, "x")
        self.assertTrue(hf_client._effort_supported)  # pylint: disable=protected-access

    def test_improvements_keep_only_real_finding_codes(self):
        reply = {"improvements": [{"line": None, "category": "security", "severity": "high",
                                   "description": "Move secrets out.", "related_findings": ["B105", "X999"]}]}
        fake = self.use(lambda kw, n: message(json.dumps(reply)))
        lint = [{"type": "bandit", "line": 18, "code": "B105", "severity": "low", "message": "pw"}]
        with mock.patch.object(improvement_suggestion, "load_lint", return_value=(lint, "static_analysis")):
            out = improvement_suggestion.suggest_improvements(SAMPLE, "sample.py")
        self.assertEqual(out["improvements"][0]["related_findings"], ["B105"])
        self.assertIn("B105", fake.requests[0]["messages"][-1]["content"])  # findings are in the prompt


# ---------------------------------------------------------------- function calling

class ToolLoopTests(FakeModelTest):
    SUBMIT = {"type": "object", "properties": {"answer": {"type": "string"}},
              "required": ["answer"], "additionalProperties": False}

    def tool(self, calls):
        return tools.Tool("echo", "Echo.", {"type": "object", "properties": {"x": {"type": "string"}},
                                            "required": ["x"], "additionalProperties": False},
                          lambda x: calls.append(x) or {"status": "ok", "echo": x})

    def test_calls_tools_then_submits(self):
        seen = []

        def script(kw, n):
            if n == 1:
                return message(calls=[("echo", {"x": "hi"}), ("nope", {})])
            tool_msgs = [m for m in kw["messages"] if m["role"] == "tool"]
            self.assertEqual(json.loads(tool_msgs[0]["content"])["echo"], "hi")
            self.assertIn("unknown tool", tool_msgs[1]["content"])
            return message(calls=[("submit", {"answer": "done"})])
        fake = self.use(script)
        out, trace = hf_client.run_tool_loop("s", "u", [self.tool(seen)], "submit", "d", self.SUBMIT)
        self.assertEqual(out, {"answer": "done"})
        self.assertEqual(seen, ["hi"])
        self.assertEqual([t["tool"] for t in trace], ["echo", "nope", "submit"])
        self.assertEqual({t["function"]["name"] for t in fake.requests[0]["tools"]}, {"echo", "submit"})

    def test_refused_submission_is_explained_and_last_step_forces_submit(self):
        def script(kw, n):
            if n == 1:
                return message(calls=[("submit", {"answer": "bad"})])
            if n == 2:
                return message(content="thinking...")
            return message(calls=[("submit", {"answer": "good"})])
        fake = self.use(script)
        out, _ = hf_client.run_tool_loop(
            "s", "u", [], "submit", "d", self.SUBMIT, max_steps=3,
            on_submit=lambda a: [] if a["answer"] == "good" else ["not good"])
        self.assertEqual(out["answer"], "good")
        self.assertIn("not good", fake.requests[1]["messages"][-1]["content"])
        self.assertEqual(fake.requests[2]["tool_choice"], {"type": "function", "function": {"name": "submit"}})

    def test_tools_unsupported(self):
        def script(kw, n):
            if "tools" in kw:
                raise BadRequest("tools not supported")
            return message("{}")
        self.use(script)
        with self.assertRaises(hf_client.ToolsUnsupported):
            hf_client.run_tool_loop("s", "u", [], "submit", "d", self.SUBMIT)


def extract_code(messages):
    text = messages[-1]["content"] if messages[-1]["role"] == "user" else messages[1]["content"]
    return text.split("Original code:\n```python\n", 1)[1].rsplit("\n```", 1)[0]


@unittest.skipUnless(HAVE_LINTERS, "linters not installed")
class CorrectionAgentTests(FakeModelTest):
    FIXED = SAMPLE.replace('password = "admin123"\n', "").replace(
        "def calculate_factorial", '"""Sample module."""\n\n\ndef calculate_factorial', 1)

    def test_loop_uses_linters_refuses_regressions_and_reports_real_numbers(self):
        broken = "def calculate_factorial(:\n"
        dropped = SAMPLE.replace("def process_data", "def renamed")

        def script(kw, n):
            if n == 1:
                return message(calls=[("run_bandit", {"code": self.FIXED})])
            if n == 2:
                tool_msg = json.loads(kw["messages"][-1]["content"])
                self.assertEqual(tool_msg["count"], 0)  # bandit really ran on the candidate
                return message(calls=[("submit_correction", {"corrected_code": broken, "changes": [],
                                                             "remaining_issues": []})])
            if n == 3:
                self.assertIn("does not compile", kw["messages"][-1]["content"])
                return message(calls=[("submit_correction", {"corrected_code": dropped, "changes": [],
                                                             "remaining_issues": []})])
            self.assertIn("process_data", kw["messages"][-1]["content"])
            return message(calls=[("submit_correction", {
                "corrected_code": "```python\n" + self.FIXED + "\n```",
                "changes": [{"line": 18, "description": "Removed the password."}],
                "remaining_issues": []})])
        fake = self.use(script)
        lint = tools.lint(SAMPLE, name="sample.py")[0]
        with mock.patch.object(correction, "load_lint", return_value=(lint, "static_analysis")):
            out = correction.correct_code(SAMPLE, "src/sample.py")
        v = out["verification"]
        self.assertTrue(v["accepted"], v)
        self.assertLess(v["total_after"], v["total_before"])
        self.assertEqual(v["findings_after"]["bandit"], 0)
        self.assertEqual(out["corrected_code"], self.FIXED)
        self.assertEqual(out["mode"], "tool_loop")
        names = {t["function"]["name"] for t in fake.requests[0]["tools"]}
        self.assertLessEqual({"run_pylint", "run_flake8", "run_bandit", "run_radon", "run_tests",
                              "check_syntax", "submit_correction"}, names)
        self.assertIn("B105", fake.requests[0]["messages"][1]["content"])  # linter context

    def test_without_function_calling_falls_back_to_one_structured_answer(self):
        def script(kw, n):
            if "tools" in kw:
                raise BadRequest("tools not supported")
            return message(json.dumps({"corrected_code": "def calculate_factorial(:", "changes": [],
                                       "remaining_issues": []}))
        self.use(script)
        with mock.patch.object(correction, "load_lint", return_value=([], "computed")):
            out = correction.correct_code(SAMPLE, "sample.py")
        self.assertTrue(out["mode"].startswith("single_call"))
        self.assertTrue(out["error"])  # the result does not compile: never handed out
        self.assertEqual(out["corrected_code"], "")
        self.assertIsNone(orchestrator.save_corrected_code(dict(out, file="x.py")))


@unittest.skipUnless(HAVE_LINTERS, "linters not installed")
class TestGeneratorTests(FakeModelTest):
    def test_runs_tests_and_reports_pytest_numbers(self):
        good = "from sample import calculate_factorial\n\ndef test_f():\n    assert calculate_factorial(4) == 24\n"

        def script(kw, n):
            if n == 1:
                return message(calls=[("run_tests", {"tests": "from sample import nope\n\ndef test_x():\n    pass\n"})])
            if n == 2:
                self.assertIn("ImportError", kw["messages"][-1]["content"])
                return message(calls=[("run_tests", {"tests": good})])
            return message(calls=[("submit_tests", {"tests": good, "framework": "pytest", "notes": ""})])
        self.use(script)
        with mock.patch.object(test_generator, "load_lint", return_value=([], "computed")):
            out = test_generator.generate_tests(SAMPLE, "src/sample.py")
        self.assertEqual(out["module"], "sample")
        self.assertTrue(out["verification"]["passed"])
        self.assertEqual(out["verification"]["tests"], 1)
        self.assertEqual([t["tool"] for t in out["tool_calls"]], ["run_tests", "run_tests", "submit_tests"])

    def test_without_execution_only_syntax_is_checked(self):
        fake = self.use(lambda kw, n: message(calls=[("submit_tests", {
            "tests": "def test_x():\n    assert True\n", "framework": "pytest", "notes": ""})]))
        with mock.patch.dict(os.environ, {"CODE_REVIEW_ALLOW_EXEC": "0"}), \
                mock.patch.object(test_generator, "load_lint", return_value=([], "computed")):
            out = test_generator.generate_tests("x = 1\n", "x.py")
        self.assertFalse(out["verification"]["ran"])
        self.assertNotIn("run_tests", {t["function"]["name"] for t in fake.requests[0]["tools"]})


# ---------------------------------------------------------------- linter context + parallel pipeline

class PipelineTests(unittest.TestCase):
    def test_static_first_then_llm_agents_in_parallel_with_the_findings(self):
        seen = {}
        lock = threading.Lock()

        def runner(agent, path, env=None):
            if agent["name"] == "static_analysis":
                return {"agent": "static_analysis", "findings": [{"type": "bandit", "code": "B105"}]}
            lint_file = (env or {}).get(orchestrator.LINT_ENV)
            with open(lint_file, encoding="utf-8") as f:
                data = json.load(f)
            with lock:
                seen[agent["name"]] = (data["findings"], time.monotonic())
            time.sleep(0.4)
            return {"agent": agent["name"], "ok": True}

        started = time.monotonic()
        results = orchestrator.run_pipeline("x.py", env={"PATH": "/bin"}, runner=runner)
        elapsed = time.monotonic() - started
        self.assertEqual([r["agent"] for r in results], [a["name"] for a in orchestrator.AGENTS])
        self.assertEqual(len(seen), 6)  # the planner and the five agents it lets through
        self.assertTrue(all(f == [{"type": "bandit", "code": "B105"}] for f, _ in seen.values()))
        self.assertLess(elapsed, 1.5)  # 5 x 0.4 s would be 2 s one after another

    def test_failed_static_analysis_means_agents_lint_themselves(self):
        envs = []

        def runner(agent, path, env=None):
            envs.append(env)
            return {"error": True} if agent["name"] == "static_analysis" else {}
        orchestrator.run_pipeline("x.py", runner=runner)
        self.assertTrue(all(e is None for e in envs))

    def test_agents_read_the_findings_file(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"findings": [{"type": "pylint", "code": "C0114"}]}, f)
        self.addCleanup(os.remove, f.name)
        with mock.patch.dict(os.environ, {common.LINT_ENV: f.name}):
            self.assertEqual(common.load_lint("x = 1\n", "x.py"),
                             ([{"type": "pylint", "code": "C0114"}], "static_analysis"))


@unittest.skipUnless(HAVE_LINTERS and importlib.util.find_spec("openai"), "linters/openai missing")
class EndToEndTests(unittest.TestCase):
    """Real agent processes and linters; the model is eval/fake_llm_server.py."""

    def test_full_pipeline_with_fake_model(self):
        import fake_llm_server  # pylint: disable=import-outside-toplevel
        httpd = fake_llm_server.start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "requests.jsonl")
            target = os.path.join(tmp, "sample.py")
            Path(target).write_text(SAMPLE, encoding="utf-8")
            env = dict(os.environ, HF_BASE_URL=f"http://127.0.0.1:{httpd.server_address[1]}/v1",
                       HF_API_TOKEN="fake", STATIC_ANALYSIS_REDIS="0")
            with mock.patch.dict(os.environ, {"FAKE_LLM_LOG": log}):  # read by the fake server
                results = {r["agent"]: r for r in orchestrator.run_pipeline(target, env=env)}
            requests = [json.loads(line) for line in Path(log).read_text().splitlines()]
        for name, r in results.items():
            self.assertFalse(r.get("error"), (name, r))
        self.assertEqual(results["code_correction"]["mode"], "tool_loop")
        self.assertTrue(results["code_correction"]["verification"]["accepted"])
        self.assertTrue(results["test_generator"]["verification"]["passed"])
        self.assertEqual(results["code_understanding"]["lint_source"], "static_analysis")
        self.assertTrue(all("Findings from pylint" in json.dumps(r["messages"]) for r in requests))


if __name__ == "__main__":
    unittest.main()
