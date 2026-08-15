"""Hermetic tests for the shipping report (adws/ship_report.py) - MAP.md's
deterministic, code-assembled account of every commit and card sitting on
`integration` that `main` does not have yet.

Real temp git repos under `tmp_path`, real `git` (the same approach
test_engine.py and test_worktrees.py already rely on) - there is no
subprocess boundary to fake here, since this collector only ever queries git
and reads files off disk. `_park` below reproduces engine.py's own
`integrate`/`park_card` mechanics closely enough to matter for this script:
the run's branch commits once and its ref NEVER MOVES again (engine.py
`integrate`, point 2), while a content-equal commit lands on `integration`
separately (there, a rebased detached copy; here, a cherry-pick - either way
`integration` and the branch share only the PRE-branch commit as their
merge-base, which is exactly the fact `gather_run_evidence` depends on to
diff "what this run changed" without also picking up every sibling card's
work that landed on `integration` around it).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import ship_report


def _git(*args: str, cwd: Path) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                            encoding="utf-8", check=False)
    assert result.returncode == 0, f"git {' '.join(args)} failed: {result.stderr}"
    return result.stdout.strip()


CARD_BODY = """## Agent Brief

**Category:** enhancement
**Summary:** one line
**Acceptance criteria:**
- [x] a test covers the new behavior
- [ ] the docs explain the new behavior
- [x] the endpoint returns the right status code
**Out of scope:** nothing
"""


def _card_text(title: str, adw_id: str) -> str:
    header = ["Status: done", "Adw: simple-sdlc", f"Adw-Id: {adw_id}",
              "Created: 2026-08-14", "Context:"]
    return f"# {title}\n\n" + "\n".join(header) + "\n\n" + CARD_BODY


@pytest.fixture
def repo(tmp_path) -> Path:
    """`main` at one commit, `integration` cut from it - the two-box model's
    shape (MAP.md, 2026-08-15), minus the origin remote: this script never
    pushes or fetches, so a bare origin adds nothing a test needs."""
    root = tmp_path / "repo"
    root.mkdir()
    _git("init", "-q", "-b", "main", cwd=root)
    for key, value in (("user.email", "t@example.com"), ("user.name", "Ship Report Test"),
                       ("commit.gpgsign", "false"), ("core.autocrlf", "false")):
        _git("config", key, value, cwd=root)
    (root / "queue" / "done").mkdir(parents=True)
    (root / "README.md").write_text("ship report test fixture\n", encoding="utf-8")
    _git("add", "-A", cwd=root)
    _git("commit", "-q", "-m", "init", cwd=root)
    _git("checkout", "-q", "-b", "integration", cwd=root)
    return root


def _write_card(root: Path, name: str, title: str, adw_id: str) -> str:
    """Drops a card straight into `queue/` on `integration`, committed - the
    state a dispatched, claimed card is in just before the engine parks it.
    Returns the path relative to `root`, as `_park` wants it."""
    rel = f"queue/{name}"
    (root / rel).write_text(_card_text(title, adw_id), encoding="utf-8")
    _git("add", "-A", cwd=root)
    _git("commit", "-q", "-m", f"queue: add {name}", cwd=root)
    return rel


def _park(root: Path, card_rel: str, adw_id: str, files: dict[str, str],
         subject: str | None = None) -> str:
    """One simulated engine cycle: cut `adw/<adw_id>_work` off `integration`,
    commit real file changes on it, land a content-equal commit on
    `integration` WITHOUT moving the branch ref (see module docstring), then
    `git mv` the card into `queue/done/` and commit that - `subject`
    defaults to the engine's own exact wording (engine.py `park_card`:
    `f"factory: {card.name} integrated"`); passing something else exercises
    the diff-only fallback path. Returns the branch name.
    """
    branch = f"adw/{adw_id}_work"
    _git("checkout", "-q", "-b", branch, cwd=root)
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    _git("add", "-A", cwd=root)
    _git("commit", "-q", "-m", f"run {adw_id}: work", cwd=root)
    branch_tip = _git("rev-parse", "HEAD", cwd=root)

    _git("checkout", "-q", "integration", cwd=root)
    # A real engine cycle rebases onto CURRENT integration, which has
    # typically moved since the run's branch forked (a sibling card, or just
    # the queue-add commit above) - reproduced here with a small marker
    # commit so the cherry-picked commit below gets a genuinely different
    # parent (and therefore sha) from the branch's own commit, rather than
    # risking git reproducing byte-identical commit objects when a
    # cherry-pick's tree, parent, author and committer timestamp all happen
    # to coincide with the original (same-second commits in a fast test).
    marker = root / ".marks" / f"{adw_id}.txt"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(f"integration advanced before parking {adw_id}\n", encoding="utf-8")
    _git("add", "-A", cwd=root)
    _git("commit", "-q", "-m", f"mark: integration moved on before {adw_id}", cwd=root)
    _git("cherry-pick", branch_tip, cwd=root)

    name = Path(card_rel).name
    dest = f"queue/done/{name}"
    _git("mv", card_rel, dest, cwd=root)
    _git("commit", "-q", "-m", subject or f"factory: {name} integrated", cwd=root)
    return branch


def _chunk(root: Path, **kwargs) -> ship_report.Chunk:
    return ship_report.build_chunk(root, kwargs.pop("range_arg", None), "integration", "main",
                                   root / "queue", **kwargs)


# ── chunk / range resolution ─────────────────────────────────────────────────

def test_default_range_starts_where_main_last_caught_up_with_integration(repo):
    """Before the first chunk ships there is nothing to catch up to, so the
    base falls back to the fork point - which is main's tip here."""
    range_expr, base, tip = ship_report.resolve_range(repo, None, "integration", "main")
    main_tip = _git("rev-parse", "main", cwd=repo)
    assert base == main_tip
    assert tip == "integration"
    assert range_expr == f"{main_tip}..integration"


