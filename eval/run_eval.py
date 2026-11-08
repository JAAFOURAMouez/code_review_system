#!/usr/bin/env python3
"""
Evaluate the review pipeline on real code: 20 files from 5 public repositories (4 per repo).

    python eval/run_eval.py                 # real model: needs HF_API_TOKEN (and HF_MODEL)
    python eval/run_eval.py --fake          # no key: scripted fake model (plumbing check only)

Steps: shallow-clone each repository into ``eval/.cache`` (the commit is recorded), pick files
deterministically (Python source, 60-400 lines, no tests, no ``__init__``/``setup``/``conftest``,
evenly spaced in path order), run ``orchestrator.run_pipeline`` on each file in place, and
check every output with tools, not with the model:

* every agent: did it succeed (same rule as the dashboard), is its JSON valid for its schema;
* correction: does the code compile, are public names kept, linter findings before/after,
  was it accepted;
* tests: were they run, how many tests, did they pass (pytest);
* timing: wall time per file versus the sum of agent times (what running one after another
  would cost), tool calls and tokens.

Writes ``eval/results/<label>.json`` (everything) and ``eval/results/<label>.md`` (summary).
With ``--fake`` the quality numbers are meaningless: the fake model only exercises the code
paths. Use a real model for quality.
"""

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

# pylint: disable=wrong-import-position
import horizon_adapter as ad  # noqa: E402
import orchestrator  # noqa: E402
from agents import schema  # noqa: E402
from agents.code_correction_agent import SUBMIT_SCHEMA as CORRECTION_SCHEMA  # noqa: E402
from agents.code_understanding import SCHEMA as UNDERSTANDING_SCHEMA  # noqa: E402
from agents.documentation_agent import SCHEMA as DOC_SCHEMA  # noqa: E402
from agents.improvement_suggestion import SCHEMA as IMPROVEMENT_SCHEMA  # noqa: E402
from agents.test_generator import SUBMIT_SCHEMA as TESTS_SCHEMA  # noqa: E402

REPOS = [
    "psf/requests",
    "pallets/click",
    "pallets/itsdangerous",
    "httpie/cli",
    "tqdm/tqdm",
]
SCHEMAS = {
    "code_understanding": UNDERSTANDING_SCHEMA,
    "improvement_suggestion": IMPROVEMENT_SCHEMA,
    "documentation_agent": DOC_SCHEMA,
    "test_generator": TESTS_SCHEMA,
    "code_correction": CORRECTION_SCHEMA,
}
SKIP_PARTS = {"tests", "test", "testing", "docs", "doc", "examples", "example", "scripts",
              "benchmarks", "extras", ".github", "build", "dist"}
SKIP_NAMES = {"__init__.py", "setup.py", "conftest.py", "__main__.py", "noxfile.py"}


def clone(repo: str, cache: Path) -> Dict[str, str]:
    """Shallow clone (or reuse) a repository. Returns its folder and commit."""
    dest = cache / repo.replace("/", "__")
    if not (dest / ".git").is_dir():
        subprocess.run(["git", "clone", "-q", "--depth", "1", f"https://github.com/{repo}.git",
                        str(dest)], check=True)
    sha = subprocess.run(["git", "-C", str(dest), "rev-parse", "HEAD"], capture_output=True,
                         text=True, check=True).stdout.strip()
    return {"repo": repo, "path": str(dest), "commit": sha}


def pick_files(repo_dir: Path, count: int, min_lines: int = 60, max_lines: int = 400) -> List[Path]:
    """Deterministic choice of ``count`` source files, evenly spaced in path order."""
    candidates = []
    for path in sorted(repo_dir.rglob("*.py")):
        rel = path.relative_to(repo_dir)
        if path.name in SKIP_NAMES or path.name.startswith("test") or \
                any(p.lower() in SKIP_PARTS or p.startswith(".") for p in rel.parts[:-1]):
            continue
        try:
            n = len(path.read_text(encoding="utf-8").splitlines())
        except (OSError, UnicodeDecodeError):
            continue
        if min_lines <= n <= max_lines:
            candidates.append(path)
    if len(candidates) <= count:
        return candidates
    step = len(candidates) / count
    return [candidates[int(i * step)] for i in range(count)]


def schema_problems(name: str, result: Dict[str, Any]) -> List[str]:
    """Check an agent's output against its schema (only the schema's own fields)."""
    sch = SCHEMAS.get(name)
    if not sch or result.get("error"):
        return []
    subset = {k: result[k] for k in sch["properties"] if k in result}
    return schema.validate(subset, sch)


