#!/usr/bin/env python3
"""
collect_runs.py - Read-only digest of completed SSSF factory runs, for the
morning-brief skill (Gate 2: the pre-merge conversation with the operator).

Reads <repo>/adws/adw_data/sssf.db exactly as the SSSF tracer writes it
(adws/adw_modules/tracer.py) - never opens it for writing, never touches the
target repo's working tree or git state. Stdlib only, no dependencies.
Generic on purpose: works against any repo that has SSSF stamped into it, not
just this one - the schema is the contract (tracer.py), not this repo's data.

Usage:
    python collect_runs.py [--repo PATH | --db PATH] [--since ISO8601 | --last N]
                            [--status any|success|fail] [--pretty]

    --repo PATH   target repo root; db is read from <repo>/adws/adw_data/sssf.db
                  (default: current directory)
    --db PATH     explicit path to sssf.db - overrides --repo
    --since T     only sessions that ENDED at or after this ISO8601 timestamp
    --last N      the N most recently completed sessions
                  (neither given: defaults to --last 5)
    --status      filter by session status: any (default), success, fail
    --pretty      pretty-print the JSON instead of one compact line

Prints one JSON object to stdout: {db_path, generated_at, filter, run_count,
runs: [...]}. Each entry in `runs` is one session's digest - adw_id, adw_name,
status, request, branch/worktree/title (if the run cut one), phase summary,
quality checks, gate results, tokens/cost, each phase's final
notes_for_next_agent, and `card`. branch, worktree and title all come from
the same `branch` trace event (stamped once, at worktree entry, by
adw_modules/runner.py's `Run._log_branch_and_title`) - `title` falls back to
a humanized branch slug for a run recorded before that event carried one; a
field the factory never recorded at all (e.g. every one of these, on a run
that never cut a branch) comes back null. This script never invents a value
to fill it.

`card` is the Kanban card (`<repo>/queue/*.md` or `<repo>/queue/done/*.md`,
the format `adws/dispatch.py` writes and `queue/TEMPLATE.md` documents) whose
`Adw-Id:` field matches this run's adw_id - {path, title, status, criteria}
where `criteria` is the "Acceptance criteria" checkbox list, each item
{text, done}. Read-only, same as everything else here: this script never
writes Status: or Adw-Id: back to a card, only dispatch.py does that. null
when no card names this adw_id - true for every direct/non-dispatched run,
and for any repo that has never used the queue at all. Never invented.

Exit codes:
    0   ok - digest printed (run_count may be 0, that is not an error)
    2   bad arguments (unparseable --since, non-positive --last)
    3   sssf.db not found at the resolved path
    4   sssf.db exists but could not be read (locked, corrupt, wrong schema)
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

EXIT_OK = 0
EXIT_BAD_ARGS = 2
EXIT_DB_NOT_FOUND = 3
EXIT_DB_ERROR = 4

DEFAULT_LAST = 5
CLIP_DEFAULT = 400


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def clip(text: object, limit: int = CLIP_DEFAULT) -> str | None:
    """Cap a string field so the digest stays compact. Never raises on None."""
    if text is None:
        return None
    s = str(text)
    if len(s) <= limit:
        return s
    return s[:limit].rstrip() + " ...[clipped]"


def parse_iso(value: str) -> datetime:
    """Accepts the tracer's own format (now_iso: milliseconds + offset) and
    the common relaxations a human would type (a bare date, a trailing Z)."""
    v = value.strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def safe_json(text: str | None, default: object = None) -> object:
    if not text:
        return default
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return default


# ── db access ─────────────────────────────────────────────────────────────

def resolve_db_path(repo: str, db: str | None) -> Path:
    if db:
        return Path(db)
    return Path(repo) / "adws" / "adw_data" / "sssf.db"


def open_db_readonly(db_path: Path) -> sqlite3.Connection:
    """mode=ro refuses to create or write the file - a read connection can
    still see a WAL-mode writer's committed data (that is what WAL is for)."""
    uri = db_path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


# ── per-session queries ──────────────────────────────────────────────────

