"""Tests for the memory between reviews (agents/memory.py) and its use by the orchestrator and
the agents' prompts. Run: python -m unittest discover tests

No API key, network or linters are needed: the agents are faked.
"""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# pylint: disable=wrong-import-position
import orchestrator  # noqa: E402
import server  # noqa: E402
from agents import code_correction_agent, common, memory, test_generator  # noqa: E402
from agents.memory import Memory  # noqa: E402


def finding(code="C0114", message="Missing module docstring", line=1, kind="pylint",
            severity="convention", symbol="missing-module-docstring"):
    return {"type": kind, "code": code, "symbol": symbol, "message": message, "line": line,
            "severity": severity}


def generator_result(code="def test_a():\n    assert True\n", passed=True, ran=True):
    return {"agent": "test_generator", "tests": code, "module": "m",
            "verification": {"ran": ran, "passed": passed, "tests": 1, "syntax_valid": True}}


def review_results(findings, tests=None, correction=None, improvements=None):
    results = [{"agent": "static_analysis", "findings": findings}]
    if tests is not None:
        results.append(tests)
    if correction is not None:
        results.append(correction)
    if improvements is not None:
        results.append({"agent": "improvement_suggestion", "improvements": improvements})
    return results


class TempMemoryCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.db = os.path.join(tmp.name, "memory", "memory.sqlite3")
        self.memory = Memory(self.db)


class FingerprintTests(unittest.TestCase):
    def test_a_finding_keeps_its_identity_when_its_line_moves(self):
        self.assertEqual(memory.fingerprint(finding(line=3)), memory.fingerprint(finding(line=90)))

    def test_numbers_in_the_message_do_not_change_the_identity(self):
        a = finding("E501", "line too long (95 > 79 characters)", kind="flake8")
        b = finding("E501", "line too long (101 > 79 characters)", kind="flake8")
        self.assertEqual(memory.fingerprint(a), memory.fingerprint(b))
        self.assertNotEqual(memory.fingerprint(a), memory.fingerprint(finding("E302")))

    def test_counts_duplicates_and_ignores_radon_info(self):
        prints = memory.fingerprints([
            finding(line=1), finding(line=9),
            {"type": "radon", "severity": "info", "message": "complexity 4"},
            "not a finding"])
        self.assertEqual([e["count"] for e in prints.values()], [2])

    def test_keeps_a_bounded_number_of_findings(self):
        many = [finding(code=f"X{i}", message=f"problem {chr(65 + i % 26)}{'z' * i}")
                for i in range(memory.MAX_FINDINGS + 50)]
        self.assertEqual(len(memory.fingerprints(many)), memory.MAX_FINDINGS)

    def test_diff_new_resolved_and_persisting(self):
        before = memory.fingerprints([finding("A", "a"), finding("B", "b"), finding("B", "b")])
        after = memory.fingerprints([finding("B", "b"), finding("C", "c")])
        changes = memory.diff(before, after)
        names = {k: sorted((e["code"], e["count"]) for e in v) for k, v in changes.items()}
        self.assertEqual(names, {"new": [("C", 1)], "resolved": [("A", 1), ("B", 1)],
                                 "persisting": [("B", 1)]})


