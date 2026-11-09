"""Tests for the planner agent (agents/planner.py) and for how the orchestrator, the dashboard
server and the adapter use its plan. Run: python -m unittest discover tests

No API key, network or linters are needed: the agents and the model are faked.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# pylint: disable=wrong-import-position
import horizon_adapter as ad  # noqa: E402
import orchestrator  # noqa: E402
import server  # noqa: E402
from agents import flow, hf_client, memory, planner  # noqa: E402

SELECTABLE = list(planner.SELECTABLE)
DOCUMENTED = '''"""A module."""


def add(a, b):
    """Add."""
    return a + b


class Box:
    """A box."""

    def open(self):
        """Open."""
        return True
'''
UNDOCUMENTED = """import os


def add(a, b):
    return a + b


def sub(a, b):
    return a - b


class Box:
    def open(self):
        return os.getcwd()
"""
TEST_FILE = """import unittest


class AddTests(unittest.TestCase):
    def test_add(self):
        self.assertEqual(1 + 1, 2)


def test_other():
    assert True
"""


def issue(kind="pylint", severity="warning", code="W0612"):
    return {"type": kind, "severity": severity, "code": code, "message": "m", "line": 3}


def facts_for(code, name="mod.py", findings=None, history=None):
    return planner.file_facts(code, name, findings or [], history)


def decisions(plan):
    return {d["agent"]: (d["run"], d["reason"]) for d in plan}


def history(same=True, verdicts=None):
    return {"reviews": 1, "previous": {"id": 1, "at": 1.0, "same_content": same},
            "changes": {"new": [], "resolved": [], "persisting": []}, "tests": None,
            "correction": None, "verdicts": verdicts or {}}


class FactsTests(unittest.TestCase):
    def test_counts_what_the_rules_need(self):
        facts = facts_for(UNDOCUMENTED, findings=[issue(), issue("bandit", "high", "B105"),
                                                  issue("pylint", "error", "E0602"),
                                                  {"type": "radon", "severity": "info"}])
        self.assertEqual((facts["syntax_valid"], facts["is_test_file"], facts["public_items"]),
                         (True, False, 3))
        self.assertEqual((facts["issues"], facts["security_issues"], facts["errors"]), (3, 1, 1))
        self.assertLess(facts["docstring_coverage"], 0.5)

    def test_docstring_coverage(self):
        self.assertEqual(facts_for(DOCUMENTED)["docstring_coverage"], 1.0)
        self.assertEqual(facts_for(UNDOCUMENTED)["docstring_coverage"], 0.0)
        self.assertEqual(facts_for("")["docstring_coverage"], 0.0)  # an empty module has no docstring

    def test_a_file_that_does_not_compile(self):
        facts = facts_for("def broken(:\n    pass\n")
        self.assertFalse(facts["syntax_valid"])
        self.assertEqual(facts["public_items"], 0)

    def test_test_files_are_recognised_by_name_and_by_content(self):
        self.assertTrue(facts_for("x = 1\n", "test_thing.py")["is_test_file"])
        self.assertTrue(facts_for("x = 1\n", "thing_test.py")["is_test_file"])
        self.assertTrue(facts_for(TEST_FILE, "checks.py")["is_test_file"])
        self.assertFalse(facts_for(UNDOCUMENTED, "tools.py")["is_test_file"])

    def test_approvals_count_only_for_the_same_content(self):
        approved = {"documentation_agent": "approved", "test_generator": "rejected"}
        same = facts_for(UNDOCUMENTED, history=history(True, approved))
        self.assertEqual((same["unchanged_since_last_review"], same["approved_before"]),
                         (True, ["documentation_agent"]))
        changed = facts_for(UNDOCUMENTED, history=history(False, approved))
        self.assertEqual(changed["approved_before"], [])
        self.assertFalse(facts_for(UNDOCUMENTED)["unchanged_since_last_review"])


class RuleTests(unittest.TestCase):
    def plan(self, code, name="mod.py", findings=None, hist=None):
        return decisions(planner.plan_by_rules(facts_for(code, name, findings, hist)))

    def test_one_decision_per_selectable_agent_in_order(self):
        plan = planner.plan_by_rules(facts_for(UNDOCUMENTED, findings=[issue()]))
        self.assertEqual([d["agent"] for d in plan], SELECTABLE)
        self.assertTrue(all(isinstance(d["run"], bool) and d["reason"] for d in plan))

    def test_a_typical_file_with_findings_runs_everything(self):
        plan = self.plan(UNDOCUMENTED, findings=[issue(), issue("bandit", "high", "B105")])
        self.assertTrue(all(run for run, _ in plan.values()), plan)
        self.assertIn("security", plan["code_correction"][1])

    def test_a_clean_documented_file_has_little_to_do(self):
        plan = self.plan(DOCUMENTED)
        self.assertFalse(plan["code_correction"][0])        # nothing to correct
        self.assertFalse(plan["documentation_agent"][0])    # already documented
        self.assertFalse(plan["improvement_suggestion"][0])  # short, no findings
        self.assertTrue(plan["test_generator"][0])           # public functions to test
        self.assertTrue(plan["code_understanding"][0])

    def test_a_clean_long_file_still_gets_a_review_of_its_design(self):
        long_code = DOCUMENTED + "".join(f"\n\ndef f{i}(x):\n    \"\"\"Doc.\"\"\"\n    return x + {i}\n"
                                         for i in range(12))
        self.assertTrue(self.plan(long_code)["improvement_suggestion"][0])

    def test_a_tiny_file_is_not_explained(self):
        run, reason = self.plan("x = 1\n")["code_understanding"]
        self.assertFalse(run)
        self.assertIn("1 line", reason)

    def test_no_public_api_means_no_tests(self):
        script = "import os\n\n_x = os.getcwd()\nprint(_x)\nprint(_x)\nprint(_x)\nprint(_x)\n"
        self.assertFalse(self.plan(script, findings=[issue()])["test_generator"][0])

    def test_test_files_get_no_new_tests_and_no_docs(self):
        plan = self.plan(TEST_FILE, "test_mod.py", findings=[issue()])
        self.assertFalse(plan["test_generator"][0])
        self.assertFalse(plan["documentation_agent"][0])
        self.assertTrue(plan["code_correction"][0])

    def test_a_file_that_does_not_compile_only_gets_the_correction(self):
        plan = self.plan("def broken(:\n    pass\n", findings=[issue("pylint", "error", "E0001")])
        self.assertEqual([a for a, (run, _) in plan.items() if run], ["code_correction"])

    def test_an_approved_result_on_the_same_version_is_not_run_again(self):
        hist = history(True, {"documentation_agent": "approved", "code_correction": "approved"})
        plan = self.plan(UNDOCUMENTED, findings=[issue()], hist=hist)
        self.assertFalse(plan["documentation_agent"][0])
        self.assertIn("approved", plan["documentation_agent"][1])
        self.assertFalse(plan["code_correction"][0])
        self.assertTrue(plan["test_generator"][0])
        changed = self.plan(UNDOCUMENTED, findings=[issue()],
                            hist=history(False, {"documentation_agent": "approved"}))
        self.assertTrue(changed["documentation_agent"][0])


class ModelPlanTests(unittest.TestCase):
    CODE = UNDOCUMENTED

    def run_plan(self, reply=None, error=None, code=None, name="mod.py", findings=None):
        findings = [issue()] if findings is None else findings
        patched = mock.patch.object(hf_client, "generate_json",
                                    side_effect=error, return_value=reply)
        with mock.patch.dict(os.environ, {"PLANNER_MODE": "llm"}), patched, \
                mock.patch.object(planner, "load_lint", return_value=(findings, "computed")), \
                mock.patch.object(memory, "load_history", return_value=None):
            return planner.plan(code or self.CODE, name)

    def test_the_model_can_change_a_decision_with_a_reason(self):
        reply = {"decisions": [{"agent": "documentation_agent", "run": False, "reason": "Docs are fine."}]}
        out = self.run_plan(reply)
        self.assertEqual(out["source"], "llm")
        self.assertEqual(decisions(out["decisions"])["documentation_agent"], (False, "Docs are fine."))
        # the agents it did not mention keep the rules' decision
        self.assertTrue(decisions(out["decisions"])["test_generator"][0])
        self.assertEqual([d["agent"] for d in out["decisions"]], SELECTABLE)

    def test_hard_rules_win_over_the_model(self):
        reply = {"decisions": [{"agent": "test_generator", "run": True, "reason": "Tests are good."}]}
        out = self.run_plan(reply, code=TEST_FILE, name="test_mod.py")
        self.assertFalse(decisions(out["decisions"])["test_generator"][0])
        broken = self.run_plan(reply, code="def broken(:\n    pass\n")
        self.assertFalse(decisions(broken["decisions"])["test_generator"][0])

    def test_correction_cannot_be_skipped_while_there_are_errors(self):
        reply = {"decisions": [{"agent": "code_correction", "run": False, "reason": "Not needed."}]}
        out = self.run_plan(reply, findings=[issue("pylint", "error", "E0602")])
        run, reason = decisions(out["decisions"])["code_correction"]
        self.assertTrue(run)
        self.assertIn("error", reason)

    def test_unknown_agents_duplicates_and_blank_reasons_are_ignored(self):
        reply = {"decisions": [
            {"agent": "static_analysis", "run": False, "reason": "no"},
            {"agent": "documentation_agent", "run": False, "reason": "  "},
            {"agent": "test_generator", "run": False, "reason": "first"},
            {"agent": "test_generator", "run": True, "reason": "second"},
        ]}
        out = decisions(self.run_plan(reply)["decisions"])
        self.assertEqual(out["test_generator"], (False, "first"))
        self.assertTrue(out["documentation_agent"][0])
        self.assertEqual(sorted(out), sorted(SELECTABLE))

    def test_a_failing_model_falls_back_to_the_rules(self):
        out = self.run_plan(error=hf_client.LLMError("no answer"))
        self.assertTrue(out["source"].startswith("rules (the model gave no usable plan"))
        self.assertEqual([d["agent"] for d in out["decisions"]], SELECTABLE)

    def test_the_model_is_not_called_in_rules_mode(self):
        with mock.patch.object(hf_client, "generate_json") as model, \
                mock.patch.dict(os.environ, {"PLANNER_MODE": "rules"}), \
                mock.patch.object(planner, "load_lint", return_value=([], "computed")):
            out = planner.plan(self.CODE, "mod.py")
        model.assert_not_called()
        self.assertEqual(out["source"], "rules")
        self.assertTrue(out["summary"].startswith("Runs "))


class PlannerProcessTests(unittest.TestCase):
    def test_runs_as_an_agent_and_prints_one_json_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mod.py"
            path.write_text(UNDOCUMENTED, encoding="utf-8")
            env = {k: v for k, v in os.environ.items() if k not in (flow.SHARED_ENV, memory.HISTORY_ENV)}
            env.pop("PLANNER_MODE", None)
            proc = subprocess.run([sys.executable, str(ROOT / "agents" / "planner.py"), str(path)],
                                  capture_output=True, text=True, env=env, timeout=120, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["agent"], "planner")
        self.assertEqual([d["agent"] for d in out["decisions"]], SELECTABLE)
        self.assertEqual(out["source"], "rules")


AGENTS = [{"name": "static_analysis", "needs_lint": False},
          {"name": "planner", "needs_lint": True, "planner": True},
          {"name": "a", "needs_lint": True},
          {"name": "b", "needs_lint": True},
          {"name": "c", "needs_lint": True, "depends_on": ["b"]}]


class ApplyPlanTests(unittest.TestCase):
    def apply(self, plan, indices=(2, 3, 4)):
        return flow.apply_plan(AGENTS, list(indices), plan)

    def test_skips_what_the_plan_skips_with_the_reason(self):
        plan = {"decisions": [{"agent": "a", "run": False, "reason": "Nothing to do."},
                              {"agent": "b", "run": True, "reason": "x"}]}
        self.assertEqual(self.apply(plan), ([3, 4], {2: "Nothing to do."}))

    def test_an_agent_the_plan_does_not_mention_runs(self):
        self.assertEqual(self.apply({"decisions": [{"agent": "a", "run": False, "reason": "r"}]}),
                         ([3, 4], {2: "r"}))

    def test_a_missing_failed_or_malformed_plan_runs_everything(self):
        for plan in (None, {"error": True, "decisions": [{"agent": "a", "run": False, "reason": "r"}]},
                     {"decisions": "no"}, {}, "plan", {"decisions": [{"agent": "a", "run": "no"}, 3, None]}):
            self.assertEqual(self.apply(plan), ([2, 3, 4], {}), plan)

    def test_a_blank_reason_gets_a_default_and_only_the_first_decision_counts(self):
        plan = {"decisions": [{"agent": "a", "run": False, "reason": " "},
                              {"agent": "a", "run": True, "reason": "late"}]}
        run, skipped = self.apply(plan)
        self.assertEqual((run, list(skipped)), ([3, 4], [2]))
        self.assertTrue(skipped[2])

    def test_only_the_given_indices_are_considered(self):
        plan = {"decisions": [{"agent": "a", "run": False, "reason": "r"}]}
        self.assertEqual(self.apply(plan, [3]), ([3], {}))

    def test_helpers(self):
        self.assertTrue(flow.is_planner(AGENTS[1]))
        self.assertFalse(flow.is_planner(AGENTS[0]))
        self.assertEqual(flow.skipped_result(AGENTS[2], "why", "f.py"),
                         {"agent": "a", "file": "f.py", "skipped": True, "reason": "why"})

    def test_skipped_agents_are_remembered_as_skipped(self):
        summary = memory.summarize([{"agent": "a", "skipped": True, "reason": "r"},
                                    {"agent": "b", "error": True}, {"agent": "c"}])
        self.assertEqual(summary["agents"], {"a": "skipped", "b": "failed", "c": "ok"})


def skip_plan(*names):
    return {"agent": "planner", "decisions": [
        {"agent": n, "run": n not in names, "reason": f"{n} is not needed."} for n in SELECTABLE]}


class PipelineTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.file = os.path.join(tmp.name, "m.py")
        Path(self.file).write_text(UNDOCUMENTED, encoding="utf-8")
        self.ran = []
        self.envs = {}
        self.plan = skip_plan("documentation_agent", "test_generator")

    def runner(self, agent, path, env=None):  # pylint: disable=unused-argument
        self.ran.append(agent["name"])
        self.envs[agent["name"]] = dict(env or {})
        if agent["name"] == "static_analysis":
            return {"agent": "static_analysis", "findings": [issue()]}
        if agent["name"] == "planner":
            return self.plan
        return {"agent": agent["name"], "ok": True}

    def test_skipped_agents_are_not_run_and_the_results_keep_their_order(self):
        reported = []
        results = orchestrator.run_pipeline(
            self.file, runner=self.runner,
            on_result=lambda agent, result, seconds: reported.append((agent["name"], result, seconds)))
        self.assertEqual([r["agent"] for r in results], [a["name"] for a in orchestrator.AGENTS])
        self.assertNotIn("documentation_agent", self.ran)
        self.assertNotIn("test_generator", self.ran)
        self.assertEqual(self.ran[:2], ["static_analysis", "planner"])  # planner before the others
        self.assertEqual(sorted(self.ran[2:]), ["code_correction", "code_understanding",
                                                "improvement_suggestion"])
        by = {r["agent"]: r for r in results}
        self.assertTrue(by["documentation_agent"]["skipped"])
        self.assertEqual(by["test_generator"]["reason"], "test_generator is not needed.")
        self.assertNotIn("skipped", by["code_correction"])
        skipped_reports = {n: s for n, r, s in reported if r.get("skipped")}
        self.assertEqual(skipped_reports, {"documentation_agent": 0.0, "test_generator": 0.0})

    def test_the_correction_does_not_wait_for_tests_that_were_skipped(self):
        orchestrator.run_pipeline(self.file, runner=self.runner)
        self.assertIn("code_correction", self.ran)
        self.assertNotIn(flow.SHARED_ENV, self.envs["code_correction"])  # no tests to hand over
        self.assertIn(orchestrator.LINT_ENV, self.envs["code_correction"])

    def test_the_planner_gets_the_findings_and_a_failed_planner_runs_everything(self):
        self.plan = {"agent": "planner", "error": True, "note": "boom"}
        results = orchestrator.run_pipeline(self.file, runner=self.runner)
        self.assertIn(orchestrator.LINT_ENV, self.envs["planner"])
        self.assertEqual(sorted(self.ran), sorted(a["name"] for a in orchestrator.AGENTS))
        self.assertFalse(any(r.get("skipped") for r in results))

    def test_the_planner_is_given_the_history_from_memory(self):
        with tempfile.TemporaryDirectory() as tmp:
            mem = memory.Memory(os.path.join(tmp, "m.sqlite3"))
            orchestrator.run_pipeline(self.file, runner=self.runner, memory=mem)
            self.envs.clear()
            orchestrator.run_pipeline(self.file, runner=self.runner, memory=mem)
        self.assertIn(memory.HISTORY_ENV, self.envs["planner"])
        self.assertNotIn(memory.HISTORY_ENV, self.envs.get("static_analysis", {}))

    def test_without_a_planner_in_the_list_everything_runs(self):
        agents = [a for a in orchestrator.AGENTS if a["name"] != "planner"]
        results = orchestrator.run_pipeline(self.file, agents=agents, runner=self.runner)
        self.assertEqual(sorted(self.ran), sorted(a["name"] for a in agents))
        self.assertFalse(any(r.get("skipped") for r in results))


class AdapterTests(unittest.TestCase):
    def make_run(self, statuses):
        agents = {n: {"status": st, "attempts": 1, "approved": False}
                  for n, st in statuses.items()}
        agents["documentation_agent"].update(reason="Already documented.") \
            if "documentation_agent" in agents else None
        return {"id": "run-001", "file": "a.py", "startedAt": 1000, "endedAt": 2000,
                "fingerprint": {"lines": 3}, "agents": agents, "events": []}

    def test_skipped_agents_are_left_out_of_the_outcome_and_the_counts(self):
        run = self.make_run({"static_analysis": "ok", "planner": "ok", "code_understanding": "ok",
                             "documentation_agent": "skipped"})
        self.assertEqual(ad.run_outcome(run), "succeeded")
        summary = ad.run_summary(run, 5000)
        self.assertEqual((summary["agentsOk"], summary["agentsTotal"], summary["agentsSkipped"]), (3, 3, 1))
        run["agents"]["code_understanding"]["status"] = "failed"
        self.assertEqual(ad.run_outcome(run), "partial")
        run["agents"]["documentation_agent"]["status"] = "pending"
        self.assertEqual(ad.run_outcome(run), "in_progress")

    def test_the_agent_view_carries_the_reason(self):
        run = self.make_run({"documentation_agent": "skipped"})
        view = ad.agent_view(run, 0, "documentation_agent")
        self.assertEqual((view["status"], view["reason"], view["result"]),
                         ("skipped", "Already documented.", None))
        ok = self.make_run({"documentation_agent": "ok"})
        ok["agents"]["documentation_agent"].update(result={"documentation": "x"}, reason="stale")
        self.assertIsNone(ad.agent_view(ok, 0, "documentation_agent")["reason"])

    def test_the_planner_is_described_and_judged_by_its_decisions(self):
        self.assertEqual(ad.info("planner")["name"], "Planner")
        self.assertIsNone(ad.evaluate_output("planner", skip_plan("documentation_agent"))["problem"])
        self.assertIsNotNone(ad.evaluate_output("planner", {"decisions": []})["problem"])


class ServerPlanTests(unittest.TestCase):
    """The dashboard's ReviewService with a fake runner."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "src").mkdir()
        (self.root / "src" / "a.py").write_text(UNDOCUMENTED, encoding="utf-8")
        self.plan = skip_plan("documentation_agent", "test_generator")
        self.calls = []
        self.service = server.ReviewService(self.root, orchestrator.AGENTS, self.run_agent, "m",
                                            state_dir=self.root / "state")

    def run_agent(self, agent, file_path, env=None):  # pylint: disable=unused-argument
        self.calls.append(agent["name"])
        out = {
            "static_analysis": {"findings": [issue()]},
            "planner": self.plan,
            "code_understanding": {"explanation": "It adds."},
            "improvement_suggestion": {"improvements": [{"line": 1, "description": "Rename."}]},
            "test_generator": {"tests": "def test_x():\n    assert True\n"},
            "documentation_agent": {"documentation": "Overview"},
            "code_correction": {"corrected_code": "x = 1\n"},
        }[agent["name"]]
        return dict(out, file=file_path)

    def review(self):
        self.assertIn("runId", self.service.start_run("src/a.py"))
        self.wait()

    def wait(self):
        for _ in range(300):
            if not self.service.busy:
                return
            time.sleep(0.02)
        self.fail("the review did not finish")

    def current(self):
        return ad.build_workspace(self.service.runs, self.service.names, "m", 9)["current"]

    def test_skipped_agents_show_their_reason_and_the_review_still_succeeds(self):
        self.review()
        self.assertNotIn("documentation_agent", self.calls)
        self.assertNotIn("test_generator", self.calls)
        run = self.current()
        self.assertEqual(run["outcome"], "succeeded")
        self.assertEqual((run["agentsOk"], run["agentsSkipped"]), (5, 2))
        docs = run["agents"]["documentation_agent"]
        self.assertEqual((docs["status"], docs["reason"]), ("skipped", "documentation_agent is not needed."))
        self.assertEqual(run["agents"]["planner"]["status"], "ok")
        events = [e for e in self.service.runs[-1]["events"] if e["title"] == "Skipped"]
        self.assertEqual(sorted(e["actorId"] for e in events), ["documentation_agent", "test_generator"])

    def test_a_failed_planner_runs_every_agent(self):
        self.plan = {"error": True, "note": "boom"}
        self.review()
        self.assertEqual(sorted(self.calls), sorted(a["name"] for a in orchestrator.AGENTS))
        run = self.current()
        self.assertEqual((run["agents"]["planner"]["status"], run["outcome"], run["agentsSkipped"]),
                         ("failed", "partial", 0))

    def test_a_skipped_agent_can_be_run_anyway_and_is_not_needed_for_full_approval(self):
        self.review()
        for name in ("static_analysis", "planner", "code_understanding", "improvement_suggestion",
                     "code_correction"):
            self.assertEqual(self.service.approve(name), {})
        self.assertTrue(any(e["title"] == "Approved every result" for e in self.service.runs[-1]["events"]))
        self.assertIn("error", self.service.approve("documentation_agent"))  # only a result can be approved
        self.calls.clear()
        self.assertEqual(self.service.rerun("documentation_agent"), {})
        self.wait()
        self.assertEqual(self.calls, ["documentation_agent"])  # no planning in a re-run
        docs = self.current()["agents"]["documentation_agent"]
        self.assertEqual((docs["status"], docs["reason"]), ("ok", None))

    def test_a_clean_run_with_all_agents_needed_skips_nothing(self):
        self.plan = skip_plan()
        self.review()
        self.assertEqual(sorted(self.calls), sorted(a["name"] for a in orchestrator.AGENTS))
        self.assertEqual(self.current()["agentsSkipped"], 0)


if __name__ == "__main__":
    unittest.main()
