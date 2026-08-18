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
that happens once the factory has integrated the run's branch into
`integration` (MAP.md's integration-branch ruling, 2026-08-15: the engine
rebases + re-runs the quality suite + ff-merges, autonomously), and parking
the card is the engine's own job at that point, never this script's.

Deliberately NOT an adw_*.py script: dispatch never opens its own session, so
routing a bad item never litters a `sessions` row with it (same reasoning as
`adws/worktrees.py`). The ADW it launches opens its own session as normal.

Idempotence: a queue item already `Status: running` is refused unless
`--adw-id` names the rejoin on purpose - two dispatches of the same file must
never both start an ADW. A `blocked` (failed) item re-dispatched with no
`--adw-id` reuses the Adw-Id already on the card by itself: there is no
running process to collide with, and rejoining the same run continues in the
SAME worktree/branch rather than orphaning the failed attempt's.

Needs: a card's optional `Needs:` header (queue/TEMPLATE.md's contract) names
other card basenames this one is blocked on, and an edge is met when that card
is MERGED - parked in `queue/done/` - not merely `done`. `read_card_header`
and `needs_satisfied` below are importable helpers - the engine (MAP.md's
"two-box model") uses them to decide what is dispatchable at all. This script
uses the same `needs_satisfied` to refuse a direct dispatch of a card whose
needs are not yet met: one line naming what is still outstanding, nonzero
exit, the file untouched.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from adw_modules import agents, git_helper
from adw_modules.utils import new_id, operator_env, uv_cmd
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

# The roster this dispatch routes to. `SSSF_CONFIG` is the factory's ONE way
# of naming a different one - the justfile reads the same variable
# (`config := env_var_or_default("SSSF_CONFIG", ...)`) - so a systemd unit, a
# shell, and a recipe all select a roster the same way. The engine passes
# --config explicitly to every dispatch it starts.
DEFAULT_CONFIG = "adws/adw_sssf_config/sssf.config.yaml"

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


# ── needs ─────────────────────────────────────────────────────────────────────

def _parse_needs(value: str) -> list[str]:
    """The Needs: line's raw value -> a clean list of card basenames.
    Comma-separated, whitespace trimmed off each; an absent or empty value
    (or one that is only commas/whitespace) yields []."""
    return [part.strip() for part in value.split(",") if part.strip()]


def read_card_header(path: Path) -> dict[str, Any]:
    """Parses one queue/*.md card into a plain dict for importers outside
    this module (the engine, built next) - every Key: value line under the
    H1 as its raw string, except `needs`, which is split into the list of
    basenames it names (queue/TEMPLATE.md's contract; absent or empty -> [])."""
    header = parse_header(Path(path).read_text(encoding="utf-8"))
    # dict[str, Any], not header.fields' dict[str, str]: `needs` is the one
    # field that comes back parsed (a list of basenames) rather than raw.
    fields: dict[str, Any] = dict(header.fields)
    fields["needs"] = _parse_needs(header.fields.get("needs", ""))
    return fields


def needs_satisfied(card_path: Path, main_root: Path) -> tuple[bool, list[str]]:
    """Checks one card's Needs: list against the queue on disk. A named card
    satisfies its edge once it is parked in queue/done/ - the point at which
    the factory has integrated it into `integration` and moved its card
    there itself (MAP.md's integration-branch ruling, 2026-08-15) - and not
    one moment before.

    `Status: done` while the card still sits in `queue/` is NOT enough, and
    that distinction is the whole reason this header exists. `done` means an
    ADW finished and pushed its own `adw/<id>_<slug>` branch; the work is not
    in `integration` until the engine rebases that branch onto current
    `integration`, re-runs the quality suite against the rebased tree, and
    only then ff-merges it. A dependent dispatched on `done` alone cuts its
    worktree from `integration` (`worktrees.ensure_run_worktree` bases a
    fresh run on trunk) - that is `integration` WITHOUT its dependency's
    code, so `Needs:` would order the dispatch and not the code, which is
    the one thing it exists to do. Waiting for the merge costs a gate;
    building on code that is not there costs the whole run, twice (the
    dependent re-implements what it cannot see, and the two branches then
    conflict).

    Everything else is unmet too - a dependency still running, one that came
    back `blocked`, or a basename matching no card file anywhere (fail closed:
    a typo'd or not-yet-published dependency never silently passes).

    Returns (True, []) once every need is met, else (False, unmet) with
    unmet holding the outstanding basenames in the order Needs: named them."""
    needs = read_card_header(card_path)["needs"]
    done_dir = Path(main_root) / "queue" / "done"
    unmet = [name for name in needs if not (done_dir / name).is_file()]
    return (not unmet, unmet)


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
        ok, unmet = needs_satisfied(path, main_root)
        if not ok:
            raise DispatchError(
                f"needs not satisfied - waiting on: {', '.join(unmet)} (a need is met "
                f"when the factory integrates the card into integration and parks it "
                f"in queue/done/)")
        script = resolve_script(main_root, header.fields.get("adw", ""))
        adw_id = claim(path, header, adw_id_override)
        write_status(path, header, RUNNING, adw_id=adw_id)
    except DispatchError as error:
        print(f"dispatch: {error}", file=sys.stderr)
        return 2
    print(f"dispatch: {path} -> {script.name} (adw_id={adw_id}, status={RUNNING})")

    prompt = request_prompt(header)
    # `uv` RESOLVED, never bare - the same fix, and the same reason, as
    # `engine.dispatch_command`. This is the second rung of the identical
    # chain: the engine spawns THIS process with a resolved uv, but the ADW
    # below it is a child of this process, launched with `operator_env()` -
    # which strips the venv bin off PATH, on a service PATH that has no
    # `~/.local/bin`. Left bare here, the engine's own fix would have bought
    # nothing under systemd: every dispatch would start, fail to launch its
    # ADW, and write `blocked` to its card. See `utils.uv_cmd`.
    cmd = [uv_cmd(), "run", str(script.relative_to(main_root)), prompt,
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
    parser.add_argument("--config", default=os.environ.get("SSSF_CONFIG") or DEFAULT_CONFIG,
                        help=f"the agent roster to run this card on (default: "
                             f"$SSSF_CONFIG, else {DEFAULT_CONFIG})")
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
