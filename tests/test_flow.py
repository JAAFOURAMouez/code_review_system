"""Tests for how the agents hand results to each other: dependency scheduling, the shared file,
per-test outcomes, and the correction agent checking its fix against the generated tests.
No API key, no network; they do not need the linters."""

import importlib.util
import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

# pylint: disable=wrong-import-position
import orchestrator  # noqa: E402
from agents import code_correction_agent as correction  # noqa: E402
from agents import flow, tools  # noqa: E402
from test_agents import FakeModelTest, message  # noqa: E402  (the scripted fake model)

HAVE_PYTEST = importlib.util.find_spec("pytest") is not None

BUGGY = "def add(a, b):\n    if a < 0:\n        return 0\n    return a + b\n"
FIXED = "def add(a, b):\n    return a + b\n"
BROKEN = "def add(a, b):\n    return a - b\n"
TESTS = ("from m import add\n\n\ndef test_ok():\n    assert add(1, 2) == 3\n\n\n"
         "def test_neg():\n    assert add(-1, 2) == 1\n")


def generator_result(code: str = BUGGY, tests: str = TESTS) -> dict:
    """What the test generator returns for ``code``, with real pytest numbers."""
    base = tools.run_tests(code, tests, "m", with_cases=True)
    keys = ("runner", "passed", "tests", "failures", "errors", "skipped", "output", "cases")
    return {"agent": "test_generator", "tests": tests, "module": "m", "framework": "pytest",
            "notes": "test_neg fails on purpose: it exposes a bug.",
            "verification": {"ran": True, "syntax_valid": True, **{k: base[k] for k in keys}}}


class ScheduleTests(unittest.TestCase):
    AGENTS = [{"name": "a"}, {"name": "b", "depends_on": ["a"]}, {"name": "c"}]

    def test_waits_for_dependencies_and_runs_the_others_in_parallel(self):
        events, lock = [], threading.Lock()

        def run_one(i):
            name = self.AGENTS[i]["name"]
            with lock:
                events.append(("start", name))
            time.sleep(0.3)
            with lock:
                events.append(("end", name))

        started = time.monotonic()
        flow.schedule(self.AGENTS, [0, 1, 2], run_one, 5)
        elapsed = time.monotonic() - started
        self.assertGreater(events.index(("start", "b")), events.index(("end", "a")))
        self.assertLess(events.index(("start", "c")), events.index(("end", "a")))
        self.assertLess(elapsed, 0.9)  # a then b is 0.6 s; all three one by one would be 0.9 s

    def test_respects_the_parallel_limit(self):
        running, peak, lock = 0, 0, threading.Lock()

        def run_one(_):
            nonlocal running, peak
            with lock:
                running += 1
                peak = max(peak, running)
            time.sleep(0.05)
            with lock:
                running -= 1

        flow.schedule([{"name": str(i)} for i in range(6)], range(6), run_one, 2)
        self.assertEqual(peak, 2)

    def test_a_dependency_outside_the_run_is_ignored(self):
        ran = []
        flow.schedule(self.AGENTS, [1], ran.append, 5)  # re-running b alone
        self.assertEqual(ran, [1])

    def test_circular_dependencies_fail_before_anything_runs(self):
        agents = [{"name": "a", "depends_on": ["b"]}, {"name": "b", "depends_on": ["a"]}]
        ran = []
        with self.assertRaisesRegex(ValueError, "circular"):
            flow.schedule(agents, [0, 1], ran.append, 5)
        self.assertEqual(ran, [])

    def test_a_crashing_agent_is_raised_and_its_dependents_do_not_start(self):
        ran = []

        def run_one(i):
            ran.append(i)
            raise RuntimeError("boom")

        with self.assertRaisesRegex(RuntimeError, "boom"):
            flow.schedule(self.AGENTS, [0, 1], run_one, 5)
        self.assertNotIn(1, ran)