def test_range_override_is_used_verbatim_and_validated(repo):
    _write_card(repo, "001-x.md", "Add a thing", "aaa1")
    _park(repo, "queue/001-x.md", "aaa1", {"src/thing.py": "x = 1\n"})
    sha_before = _git("rev-parse", "main", cwd=repo)
    range_expr, base, tip = ship_report.resolve_range(repo, f"{sha_before}..integration",
                                                       "integration", "main")
    assert (range_expr, base, tip) == (f"{sha_before}..integration", sha_before, "integration")


def test_range_override_without_two_dots_is_rejected(repo):
    with pytest.raises(ship_report.ShipReportError, match="BASE..TIP"):
        ship_report.resolve_range(repo, "not-a-range", "integration", "main")


def test_missing_ref_is_reported_not_crashed(repo):
    with pytest.raises(ship_report.ShipReportError, match="no-such-branch"):
        ship_report.resolve_range(repo, None, "no-such-branch", "main")


def test_a_fetch_only_checkout_falls_back_to_the_remote_tracking_ref(repo, tmp_path):
    """An ordinary main-tracking clone never creates a local `integration`
    branch, and `git rev-parse integration` does NOT fall back to
    `refs/remotes/origin/integration` on its own - so without this fallback
    the gate cannot run from such a checkout at all."""
    _write_card(repo, "001-x.md", "Add a thing", "aaa1")
    _park(repo, "queue/001-x.md", "aaa1", {"src/thing.py": "x = 1\n"})
    clone = tmp_path / "clone"
    _git("clone", "-q", "--branch", "main", str(repo), str(clone), cwd=tmp_path)
    assert _git("rev-parse", "--verify", "--quiet", "refs/remotes/origin/integration",
                cwd=clone)

    range_expr, _base, tip = ship_report.resolve_range(clone, None, "integration", "main")

    assert tip == "origin/integration"
    assert range_expr.endswith("..origin/integration")
    chunk = ship_report.build_chunk(clone, None, "integration", "main", clone / "queue")
    assert [c.name for c in chunk.cards] == ["001-x.md"]
    assert chunk.cards[0].title == "Add a thing"