class StoreTests(TempMemoryCase):
    KEY, HASH = "/p/a.py", "h1"

    def test_a_first_review_has_no_history_and_reading_creates_nothing(self):
        self.assertIsNone(self.memory.recall(self.KEY, self.HASH, [finding()]))
        self.assertFalse(os.path.exists(self.db))

    def test_recall_reports_what_changed_since_the_last_review(self):
        self.memory.record(self.KEY, "h1", [finding("A", "a"), finding("B", "b")], review_results([]))
        history = self.memory.recall(self.KEY, "h2", [finding("B", "b"), finding("C", "c")])
        self.assertEqual(history["reviews"], 1)
        self.assertFalse(history["previous"]["same_content"])
        changes = history["changes"]
        self.assertEqual([e["code"] for e in changes["new"]], ["C"])
        self.assertEqual([e["code"] for e in changes["resolved"]], ["A"])
        self.assertEqual([e["code"] for e in changes["persisting"]], ["B"])
        again = self.memory.recall(self.KEY, "h1", [])
        self.assertTrue(again["previous"]["same_content"])

    def test_files_do_not_share_memory(self):
        self.memory.record("/p/a.py", "h", [finding()], review_results([]))
        self.assertIsNone(self.memory.recall("/p/b.py", "h", [finding()]))

    def test_remembers_tests_that_passed_even_when_the_last_review_had_none(self):
        tests = generator_result("def test_x():\n    assert 1\n")
        self.memory.record(self.KEY, "h1", [], review_results([], tests=tests))
        self.memory.record(self.KEY, "h2", [], review_results([], tests=generator_result(passed=False)))
        history = self.memory.recall(self.KEY, "h2", [])
        self.assertIn("def test_x", history["tests"]["code"])
        self.assertFalse(history["tests"]["same_content"])
        self.assertTrue(self.memory.recall(self.KEY, "h1", [])["tests"]["same_content"])

    def test_tests_that_did_not_run_or_fail_are_not_remembered(self):
        for tests in (generator_result(passed=False), generator_result(ran=False),
                      dict(generator_result(), error=True)):
            self.memory.forget()
            self.memory.record(self.KEY, "h", [], review_results([], tests=tests))
            self.assertIsNone(self.memory.recall(self.KEY, "h", [])["tests"])

    def test_long_tests_are_cut_and_flagged(self):
        long_tests = generator_result("x = 1\n" * 2000)
        self.memory.record(self.KEY, "h", [], review_results([], tests=long_tests))
        stored = self.memory.recall(self.KEY, "h", [])["tests"]
        self.assertEqual(len(stored["code"]), memory.MAX_TESTS_CHARS)
        self.assertTrue(stored["truncated"])

    def test_the_outcome_of_the_last_correction_is_remembered(self):
        correction = {"agent": "code_correction", "remaining_issues": ["W0703: kept on purpose"],
                      "verification": {"accepted": True, "total_before": 9, "total_after": 3}}
        self.memory.record(self.KEY, "h", [], review_results([], correction=correction))
        last = self.memory.recall(self.KEY, "h", [])["correction"]
        self.assertEqual((last["findings_before"], last["findings_after"], last["accepted"]),
                         (9, 3, True))
        self.assertEqual(last["remaining_issues"], ["W0703: kept on purpose"])

    def test_verdicts_attach_to_the_latest_review(self):
        self.assertFalse(self.memory.set_verdict(self.KEY, "code_correction", "approved"))
        self.memory.record(self.KEY, "h1", [], review_results([]))
        self.memory.record(self.KEY, "h2", [], review_results([]))
        self.assertTrue(self.memory.set_verdict(self.KEY, "code_correction", "approved"))
        self.assertTrue(self.memory.set_verdict(self.KEY, "code_correction", "rejected"))
        self.assertEqual(self.memory.recall(self.KEY, "h2", [])["verdicts"],
                         {"code_correction": "rejected"})
        with self.assertRaises(ValueError):
            self.memory.set_verdict(self.KEY, "code_correction", "maybe")
        self.memory.record(self.KEY, "h3", [], review_results([]))  # a new review starts clean
        self.assertEqual(self.memory.recall(self.KEY, "h3", [])["verdicts"], {})

    def test_only_the_most_recent_reviews_are_kept(self):
        with mock.patch.dict(os.environ, {memory.KEEP_ENV: "3"}):
            for i in range(6):
                self.memory.record(self.KEY, f"h{i}", [], review_results([]))
            self.memory.record("/p/other.py", "x", [], review_results([]))
        self.assertEqual(self.memory.recall(self.KEY, "h9", [])["reviews"], 3)
        self.assertEqual(self.memory.recall("/p/other.py", "x", [])["reviews"], 1)

    def test_forget_one_file_or_everything(self):
        self.memory.record("/p/a.py", "h", [], review_results([]))
        self.memory.record("/p/b.py", "h", [], review_results([]))
        self.assertEqual(self.memory.forget("/p/a.py"), 1)
        self.assertIsNone(self.memory.recall("/p/a.py", "h", []))
        self.assertIsNotNone(self.memory.recall("/p/b.py", "h", []))
        self.assertEqual(self.memory.forget(), 1)
        self.assertEqual(Memory(os.path.join(self.dir, "none.db")).forget(), 0)

    def test_memory_switched_off_never_touches_the_disk(self):
        off = Memory(None)
        self.assertFalse(off.enabled)
        self.assertIsNone(off.record(self.KEY, "h", [], review_results([])))
        self.assertIsNone(off.recall(self.KEY, "h", []))
        self.assertFalse(off.set_verdict(self.KEY, "code_correction", "approved"))

    def test_from_env(self):
        with mock.patch.dict(os.environ, {memory.DB_ENV: "off"}):
            self.assertFalse(Memory.from_env().enabled)
        with mock.patch.dict(os.environ, {memory.DB_ENV: self.db}):
            self.assertEqual(Memory.from_env().path, self.db)
        with mock.patch.dict(os.environ):
            os.environ.pop(memory.DB_ENV, None)
            self.assertEqual(Memory.from_env().path, memory.DEFAULT_DB)

    def test_a_broken_database_never_breaks_a_review(self):
        os.makedirs(os.path.dirname(self.db))
        with open(self.db, "w", encoding="utf-8") as f:
            f.write("this is not a database")
        with mock.patch("sys.stderr"):
            self.assertIsNone(self.memory.recall(self.KEY, "h", []))
            self.assertIsNone(self.memory.record(self.KEY, "h", [], review_results([])))
            self.assertFalse(self.memory.set_verdict(self.KEY, "a", "approved"))
            self.assertEqual(self.memory.forget(), 0)


