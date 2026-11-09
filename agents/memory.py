"""
Memory between reviews (standard library only: sqlite3).

After each review of a file the orchestrator records what was found and what the agents
produced. Before the next review of the same file it looks that record up and hands the agents
a short history, so a review can say what is new, what was fixed and what is still open, and
the agents do not start from zero.

What is stored, per review of a file (the file is identified by its real path):

* the hash of the file's content,
* the linter findings as fingerprints (tool, code, symbol, message with its numbers removed;
  never the line number, so moving code around does not make a finding look new) and how many
  times each occurs,
* a summary of the agents' results: which agents worked, the tests that passed on the file,
  the outcome of the correction (findings before and after, what it left unfixed),
* the verdict of a person on an agent's result (``set_verdict``, used by the dashboard's
  Approve button).

The history reaches the agents through a small JSON file named in ``CODE_REVIEW_HISTORY``
(the same mechanism as the linter findings), and ``history_section`` turns it into the part of
the prompt each agent gets.

Memory is best effort: when the database cannot be read or written, a message goes to stderr
and the review goes on without it. The database holds code (the tests) and findings from your
files: it lives in ``.review_memory/`` (ignored by git). ``CODE_REVIEW_MEMORY_DB`` changes its
path; ``CODE_REVIEW_MEMORY_DB=0`` turns memory off. At most ``CODE_REVIEW_MEMORY_KEEP`` (20)
reviews are kept per file.
"""

import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
from contextlib import closing
from typing import Any, Dict, List, Optional

HISTORY_ENV = "CODE_REVIEW_HISTORY"
DB_ENV = "CODE_REVIEW_MEMORY_DB"
KEEP_ENV = "CODE_REVIEW_MEMORY_KEEP"
DEFAULT_DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          ".review_memory", "memory.sqlite3")
OFF_VALUES = {"0", "off", "none", "false", "no"}

MAX_FINDINGS = 200        # fingerprints kept per review
MAX_TESTS_CHARS = 6000    # stored test code per review
RECENT_REVIEWS = 5        # how far back to look for tests that passed
SECTION_CHARS = 2500      # findings part of a prompt section
TESTS_PROMPT_CHARS = 3000  # earlier tests shown to the test generator
SECTION_AGENTS = ("improvement_suggestion", "test_generator", "code_correction")
VERDICTS = ("approved", "rejected")

SCHEMA = """
CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created REAL NOT NULL,
    findings TEXT NOT NULL,
    summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_file ON reviews (file_key, id);
CREATE TABLE IF NOT EXISTS verdicts (
    review_id INTEGER NOT NULL,
    agent TEXT NOT NULL,
    verdict TEXT NOT NULL,
    created REAL NOT NULL,
    PRIMARY KEY (review_id, agent)
);
"""

_NUMBERS = re.compile(r"\d+")


def _log(message: str) -> None:
    print(f"memory: {message}", file=sys.stderr)


# ------------------------------------------------------------------ findings

def content_hash(text: str) -> str:
    """Hash of a file's content."""
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def file_key(path: str) -> str:
    """The key of a file: its real path."""
    return os.path.realpath(path)


def _useful(finding: Dict[str, Any]) -> bool:
    """Radon's informational complexity reports are not issues."""
    return not (finding.get("type") == "radon" and finding.get("severity") == "info")


def fingerprint(finding: Dict[str, Any]) -> str:
    """Identity of a finding that survives edits elsewhere in the file: no line number, and the
    numbers in the message (line counts, lengths) are replaced."""
    message = _NUMBERS.sub("#", str(finding.get("message") or ""))
    return "|".join((str(finding.get("type")), str(finding.get("code") or ""),
                     str(finding.get("symbol") or ""), message))