def evaluate_file(path: Path, repo: str, repo_dir: Path, env: Dict[str, str]) -> Dict[str, Any]:
    """Run the pipeline on one file and measure its outputs."""
    started = time.monotonic()
    results = orchestrator.run_pipeline(str(path), env=env)
    wall = time.monotonic() - started
    agents: Dict[str, Any] = {}
    for r in results:
        name = r.get("agent", "?")
        verdict = ad.evaluate_output(name, r)
        agents[name] = {
            "ok": verdict["problem"] is None,
            "problem": verdict["problem"],
            "schema_problems": schema_problems(name, r),
            "duration_s": r.get("duration_s"),
            "tool_calls": len(r.get("tool_calls") or []),
            "mode": r.get("mode"),
            "usage": r.get("usage"),
        }
    by = {r.get("agent"): r for r in results}
    corr = (by.get("code_correction") or {}).get("verification") or {}
    tests = (by.get("test_generator") or {}).get("verification") or {}
    static = by.get("static_analysis") or {}
    durations = [a["duration_s"] for a in agents.values() if isinstance(a["duration_s"], (int, float))]
    return {
        "repo": repo,
        "file": str(path.relative_to(repo_dir)),
        "lines": len(path.read_text(encoding="utf-8").splitlines()),
        "static_findings": len(static.get("findings") or []),
        "agents": agents,
        "correction": {k: corr.get(k) for k in ("syntax_valid", "api_preserved", "accepted",
                                                "total_before", "total_after", "problems")},
        "tests": {k: tests.get(k) for k in ("ran", "passed", "tests", "failures", "errors", "reason")},
        "wall_s": round(wall, 1),
        "sum_agent_s": round(sum(durations), 1),
    }


def pct(part: int, whole: int) -> str:
    """'n/N (p%)'."""
    return f"{part}/{whole} ({100 * part / whole:.0f}%)" if whole else "0/0"


def summarize(files: List[Dict[str, Any]], meta: Dict[str, Any]) -> str:
    """Markdown summary."""
    n = len(files)
    names = [a["name"] for a in orchestrator.AGENTS]
    lines = [f"# Evaluation: {meta['label']}", "",
             f"- Model: `{meta['model']}`"
             + (" (scripted fake: plumbing check only, quality numbers are meaningless)"
                if meta["fake"] else ""),
             f"- Files: {n} from {len(meta['repos'])} repositories, run on {meta['date']}",
             "", "## Agents", "", "| Agent | Succeeded | Valid JSON for its schema | Median time |",
             "|---|---|---|---|"]
    for name in names:
        rows = [f["agents"][name] for f in files if name in f["agents"]]
        ok = sum(1 for r in rows if r["ok"])
        valid = sum(1 for r in rows if r["ok"] and not r["schema_problems"])
        times = [r["duration_s"] for r in rows if isinstance(r["duration_s"], (int, float))]
        med = f"{statistics.median(times):.1f}s" if times else "-"
        lines.append(f"| {name} | {pct(ok, len(rows))} | "
                     f"{pct(valid, ok) if name in SCHEMAS else 'n/a'} | {med} |")
    corr = [f["correction"] for f in files if f["correction"].get("syntax_valid") is not None]
    compiled = sum(1 for c in corr if c["syntax_valid"])
    kept = sum(1 for c in corr if c.get("api_preserved"))
    accepted = sum(1 for c in corr if c.get("accepted"))
    fewer = sum(1 for c in corr if c["syntax_valid"]
                and (c.get("total_after") or 0) < (c.get("total_before") or 0))
    before = sum(c.get("total_before") or 0 for c in corr if c["syntax_valid"])
    after = sum(c.get("total_after") or 0 for c in corr if c["syntax_valid"])
    tests = [f["tests"] for f in files]
    ran = [t for t in tests if t.get("ran")]
    passed = sum(1 for t in ran if t.get("passed"))
    walls = [f["wall_s"] for f in files]
    sums = [f["sum_agent_s"] for f in files]
    calls = [f["agents"].get("code_correction", {}).get("tool_calls", 0) for f in files]
    lines += [
        "", "## Code correction (checked with the linters)", "",
        f"- Compiles: {pct(compiled, len(corr))}",
        f"- Public functions/classes kept: {pct(kept, len(corr))}",
        f"- Fewer linter findings than the original: {pct(fewer, len(corr))}",
        f"- Accepted by the checks: {pct(accepted, len(corr))}",
        f"- Linter findings, all files: {before} before, {after} after",
        f"- Tool calls per file (median): {statistics.median(calls) if calls else 0}",
        "", "## Generated tests (run with pytest)", "",
        f"- Run: {pct(len(ran), n)}",
        f"- All passing: {pct(passed, len(ran))}",
        f"- Tests written: {sum(t.get('tests') or 0 for t in ran)}",
        "", "## Time", "",
        f"- Wall time per file (median): {statistics.median(walls):.1f}s" if walls else "",
        f"- Sum of agent times per file, i.e. one after another (median): "
        f"{statistics.median(sums):.1f}s" if sums else "",
        f"- Total: {sum(walls):.0f}s wall vs {sum(sums):.0f}s sequential",
        "", "## Files", "", "| Repository | File | Lines | Findings | Correction | Tests |",
        "|---|---|---|---|---|---|",
    ]
    for f in files:
        c, t = f["correction"], f["tests"]
        if c.get("syntax_valid") is None:
            cdesc = "failed"
        elif not c["syntax_valid"]:
            cdesc = "does not compile"
        else:
            cdesc = (f"{c.get('total_before')}→{c.get('total_after')}"
                     + ("" if c.get("accepted") else " (refused)"))
        tdesc = (f"{t.get('tests')} tests, {'pass' if t.get('passed') else 'fail'}" if t.get("ran")
                 else (t.get("reason") or "not run"))
        lines.append(f"| {f['repo']} | `{f['file']}` | {f['lines']} | {f['static_findings']} | "
                     f"{cdesc} | {tdesc} |")
    lines += ["", "## Repositories", ""]
    lines += [f"- {r['repo']} @ `{r['commit'][:12]}`" for r in meta["repos"]]
    return "\n".join(line for line in lines if line is not None) + "\n"