class SharedFileTests(unittest.TestCase):
    def test_shares_the_tests_and_how_they_fare(self):
        gen = {"tests": "def test_x():\n    pass\n", "module": "m", "framework": "pytest",
               "notes": "n", "verification": {"ran": True, "syntax_valid": True, "passed": True,
                                              "tests": 1, "cases": {"test_m::test_x": "passed"},
                                              "output": "1 passed", "runner": "pytest"}}
        tests = flow.build_shared({"test_generator": gen})["tests"]
        self.assertEqual(tests["code"], gen["tests"])
        self.assertEqual(tests["module"], "m")
        self.assertEqual(tests["baseline"]["cases"], {"test_m::test_x": "passed"})
        self.assertNotIn("runner", tests["baseline"])

    def test_nothing_is_shared_when_there_is_nothing_usable(self):
        good = {"tests": "x", "verification": {"syntax_valid": True}}
        self.assertEqual(flow.build_shared({}), {})
        self.assertEqual(flow.build_shared({"test_generator": dict(good, error=True)}), {})
        self.assertEqual(flow.build_shared({"test_generator": dict(good, tests="")}), {})
        self.assertEqual(flow.build_shared(
            {"test_generator": {"tests": "x", "verification": {"syntax_valid": False}}}), {})
        self.assertIsNone(flow.write_shared_file({"test_generator": {"error": True}}))

    def test_file_round_trip(self):
        path = flow.write_shared_file({"test_generator": generator_result()}) if HAVE_PYTEST else None
        if path is None:
            path = flow.write_shared_file({"test_generator": {
                "tests": "x", "module": "m", "verification": {"syntax_valid": True}}})
        self.addCleanup(os.remove, path)
        with mock.patch.dict(os.environ, {flow.SHARED_ENV: path}):
            self.assertEqual(flow.load_shared()["tests"]["module"], "m")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(flow.load_shared(), {})

    def test_environment(self):
        env = {"PATH": "/bin"}
        self.assertIs(flow.env_with_shared(env, None), env)
        self.assertIsNone(flow.env_with_shared(None, None))
        self.assertEqual(flow.env_with_shared(env, "/tmp/x.json"),
                         {"PATH": "/bin", flow.SHARED_ENV: "/tmp/x.json"})
        self.assertEqual(env, {"PATH": "/bin"})  # the caller's environment is not modified
        self.assertEqual(flow.env_with_shared(None, "/tmp/x.json")[flow.SHARED_ENV], "/tmp/x.json")


class PipelineHandoverTests(unittest.TestCase):
    TESTS_CODE = "def test_x():\n    pass\n"
    GENERATED = {"agent": "test_generator", "tests": TESTS_CODE, "module": "x",
                 "verification": {"ran": True, "syntax_valid": True}}

    def test_correction_starts_after_the_generator_and_receives_its_tests(self):
        log, shared_paths = [], []

        def runner(agent, path, env=None):
            name = agent["name"]
            if name == "static_analysis":
                return {"findings": []}
            if name == "test_generator":
                time.sleep(0.3)
                log.append("generator finished")
                return self.GENERATED
            if name == "code_correction":
                shared_paths.append(env[flow.SHARED_ENV])
                with open(env[flow.SHARED_ENV], encoding="utf-8") as f:
                    got = json.load(f)
                log.append(("correction got", got["tests"]["code"], "generator finished" in log))
            return {"ok": True}

        orchestrator.run_pipeline("x.py", runner=runner)
        self.assertIn(("correction got", self.TESTS_CODE, True), log)
        self.assertFalse(os.path.exists(shared_paths[0]))  # cleaned up afterwards

    def test_nothing_is_handed_over_when_the_generator_fails(self):
        seen = {}

        def runner(agent, path, env=None):
            seen[agent["name"]] = (env or {}).get(flow.SHARED_ENV)
            return {"error": True} if agent["name"] == "test_generator" else {"ok": True}

        orchestrator.run_pipeline("x.py", runner=runner)
        self.assertIsNone(seen["code_correction"])

    def test_only_agents_with_dependencies_get_the_shared_file(self):
        seen = {}

        def runner(agent, path, env=None):
            seen[agent["name"]] = (env or {}).get(flow.SHARED_ENV)
            return self.GENERATED if agent["name"] == "test_generator" else {"ok": True}

        orchestrator.run_pipeline("x.py", runner=runner)
        for name, value in seen.items():
            if name != "code_correction":
                self.assertIsNone(value, name)
        self.assertIsNotNone(seen["code_correction"])

    def test_the_correction_agent_declares_its_dependency(self):
        by_name = {a["name"]: a for a in orchestrator.AGENTS}
        self.assertEqual(flow.dependencies(by_name["code_correction"]), ["test_generator"])
        self.assertEqual(flow.dependencies(by_name["documentation_agent"]), [])


