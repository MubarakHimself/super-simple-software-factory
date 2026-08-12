#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""dispatch - the seam between the Board and the factory.

Usage:
    uv run adws/dispatch.py queue/001-add-health-endpoint.md
    uv run adws/dispatch.py --next
    uv run adws/dispatch.py queue/001-add-health-endpoint.md --adw-id a1b2c3d4
    uv run adws/dispatch.py --next --config adws/adw_sssf_config/sssf.config.yaml

Picks up one `queue/*.md` item (header contract in `queue/TEMPLATE.md`, Status
vocabulary owned by `apps/ui/server/queue.ts` - matched here, never
reinvented), routes it to the writing ADW named on its `Adw:` line, runs that
ADW as a subprocess - on its own branch, in its own worktree, the ADW itself
cuts that (`specs/worktrees.md`) - and writes the Status back to the card as
it goes: ready-for-agent -> running -> done | blocked. The prompt handed to
the ADW leads with the card's H1 title (see `request_prompt`) so the branch
slug the ADW derives from it is legible (specs/worktrees.md 3.2) - the full
body follows untouched, still the ADW's whole task.

A command, not a daemon (MAP rule 1, KISS): one dispatch, one subprocess, two
write-backs (claim, then terminal). It never moves the file to `queue/done/` -
that is the MERGE event, and Gate owns it (`specs/ui.md` 5.4), which reads
`sessions.status` and git directly and never this file's Status: line.

Deliberately NOT an adw_*.py script: dispatch never opens its own session, so
routing a bad item never litters a `sessions` row with it (same reasoning as
`adws/worktrees.py`). The ADW it launches opens its own session as normal.

Idempotence: a queue item already `Status: running` is refused unless
`--adw-id` names the rejoin on purpose - two dispatches of the same file must
never both start an ADW. A `blocked` (failed) item re-dispatched with no
`--adw-id` reuses the Adw-Id already on the card by itself: there is no
running process to collide with, and rejoining the same run continues in the
SAME worktree/branch rather than orphaning the failed attempt's.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml
from adw_modules import agents, git_helper
from adw_modules.utils import new_id, operator_env
from pydantic import ValidationError

# ── the Board's vocabulary — owned by apps/ui/server/queue.ts's VALID_STATUSES
# and documented in queue/TEMPLATE.md's comment. Mirrored here (cross-language:
# the UI is TypeScript, this is Python) rather than invented in parallel -
# adws/tests/test_dispatch.py checks this constant against both source files.
READY = "ready-for-agent"
RUNNING = "running"
BLOCKED = "blocked"
DONE = "done"
QUEUE_STATUSES = (READY, RUNNING, BLOCKED, DONE)

# The 8 writing ADWs (specs/worktrees.md 4.1) — the only ones dispatch may
# route to. The 4 read-only ADWs (adw_prompt, adw_scout, adw_plan, adw_quality)
# cut no branch and have no place on a Kanban card that expects a merge.
KNOWN_WRITING_ADWS = (
    "build", "build-review", "build-test", "document",
    "plan-build", "plan-build-test", "plan-build-test-quality", "simple-sdlc",
)

H1_RE = re.compile(r"^#\s+(.+?)\s*$")
HEADER_LINE_RE = re.compile(r"^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$")


class DispatchError(RuntimeError):
    """A problem this command can name precisely — never a raw traceback."""


@dataclass
class QueueHeader:
    """One parsed queue/*.md file — lines kept verbatim so write-back touches
    only the Status:/Adw-Id: lines and nothing else (title, body, comments,
    even stray whitespace survive byte for byte)."""
    lines: list[str]
    trailing_newline: bool
    title: str
    fields: dict[str, str]
    field_lines: dict[str, int]     # key -> index into `lines`
    body_start: int                 # first line index after the header block


# ── parsing (mirrors apps/ui/server/queue.ts's parseHeaderBlock exactly) ────