def fetch_sessions(conn: sqlite3.Connection, since_dt: datetime | None,
                    last_n: int | None, status_filter: str) -> list[dict]:
    where = ["ended_at IS NOT NULL"]   # a run still in flight isn't briefable yet
    params: list[object] = []
    if status_filter != "any":
        where.append("status = ?")
        params.append(status_filter)
    if since_dt is not None:
        where.append("ended_at >= ?")
        params.append(since_dt.astimezone(timezone.utc).isoformat(timespec="milliseconds"))
    sql = "SELECT * FROM sessions WHERE " + " AND ".join(where) + " ORDER BY ended_at DESC"
    if last_n is not None:
        sql += " LIMIT ?"
        params.append(last_n)
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def fetch_branch_event(conn: sqlite3.Connection, adw_id: str) -> dict:
    """The latest `branch` trace event's payload for this run - `branch`,
    `path` (its worktree) and `title`, all stamped together at worktree entry
    (adw_modules/runner.py's `Run._log_branch_and_title`; see git_helper.py
    for how `title` is derived). `{}` when the run never reached that phase
    (a scout/prompt-only run, or one that failed before it) - callers read
    each key with `.get()` rather than assuming shape, and this function
    never guesses a branch from adw_id + slugify(request).

    ORDER BY DESC so a joined run's later re-prompt (a fresh `title`, the
    same `branch` - `Run.enter_worktree` logs a fresh event on every call)
    wins: the newest record is the one worth narrating.
    """
    rows = conn.execute(
        "SELECT payload_json FROM events "
        "WHERE adw_id = ? AND type = 'log' AND name = 'branch' "
        "ORDER BY started_at DESC", (adw_id,),
    ).fetchall()
    for r in rows:
        payload = safe_json(r["payload_json"], {})
        if isinstance(payload, dict) and payload.get("branch"):
            return payload
    return {}


def humanize_slug(slug: str) -> str:
    """Mirrors adw_modules/git_helper.py's `humanize_slug` exactly: dashes to
    spaces, sentence case. "add-a-clamp-helper" -> "Add a clamp helper". Used
    only as `title_for_event`'s fallback, for a `branch` event recorded
    before it carried a `title` (older telemetry)."""
    words = [w for w in slug.split("-") if w]
    if not words:
        return slug
    text = " ".join(words)
    return text[0].upper() + text[1:]


def title_for_event(branch_event: dict) -> str | None:
    """The run's human title: the trace's own record when present, else the
    branch slug humanized, else None (no branch at all - never invented)."""
    title = branch_event.get("title")
    if title:
        return str(title)
    branch = branch_event.get("branch")
    if not branch:
        return None
    slug = branch.split("_", 1)[1] if "_" in branch else ""
    return humanize_slug(slug) if slug else None


def fetch_phases(conn: sqlite3.Connection, adw_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT phase_id, seq, name, kind, owner, status, attempt, retries, "
        "error, started_at, ended_at FROM phases WHERE adw_id = ? ORDER BY seq",
        (adw_id,),
    ).fetchall()
    return [
        {
            "phase_id": r["phase_id"],
            "seq": r["seq"],
            "name": r["name"],
            "kind": r["kind"],
            "owner": r["owner"],
            "status": r["status"],
            "attempt": r["attempt"],
            "retries": r["retries"],
            "error": clip(r["error"], 300),
            "started_at": r["started_at"],
            "ended_at": r["ended_at"],
        }
        for r in rows
    ]


def fetch_quality_checks(conn: sqlite3.Connection, adw_id: str) -> list[dict]:
    """Per-check evidence from the quality phase's `quality:<check>` tool_call
    events (adw_modules/quality.py) - one row per lint/typecheck/test/scan
    command, each with its own pass/fail/incomplete verdict (never collapsed
    to a bool - see QualityStatus in data_types.py)."""
    rows = conn.execute(
        "SELECT name, payload_json FROM events "
        "WHERE adw_id = ? AND type = 'tool_call' AND name LIKE 'quality:%' "
        "ORDER BY started_at", (adw_id,),
    ).fetchall()
    checks = []
    for r in rows:
        payload = safe_json(r["payload_json"], {}) or {}
        checks.append({
            "check": r["name"].split(":", 1)[1] if ":" in r["name"] else r["name"],
            "area": payload.get("area"),
            "operation": payload.get("operation"),
            "status": payload.get("status"),
            "returncode": payload.get("returncode"),
            "command": clip(payload.get("command"), 200),
        })
    return checks