def make_history(**overrides):
    history = {
        "reviews": 2,
        "previous": {"id": 2, "at": 1_700_000_000.0, "same_content": False},
        "changes": memory.diff(
            memory.fingerprints([finding("A", "fixed one"), finding("B", "still here")]),
            memory.fingerprints([finding("B", "still here"), finding("C", "brand new")])),
        "tests": {"code": "def test_old():\n    assert True\n", "same_content": False,
                  "truncated": False, "count": 1, "module": "m"},
        "correction": {"accepted": True, "findings_before": 8, "findings_after": 2,
                       "remaining_issues": ["R0913: too many arguments, public API"]},
        "verdicts": {},
    }
    history.update(overrides)
    return history


class HistorySectionTests(unittest.TestCase):
    def test_no_history_or_an_agent_that_does_not_use_it_gets_nothing(self):
        self.assertEqual(memory.history_section(None, "code_correction"), "")
        self.assertEqual(memory.history_section(make_history(), "documentation_agent"), "")
        self.assertEqual(memory.history_section(make_history(), "code_understanding"), "")

    def test_improvement_agent_gets_the_findings_to_prioritise_and_the_fixed_ones(self):
        text = memory.history_section(make_history(), "improvement_suggestion")
        self.assertIn("1 finding(s) are new, 1 were fixed, 1 are still there", text)
        self.assertIn("still here", text)
        self.assertIn("fixed one", text)
        self.assertIn("not instructions", text)
        self.assertNotIn("def test_old", text)

    def test_test_generator_gets_the_earlier_tests(self):
        text = memory.history_section(make_history(), "test_generator")
        self.assertIn("def test_old", text)
        self.assertIn("an earlier version of the file", text)
        same = make_history(tests={**make_history()["tests"], "same_content": True})
        self.assertIn("this very version of the file", memory.history_section(same, "test_generator"))
        self.assertNotIn("def test_old", memory.history_section(make_history(tests=None), "test_generator"))

    def test_correction_agent_gets_what_it_left_unfixed(self):
        text = memory.history_section(make_history(), "code_correction")
        self.assertIn("from 8 to 2 finding(s)", text)
        self.assertIn("R0913: too many arguments", text)
        self.assertIn("still here", text)
        rejected = make_history(correction={**make_history()["correction"], "accepted": False})
        self.assertIn("not accepted", memory.history_section(rejected, "code_correction"))

    def test_a_persons_verdict_is_passed_on(self):
        approved = make_history(verdicts={"code_correction": "approved"})
        self.assertIn("approved your result", memory.history_section(approved, "code_correction"))
        self.assertNotIn("approved your result", memory.history_section(approved, "test_generator"))
        rejected = make_history(verdicts={"test_generator": "rejected"})
        self.assertIn("rejected your result", memory.history_section(rejected, "test_generator"))

    def test_the_section_stays_small(self):
        crowd = memory.fingerprints([finding(code=f"X{i}", message="m" * 300 + chr(65 + i % 26) * i)
                                     for i in range(100)])
        history = make_history(changes=memory.diff({}, crowd) | {"persisting": list(crowd.values())})
        text = memory.history_section(history, "improvement_suggestion")
        self.assertLess(len(text), memory.SECTION_CHARS + 1200)

    def test_describe(self):
        line = memory.describe(make_history())
        self.assertIn("review 3", line)
        self.assertIn("1 new, 1 fixed, 1 still there", line)