def parse_header(text: str) -> QueueHeader:
    """An H1, then the contiguous run of `Key: value` lines directly under
    it — the same rule the Board's own parser applies, so a file that one
    parser calls malformed is malformed to both."""
    lines = text.splitlines()
    h1_index = None
    title = ""
    for i, line in enumerate(lines):
        m = H1_RE.match(line)
        if m:
            h1_index = i
            title = m.group(1)
            break
    if h1_index is None:
        raise DispatchError('no H1 title found (expected "# Title" on its own line)')

    i = h1_index + 1
    while i < len(lines) and lines[i].strip() == "":
        i += 1

    fields: dict[str, str] = {}
    field_lines: dict[str, int] = {}
    while i < len(lines):
        line = lines[i]
        if line.strip() == "":
            break
        m = HEADER_LINE_RE.match(line)
        if not m:
            break
        key = m.group(1).lower()
        fields[key] = m.group(2).strip()
        field_lines[key] = i
        i += 1

    if "status" not in fields:
        raise DispatchError("missing Status: line under the H1")
    if fields["status"] not in QUEUE_STATUSES:
        raise DispatchError(
            f"unknown Status: {fields['status']!r} (expected one of "
            f"{', '.join(QUEUE_STATUSES)})")

    return QueueHeader(lines=lines, trailing_newline=text.endswith("\n"), title=title,
                       fields=fields, field_lines=field_lines, body_start=i)


def body_of(header: QueueHeader) -> str:
    """Everything below the header block — the AGENT-BRIEF.md contract the
    triage skill wrote — the ADW's actual task, verbatim."""
    return "\n".join(header.lines[header.body_start:]).lstrip("\n")


def request_prompt(header: QueueHeader) -> str:
    """The single string handed to the ADW's CLI: its request prompt AND —
    inside `Run.enter_worktree` (specs/worktrees.md 3.2) — its branch-slug
    source, since both read the same one positional argument. `slugify`
    takes the first four words of whatever comes first, so leading with the
    card's H1 title yields a legible slug ("add-a-health-endpoint") instead
    of one built from the Agent Brief boilerplate every card starts with
    ("agent-brief-category-enhancement" — the same four words on every
    card, useless as a directory name). The body that follows is untouched
    byte for byte: the ADW's task is still the full card content, only the
    slug source changes."""
    return f"{header.title}\n\n{body_of(header)}"


def _render(header: QueueHeader) -> str:
    text = "\n".join(header.lines)
    return text + "\n" if header.trailing_newline else text


def write_status(path: Path, header: QueueHeader, status: str, adw_id: str | None = None) -> None:
    """Rewrites ONLY the Status:/Adw-Id: lines in place — title, body, and
    every other byte survive untouched. The UI never writes queue files
    (specs/ui.md 5.3); this is the one place that does, on the operator's own
    `just work` command."""
    if "status" not in header.field_lines:
        raise DispatchError(f"{path}: missing Status: line - cannot write back")
    header.lines[header.field_lines["status"]] = f"Status: {status}"
    header.fields["status"] = status
    if adw_id is not None:
        if "adw-id" not in header.field_lines:
            raise DispatchError(f"{path}: missing Adw-Id: line - cannot write back")
        header.lines[header.field_lines["adw-id"]] = f"Adw-Id: {adw_id}"
        header.fields["adw-id"] = adw_id
    path.write_text(_render(header), encoding="utf-8")


# ── routing ──────────────────────────────────────────────────────────────────

def resolve_script(main_root: Path, adw_value: str) -> Path:
    """`Adw: simple-sdlc` -> adws/adw_simple_sdlc.py, or a clear rejection."""
    if adw_value not in KNOWN_WRITING_ADWS:
        raise DispatchError(
            f"Adw: {adw_value!r} is not a known writing workflow. Expected "
            f"one of: {', '.join(KNOWN_WRITING_ADWS)}.")
    script = main_root / "adws" / f"adw_{adw_value.replace('-', '_')}.py"
    if not script.is_file():
        raise DispatchError(f"Adw: {adw_value!r} resolves to {script}, which "
                            f"does not exist on disk.")
    return script


def claim(path: Path, header: QueueHeader, adw_id_override: str | None) -> str:
    """The adw_id this dispatch will use, or a refusal — pure w.r.t. the
    filesystem (reads only the already-parsed header, writes nothing).

    Refuses a `Status: running` item unless `--adw-id` names the rejoin on
    purpose (two dispatches of the same file must never both start an ADW).
    Any other status reuses the card's existing Adw-Id automatically when one
    is already on it — a `blocked` retry rejoins its own prior run's
    branch/worktree rather than orphaning it — and mints a fresh one only when
    the card has never been claimed."""
    status = header.fields["status"]
    existing_id = header.fields.get("adw-id", "")
    if status == RUNNING and adw_id_override is None:
        raise DispatchError(
            f"{path} is already {RUNNING} (adw_id={existing_id or '?'}). Pass "
            f"--adw-id {existing_id or '<id>'} to rejoin it on purpose, or "
            f"leave it alone if it is really still working.")
    if adw_id_override and existing_id and adw_id_override != existing_id:
        raise DispatchError(
            f"{path} already carries Adw-Id: {existing_id}, which does not "
            f"match --adw-id {adw_id_override}.")
    return adw_id_override or existing_id or new_id(8)