# ── chunk detection ───────────────────────────────────────────────────────────

def test_a_park_with_the_engines_exact_message_is_detected_by_commit_message(repo):
    _write_card(repo, "001-health.md", "Add a /health endpoint", "aaa1")
    _park(repo, "queue/001-health.md", "aaa1", {"app.py": "def health(): return 200\n"})

    chunk = _chunk(repo)

    assert [c.name for c in chunk.cards] == ["001-health.md"]
    card = chunk.cards[0]
    assert card.detected_by == "commit-message"
    assert card.sha is not None
    assert card.title == "Add a /health endpoint"
    assert (repo / "queue" / "done" / "001-health.md").exists()


def test_a_park_under_a_different_commit_message_falls_back_to_the_diff(repo):
    _write_card(repo, "002-clamp.md", "Add a clamp helper", "bbb2")
    _park(repo, "queue/002-clamp.md", "bbb2", {"lib/clamp.py": "def clamp(x): return x\n"},
         subject="chore: move 002-clamp.md by hand")

    chunk = _chunk(repo)

    assert [c.name for c in chunk.cards] == ["002-clamp.md"]
    assert chunk.cards[0].detected_by == "diff"


def test_two_cards_are_both_found_oldest_first(repo):
    _write_card(repo, "001-a.md", "Card A", "aaa1")
    _park(repo, "queue/001-a.md", "aaa1", {"a.py": "a = 1\n"})
    _write_card(repo, "002-b.md", "Card B", "bbb2")
    _park(repo, "queue/002-b.md", "bbb2", {"b.py": "b = 1\n"})

    chunk = _chunk(repo)

    assert [c.name for c in chunk.cards] == ["001-a.md", "002-b.md"]
    assert chunk.commit_count == len(
        _git("rev-list", f"{chunk.base}..integration", cwd=repo).splitlines())


def _squash_into_main(repo: Path, message: str = "chunk shipped") -> None:
    """The ONE merge shape MAP.md's two-box model performs on `main`: `git
    merge --squash` + commit. It records NO merge parentage, so `git
    merge-base main integration` does not move past the original fork point -
    which is exactly why the chunk's base cannot be derived from it. Anything
    weaker here (a fast-forward, a real merge) advances the merge-base and
    would let a broken collector pass."""
    start = _git("rev-parse", "--abbrev-ref", "HEAD", cwd=repo)
    _git("checkout", "-q", "main", cwd=repo)
    _git("merge", "--squash", "integration", cwd=repo)
    _git("commit", "-q", "-m", message, cwd=repo)
    _git("checkout", "-q", start, cwd=repo)


def test_a_card_that_shipped_in_an_earlier_squash_is_not_part_of_the_chunk(repo):
    """Only what main has not caught up with belongs to the chunk - a card
    that shipped in an earlier chunk must not be re-reported the next time
    this runs, even though a squash leaves its commits unreachable from
    main."""
    _write_card(repo, "001-old.md", "Old card", "aaa1")
    _park(repo, "queue/001-old.md", "aaa1", {"old.py": "x = 1\n"})
    _squash_into_main(repo, "ship chunk 1")
    # A squash really does leave the merge-base pinned at the fork point -
    # assert it, so this test keeps naming the actual hazard.
    assert _git("merge-base", "main", "integration", cwd=repo) != _git(
        "rev-parse", "integration", cwd=repo)

    _write_card(repo, "002-new.md", "New card", "bbb2")
    _park(repo, "queue/002-new.md", "bbb2", {"new.py": "x = 2\n"})

    chunk = _chunk(repo)

    assert [c.name for c in chunk.cards] == ["002-new.md"]