class HandOffTests(unittest.TestCase):
    def test_the_history_travels_in_a_file_named_in_the_environment(self):
        self.assertIsNone(memory.write_history_file(None))
        path = memory.write_history_file(make_history())
        self.addCleanup(os.remove, path)
        env = memory.env_with_history({"PATH": "/bin"}, path)
        self.assertEqual(env, {"PATH": "/bin", memory.HISTORY_ENV: path})
        self.assertIsNone(memory.env_with_history(None, None))
        with mock.patch.dict(os.environ, {memory.HISTORY_ENV: path}):
            self.assertEqual(memory.load_history()["reviews"], 2)
            self.assertIn("still here", common.history_text("improvement_suggestion"))
        with mock.patch.dict(os.environ):
            os.environ.pop(memory.HISTORY_ENV, None)
            self.assertIsNone(memory.load_history())
            self.assertEqual(common.history_text("improvement_suggestion"), "")
        with mock.patch.dict(os.environ, {memory.HISTORY_ENV: "/does/not/exist.json"}):
            self.assertIsNone(memory.load_history())

    def test_the_prompts_carry_the_history(self):
        path = memory.write_history_file(make_history())
        self.addCleanup(os.remove, path)
        with mock.patch.dict(os.environ, {memory.HISTORY_ENV: path}):
            tests_prompt = test_generator._prompt("x = 1\n", "m", [], True)  # pylint: disable=protected-access
            fix_prompt = code_correction_agent._prompt("x = 1\n", "m", [], "m.py")  # pylint: disable=protected-access
        self.assertIn("def test_old", tests_prompt)
        self.assertIn("R0913: too many arguments", fix_prompt)
        self.assertLess(fix_prompt.index("R0913"), fix_prompt.index("Original code:"))
        with mock.patch.dict(os.environ):
            os.environ.pop(memory.HISTORY_ENV, None)
            self.assertNotIn("Memory from earlier", test_generator._prompt("x = 1\n", "m", [], True))  # pylint: disable=protected-access