@unittest.skipUnless(HAVE_PYTEST, "pytest not installed")
class TestOutcomeTests(unittest.TestCase):
    def run_tests(self, code):
        return tools.run_tests(code, TESTS, "m", with_cases=True)

    def test_outcome_of_each_test(self):
        res = self.run_tests(BUGGY)
        self.assertEqual({k.split("::")[-1]: v for k, v in res["cases"].items()},
                         {"test_ok": "passed", "test_neg": "failed"})
        self.assertNotIn("cases", tools.run_tests(BUGGY, TESTS, "m"))  # opt in: the model's tool stays small

    def test_compare_a_fix_and_a_regression(self):
        before = self.run_tests(BUGGY)
        fixed = tools.compare_runs(before, self.run_tests(FIXED))
        self.assertEqual([t.split("::")[-1] for t in fixed["fixed"]], ["test_neg"])
        self.assertEqual((fixed["regressions"], fixed["still_failing"]), ([], []))
        broken = tools.compare_runs(before, self.run_tests(BROKEN))
        self.assertEqual([t.split("::")[-1] for t in broken["regressions"]], ["test_ok"])
        self.assertEqual([t.split("::")[-1] for t in broken["still_failing"]], ["test_neg"])

    def test_without_per_test_outcomes_only_all_passed_to_not_passed_is_told(self):
        self.assertEqual(tools.compare_runs({"passed": True}, {"passed": False})["regressions"],
                         ["(all tests)"])
        self.assertEqual(tools.compare_runs({"passed": False}, {"passed": False})["regressions"], [])
        self.assertEqual(tools.compare_runs({"passed": True}, {"passed": True})["regressions"], [])