def test_the_chunk_after_a_squash_counts_only_the_commits_main_has_not_caught_up_with(repo):
    _write_card(repo, "001-old.md", "Old card", "aaa1")
    _park(repo, "queue/001-old.md", "aaa1", {"old.py": "x = 1\n"})
    _squash_into_main(repo, "ship chunk 1")
    shipped_tip = _git("rev-parse", "integration", cwd=repo)

    _write_card(repo, "002-new.md", "New card", "bbb2")
    _park(repo, "queue/002-new.md", "bbb2", {"new.py": "x = 2\n"})

    chunk = _chunk(repo)

    assert chunk.base == shipped_tip
    assert chunk.commit_count == len(
        _git("rev-list", f"{shipped_tip}..integration", cwd=repo).splitlines())
    text = ship_report.render_pr(chunk)
    assert text.startswith("# Shipping report: 1 card(s)")
    assert "Old card" not in text


def test_nothing_is_left_to_ship_right_after_a_squash(repo):
    _write_card(repo, "001-old.md", "Old card", "aaa1")
    _park(repo, "queue/001-old.md", "aaa1", {"old.py": "x = 1\n"})
    _squash_into_main(repo, "ship chunk 1")

    chunk = _chunk(repo)

    assert chunk.commit_count == 0
    assert chunk.cards == []
    assert "Nothing to ship" in ship_report.render_pr(chunk)


# ── box walk honesty ──────────────────────────────────────────────────────────

def test_a_checked_test_criterion_confirms_when_the_diff_touched_a_test_file(repo):
    _write_card(repo, "001-x.md", "Add a thing", "aaa1")
    _park(repo, "queue/001-x.md", "aaa1", {
        "src/thing.py": "def thing(): return 1\n",
        "adws/tests/test_thing.py": "def test_thing(): assert True\n",
    })

    chunk = _chunk(repo)
    criteria = {c.text: c for c in chunk.cards[0].criteria}

    test_box = criteria["a test covers the new behavior"]
    assert test_box.verdict == ship_report.CONFIRMED
    assert "test_thing.py" in test_box.evidence


def test_an_unchecked_doc_criterion_cannot_confirm_even_with_matching_evidence(repo):
    _write_card(repo, "001-x.md", "Add a thing", "aaa1")
    _park(repo, "queue/001-x.md", "aaa1", {
        "src/thing.py": "def thing(): return 1\n",
        "docs/thing.md": "# thing\n",
    })

    chunk = _chunk(repo)
    criteria = {c.text: c for c in chunk.cards[0].criteria}

    doc_box = criteria["the docs explain the new behavior"]
    # the card's own checkbox for this line is unchecked (CARD_BODY) even
    # though a doc file is right there in the diff - the box walk must not
    # trust the diff alone, same as morning-brief's own rule.
    assert doc_box.checked is False
    assert doc_box.verdict == ship_report.CANNOT_CONFIRM
    assert "unchecked" in doc_box.evidence


def test_a_box_with_no_mechanical_evidence_always_reads_cannot_confirm(repo):
    """"the endpoint returns the right status code" names neither "test" nor
    "doc" - nothing in a diff of file names can verify a behavioral claim
    like that, so it must never be reported as confirmed, checked box or
    not."""
    _write_card(repo, "001-x.md", "Add a thing", "aaa1")
    _park(repo, "queue/001-x.md", "aaa1", {"src/thing.py": "def thing(): return 200\n"})

    chunk = _chunk(repo)
    criteria = {c.text: c for c in chunk.cards[0].criteria}

    status_box = criteria["the endpoint returns the right status code"]
    assert status_box.checked is True
    assert status_box.verdict == ship_report.CANNOT_CONFIRM
    assert "nothing mechanical" in status_box.evidence


def _evidence_with_a_test_and_a_doc_file() -> ship_report.RunEvidence:
    return ship_report.RunEvidence(
        branch="adw/aaa1_work", files=("adws/tests/test_thing.py", "docs/runbook.md"),
        insertions=2, deletions=0, test_files=("adws/tests/test_thing.py",),
        doc_files=("docs/runbook.md",), note=None)