class PipelineMemoryTests(TempMemoryCase):
    """run_pipeline with a fake runner and a real (temporary) database."""

    def setUp(self):
        super().setUp()
        self.file = os.path.join(self.dir, "m.py")
        self.write("x = 1\n")
        self.histories = []
        self.statics = [[finding("A", "first"), finding("B", "second")],
                        [finding("B", "second"), finding("C", "third")]]
        self.static_calls = 0

    def write(self, text):
        with open(self.file, "w", encoding="utf-8") as f:
            f.write(text)

    def runner(self, agent, path, env=None):  # pylint: disable=unused-argument
        name = agent["name"]
        if name == "static_analysis":
            findings = self.statics[min(self.static_calls, len(self.statics) - 1)]
            self.static_calls += 1
            return {"agent": name, "findings": findings}
        history_file = (env or {}).get(memory.HISTORY_ENV)
        if history_file:
            with open(history_file, encoding="utf-8") as f:
                self.histories.append((name, json.load(f), history_file))
        if name == "test_generator":
            return generator_result("def test_m():\n    assert True\n")
        return {"agent": name}

    def test_first_review_has_no_history_and_is_stored(self):
        seen = []
        orchestrator.run_pipeline(self.file, runner=self.runner, memory=self.memory,
                                  on_history=seen.append)
        self.assertEqual((self.histories, seen), ([], []))
        history = self.memory.recall(memory.file_key(self.file), "other", [])
        self.assertEqual(history["reviews"], 1)
        self.assertIn("def test_m", history["tests"]["code"])

    def test_second_review_hands_the_agents_what_changed_and_cleans_up(self):
        orchestrator.run_pipeline(self.file, runner=self.runner, memory=self.memory)
        self.write("x = 2\n")
        seen = []
        orchestrator.run_pipeline(self.file, runner=self.runner, memory=self.memory,
                                  on_history=seen.append)
        self.assertEqual(len(seen), 1)
        self.assertEqual(len(self.histories), 5)  # every agent except static analysis
        for _, history, _ in self.histories:
            self.assertEqual([e["code"] for e in history["changes"]["new"]], ["C"])
            self.assertEqual([e["code"] for e in history["changes"]["resolved"]], ["A"])
            self.assertFalse(history["previous"]["same_content"])
        self.assertTrue(all(not os.path.exists(path) for _, _, path in self.histories))
        self.assertEqual(self.memory.recall(memory.file_key(self.file), "z", [])["reviews"], 2)

    def test_the_correction_agent_still_gets_the_shared_tests_and_the_history(self):
        orchestrator.run_pipeline(self.file, runner=self.runner, memory=self.memory)
        envs = {}

        def runner(agent, path, env=None):
            envs[agent["name"]] = dict(env or {})
            return self.runner(agent, path, env)
        orchestrator.run_pipeline(self.file, runner=runner, memory=self.memory)
        self.assertIn(memory.HISTORY_ENV, envs["code_correction"])
        self.assertIn("CODE_REVIEW_SHARED", envs["code_correction"])
        self.assertIn(orchestrator.LINT_ENV, envs["code_correction"])

    def test_a_failed_static_analysis_means_no_history_and_nothing_stored(self):
        def runner(agent, path, env=None):
            return {"error": True} if agent["name"] == "static_analysis" else {}
        orchestrator.run_pipeline(self.file, runner=runner, memory=self.memory)
        self.assertFalse(os.path.exists(self.db))

    def test_without_a_memory_nothing_is_written(self):
        orchestrator.run_pipeline(self.file, runner=self.runner)
        orchestrator.run_pipeline(self.file, runner=self.runner, memory=Memory(None))
        self.assertEqual(self.histories, [])
        self.assertFalse(os.path.exists(self.db))

    def test_an_unreadable_file_is_reviewed_without_memory(self):
        missing = os.path.join(self.dir, "missing.py")
        orchestrator.run_pipeline(missing, runner=self.runner, memory=self.memory)
        self.assertFalse(os.path.exists(self.db))