def fetch_gates(conn: sqlite3.Connection, adw_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT phase_id, attempt, gate, passed, violations_json, checks_json, "
        "created_at FROM gate_results WHERE adw_id = ? ORDER BY created_at",
        (adw_id,),
    ).fetchall()
    return [
        {
            "phase_id": r["phase_id"],
            "attempt": r["attempt"],
            "gate": r["gate"],
            "passed": bool(r["passed"]),
            "violations": safe_json(r["violations_json"], []),
            "checks": safe_json(r["checks_json"], []),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def fetch_envelope_notes(conn: sqlite3.Connection, adw_id: str,
                          phase_name_by_id: dict[str, str]) -> list[dict]:
    """The FINAL valid envelope per phase (highest attempt) - a retried phase
    produced more than one, and only the last one is what actually shipped.
    `notes_for_next_agent` is what the run itself said carries forward; it is
    quoted, never rephrased, so the brief can't put words in the agent's
    mouth."""
    rows = conn.execute(
        "SELECT phase_id, agent, payload_json, attempt FROM envelopes "
        "WHERE adw_id = ? AND valid = 1 ORDER BY phase_id, attempt ASC",
        (adw_id,),
    ).fetchall()
    latest_by_phase: dict[str, sqlite3.Row] = {}
    for r in rows:
        latest_by_phase[r["phase_id"]] = r  # ASC order -> last write wins -> highest attempt

    notes = []
    for phase_id, r in latest_by_phase.items():
        payload = safe_json(r["payload_json"], {}) or {}
        if not isinstance(payload, dict):
            payload = {}
        entry = {
            "phase": phase_name_by_id.get(phase_id, phase_id),
            "agent": r["agent"],
            "summary": clip(payload.get("summary"), 300),
            "notes_for_next_agent": clip(payload.get("notes_for_next_agent"), 300),
        }
        # Carry a few common envelope-specific fields through as-is when the
        # agent's output type included them (BuildOutput/DocumentOutput/
        # ReviewOutput in data_types.py) - never invented when absent.
        for key in ("commit_message", "document_path", "approved", "changed_files"):
            if key in payload:
                entry[key] = payload[key]
        notes.append(entry)
    notes.sort(key=lambda e: e["phase"] or "")
    return notes


# ── card lookup (queue/*.md, queue/done/*.md) ───────────────────────────────
#
# Deliberately its own small parser rather than an import of adws/dispatch.py:
# this script must stay generic across any SSSF repo (stdlib only, no
# dependency on a target repo's own adws/ package being importable, or even
# present under that name). It mirrors dispatch.py's `parse_header` grammar
# on purpose - same H1 + `Key: value` block rule apps/ui/server/queue.ts's
# `parseHeaderBlock` also mirrors - so a card dispatch.py would accept is the
# same card this finds. Three independent implementations agreeing by
# convention, the same pattern dispatch.py itself already uses.

CARD_H1_RE = re.compile(r"^#\s+(.+?)\s*$")
CARD_HEADER_LINE_RE = re.compile(r"^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$")
CARD_ACCEPTANCE_HEADING_RE = re.compile(r"acceptance criteria", re.IGNORECASE)
CARD_CHECKBOX_RE = re.compile(r"^-\s*\[([ xX])\]\s*(.+?)\s*$")


def parse_card_header(text: str) -> dict:
    """H1 title + the contiguous `Key: value` block directly under it, plus
    the raw line list (for the acceptance-criteria scan below). `title` is
    None when there is no H1 at all - such a file is malformed the same way
    dispatch.py's own parser would refuse it, so `find_card` skips it rather
    than guessing which card it might be."""
    lines = text.splitlines()
    title = None
    h1_index = None
    for i, line in enumerate(lines):
        m = CARD_H1_RE.match(line)
        if m:
            h1_index, title = i, m.group(1)
            break

    fields: dict[str, str] = {}
    if h1_index is not None:
        i = h1_index + 1
        while i < len(lines) and lines[i].strip() == "":
            i += 1
        while i < len(lines):
            line = lines[i]
            if line.strip() == "":
                break
            m = CARD_HEADER_LINE_RE.match(line)
            if not m:
                break
            fields[m.group(1).lower()] = m.group(2).strip()
            i += 1

    return {"title": title, "fields": fields, "lines": lines}


def parse_acceptance_criteria(lines: list[str]) -> list[dict]:
    """The "Acceptance criteria" checkbox list from a card's body -
    `- [ ] ...` / `- [x] ...` lines, in order, starting right after the first
    line that mentions "acceptance criteria" (queue/TEMPLATE.md's
    `**Acceptance criteria:**` lead-in) and running until the first line that
    is neither a checkbox nor blank (the template's next `**...**` field).
    `[]` (not None) when the card has no such section at all - an honest
    "this card recorded no criteria", not a guess at what they might be."""
    start = None
    for i, line in enumerate(lines):
        if CARD_ACCEPTANCE_HEADING_RE.search(line):
            start = i + 1
            break
    if start is None:
        return []

    criteria = []
    for line in lines[start:]:
        stripped = line.strip()
        if stripped == "":
            continue
        m = CARD_CHECKBOX_RE.match(stripped)
        if not m:
            break
        mark, text = m.groups()
        criteria.append({"text": clip(text, 200), "done": mark.lower() == "x"})
    return criteria


def find_card(repo_root: Path, adw_id: str) -> dict | None:
    """The queue/*.md or queue/done/*.md card whose Adw-Id: field matches
    this run - {path, title, status, criteria} - or None when no card on
    disk names this adw_id (a direct/non-dispatched run, or a repo that has
    never used the queue). Read-only: opens files for reading only, never
    writes Status: or Adw-Id: back (that is dispatch.py's job alone).
    `path` is relative to `repo_root`, POSIX-style, for a stable, portable
    field. First matching file wins if more than one somehow claims the same
    adw_id (should not happen - dispatch.py's own `claim()` prevents it)."""
    queue_dir = repo_root / "queue"
    if not queue_dir.is_dir():
        return None

    candidates: list[Path] = []
    for sub in (queue_dir, queue_dir / "done"):
        if sub.is_dir():
            candidates.extend(sorted(
                p for p in sub.iterdir()
                if p.is_file() and p.suffix.lower() == ".md" and p.name != "TEMPLATE.md"
            ))

    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue   # unreadable or badly-encoded card is a gap, not a crash - keep looking
        parsed = parse_card_header(text)
        if parsed["title"] is None:
            continue   # malformed (no H1) - not a card either parser would accept
        if parsed["fields"].get("adw-id", "") != adw_id:
            continue
        return {
            "path": path.relative_to(repo_root).as_posix(),
            "title": clip(parsed["title"], 200),
            "status": parsed["fields"].get("status"),
            "criteria": parse_acceptance_criteria(parsed["lines"]),
        }
    return None


def build_digest(conn: sqlite3.Connection, session: dict, repo_root: Path) -> dict:
    adw_id = session["adw_id"]
    phases = fetch_phases(conn, adw_id)
    phase_name_by_id = {p["phase_id"]: p["name"] for p in phases}
    quality_phase = next((p for p in phases if p["name"] == "quality"), None)

    started, ended = session.get("started_at"), session.get("ended_at")
    duration_seconds = None
    if started and ended:
        try:
            duration_seconds = round((parse_iso(ended) - parse_iso(started)).total_seconds(), 1)
        except ValueError:
            duration_seconds = None

    branch_event = fetch_branch_event(conn, adw_id)
    digest = {
        "adw_id": adw_id,
        "adw_name": session.get("adw_name"),
        "status": session.get("status"),
        "engineer": session.get("engineer"),
        "request": clip(session.get("request"), 300),
        "started_at": started,
        "ended_at": ended,
        "duration_seconds": duration_seconds,
        "branch": branch_event.get("branch") or None,
        # The worktree path, from the same event - null (not omitted) for a
        # run that never cut a branch, or one recorded before this event
        # existed at all, so a reader never mistakes silence for "no
        # worktree was used".
        "worktree": branch_event.get("path") or None,
        # The run's human name - MAP.md's worktree-naming ticket ("an id
        # tells me nothing"). See `title_for_event`.
        "title": title_for_event(branch_event),
        "tokens": {
            "total_tokens": session.get("total_tokens") or 0,
            "total_cost": session.get("total_cost") or 0.0,
        },
        "phases": phases,
        "quality": None,
        "gates": fetch_gates(conn, adw_id),
        "notes_for_next_agent": fetch_envelope_notes(conn, adw_id, phase_name_by_id),
        "card": find_card(repo_root, adw_id),
    }

    if quality_phase is not None:
        checks = fetch_quality_checks(conn, adw_id)
        statuses = [c["status"] for c in checks if c.get("status")]
        digest["quality"] = {
            "phase_status": quality_phase["status"],
            "checks": checks,
            "pass_count": statuses.count("pass"),
            "fail_count": statuses.count("fail"),
            "incomplete_count": statuses.count("incomplete"),
            "phase_error": quality_phase["error"],
        }

    return digest


# ── CLI ───────────────────────────────────────────────────────────────────

def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Print a compact JSON digest of completed SSSF factory "
                    "runs, read-only, for the morning-brief skill.")
    p.add_argument("--repo", default=".",
                  help="target repo root; db is <repo>/adws/adw_data/sssf.db (default: .)")
    p.add_argument("--db", default=None,
                  help="explicit path to sssf.db - overrides --repo")
    sel = p.add_mutually_exclusive_group()
    sel.add_argument("--since", metavar="ISO8601",
                     help="only sessions that ended at or after this timestamp")
    sel.add_argument("--last", type=int, metavar="N",
                     help="the N most recently completed sessions")
    p.add_argument("--status", choices=["any", "success", "fail"], default="any",
                  help="filter by session status (default: any)")
    p.add_argument("--pretty", action="store_true",
                  help="pretty-print the JSON instead of one compact line")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)

    since_dt = None
    if args.since:
        try:
            since_dt = parse_iso(args.since)
        except ValueError as exc:
            eprint(f"ERROR: --since {args.since!r} is not a parseable ISO8601 "
                   f"timestamp ({exc}). Try e.g. 2026-08-12T08:00:00+00:00")
            return EXIT_BAD_ARGS

    last_n = args.last
    if last_n is not None and last_n <= 0:
        eprint(f"ERROR: --last must be a positive integer, got {args.last}")
        return EXIT_BAD_ARGS
    if since_dt is None and last_n is None:
        last_n = DEFAULT_LAST  # KISS default: brief on the most recent handful

    db_path = resolve_db_path(args.repo, args.db)
    # The card lookup's own root - always --repo (default "."), independent
    # of --db overriding where sssf.db itself is read from, since queue/
    # lives beside adws/adw_data/ in the repo --repo names.
    repo_root = Path(args.repo)
    if not db_path.exists():
        message = (
            f"no sssf.db at {db_path} - this repo has not run any SSSF factory "
            f"sessions yet, or --repo/--db points somewhere else. Expected "
            f"<repo>/adws/adw_data/sssf.db."
        )
        eprint("ERROR:", message)
        print(json.dumps({"error": message, "db_path": str(db_path)}))
        return EXIT_DB_NOT_FOUND

    conn = None
    try:
        conn = open_db_readonly(db_path)
        sessions = fetch_sessions(conn, since_dt, last_n, args.status)
        runs = [build_digest(conn, s, repo_root) for s in sessions]
    except sqlite3.Error as exc:
        message = f"could not read {db_path}: {exc}"
        eprint("ERROR:", message)
        print(json.dumps({"error": message, "db_path": str(db_path)}))
        return EXIT_DB_ERROR
    finally:
        if conn is not None:
            conn.close()

    output = {
        "db_path": str(db_path),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "filter": {
            "since": since_dt.astimezone(timezone.utc).isoformat(timespec="milliseconds")
                    if since_dt else None,
            "last": last_n,
            "status": args.status,
        },
        "run_count": len(runs),
        "runs": runs,
    }
    print(json.dumps(output, indent=2 if args.pretty else None, ensure_ascii=True))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