@pytest.mark.parametrize("text", [
    "the dashboard shows the latest reading",
    "the greatest value is highlighted",
    "the Dockerfile builds without network access",
    "the protest banner can be dismissed",
    "the docket number is shown",
])
def test_a_word_that_merely_contains_test_or_doc_confirms_nothing(text):
    """Substring matching turned "latest", "greatest" and "Dockerfile" into
    test/doc criteria and printed them confirmed off a file they have nothing
    to do with - the invented semantic match this module promises never to
    make. Checked here with the box already ticked, which is the only state
    that could ever read confirmed."""
    [verdict] = ship_report.walk_criteria([{"text": text, "done": True}],
                                          _evidence_with_a_test_and_a_doc_file())

    assert verdict.verdict == ship_report.CANNOT_CONFIRM
    assert "nothing mechanical" in verdict.evidence


@pytest.mark.parametrize("text,expected_file", [
    ("a test covers the new behavior", "test_thing.py"),
    ("tests cover the new behavior", "test_thing.py"),
    ("the behavior is tested end to end", "test_thing.py"),
    ("the docs explain the new behavior", "runbook.md"),
    ("the documentation explains the new behavior", "runbook.md"),
])
def test_the_whole_word_still_confirms_against_its_own_evidence_class(text, expected_file):
    [verdict] = ship_report.walk_criteria([{"text": text, "done": True}],
                                          _evidence_with_a_test_and_a_doc_file())

    assert verdict.verdict == ship_report.CONFIRMED
    assert expected_file in verdict.evidence


def test_a_card_with_no_findable_branch_reads_cannot_confirm_for_every_box(repo):
    _write_card(repo, "001-x.md", "Add a thing", "orphan-id")
    # Committed straight to queue/done/ on integration, with no adw/*
    # branch ever cut for "orphan-id" - the honest "the run's branch is
    # gone or was never pushed here" case.
    (repo / "queue" / "001-x.md").rename(repo / "queue" / "done" / "001-x.md")
    _git("add", "-A", cwd=repo)
    _git("commit", "-q", "-m", "factory: 001-x.md integrated", cwd=repo)

    chunk = _chunk(repo)
    card = chunk.cards[0]

    assert card.evidence.branch is None
    assert all(c.verdict == ship_report.CANNOT_CONFIRM for c in card.criteria)
    assert "no adw/orphan-id_* branch" in card.criteria[0].evidence


def test_the_card_is_read_from_its_park_commit_not_from_the_checkout(repo):
    """Cards parked on `integration` are not in `main`'s tree, and ship-check
    records `<start-branch>` precisely because the session may begin
    anywhere - so the walk has to read the card from the commit that parked
    it, which `_walk_done_dir` already found."""
    _write_card(repo, "001-x.md", "Add a thing", "aaa1")
    _park(repo, "queue/001-x.md", "aaa1", {
        "src/thing.py": "def thing(): return 1\n",
        "adws/tests/test_thing.py": "def test_thing(): assert True\n",
    })
    _git("checkout", "-q", "main", cwd=repo)
    assert not (repo / "queue" / "done" / "001-x.md").exists()

    card = _chunk(repo).cards[0]

    assert card.read_error is None
    assert card.title == "Add a thing"
    assert [c.text for c in card.criteria] == [
        "a test covers the new behavior",
        "the docs explain the new behavior",
        "the endpoint returns the right status code",
    ]
    assert card.criteria[0].verdict == ship_report.CONFIRMED


# ── report rendering ──────────────────────────────────────────────────────────

def test_pr_report_lists_the_card_diff_stats_and_a_gaps_section(repo):
    _write_card(repo, "001-x.md", "Add a thing", "aaa1")
    _park(repo, "queue/001-x.md", "aaa1", {
        "src/thing.py": "def thing(): return 1\n",
        "adws/tests/test_thing.py": "def test_thing(): assert True\n",
    })

    text = ship_report.render_pr(_chunk(repo))

    assert text.startswith("# Shipping report: 1 card(s)")
    assert "Add a thing" in text
    assert "001-x.md" in text
    assert "Tests touched: 1" in text
    assert "## Gaps" in text
    # the unchecked doc box and the unverifiable status-code box both belong
    # in the gaps list; the confirmed test box must not.
    assert "the docs explain the new behavior" in text.split("## Gaps", 1)[1]
    assert "a test covers the new behavior" not in text.split("## Gaps", 1)[1]