class ServerMemoryTests(TempMemoryCase):
    """The dashboard's ReviewService with the memory, a fake runner and a real database."""

    def setUp(self):
        super().setUp()
        self.root = Path(self.dir) / "project"
        (self.root / "src").mkdir(parents=True)
        self.file = self.root / "src" / "a.py"
        self.file.write_text("x = 1\n", encoding="utf-8")
        self.statics = [[finding("A", "first"), finding("B", "second")],
                        [finding("B", "second"), finding("C", "third")]]
        self.static_runs = 0
        self.histories = []
        self.service = self.make_service(self.memory)

    def make_service(self, mem, public=False):
        def run_agent(agent, file_path, env=None):  # pylint: disable=unused-argument
            name = agent["name"]
            if name == "static_analysis":
                findings = self.statics[min(self.static_runs, len(self.statics) - 1)]
                self.static_runs += 1
                return {"agent": name, "findings": findings}
            path = (env or {}).get(memory.HISTORY_ENV)
            if path:
                with open(path, encoding="utf-8") as f:
                    self.histories.append((name, json.load(f)))
            return {
                "code_understanding": {"explanation": "It sets x."},
                "improvement_suggestion": {"improvements": [{"line": 1, "description": "Rename."}]},
                "test_generator": {"tests": "def test_x():\n    assert True\n", "module": "a",
                                   "verification": {"ran": True, "passed": True, "tests": 1,
                                                    "syntax_valid": True}},
                "documentation_agent": {"documentation": "Overview"},
                "code_correction": {"corrected_code": "x = 1\n", "remaining_issues": ["left R0913"],
                                    "verification": {"accepted": True, "total_before": 2,
                                                     "total_after": 1, "syntax_valid": True}},
            }[name]
        return server.ReviewService(self.root, orchestrator.AGENTS, run_agent, "m",
                                    state_dir=Path(self.dir) / "state", public=public, memory=mem)

    def review(self):
        self.assertIn("runId", self.service.start_run("src/a.py"))
        self.wait_idle()

    def wait_idle(self):
        for _ in range(300):
            if not self.service.busy:
                return
            time.sleep(0.02)
        self.fail("the review did not finish")

    def key(self):
        return memory.file_key(str(self.file))

    def test_a_review_is_remembered_and_the_next_one_gets_the_history(self):
        self.review()
        self.assertEqual(self.histories, [])
        self.assertEqual(self.memory.recall(self.key(), "z", [])["reviews"], 1)
        self.file.write_text("x = 2\n", encoding="utf-8")
        self.review()
        self.assertEqual(sorted(name for name, _ in self.histories),
                         sorted(a["name"] for a in orchestrator.AGENTS
                                if a["name"] != "static_analysis"))
        history = self.histories[0][1]
        self.assertEqual([e["code"] for e in history["changes"]["new"]], ["C"])
        self.assertEqual([e["code"] for e in history["changes"]["resolved"]], ["A"])
        self.assertIn("def test_x", history["tests"]["code"])
        events = [e for e in self.service.current()["events"]
                  if e["title"] == "Compared with the last review"]
        self.assertEqual(len(events), 1)
        self.assertIn("1 new, 1 fixed, 1 still there", events[0]["detail"])

    def test_approving_a_result_is_remembered_as_a_verdict(self):
        self.review()
        self.assertEqual(self.service.approve("code_correction"), {})
        self.assertEqual(self.memory.recall(self.key(), "z", [])["verdicts"],
                         {"code_correction": "approved"})
        self.review()
        self.assertEqual(self.histories[0][1]["verdicts"], {"code_correction": "approved"})

    def test_re_running_one_agent_keeps_its_history_and_does_not_store_a_second_review(self):
        self.review()
        self.review()
        self.histories.clear()
        self.assertEqual(self.service.rerun("improvement_suggestion"), {})
        self.wait_idle()
        self.assertEqual([name for name, _ in self.histories], ["improvement_suggestion"])
        self.assertEqual(self.histories[0][1]["reviews"], 1)  # what the review started with
        self.assertEqual(self.memory.recall(self.key(), "z", [])["reviews"], 2)

    def test_no_memory_means_no_database_and_no_history(self):
        self.service = self.make_service(None)
        self.review()
        self.review()
        self.assertEqual(self.histories, [])
        self.assertFalse(os.path.exists(self.db))

    def test_a_public_deployment_never_stores_visitors_code(self):
        public = self.make_service(self.memory, public=True)
        self.assertIsNone(public.memory)
        self.assertFalse(os.path.exists(self.db))


if __name__ == "__main__":
    unittest.main()
