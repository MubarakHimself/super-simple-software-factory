#!/usr/bin/env -S uv run
"""ship_report - the shipping report that replaces the morning-brief ritual.

MAP.md's two-box model (2026-08-15): the engine ships cards onto `integration`
by itself - rebase, deterministic re-verify, fast-forward merge, park the card
to `queue/done/`. `main` only ever moves by ONE squash commit per finished
chunk, clicked by the operator in the UI. This script is what that click reads
first: a deterministic, code-assembled account of everything sitting on
`integration` that `main` does not have yet, so nobody has to eyeball a raw
`git log` to write the squash commit's own body.

THE CHUNK: every commit on `integration` since `main` last caught up with it.
The base is NOT `git merge-base main integration`: `main` moves by `git merge
--squash`, which records no merge parentage at all, so the merge-base never
advances past the original fork point and every chunk after the first would
re-list the cards that already shipped. What a squash DOES record is the
content - `main`'s new commit carries `integration`'s whole tree - so the base
is the newest commit on `integration` whose tree `main`'s history already
holds (`last_shipped_point` below), falling back to the merge-base when
nothing matches (the first chunk, before `main` has ever caught up). `--range
BASE..TIP` overrides both endpoints outright, to look at a different pair of
refs (a server checkout, a past chunk, a rehearsal). THE CHUNK'S CARDS: every
`queue/done/*.md` file that
entered `queue/done/` somewhere inside that range - matched first against the
engine's own park commit message (`engine.py`'s `park_card`: `"factory:
<card.name> integrated"`), and, for anything that message doesn't explain (a
hand-parked card, an older engine build, a differently-worded commit), against
the raw fact that the file appeared under `queue/done/` in the range at all.
Either way the file has to actually be there - a commit message alone, with no
matching file change, names nothing.

THE BOX WALK borrows morning-brief's honesty rule (`SKILL.md`'s "Never")
verbatim, tightened for a script with no notes_for_next_agent prose and no
agent judgment to lean on: a criterion reads `confirmed-by-record` only when
its own text names something this script can check mechanically against the
run's committed diff (a criterion whose text uses the WHOLE WORD "test"
against files that look like tests, one using the whole word "doc" against
files that look like docs - whole words, never substrings, or "the latest
reading", "the greatest value" and "the Dockerfile builds" would each be
answered with a file they have nothing to do with) AND the card's own
checkbox agrees. Every other criterion - which, for most real Acceptance
criteria lines, is most of them - reads `cannot-confirm-from-record`. That is
not a bug in the collector; free-form behavioral claims ("the endpoint
returns 200") are not something a diff of file names can verify, and this
script never pretends otherwise by inventing a semantic match. The card's own
checkbox is reported alongside every verdict, never trusted alone (a card can
say `- [x]` with nothing in the diff to back it).

PURE READ-ONLY: every git call here is a query (log, diff, rev-list, branch
--list, merge-base) - nothing writes to the repo, nothing spawns an agent,
nothing touches the network. Runs the same way from the laptop or the server,
against any checkout that has both `main` and `integration` (or whatever
--range names) reachable locally.

Usage:
    uv run adws/ship_report.py                    # --pr body, to stdout
    uv run adws/ship_report.py --pr
    uv run adws/ship_report.py --changelog
    uv run adws/ship_report.py --range abc123..def456
    uv run adws/ship_report.py --integration origin/integration
    uv run adws/ship_report.py --pr --out .git/SQUASH_BODY.md
    uv run adws/ship_report.py --repo /path/to/checkout

`just ship-report` is the justfile wrapper.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from adw_modules import git_helper

# ── the factory's own vocabulary, read not written ──────────────────────────
#
# Deliberately NOT `import dispatch` or `import engine`: both carry PEP 723
# metadata (pydantic/pyyaml/python-dotenv) or pull in modules that do
# (adw_modules.worktrees -> data_types -> pydantic), and this script has no
# inline `# /// script ///` header of its own (like clean.py, not like
# dispatch.py) - it runs on whatever `uv run` resolves for a plain script,
# stdlib plus adw_modules.git_helper, which is stdlib-only itself. The header
# grammar below mirrors dispatch.py's `parse_header` and the morning-brief
# skill's `collect_runs.py` on purpose (three independent readers of the same
# queue/TEMPLATE.md contract, agreeing by convention rather than a shared
# import - collect_runs.py's own comment explains why: it has to stay generic
# across any repo, and this script wants the same freedom from the project's
# heavier deps).
HUMAN_TRUNK = "main"                 # mirrors engine.py's HUMAN_TRUNK
DEFAULT_INTEGRATION = "integration"  # git_helper.factory_trunk()'s own default

H1_RE = re.compile(r"^#\s+(.+?)\s*$")
HEADER_LINE_RE = re.compile(r"^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$")
CRITERIA_HEADING_RE = re.compile(r"acceptance criteria", re.IGNORECASE)
CHECKBOX_RE = re.compile(r"^-\s*\[([ xX])\]\s*(.+?)\s*$")

# engine.py's `park_card`: `message = f"factory: {card.name} integrated"`.
# Matched literally - this is the one place that string is decided, and this
# regex is the only place outside engine.py that re-derives it.
PARK_MESSAGE_RE = re.compile(r"^factory: (.+) integrated$")

# `git log --name-status` line: a status code (A/M/D/R###/C###) then a tab
# then the path (renames/copies carry a SECOND tab-separated path - the new
# one - handled in `_walk_done_dir`).
NAME_STATUS_RE = re.compile(r"^([AMDRC]\d*)\t(.+)$")

# Mechanical evidence classes the box walk is willing to claim - nothing else
# is checkable from a diff of file names alone, so nothing else is claimed.
TEST_PATH_RE = re.compile(
    r"(^|/)(tests?)/|(^|/)test_[^/]+$|_test\.[a-z0-9]+$|\.(test|spec)\.[a-z0-9]+$",
    re.IGNORECASE)
DOC_PATH_RE = re.compile(
    r"(^|/)docs?/|(^|/)readme(\.|$)|(^|/)changelog(\.|$)", re.IGNORECASE)

# Which criteria those two evidence classes are even allowed to answer, matched
# on WHOLE WORDS. A bare `"test" in text` also fires on "latest", "greatest",
# "contest", "protest"; `"doc" in text` on "Dockerfile", "dock", "docket" - and
# every one of those would be printed as `confirmed-by-record` off a file the
# criterion never mentioned, which is exactly the invented semantic match this
# module's docstring promises never to make.
TEST_WORD_RE = re.compile(r"\b(tests?|tested|testing)\b", re.IGNORECASE)
DOC_WORD_RE = re.compile(r"\b(docs?|document|documents|documented|documenting|documentation)\b",
                         re.IGNORECASE)

CONFIRMED = "confirmed-by-record"
CANNOT_CONFIRM = "cannot-confirm-from-record"

MAX_LISTED_FILES = 5


class ShipReportError(RuntimeError):
    """A problem this script can name precisely - never a raw traceback."""


# ── card header + acceptance-criteria parsing (queue/TEMPLATE.md's grammar) ─

def parse_card(text: str) -> tuple[str | None, dict[str, str], list[str]]:
    """An H1, then the contiguous `Key: value` block directly under it - the
    same rule dispatch.py's `parse_header` and apps/ui/server/queue.ts's
    `parseHeaderBlock` both apply. Returns `(title, fields, lines)`; `title`
    is `None` for a file with no H1 at all, which is malformed the same way
    every other reader of this grammar would call it - the caller reports
    that as a gap, never guesses a title past the filename.
    """
    lines = text.splitlines()
    title: str | None = None
    h1_index: int | None = None
    for i, line in enumerate(lines):
        m = H1_RE.match(line)
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
            m = HEADER_LINE_RE.match(line)
            if not m:
                break
            fields[m.group(1).lower()] = m.group(2).strip()
            i += 1
    return title, fields, lines


def parse_acceptance_criteria(lines: list[str]) -> list[dict]:
    """The "Acceptance criteria" checkbox list from a card's body - borrowed
    verbatim from the morning-brief skill's `collect_runs.py`: `- [ ]` / `-
    [x]` lines, starting right after the first line mentioning "acceptance
    criteria" and running until the first line that is neither a checkbox nor
    blank. `[]` (not None) when the card has no such section - an honest "no
    criteria recorded", not a guess at what they might be.
    """
    start = None
    for i, line in enumerate(lines):
        if CRITERIA_HEADING_RE.search(line):
            start = i + 1
            break
    if start is None:
        return []

    criteria = []
    for line in lines[start:]:
        stripped = line.strip()
        if stripped == "":
            continue
        m = CHECKBOX_RE.match(stripped)
        if not m:
            break
        mark, text = m.groups()
        criteria.append({"text": text[:200], "done": mark.lower() == "x"})
    return criteria


def humanize_card_name(name: str) -> str:
    """Fallback title when a card can't be read or has no H1 - the filename
    minus its `NNN-` prefix and `.md` suffix, dashes to spaces, sentence
    case. Only used when `parse_card` found nothing better; never invented
    past that."""
    stem = re.sub(r"^\d+-", "", Path(name).stem)
    return git_helper.humanize_slug(stem)


# ── the chunk: a git range, and the cards parked inside it ──────────────────

def resolve_integration_ref(root: Path, ref: str) -> str:
    """`ref` itself when this checkout has it, else `origin/<ref>` when it
    does. An ordinary main-tracking clone has only ever FETCHED the factory's
    working line, so `refs/heads/integration` does not exist there and `git
    rev-parse integration` fails outright - it does not fall back to the
    remote-tracking ref on its own. Falling back here is what lets the gate
    run from such a checkout at all; the ref that was actually used is
    printed in the report's own range expression, so nothing is silent about
    it. A ref the caller already qualified (`origin/integration`, a sha) is
    left exactly as given."""
    if git_helper.ref_exists(ref, tree=root):
        return ref
    remote_ref = f"origin/{ref}"
    if "/" not in ref and git_helper.ref_exists(remote_ref, tree=root):
        return remote_ref
    return ref


def _trees_on(root: Path, ref: str) -> set[str]:
    """Every tree oid recorded anywhere in `ref`'s history - the content
    `ref` has already seen, whatever commits carried it there."""
    result = git_helper.run("log", "--format=%T", ref, tree=root)
    if result.returncode != 0:
        return set()
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def last_shipped_point(root: Path, human_ref: str, integration_ref: str, fork: str) -> str:
    """The newest commit on `integration` whose whole tree `main` already
    holds - i.e. where `main` last caught up. `fork` (the merge-base) when
    nothing matches, which is the first chunk, before `main` has caught up
    with anything.

    Why not the merge-base alone: `main` moves by ONE `git merge --squash`
    per chunk (MAP.md's two-box model, ship-check step 3.2), and a squash
    records no merge parentage - `git merge-base main integration` stays
    pinned at the original fork point forever, so from the second chunk on
    every card that already shipped would be listed again. The squash does
    leave one unambiguous receipt: it stages `integration`'s entire diff, so
    the commit it produces on `main` carries `integration`'s exact tree.
    Matching on that tree finds the shipped point with no tag, note or extra
    bookkeeping to keep in sync, and it works the same for a fast-forward or
    a rebase-and-merge - any shape that lands the same content.

    `--topo-order` so "newest" means newest in ancestry, never whichever
    commit happens to carry the latest date.
    """
    trees = _trees_on(root, human_ref)
    if not trees:
        return fork
    result = git_helper.run("log", "--topo-order", "--format=%H %T",
                            f"{fork}..{integration_ref}", tree=root)
    if result.returncode != 0:
        return fork
    for line in result.stdout.splitlines():
        sha, _, tree = line.partition(" ")
        if tree.strip() in trees:
            return sha
    return fork


def resolve_range(root: Path, range_arg: str | None, integration_ref: str,
                  human_ref: str) -> tuple[str, str, str]:
    """The chunk's range expression, plus its two endpoints split out (every
    later step needs the tip on its own, to diff an individual run's branch
    against it). `--range BASE..TIP` overrides both endpoints outright;
    otherwise the tip is `integration_ref` (or its `origin/` twin, see
    `resolve_integration_ref`) and the base is `last_shipped_point` - where
    `main` last caught up, NOT the merge-base, for the reason that function
    spells out."""
    if range_arg:
        parts = range_arg.split("..", 1)
        if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
            raise ShipReportError(f"--range must look like 'BASE..TIP', got {range_arg!r}")
        base, tip = parts[0].strip(), parts[1].strip()
        for ref in (base, tip):
            if not git_helper.ref_exists(ref, tree=root):
                raise ShipReportError(f"{ref!r} (from --range) does not resolve to a commit in "
                                      f"{root}")
        return range_arg, base, tip

    integration_ref = resolve_integration_ref(root, integration_ref)
    for ref in (human_ref, integration_ref):
        if not git_helper.ref_exists(ref, tree=root):
            raise ShipReportError(
                f"{ref!r} does not resolve to a commit in {root} - is this checkout missing "
                f"that branch? (fetch it, or pass --integration origin/<name>, or --range to "
                f"name two refs that exist here)")
    fork = git_helper.merge_base(human_ref, integration_ref, tree=root)
    base = last_shipped_point(root, human_ref, integration_ref, fork)
    return f"{base}..{integration_ref}", base, integration_ref


def _walk_done_dir(root: Path, range_expr: str) -> dict[str, dict]:
    """Every `queue/done/*.md` file-change inside `range_expr`, oldest first:
    `name -> {sha, date, detected_by}`. One `git log` call carries both the
    commit metadata and the file-status lines, joined by a `COMMIT<0x1f>...`
    marker line `-M --name-status` never itself produces (0x1f, the unit
    separator, is not one of the characters Python's `str.splitlines` treats
    as a line break - verified; 0x1e, the more obvious choice, IS one of
    those and silently corrupts this exact parse, which is why it is not
    used here).

    `detected_by` is `"commit-message"` when the same commit's subject
    matches engine.py's `"factory: <name> integrated"` exactly for THIS
    name, else `"diff"` - the fallback queue/TEMPLATE.md and this script's
    own docstring both promise: a card the engine parked under a differently
    -worded commit, or one an operator moved by hand, still counts, as long
    as the file change itself is really there.
    """
    result = git_helper.run(
        "log", "--reverse", "-M", "--name-status",
        "--format=COMMIT%x1f%H%x1f%cI%x1f%s",
        range_expr, "--", "queue/done", tree=root)
    if result.returncode != 0:
        raise ShipReportError(
            f"git log over {range_expr!r} failed: {(result.stderr or result.stdout).strip()}")

    events: dict[str, dict] = {}
    current: dict | None = None
    for line in result.stdout.splitlines():
        if line.startswith("COMMIT\x1f"):
            _, sha, date, subject = line.split("\x1f", 3)
            current = {"sha": sha, "date": date, "subject": subject}
            continue
        if current is None or not line.strip():
            continue
        m = NAME_STATUS_RE.match(line)
        if not m:
            continue
        status, rest = m.groups()
        # A rename/copy line carries "old<TAB>new" after the status code -
        # only the destination (what now sits under queue/done/) matters.
        path = rest.split("\t")[-1] if status[0] in "RC" else rest
        if status[0] == "D":
            continue   # a file leaving queue/done/ names nothing to report
        p = PurePosixPath(path)
        if p.parent.as_posix() != "queue/done" or p.suffix.lower() != ".md":
            continue
        name = p.name
        if name in events:
            continue   # first (oldest) occurrence wins - one park per card
        subj_match = PARK_MESSAGE_RE.match(current["subject"])
        detected_by = ("commit-message"
                      if subj_match and subj_match.group(1).strip() == name
                      else "diff")
        events[name] = {"sha": current["sha"], "date": current["date"],
                        "detected_by": detected_by}
    return events


@dataclass
class Criterion:
    text: str
    checked: bool
    verdict: str
    evidence: str


@dataclass
class RunEvidence:
    branch: str | None
    files: tuple[str, ...]
    insertions: int
    deletions: int
    test_files: tuple[str, ...]
    doc_files: tuple[str, ...]
    note: str | None   # set whenever there is a reason the evidence above is incomplete


@dataclass
class ChunkCard:
    name: str                       # e.g. "003-add-health-endpoint.md"
    path: Path                      # queue/done/<name>, absolute
    sha: str | None
    date: str | None                # commit date, ISO 8601, of the park event
    detected_by: str                # "commit-message" | "diff"
    title: str = ""
    adw_id: str | None = None
    criteria: list[Criterion] = field(default_factory=list)
    evidence: RunEvidence | None = None
    read_error: str | None = None   # set when the card file itself is a gap


@dataclass
class Chunk:
    range_expr: str
    base: str
    tip: str
    commit_count: int
    cards: list[ChunkCard]


def _diff_files_between(root: Path, base: str, tip: str) -> list[str] | None:
    """Files that differ between two COMMITS (never the working tree) -
    `git_helper.diff_files` takes one ref and diffs it against the working
    tree, which is the wrong comparison for "what did this run's branch
    change since it forked" - so this stays local rather than reusing it."""
    result = git_helper.run("diff", "--name-only", base, tip, tree=root)
    if result.returncode != 0:
        return None
    return [line for line in result.stdout.splitlines() if line]


def _diff_counts_between(root: Path, base: str, tip: str) -> tuple[int, int] | None:
    result = git_helper.run("diff", "--numstat", base, tip, tree=root)
    if result.returncode != 0:
        return None
    insertions = deletions = 0
    for line in result.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        if parts[0].isdigit():
            insertions += int(parts[0])
        if parts[1].isdigit():
            deletions += int(parts[1])
    return insertions, deletions


def gather_run_evidence(root: Path, adw_id: str | None, tip_ref: str) -> RunEvidence:
    """The one run this card names, described entirely from git: which
    branch (`adw/<adw_id>_*`, `git_helper.find_run_branch` - the branch ref
    never moves, engine.py's `integrate` docstring point 2, so this is
    always the run's real, un-rewritten history), what it changed since it
    forked from the working line (`merge_base(branch, tip_ref)..branch`,
    never the branch-vs-working-tree comparison `git_helper.diff_files`
    would give), and which of those files mechanically look like tests or
    docs. `note` is set, and every count left at zero, whenever a step along
    the way could not be completed - never silently substituted with a
    guess.

    `tip_ref` decides how trustworthy the fork point is, so pass the ref the
    hub holds. The HUB's `integration` only ever advances by fast-forward; a
    server's LOCAL copy does not - engine.py's `pull` runs `git pull
    --rebase` when the hub and the server have both moved, replaying local
    commits under new shas. A run branch cut from a commit that was still
    local-only at that moment loses its fork point on that box, and
    `merge_base` then falls back to an older shared ancestor, which widens
    this diff to include neighbouring cards' commits. `--integration
    origin/integration` (what ship-check passes) reads the hub's ref and
    sidesteps it."""
    if not adw_id:
        return RunEvidence(None, (), 0, 0, (), (),
                           "no Adw-Id: on the card - its run branch cannot be located")
    branch = git_helper.find_run_branch(adw_id, tree=root)
    if branch is None:
        return RunEvidence(None, (), 0, 0, (), (),
                           f"no adw/{adw_id}_* branch in this checkout")
    if not git_helper.ref_exists(tip_ref, tree=root):
        return RunEvidence(branch, (), 0, 0, (), (),
                           f"{tip_ref!r} does not resolve here - cannot diff {branch} against it")
    base = git_helper.merge_base(branch, tip_ref, tree=root)
    files = _diff_files_between(root, base, branch)
    if files is None:
        return RunEvidence(branch, (), 0, 0, (), (),
                           f"git diff between {branch} and its fork point failed")
    if not files:
        return RunEvidence(branch, (), 0, 0, (), (),
                           f"{branch} holds no commits its fork point does not already have")
    counts = _diff_counts_between(root, base, branch) or (0, 0)
    test_files = tuple(f for f in files if TEST_PATH_RE.search(f))
    doc_files = tuple(f for f in files if DOC_PATH_RE.search(f))
    return RunEvidence(branch, tuple(files), counts[0], counts[1], test_files, doc_files, None)


def _clip_list(items: tuple[str, ...]) -> str:
    if not items:
        return "none"
    shown = ", ".join(items[:MAX_LISTED_FILES])
    extra = len(items) - MAX_LISTED_FILES
    return f"{shown} (+{extra} more)" if extra > 0 else shown


def walk_criteria(criteria: list[dict], evidence: RunEvidence) -> list[Criterion]:
    """One verdict per acceptance box, from mechanical evidence alone - never
    a semantic judgment. `confirmed-by-record` requires BOTH the card's own
    checkbox to already say done AND a concrete file-level match (a criterion
    using the whole word "test" needs a test-looking file in the diff; one
    using the whole word "doc" needs a doc-looking file - `TEST_WORD_RE` /
    `DOC_WORD_RE`, whole words only, so "the latest reading" and "the
    Dockerfile builds" fall through to the honest verdict below like any
    other behavioral claim); everything else - which is most real acceptance
    criteria, since most name behavior a diff of file paths cannot see -
    reads `cannot-confirm-from-record`, the same fixed two-word vocabulary
    every time, so a reader learns to recognize it as this script's own
    honest "can't tell from here," never a soft dodge."""
    results = []
    for item in criteria:
        text, checked = item["text"], item["done"]
        lower = text.lower()
        checkbox_note = f"card's own checkbox: {'checked' if checked else 'unchecked'}"

        if evidence.note and not evidence.files:
            results.append(Criterion(text, checked, CANNOT_CONFIRM,
                                     f"{evidence.note} ({checkbox_note})"))
            continue

        if TEST_WORD_RE.search(lower):
            if evidence.test_files and checked:
                verdict, basis = CONFIRMED, f"diff touched test file(s): {_clip_list(evidence.test_files)}"
            elif evidence.test_files:
                verdict, basis = CANNOT_CONFIRM, (
                    f"diff touched test file(s) ({_clip_list(evidence.test_files)}) but the "
                    f"card's own checkbox is still unchecked")
            else:
                verdict, basis = CANNOT_CONFIRM, "diff touched no file that looks like a test"
            results.append(Criterion(text, checked, verdict, f"{basis} ({checkbox_note})"))
            continue

        if DOC_WORD_RE.search(lower):
            if evidence.doc_files and checked:
                verdict, basis = CONFIRMED, f"diff touched doc file(s): {_clip_list(evidence.doc_files)}"
            elif evidence.doc_files:
                verdict, basis = CANNOT_CONFIRM, (
                    f"diff touched doc file(s) ({_clip_list(evidence.doc_files)}) but the "
                    f"card's own checkbox is still unchecked")
            else:
                verdict, basis = CANNOT_CONFIRM, "diff touched no file that looks like documentation"
            results.append(Criterion(text, checked, verdict, f"{basis} ({checkbox_note})"))
            continue

        results.append(Criterion(
            text, checked, CANNOT_CONFIRM,
            f"the record has nothing mechanical that speaks to this criterion ({checkbox_note})"))
    return results


def find_chunk_cards(root: Path, range_expr: str, queue_dir: Path) -> list[ChunkCard]:
    events = _walk_done_dir(root, range_expr)
    cards = [
        ChunkCard(name=name, path=queue_dir / "done" / name,
                  sha=info["sha"], date=info["date"], detected_by=info["detected_by"])
        for name, info in events.items()
    ]
    cards.sort(key=lambda c: (c.date or "", c.name))
    return cards


def read_card_text(root: Path, card: ChunkCard) -> tuple[str | None, str | None]:
    """The card's body as the commit that PARKED it recorded it - `git show
    <sha>:queue/done/<name>` - falling back to the file on disk.

    The commit is the right source and the checkout is not: cards parked on
    `integration` do not exist in `main`'s tree, so reading from disk loses
    every title and every acceptance criterion the moment the operator runs
    the gate from their own branch (which ship-check step 3.2 explicitly
    allows - it records `<start-branch>` precisely because the session may
    begin anywhere). `_walk_done_dir` already found the sha; this just asks
    it for the file. Still a pure query - `git show` reads, like every other
    call in this module. Returns `(text, None)` or `(None, reason)`."""
    rel: str | None = None
    if card.sha:
        try:
            rel = card.path.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            rel = None   # a --queue-dir outside the repo: nothing git can show
    if card.sha and rel:
        result = git_helper.run("show", f"{card.sha}:{rel}", tree=root)
        if result.returncode == 0:
            return result.stdout, None
    try:
        return card.path.read_text(encoding="utf-8"), None
    except OSError as error:
        where = f"`{card.sha[:10]}:{rel}` or " if (card.sha and rel) else ""
        return None, f"could not read the card from {where}{card.path}: {error}"


def enrich_card(root: Path, card: ChunkCard, tip_ref: str) -> None:
    """Fills in everything `_walk_done_dir` couldn't know on its own: the
    card's title and criteria (from the park commit, see `read_card_text`),
    and the box walk against its run's evidence."""
    text, read_error = read_card_text(root, card)
    if text is None:
        card.title = humanize_card_name(card.name)
        card.read_error = read_error
        card.evidence = RunEvidence(None, (), 0, 0, (), (), card.read_error)
        return

    title, fields, lines = parse_card(text)
    card.title = title or humanize_card_name(card.name)
    if title is None:
        card.read_error = "no H1 title found - malformed card, treated as a gap"
    card.adw_id = fields.get("adw-id") or None
    card.evidence = gather_run_evidence(root, card.adw_id, tip_ref)
    card.criteria = walk_criteria(parse_acceptance_criteria(lines), card.evidence)


def build_chunk(root: Path, range_arg: str | None, integration_ref: str, human_ref: str,
               queue_dir: Path) -> Chunk:
    range_expr, base, tip = resolve_range(root, range_arg, integration_ref, human_ref)
    count = git_helper.rev_list_count(range_expr, tree=root)
    cards = find_chunk_cards(root, range_expr, queue_dir)
    for card in cards:
        enrich_card(root, card, tip)
    return Chunk(range_expr=range_expr, base=base, tip=tip, commit_count=count, cards=cards)


# ── report rendering ─────────────────────────────────────────────────────────

def _diff_line(evidence: RunEvidence) -> list[str]:
    lines = []
    branch = evidence.branch or "no run branch found"
    lines.append(f"- Branch: `{branch}`" if evidence.branch else f"- Branch: {branch}")
    if evidence.files:
        lines.append(f"- Diff: {len(evidence.files)} file(s) changed, "
                     f"+{evidence.insertions} / -{evidence.deletions}")
        lines.append(f"- Tests touched: {len(evidence.test_files)} "
                     f"({_clip_list(evidence.test_files)})")
        lines.append(f"- Docs touched: {len(evidence.doc_files)} "
                     f"({_clip_list(evidence.doc_files)})")
    else:
        lines.append(f"- Diff: none recorded ({evidence.note})" if evidence.note
                     else "- Diff: none recorded")
    return lines


def render_pr(chunk: Chunk) -> str:
    if chunk.commit_count == 0:
        return (f"# Shipping report\n\nNothing to ship: `{chunk.tip}` has no commits "
                f"`{HUMAN_TRUNK}` does not already have (`{chunk.range_expr}`).\n")
    if not chunk.cards:
        return (f"# Shipping report\n\nNothing to ship: {chunk.commit_count} commit(s) on "
                f"`{chunk.tip}` since `{HUMAN_TRUNK}` (`{chunk.range_expr}`), but no card was "
                f"parked into `queue/done/` inside them.\n")

    summary = (f"`{chunk.tip}` is {chunk.commit_count} commit(s) ahead of `{HUMAN_TRUNK}` "
              f"(`{chunk.range_expr}`). This is the body for the ONE squash commit MAP.md's "
              f"two-box model reserves for `{HUMAN_TRUNK}` - assembled from git alone, no agent "
              f"judgment.")
    out = [f"# Shipping report: {len(chunk.cards)} card(s) ready for `{HUMAN_TRUNK}`", "",
          summary, ""]

    gaps: list[str] = []
    for card in chunk.cards:
        out.append(f"## {card.title} (`{card.name}`)")
        out.append("")
        out.append(f"- Card: `queue/done/{card.name}`")
        if card.sha:
            out.append(f"- Integrated: `{card.sha[:10]}` on {card.date} "
                       f"(detected via {card.detected_by})")
        else:
            out.append("- Integrated: unknown commit (detected via diff only)")
        if card.read_error:
            out.append(f"- Gap: {card.read_error}")
            gaps.append(f"{card.name}: {card.read_error}")
        evidence = card.evidence or RunEvidence(None, (), 0, 0, (), (), "no evidence gathered")
        out.extend(_diff_line(evidence))
        if evidence.note and evidence.files == ():
            gaps.append(f"{card.name}: {evidence.note}")
        out.append("")
        if card.criteria:
            out.append("Acceptance criteria:")
            for c in card.criteria:
                mark = "x" if c.verdict == CONFIRMED else " "
                out.append(f"- [{mark}] {c.verdict} - {c.text}")
                out.append(f"      record: {c.evidence}")
                if c.verdict == CANNOT_CONFIRM:
                    gaps.append(f"{card.name}: \"{c.text}\" -> {CANNOT_CONFIRM} ({c.evidence})")
        else:
            out.append("Acceptance criteria: none recorded on this card.")
        out.append("")

    out.append("## Gaps")
    out.append("")
    if gaps:
        out.extend(f"- {g}" for g in gaps)
    else:
        out.append("No gaps - every acceptance box in this chunk is confirmed-by-record.")
    out.append("")
    return "\n".join(out)


def render_changelog(chunk: Chunk) -> str:
    if chunk.commit_count == 0:
        return (f"# Changelog\n\nNothing to ship: `{chunk.tip}` has no commits `{HUMAN_TRUNK}` "
                f"does not already have (`{chunk.range_expr}`).\n")
    if not chunk.cards:
        return (f"# Changelog\n\nNothing to ship: {chunk.commit_count} commit(s) since "
                f"`{HUMAN_TRUNK}` (`{chunk.range_expr}`), but no card was parked into "
                f"`queue/done/` inside them.\n")

    out = [f"# Changelog - {len(chunk.cards)} card(s) (`{chunk.range_expr}`)", ""]
    for card in chunk.cards:
        date = card.date.split("T", 1)[0] if card.date else "unknown date"
        out.append(f"- {date}: {card.title} (`{card.name}`)")
    out.append("")
    return "\n".join(out)


def _ascii_safe(text: str) -> str:
    """ASCII stdout, everywhere in this factory (MAP.md's platform landmine:
    a single non-ASCII glyph reaching a cp1252 console takes a Windows
    process down) - the same guard engine.py's `log` applies."""
    return text.encode("ascii", "replace").decode("ascii")


# ── CLI ──────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", default=None,
                        help="repo root (default: the checkout this runs from)")
    parser.add_argument("--range", dest="range_arg", default=None,
                        help="override the chunk's range, 'BASE..TIP' (default: "
                             "'<merge-base main integration>..integration')")
    parser.add_argument("--integration", default=None,
                        help=f"the factory's working line (default: "
                             f"${git_helper.FACTORY_TRUNK_ENV}, else {DEFAULT_INTEGRATION!r})")
    parser.add_argument("--main", dest="human_branch", default=HUMAN_TRUNK,
                        help=f"the human-owned branch the chunk ships onto "
                             f"(default: {HUMAN_TRUNK!r})")
    parser.add_argument("--queue-dir", default=None,
                        help="override the queue directory (default: <repo>/queue)")
    parser.add_argument("--out", default=None,
                        help="write the report to this file (utf-8, LF) instead of stdout - "
                             "what `git commit -F <file>` reads. Every line of the report is "
                             "backtick-quoted markdown, which no shell can carry through an "
                             "argument intact, so the body never passes through one")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--pr", action="store_true",
                      help="markdown PR/squash body (default output mode)")
    mode.add_argument("--changelog", action="store_true",
                      help="compact CHANGELOG entry: one line per card")
    args = parser.parse_args(argv)

    root = Path(args.repo).resolve() if args.repo else git_helper.repo_root()
    if not git_helper.is_repo(root):
        parser.error(f"{root} is not a git repository")
    integration_ref = args.integration or git_helper.factory_trunk()
    queue_dir = Path(args.queue_dir) if args.queue_dir else root / "queue"

    try:
        chunk = build_chunk(root, args.range_arg, integration_ref, args.human_branch, queue_dir)
    except ShipReportError as error:
        print(f"ship_report: error: {error}", file=sys.stderr)
        return 1

    text = render_changelog(chunk) if args.changelog else render_pr(chunk)
    if not text.endswith("\n"):
        text += "\n"

    if args.out:
        out_path = Path(args.out)
        try:
            if out_path.parent != Path(""):
                out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(text, encoding="utf-8", newline="\n")
        except OSError as error:
            print(_ascii_safe(f"ship_report: error: could not write {out_path}: {error}"),
                  file=sys.stderr)
            return 1
        print(_ascii_safe(f"ship_report: wrote {out_path}"))
        return 0

    sys.stdout.write(_ascii_safe(text))
    return 0


if __name__ == "__main__":
    sys.exit(main())