def test_changelog_is_one_line_per_card_with_its_park_date(repo):
    _write_card(repo, "001-a.md", "Card A", "aaa1")
    _park(repo, "queue/001-a.md", "aaa1", {"a.py": "a = 1\n"})
    _write_card(repo, "002-b.md", "Card B", "bbb2")
    _park(repo, "queue/002-b.md", "bbb2", {"b.py": "b = 1\n"})

    text = ship_report.render_changelog(_chunk(repo))
    lines = [line for line in text.splitlines() if line.startswith("- ")]

    assert len(lines) == 2
    assert all(line.count(": ") >= 1 for line in lines)
    assert "Card A (`001-a.md`)" in lines[0]
    assert "Card B (`002-b.md`)" in lines[1]


# ── empty chunk ───────────────────────────────────────────────────────────────

def test_nothing_to_ship_when_integration_has_no_commits_ahead_of_main(repo):
    chunk = _chunk(repo)
    assert chunk.commit_count == 0
    assert chunk.cards == []
    for text in (ship_report.render_pr(chunk), ship_report.render_changelog(chunk)):
        assert "Nothing to ship" in text
        assert "no commits" in text


def test_nothing_to_ship_when_commits_exist_but_no_card_was_parked(repo):
    (repo / "src").mkdir()
    (repo / "src" / "unrelated.py").write_text("x = 1\n", encoding="utf-8")
    _git("add", "-A", cwd=repo)
    _git("commit", "-q", "-m", "unrelated work, no card involved", cwd=repo)

    chunk = _chunk(repo)
    assert chunk.commit_count == 1
    assert chunk.cards == []
    for text in (ship_report.render_pr(chunk), ship_report.render_changelog(chunk)):
        assert "Nothing to ship" in text
        assert "no card was parked" in text


# ── CLI ────────────────────────────────────────────────────────────────────────

def test_cli_default_mode_is_pr_and_exits_zero(repo, capsys):
    _write_card(repo, "001-x.md", "Add a thing", "aaa1")
    _park(repo, "queue/001-x.md", "aaa1", {"src/thing.py": "x = 1\n"})

    code = ship_report.main(["--repo", str(repo)])
    out = capsys.readouterr().out

    assert code == 0
    assert out.startswith("# Shipping report:")


def test_cli_changelog_flag_switches_the_mode(repo, capsys):
    _write_card(repo, "001-x.md", "Add a thing", "aaa1")
    _park(repo, "queue/001-x.md", "aaa1", {"src/thing.py": "x = 1\n"})

    code = ship_report.main(["--repo", str(repo), "--changelog"])
    out = capsys.readouterr().out

    assert code == 0
    assert out.startswith("# Changelog")


def test_cli_out_writes_the_body_to_a_file_for_git_commit_dash_f(repo, tmp_path, capsys):
    """The body is backtick-quoted markdown from its first line on, which no
    shell carries through an argument intact (PowerShell eats backticks as
    escapes, bash runs them as command substitution) - so `git commit` reads
    a file, and this is the file."""
    _write_card(repo, "001-x.md", "Add a thing", "aaa1")
    _park(repo, "queue/001-x.md", "aaa1", {"src/thing.py": "x = 1\n"})
    out = tmp_path / "SQUASH_BODY.md"

    code = ship_report.main(["--repo", str(repo), "--pr", "--out", str(out)])
    printed = capsys.readouterr().out

    assert code == 0
    assert "wrote" in printed
    body = out.read_text(encoding="utf-8")
    assert body.startswith("# Shipping report: 1 card(s)")
    assert "`001-x.md`" in body
    assert "\r\n" not in body


def test_cli_reports_a_bad_range_on_stderr_and_exits_nonzero(repo, capsys):
    code = ship_report.main(["--repo", str(repo), "--range", "no-such-ref..integration"])
    err = capsys.readouterr().err

    assert code == 1
    assert "no-such-ref" in err