def main() -> None:
    """Command line."""
    parser = argparse.ArgumentParser(
        description="Evaluate the pipeline on 20 files from 5 repositories.")
    parser.add_argument("--repos", nargs="+", default=REPOS)
    parser.add_argument("--files-per-repo", type=int, default=4)
    parser.add_argument("--cache", default=str(HERE / ".cache"))
    parser.add_argument("--out", default=str(HERE / "results"))
    parser.add_argument("--fake", action="store_true", help="use the scripted fake model (no key)")
    parser.add_argument("--label", default=None)
    args = parser.parse_args()

    env = dict(os.environ, STATIC_ANALYSIS_REDIS="0")
    httpd = None
    if args.fake:
        import fake_llm_server  # pylint: disable=import-outside-toplevel
        httpd = fake_llm_server.start()
        env.update(HF_BASE_URL=f"http://127.0.0.1:{httpd.server_address[1]}/v1",
                   HF_API_TOKEN="fake", HF_MODEL="fake-scripted-model")
    elif not env.get("HF_API_TOKEN"):
        sys.exit("Set HF_API_TOKEN (or put it in .env), or use --fake for a plumbing check.")
    model = env.get("HF_MODEL", "openai/gpt-oss-20b:groq")
    label = args.label or ("fake" if args.fake else model.replace("/", "_").replace(":", "_"))

    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    repos = [clone(r, cache) for r in args.repos]
    files: List[Dict[str, Any]] = []
    for info in repos:
        repo_dir = Path(info["path"])
        for path in pick_files(repo_dir, args.files_per_repo):
            print(f"[{len(files) + 1:2}] {info['repo']}: {path.relative_to(repo_dir)}", flush=True)
            res = evaluate_file(path, info["repo"], repo_dir, env)
            failed = [n for n, a in res["agents"].items() if not a["ok"]]
            print(f"     {res['wall_s']}s (sequential {res['sum_agent_s']}s); "
                  f"failed: {', '.join(failed) or 'none'}", flush=True)
            files.append(res)
    if httpd:
        httpd.shutdown()

    meta = {"label": label, "model": model, "fake": args.fake,
            "date": time.strftime("%Y-%m-%d %H:%M"), "repos": repos}
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for r in repos:
        r["path"] = os.path.relpath(r["path"], ROOT)
    (out / f"{label}.json").write_text(json.dumps({"meta": meta, "files": files}, indent=2), "utf-8")
    report = summarize(files, meta)
    (out / f"{label}.md").write_text(report, "utf-8")
    print("\n" + report)


if __name__ == "__main__":
    main()