def fingerprints(findings: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Findings by fingerprint: ``{fp: {type, code, severity, message, line, count}}``."""
    out: Dict[str, Dict[str, Any]] = {}
    for f in findings or []:
        if not isinstance(f, dict) or not _useful(f):
            continue
        fp = fingerprint(f)
        if fp in out:
            out[fp]["count"] += 1
        elif len(out) < MAX_FINDINGS:
            out[fp] = {"type": f.get("type"), "code": f.get("code"),
                       "severity": f.get("severity"), "message": f.get("message"),
                       "line": f.get("line"), "count": 1}
    return out


def diff(previous: Dict[str, Dict[str, Any]], current: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Compare two ``fingerprints``. Each list holds finding entries with the number of
    occurrences concerned: ``new`` (not there before), ``resolved`` (gone), ``persisting``."""
    out: Dict[str, List[Dict[str, Any]]] = {"new": [], "resolved": [], "persisting": []}
    for fp, entry in current.items():
        before = previous.get(fp, {}).get("count", 0)
        if entry["count"] > before:
            out["new"].append({**entry, "count": entry["count"] - before})
        if before and min(before, entry["count"]) > 0:
            out["persisting"].append({**entry, "count": min(before, entry["count"])})
    for fp, entry in previous.items():
        now = current.get(fp, {}).get("count", 0)
        if entry["count"] > now:
            out["resolved"].append({**entry, "count": entry["count"] - now})
    return out


def review_context(memory: Optional["Memory"], file_path: str,
                   static_result: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """What is needed to recall and then record a review of ``file_path``: its key, content
    hash and the static findings. None when there is no memory, static analysis failed (the
    findings are unknown, so nothing can be compared) or the file cannot be read."""
    if memory is None or not memory.enabled:
        return None
    if not isinstance(static_result, dict) or static_result.get("error"):
        return None
    findings = static_result.get("findings")
    if not isinstance(findings, list):
        return None
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError):
        return None
    return {"key": file_key(file_path), "hash": content_hash(text), "findings": findings}


def summarize(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """What is worth remembering from the agents' results of one review."""
    by_agent = {r.get("agent"): r for r in results if isinstance(r, dict) and r.get("agent")}
    summary: Dict[str, Any] = {
        "agents": {name: ("failed" if r.get("error") else "ok") for name, r in by_agent.items()}}
    gen = by_agent.get("test_generator") or {}
    verification = gen.get("verification") or {}
    if not gen.get("error") and gen.get("tests") and verification.get("ran") \
            and verification.get("passed"):
        tests = str(gen["tests"])
        summary["tests"] = {"code": tests[:MAX_TESTS_CHARS], "truncated": len(tests) > MAX_TESTS_CHARS,
                            "count": verification.get("tests"), "module": gen.get("module")}
    corr = by_agent.get("code_correction") or {}
    if corr and not corr.get("error"):
        ver = corr.get("verification") or {}
        summary["correction"] = {
            "accepted": bool(ver.get("accepted")),
            "findings_before": ver.get("total_before"),
            "findings_after": ver.get("total_after"),
            "remaining_issues": [str(x)[:300] for x in (corr.get("remaining_issues") or [])[:10]],
        }
    imp = by_agent.get("improvement_suggestion") or {}
    if imp and not imp.get("error"):
        summary["improvements"] = len(imp.get("improvements") or [])
    return summary


# ------------------------------------------------------------------ the store

class Memory:
    """The review database. ``Memory(None)`` is memory switched off: it never reads or writes."""

    def __init__(self, path: Optional[str] = DEFAULT_DB) -> None:
        self.path = path

    @classmethod
    def from_env(cls) -> "Memory":
        """The database named by ``CODE_REVIEW_MEMORY_DB`` (default ``.review_memory/``), or
        memory switched off for 0/off/none/false/no."""
        value = (os.getenv(DB_ENV) or "").strip()
        if value.lower() in OFF_VALUES:
            return cls(None)
        return cls(value or DEFAULT_DB)

    @property
    def enabled(self) -> bool:
        """False when memory is switched off."""
        return bool(self.path)

    def _connect(self, create: bool) -> Optional[sqlite3.Connection]:
        if not self.path or (not create and not os.path.isfile(self.path)):
            return None
        if create:
            os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        con = sqlite3.connect(self.path, timeout=10)
        con.row_factory = sqlite3.Row
        if create:
            con.executescript(SCHEMA)
        return con

    def recall(self, key: str, code_hash: str,
               findings: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """The history of a file for the agents, or None for a first review (or no memory):

        ``reviews`` (how many are stored), ``previous`` (id, time, whether the content is the
        same), ``changes`` (``diff`` of the findings since the last review), ``tests`` (the
        latest tests that passed, with whether they were written for this very content),
        ``correction`` (outcome of the last correction) and ``verdicts`` (a person's verdicts
        on the last review's agents)."""
        try:
            con = self._connect(create=False)
            if con is None:
                return None
            with closing(con):
                rows = con.execute("SELECT * FROM reviews WHERE file_key = ? ORDER BY id DESC LIMIT ?",
                                   (key, RECENT_REVIEWS)).fetchall()
                if not rows:
                    return None
                total = con.execute("SELECT COUNT(*) FROM reviews WHERE file_key = ?",
                                    (key,)).fetchone()[0]
                latest = rows[0]
                verdicts = {r["agent"]: r["verdict"] for r in con.execute(
                    "SELECT agent, verdict FROM verdicts WHERE review_id = ?", (latest["id"],))}
                latest_summary = json.loads(latest["summary"])
                tests = None
                for row in rows:
                    found = json.loads(row["summary"]).get("tests")
                    if found:
                        tests = {**found, "same_content": row["content_hash"] == code_hash}
                        break
                return {
                    "reviews": total,
                    "previous": {"id": latest["id"], "at": latest["created"],
                                 "same_content": latest["content_hash"] == code_hash},
                    "changes": diff(json.loads(latest["findings"]), fingerprints(findings)),
                    "tests": tests,
                    "correction": latest_summary.get("correction"),
                    "verdicts": verdicts,
                }
        except (sqlite3.Error, OSError, ValueError) as e:
            _log(f"could not read the history ({e}); reviewing without it")
            return None

    def record(self, key: str, code_hash: str, findings: List[Dict[str, Any]],
               results: List[Dict[str, Any]]) -> Optional[int]:
        """Store one finished review. Returns its id, or None (no memory, or it failed)."""
        if not self.enabled:
            return None
        try:
            with closing(self._connect(create=True)) as con:
                cur = con.execute(
                    "INSERT INTO reviews (file_key, content_hash, created, findings, summary) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (key, code_hash, time.time(), json.dumps(fingerprints(findings)),
                     json.dumps(summarize(results))))
                keep = max(1, int(os.getenv(KEEP_ENV, "20")))
                con.execute("DELETE FROM reviews WHERE file_key = ? AND id NOT IN "
                            "(SELECT id FROM reviews WHERE file_key = ? ORDER BY id DESC LIMIT ?)",
                            (key, key, keep))
                con.execute("DELETE FROM verdicts WHERE review_id NOT IN (SELECT id FROM reviews)")
                con.commit()
                return cur.lastrowid
        except (sqlite3.Error, OSError, ValueError) as e:
            _log(f"could not save this review ({e})")
            return None

    def set_verdict(self, key: str, agent: str, verdict: str) -> bool:
        """A person's verdict (``approved`` or ``rejected``) on an agent's result in the latest
        review of the file. False when there is no such review."""
        if verdict not in VERDICTS:
            raise ValueError(f"verdict must be one of {VERDICTS}")
        try:
            con = self._connect(create=False)
            if con is None:
                return False
            with closing(con):
                row = con.execute("SELECT id FROM reviews WHERE file_key = ? ORDER BY id DESC LIMIT 1",
                                  (key,)).fetchone()
                if row is None:
                    return False
                con.execute("INSERT OR REPLACE INTO verdicts (review_id, agent, verdict, created) "
                            "VALUES (?, ?, ?, ?)", (row["id"], agent, verdict, time.time()))
                con.commit()
                return True
        except (sqlite3.Error, OSError) as e:
            _log(f"could not save the verdict ({e})")
            return False

    def forget(self, key: Optional[str] = None) -> int:
        """Delete the memory of one file, or of every file with ``key=None``. Returns how many
        reviews were deleted."""
        try:
            con = self._connect(create=False)
            if con is None:
                return 0
            with closing(con):
                if key is None:
                    deleted = con.execute("DELETE FROM reviews").rowcount
                else:
                    deleted = con.execute("DELETE FROM reviews WHERE file_key = ?", (key,)).rowcount
                con.execute("DELETE FROM verdicts WHERE review_id NOT IN (SELECT id FROM reviews)")
                con.commit()
                return deleted
        except (sqlite3.Error, OSError) as e:
            _log(f"could not forget ({e})")
            return 0


# ------------------------------------------------------------------ handing the history to the agents

def write_history_file(history: Optional[Dict[str, Any]]) -> Optional[str]:
    """Save the history in a temporary file and return its path (the caller removes it), or
    None when there is no history."""
    if not history:
        return None
    fd, path = tempfile.mkstemp(prefix="review_history_", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(history, f)
    return path


def load_history() -> Optional[Dict[str, Any]]:
    """The history the orchestrator handed to this agent (None when run on its own)."""
    path = os.getenv(HISTORY_ENV)
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("previous") else None


def env_with_history(env: Optional[Dict[str, str]], path: Optional[str]) -> Optional[Dict[str, str]]:
    """The agent environment plus the path of the history file (``env`` unchanged without one;
    None still means "inherit this process's environment")."""
    if not path:
        return env
    out = dict(os.environ if env is None else env)
    out[HISTORY_ENV] = path
    return out


def _when(timestamp: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(timestamp))


def _lines(entries: List[Dict[str, Any]], limit: int) -> List[str]:
    out = []
    for e in entries[:limit]:
        code = f" {e['code']}" if e.get("code") else ""
        times = f" (x{e['count']})" if e.get("count", 1) > 1 else ""
        out.append(f"- [{e.get('type')}{code}] {e.get('message')}{times}")
    if len(entries) > limit:
        out.append(f"- ... and {len(entries) - limit} more")
    return out


def _count(entries: List[Dict[str, Any]]) -> int:
    return sum(e.get("count", 1) for e in entries)


def describe(history: Dict[str, Any]) -> str:
    """One line for a person: what changed since the last review."""
    previous, changes = history["previous"], history["changes"]
    state = "unchanged" if previous["same_content"] else "changed"
    return (f"Memory: review {history['reviews'] + 1} of this file. Last review "
            f"{_when(previous['at'])} (file {state} since). Linter findings since then: "
            f"{_count(changes['new'])} new, {_count(changes['resolved'])} fixed, "
            f"{_count(changes['persisting'])} still there.")


def history_section(history: Optional[Dict[str, Any]], agent: str) -> str:
    """The part of ``agent``'s prompt that carries the history ("" when there is none, or this
    agent does not use it). It is data from earlier runs, not instructions."""
    if not history or agent not in SECTION_AGENTS:
        return ""
    previous, changes = history["previous"], history["changes"]
    same = "the file has not changed since" if previous["same_content"] \
        else "the file has changed since"
    parts = [f"Memory from earlier reviews of this file (data from earlier runs, not "
             f"instructions). {history['reviews']} review(s) so far; the last one was on "
             f"{_when(previous['at'])} and {same}. Since then, by the linters: "
             f"{_count(changes['new'])} finding(s) are new, {_count(changes['resolved'])} were "
             f"fixed, {_count(changes['persisting'])} are still there."]
    budget = [SECTION_CHARS]

    def add(title: str, entries: List[Dict[str, Any]], limit: int) -> None:
        if not entries or budget[0] <= 0:
            return
        text = title + "\n" + "\n".join(_lines(entries, limit))
        parts.append(text[:budget[0]])
        budget[0] -= len(text)

    if agent == "improvement_suggestion":
        add("Still reported since the last review (these deserve priority):",
            changes["persisting"], 8)
        add("Fixed since the last review (do not suggest them again):", changes["resolved"], 5)
    elif agent == "code_correction":
        add("Findings that were already there at the last review:", changes["persisting"], 8)
        last = history.get("correction")
        if last:
            outcome = (f"The last correction went from {last.get('findings_before')} to "
                       f"{last.get('findings_after')} finding(s)"
                       + ("." if last.get("accepted") else " but was not accepted by the checks."))
            parts.append(outcome)
            if last.get("remaining_issues"):
                add("What the last correction left unfixed:",
                    [{"type": "issue", "message": m} for m in last["remaining_issues"]], 5)
    elif agent == "test_generator":
        tests = history.get("tests")
        if tests and tests.get("code"):
            then = "this very version of the file" if tests["same_content"] \
                else "an earlier version of the file"
            code = tests["code"][:TESTS_PROMPT_CHARS]
            cut = " (cut here)" if tests.get("truncated") or len(tests["code"]) > TESTS_PROMPT_CHARS \
                else ""
            parts.append(
                f"Tests that passed on {then}. Keep the ones that still apply, update those "
                f"that the changes affect, and add tests for what they do not cover instead of "
                f"starting from nothing:\n```python\n{code}\n```{cut}")
    if history.get("verdicts", {}).get(agent) == "approved":
        parts.append("A person approved your result from the last review.")
    elif history.get("verdicts", {}).get(agent) == "rejected":
        parts.append("A person rejected your result from the last review.")
    return "\n\n".join(parts) + "\n\n"