@unittest.skipUnless(HAVE_PYTEST, "pytest not installed")
class CorrectionOracleTests(unittest.TestCase):
    def oracle(self, gen=None, code=BUGGY, module="m", env=None):
        gen = gen or generator_result()
        path = flow.write_shared_file({"test_generator": gen})
        self.addCleanup(os.remove, path)
        with mock.patch.dict(os.environ, {flow.SHARED_ENV: path, **(env or {})}):
            return correction.make_oracle(code, module, None)

    def test_a_fix_is_accepted_and_a_regression_refused(self):
        oracle, reason = self.oracle()
        self.assertEqual(reason, "")
        before = tools.counts(tools.lint(BUGGY, name="m.py")[0])
        good = correction.assess(BUGGY, FIXED, before, "m.py", oracle)
        self.assertTrue(good["accepted"], good)
        self.assertEqual([t.split("::")[-1] for t in good["tests"]["fixed"]], ["test_neg"])
        self.assertEqual(good["tests"]["regressions"], [])
        bad = correction.assess(BUGGY, BROKEN, before, "m.py", oracle)
        self.assertFalse(bad["accepted"])
        self.assertTrue(any("breaks tests that passed" in p and "test_ok" in p
                            for p in bad["problems"]), bad["problems"])

    def test_without_an_oracle_the_other_checks_are_unchanged(self):
        before = tools.counts(tools.lint(BUGGY, name="m.py")[0])
        report = correction.assess(BUGGY, FIXED, before, "m.py")
        self.assertNotIn("tests", report)
        self.assertTrue(report["accepted"], report)

    def test_each_candidate_is_tested_once(self):
        oracle, _ = self.oracle()
        with mock.patch.object(tools, "run_tests", wraps=tools.run_tests) as spy:
            correction.run_oracle(oracle, FIXED)
            correction.run_oracle(oracle, FIXED)
        self.assertEqual(spy.call_count, 1)

    def test_baseline_is_recomputed_when_the_generator_did_not_record_it(self):
        gen = generator_result()
        gen["verification"] = {"ran": False, "syntax_valid": True}
        oracle, reason = self.oracle(gen)
        self.assertEqual(reason, "")
        self.assertEqual(sorted(oracle["baseline"]["cases"].values()), ["failed", "passed"])

    def test_reasons_for_not_using_the_tests(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(correction.make_oracle(BUGGY, "m", None),
                             (None, "no tests from the test generator"))
        self.assertEqual(self.oracle(env={"CODE_REVIEW_ALLOW_EXEC": "0"}),
                         (None, "code execution is disabled"))
        self.assertEqual(self.oracle(module="other"),
                         (None, "the tests target another module name"))
        all_failing = generator_result(BROKEN, "from m import add\n\n\ndef test_x():\n    assert add(1, 2) == 99\n")
        self.assertEqual(self.oracle(all_failing)[1], "no test passed on the original file")

    def test_the_prompt_lists_the_tests_that_fail_on_the_original(self):
        oracle, _ = self.oracle()
        prompt = correction._prompt(BUGGY, "m", [], "m.py", oracle)  # pylint: disable=protected-access
        self.assertIn("run_shared_tests", prompt)
        self.assertIn("test_neg", prompt)
        self.assertIn("exposes a bug", prompt)
        self.assertNotIn("run_shared_tests", correction._prompt(BUGGY, "m", [], "m.py"))  # pylint: disable=protected-access


class CorrectionLoopTests(FakeModelTest):
    """The model-facing side: the tool, the prompt and the refusal of a candidate that breaks a
    test (scripted fake model, real pytest)."""

    @unittest.skipUnless(HAVE_PYTEST, "pytest not installed")
    def test_loop_checks_candidates_against_the_tests_from_the_test_generator(self):
        path = flow.write_shared_file({"test_generator": generator_result()})
        self.addCleanup(os.remove, path)

        def submit(code):
            return message(calls=[("submit_correction", {"corrected_code": code, "changes": [],
                                                         "remaining_issues": []})])

        def script(kw, n):
            if n == 1:
                return message(calls=[("run_shared_tests", {"code": BROKEN})])
            if n == 2:
                result = json.loads(kw["messages"][-1]["content"])
                self.assertTrue(any("test_ok" in t for t in result["regressions"]), result)
                return submit(BROKEN)
            if n == 3:
                self.assertIn("breaks tests that passed on the original",
                              kw["messages"][-1]["content"])
            return submit(FIXED)
        fake = self.use(script)
        with mock.patch.dict(os.environ, {flow.SHARED_ENV: path}), \
                mock.patch.object(correction, "load_lint", return_value=([], "computed")):
            out = correction.correct_code(BUGGY, "m.py")
        self.assertEqual(out["corrected_code"], FIXED)
        self.assertTrue(out["verification"]["accepted"], out["verification"])
        self.assertEqual(out["verification"]["tests"]["regressions"], [])
        self.assertEqual(len(out["verification"]["tests"]["fixed"]), 1)
        self.assertIn("run_shared_tests", {t["function"]["name"] for t in fake.requests[0]["tools"]})
        self.assertIn("Tests that FAIL on the original file", fake.requests[0]["messages"][1]["content"])

    def test_without_shared_tests_the_report_says_so(self):
        self.use(lambda kw, n: message(calls=[("submit_correction", {
            "corrected_code": "x = 1\n", "changes": [], "remaining_issues": []})]))
        env = {k: v for k, v in os.environ.items() if k != flow.SHARED_ENV}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(correction, "load_lint", return_value=([], "computed")):
            out = correction.correct_code("x = 1\n", "x.py")
        self.assertEqual(out["verification"]["tests"],
                         {"used": False, "reason": "no tests from the test generator"})


if __name__ == "__main__":
    unittest.main()