def pick_next(queue_dir: Path) -> Path:
    """The lowest-numbered queue/*.md item whose Status is READY — filenames
    sort lexicographically, which is numeric order because NNN is zero-padded
    (queue/TEMPLATE.md's own contract). Non-recursive, same as the Board's own
    reader — `queue/done/` is a directory and never a candidate."""
    if not queue_dir.is_dir():
        raise DispatchError(f"no queue directory at {queue_dir}")
    candidates = sorted(
        p for p in queue_dir.iterdir()
        if p.is_file() and p.suffix.lower() == ".md" and p.name != "TEMPLATE.md")
    for candidate in candidates:
        try:
            header = parse_header(candidate.read_text(encoding="utf-8"))
        except (DispatchError, OSError):
            continue   # malformed items are the Board's "Unparsed" bucket, not --next's business
        if header.fields.get("status") == READY:
            return candidate
    raise DispatchError(f"no {READY!r} item in {queue_dir}")


# ── running the ADW ──────────────────────────────────────────────────────────

def _stream(cmd: list[str], *, cwd: Path, env: dict[str, str]) -> int:
    """Runs the ADW as a child process with its console output streamed
    through live — the operator watches `just work` exactly the way they
    watch `just simple-sdlc` directly. utf-8 pinned at this one pipe (MAP.md's
    landmine: per-site pins, never an ambient PYTHONUTF8)."""
    process = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                               errors="replace", bufsize=1)
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="")
    return process.wait()


def dispatch(path: Path, *, main_root: Path, config: str, adw_id_override: str | None) -> int:
    """The whole seam: claim -> route -> run -> write back.

    Returns the child ADW's own exit code, except for a dispatcher-level
    refusal (bad Adw:, already in-progress, missing header lines), which
    returns 2 and touches the file not at all."""
    if not path.is_file():
        print(f"dispatch: no such queue item: {path}", file=sys.stderr)
        return 2

    try:
        header = parse_header(path.read_text(encoding="utf-8"))
        script = resolve_script(main_root, header.fields.get("adw", ""))
        adw_id = claim(path, header, adw_id_override)
        write_status(path, header, RUNNING, adw_id=adw_id)
    except DispatchError as error:
        print(f"dispatch: {error}", file=sys.stderr)
        return 2
    print(f"dispatch: {path} -> {script.name} (adw_id={adw_id}, status={RUNNING})")

    prompt = request_prompt(header)
    cmd = ["uv", "run", str(script.relative_to(main_root)), prompt,
          "--config", config, "--adw-id", adw_id]
    try:
        returncode = _stream(cmd, cwd=main_root, env=operator_env())
    except OSError as error:
        print(f"dispatch: could not start {script.name}: {error}", file=sys.stderr)
        returncode = 1

    terminal = DONE if returncode == 0 else BLOCKED
    write_status(path, header, terminal)
    print(f"dispatch: {script.name} exited {returncode} -> Status: {terminal} ({path})")
    return returncode


# ── CLI ──────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", nargs="?", default=None, help="queue/NNN-slug.md to dispatch")
    parser.add_argument("--next", action="store_true",
                        help=f"dispatch the lowest-numbered {READY!r} item")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--queue-dir", default=None,
                        help="override the queue directory (default: <repo root>/queue)")
    parser.add_argument("--adw-id", default=None,
                        help="rejoin an in-progress item, or pin a fresh one's id")
    args = parser.parse_args(argv)

    if bool(args.file) == bool(args.next):
        parser.error("pass exactly one of a queue file path, or --next")

    main_root = git_helper.repo_root()
    queue_dir = Path(args.queue_dir) if args.queue_dir else main_root / "queue"

    try:
        agents.load_config(args.config)   # fail fast, before spawning anything
    except (OSError, yaml.YAMLError, ValidationError) as error:
        print(f"dispatch: could not load {args.config}: {error}", file=sys.stderr)
        return 2

    try:
        path = Path(args.file) if args.file else pick_next(queue_dir)
    except DispatchError as error:
        print(f"dispatch: {error}", file=sys.stderr)
        return 2

    return dispatch(path, main_root=main_root, config=args.config, adw_id_override=args.adw_id)


if __name__ == "__main__":
    sys.exit(main())
