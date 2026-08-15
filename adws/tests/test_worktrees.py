"""Hermetic tests for the worktree layer (specs/worktrees.md section 11).

Real temp git repos under `tmp_path`, real `git` (already a hard dependency of
this test suite — see test_run_branch.py), a real temp sqlite db. No network,
no pi, no model calls, no touching the operator's own repo. Section numbers in
comments below refer to specs/worktrees.md.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from adw_modules import gates, git_helper, permissions, session, worktrees
from adw_modules.data_types import (
    AgentConfig,
    ConfigDefaults,
    EventRecord,
    ObservabilityConfig,
    PhaseParams,
    PromptEngineering,
    SSSFConfig,
    WorktreeRow,
    WorktreesConfig,
)
from adw_modules.tracer import Tracer

STALE = 30   # stale_after_minutes used across the classify tests


def _run(*args: str, cwd: Path) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                            encoding="utf-8", check=False)
    assert result.returncode == 0, f"git {' '.join(args)} failed: {result.stderr}"
    return result.stdout.strip()


@pytest.fixture
def main_repo(tmp_path):
    """A throwaway git repo standing in for the main checkout — NOT chdir'd
    into: every worktrees.py/git_helper call below takes an explicit `tree=`,
    which is the whole point of the seam (spec 5.2).

    Carries an `integration` branch alongside `main`, at the same tip — the
    shape a real checkout has once MAP.md's integration-branch ruling
    (2026-08-15) is converged: runs fork from and are measured against
    `integration`, never `main`. Tests that specifically exercise the
    self-heal path (`ensure_factory_trunk`) build their own bare `main`-only
    repo instead of this fixture."""
    repo = tmp_path / "main"
    repo.mkdir()
    _run("init", "-q", "-b", "main", cwd=repo)
    _run("config", "user.email", "test@example.com", cwd=repo)
    _run("config", "user.name", "Test", cwd=repo)
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    _run("add", "-A", cwd=repo)
    _run("commit", "-q", "-m", "init", cwd=repo)
    _run("branch", "integration", "main", cwd=repo)
    return repo


@pytest.fixture
def wcfg(tmp_path):
    return WorktreesConfig(root=str(tmp_path / "worktrees"), trunk="integration",
                           stale_after_minutes=STALE)


# ── lifecycle: create / rejoin / stranger path / parallel / mutex ───────────

def test_create_makes_a_worktree_on_the_matching_branch_and_leaves_main_untouched(
        main_repo, wcfg):
    before_head = git_helper.rev("HEAD", tree=main_repo)
    before_branch = git_helper.current_branch(tree=main_repo)

    rw = worktrees.ensure_run_worktree(main_repo, "deadbeef", "Add a login flow", wcfg)

    assert rw.branch == "adw/deadbeef_add-a-login-flow"
    assert Path(rw.path).name == "deadbeef_add-a-login-flow"
    assert Path(rw.path).is_dir()
    assert git_helper.current_branch(tree=rw.path) == rw.branch
    assert rw.reused is False
    # invariant 1: the main checkout never moves.
    assert git_helper.rev("HEAD", tree=main_repo) == before_head
    assert git_helper.current_branch(tree=main_repo) == before_branch


def test_base_is_trunk_not_whatever_the_main_checkout_has_checked_out(main_repo, wcfg):
    # Leave the main checkout sitting somewhere else entirely, ahead of trunk.
    _run("checkout", "-q", "-b", "some-other-branch", cwd=main_repo)
    (main_repo / "other.txt").write_text("x\n", encoding="utf-8")
    _run("add", "-A", cwd=main_repo)
    _run("commit", "-q", "-m", "other work", cwd=main_repo)

    rw = worktrees.ensure_run_worktree(main_repo, "cafef00d", "add a feature", wcfg)

    assert rw.base == "integration"
    assert git_helper.rev(rw.branch, tree=main_repo) == \
        git_helper.rev("integration", tree=main_repo)
    assert not (Path(rw.path) / "other.txt").exists()


def test_rejoin_same_adw_id_different_prompt_reuses_the_tree_not_a_second_branch(
        main_repo, wcfg):
    first = worktrees.ensure_run_worktree(main_repo, "deadbeef", "Add a login flow", wcfg)
    second = worktrees.ensure_run_worktree(main_repo, "deadbeef", "totally different ask", wcfg)

    assert second.path == first.path
    assert second.branch == first.branch
    assert second.reused is True
    branches = _run("branch", "--list", "adw/deadbeef_*", "--format=%(refname:short)",
                    cwd=main_repo)
    assert branches.splitlines() == [first.branch]


def test_rejoin_after_directory_removal_readds_without_recutting_the_branch(main_repo, wcfg):
    first = worktrees.ensure_run_worktree(main_repo, "deadbeef", "Add a login flow", wcfg)
    shutil.rmtree(first.path)

    second = worktrees.ensure_run_worktree(main_repo, "deadbeef", "Add a login flow", wcfg)

    assert second.branch == first.branch
    assert second.path == first.path
    assert Path(second.path).is_dir()
    branches = _run("branch", "--list", "adw/deadbeef_*", "--format=%(refname:short)",
                    cwd=main_repo)
    assert branches.splitlines() == [first.branch]   # still exactly one branch — no -b re-cut


def test_stranger_path_fails_the_phase_and_is_left_untouched(main_repo, wcfg):
    path = Path(wcfg.root) / "deadbeef_add-a-login-flow"
    path.mkdir(parents=True)
    (path / "not-mine.txt").write_text("do not touch\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="does not know it"):
        worktrees.ensure_run_worktree(main_repo, "deadbeef", "Add a login flow", wcfg)

    assert (path / "not-mine.txt").read_text(encoding="utf-8") == "do not touch\n"
    assert not git_helper.ref_exists("adw/deadbeef_add-a-login-flow", tree=main_repo)


def test_two_adw_ids_get_independent_usable_trees(main_repo, wcfg):
    one = worktrees.ensure_run_worktree(main_repo, "aaaaaaaa", "first unit of work", wcfg)
    two = worktrees.ensure_run_worktree(main_repo, "bbbbbbbb", "second unit of work", wcfg)

    assert one.path != two.path
    assert one.branch != two.branch
    (Path(one.path) / "a.txt").write_text("a\n", encoding="utf-8")
    (Path(two.path) / "b.txt").write_text("b\n", encoding="utf-8")
    assert not (Path(one.path) / "b.txt").exists()
    assert not (Path(two.path) / "a.txt").exists()


def test_git_worktree_mutex_refuses_a_second_checkout_of_the_same_branch(main_repo, tmp_path):
    path_a = tmp_path / "wt-a"
    path_b = tmp_path / "wt-b"
    git_helper.worktree_add(path_a, "adw/aaaa1111_test", tree=main_repo, base="main")

    with pytest.raises(RuntimeError, match="already used by worktree"):
        git_helper.worktree_add(path_b, "adw/aaaa1111_test", tree=main_repo)


# ── self-heal: the factory trunk (integration) is created from main when it
# is missing (MAP.md's integration-branch ruling, 2026-08-15) ──────────────
#
# `main_repo` (above) already carries `integration` — realistic once a
# checkout has converged once. These tests build their own bare `main`-only
# repo instead, to exercise the FIRST run against a fresh checkout, where
# `integration` genuinely does not exist yet.

@pytest.fixture
def main_only_repo(tmp_path):
    """A throwaway repo carrying `main` and NOTHING else — the pre-heal
    shape: no `integration` branch has ever been cut."""
    repo = tmp_path / "main-only"
    repo.mkdir()
    _run("init", "-q", "-b", "main", cwd=repo)
    _run("config", "user.email", "test@example.com", cwd=repo)
    _run("config", "user.name", "Test", cwd=repo)
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    _run("add", "-A", cwd=repo)
    _run("commit", "-q", "-m", "init", cwd=repo)
    return repo


def test_ensure_factory_trunk_creates_it_from_main_without_touching_main(main_only_repo):
    before_head = git_helper.rev("HEAD", tree=main_only_repo)
    before_branch = git_helper.current_branch(tree=main_only_repo)

    note = worktrees.ensure_factory_trunk(main_only_repo, "integration")

    assert "created 'integration' from 'main'" in note
    assert git_helper.ref_exists("integration", tree=main_only_repo)
    assert git_helper.rev("integration", tree=main_only_repo) == \
        git_helper.rev("main", tree=main_only_repo)
    # main itself: never checked out, never moved.
    assert git_helper.rev("HEAD", tree=main_only_repo) == before_head
    assert git_helper.current_branch(tree=main_only_repo) == before_branch


def test_ensure_factory_trunk_pushes_to_origin_when_one_is_configured(main_only_repo, tmp_path):
    origin = tmp_path / "origin.git"
    origin.mkdir()
    _run("init", "-q", "--bare", "-b", "main", cwd=origin)
    _run("remote", "add", "origin", str(origin), cwd=main_only_repo)

    note = worktrees.ensure_factory_trunk(main_only_repo, "integration")

    assert "pushed to origin" in note
    pushed = _run("branch", "--list", "integration", "--format=%(refname:short)", cwd=origin)
    assert pushed.splitlines() == ["integration"]


def test_ensure_factory_trunk_skips_the_push_with_no_remote(main_only_repo):
    note = worktrees.ensure_factory_trunk(main_only_repo, "integration")

    assert "no 'origin' remote" in note
    assert git_helper.ref_exists("integration", tree=main_only_repo)


def test_ensure_factory_trunk_is_a_noop_when_the_trunk_already_exists(main_repo):
    # main_repo already carries integration (fixture above).
    tip_before = git_helper.rev("integration", tree=main_repo)

    note = worktrees.ensure_factory_trunk(main_repo, "integration")

    assert note == ""
    assert git_helper.rev("integration", tree=main_repo) == tip_before


def test_ensure_factory_trunk_is_a_noop_when_trunk_equals_source(main_only_repo):
    note = worktrees.ensure_factory_trunk(main_only_repo, "main", source="main")
    assert note == ""


def test_ensure_factory_trunk_has_nothing_to_heal_from_on_a_repo_with_no_source(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    _run("init", "-q", "-b", "scratch", cwd=empty)   # no commits at all yet

    note = worktrees.ensure_factory_trunk(empty, "integration")

    assert note == ""
    assert not git_helper.ref_exists("integration", tree=empty)


def test_ensure_factory_trunk_defaults_the_trunk_name_from_the_env(main_only_repo, monkeypatch):
    monkeypatch.setenv(git_helper.FACTORY_TRUNK_ENV, "custom-trunk")

    note = worktrees.ensure_factory_trunk(main_only_repo)   # no explicit trunk

    assert "created 'custom-trunk' from 'main'" in note
    assert git_helper.ref_exists("custom-trunk", tree=main_only_repo)


def test_ensure_run_worktree_self_heals_integration_from_main_on_a_fresh_checkout(
        main_only_repo, tmp_path):
    wcfg = WorktreesConfig(root=str(tmp_path / "worktrees"), trunk="integration",
                           stale_after_minutes=STALE)

    rw = worktrees.ensure_run_worktree(main_only_repo, "deadbeef", "add a feature", wcfg)

    assert rw.base == "integration"
    assert git_helper.ref_exists("integration", tree=main_only_repo)
    assert git_helper.rev(rw.branch, tree=main_only_repo) == \
        git_helper.rev("integration", tree=main_only_repo)
    # invariant 1 still holds through the self-heal path.
    assert git_helper.current_branch(tree=main_only_repo) == "main"


def test_ensure_run_worktree_still_falls_back_to_current_head_when_nothing_can_heal(
        tmp_path, capsys):
    # A repo with no "main" at all (its default branch is called something
    # else) and no "integration" either - self-heal has nothing to work
    # from, so the pre-ruling fallback (base off the main checkout's current
    # HEAD, loudly) is what protects the run.
    repo = tmp_path / "odd-default"
    repo.mkdir()
    _run("init", "-q", "-b", "trunk", cwd=repo)
    _run("config", "user.email", "test@example.com", cwd=repo)
    _run("config", "user.name", "Test", cwd=repo)
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    _run("add", "-A", cwd=repo)
    _run("commit", "-q", "-m", "init", cwd=repo)
    wcfg = WorktreesConfig(root=str(tmp_path / "worktrees"), trunk="integration",
                           stale_after_minutes=STALE)

    rw = worktrees.ensure_run_worktree(repo, "deadbeef", "add a feature", wcfg)

    assert rw.base == "trunk"
    assert "does not resolve" in capsys.readouterr().out


# ── classify: pure function, the four-state table + ordering rule ──────────

def test_classify_alive_when_session_status_is_running():
    state, note = worktrees.classify(
        adw_id="x", dirty=False, has_session=True, session_status="running",
        live_processes=0, latest_event_age_minutes=1.0, merged_into_trunk=False,
        ahead=3, trunk="main", stale_after_minutes=STALE)
    assert state == "alive"
    assert "stale" not in note


def test_classify_alive_when_a_process_row_is_live_even_if_status_says_fail():
    state, _ = worktrees.classify(
        adw_id="x", dirty=True, has_session=True, session_status="fail",
        live_processes=1, latest_event_age_minutes=1.0, merged_into_trunk=False,
        ahead=1, trunk="main", stale_after_minutes=STALE)
    assert state == "alive"


def test_classify_alive_is_annotated_stale_past_the_window():
    state, note = worktrees.classify(
        adw_id="x", dirty=False, has_session=True, session_status="running",
        live_processes=0, latest_event_age_minutes=180.0, merged_into_trunk=False,
        ahead=0, trunk="main", stale_after_minutes=STALE)
    assert state == "alive"
    assert "stale" in note


def test_classify_orphan_beats_unmerged_the_ordering_rule():
    # No session row AND a dirty tree — orphan wins: "you cannot decide
    # anything about a tree you cannot name" (8.3).
    state, note = worktrees.classify(
        adw_id="x", dirty=True, has_session=False, session_status="",
        live_processes=0, latest_event_age_minutes=None, merged_into_trunk=False,
        ahead=5, trunk="main", stale_after_minutes=STALE)
    assert state == "orphan"
    assert "CANNOT NAME" in note


def test_classify_unmerged_when_dirty():
    state, note = worktrees.classify(
        adw_id="x", dirty=True, has_session=True, session_status="success",
        live_processes=0, latest_event_age_minutes=None, merged_into_trunk=True,
        ahead=0, trunk="main", stale_after_minutes=STALE)
    assert state == "unmerged"
    assert "HOLDS WORK" in note


def test_classify_unmerged_when_clean_but_not_merged():
    state, _ = worktrees.classify(
        adw_id="x", dirty=False, has_session=True, session_status="success",
        live_processes=0, latest_event_age_minutes=None, merged_into_trunk=False,
        ahead=3, trunk="main", stale_after_minutes=STALE)
    assert state == "unmerged"


def test_classify_merged_when_clean_and_merged():
    state, note = worktrees.classify(
        adw_id="x", dirty=False, has_session=True, session_status="success",
        live_processes=0, latest_event_age_minutes=None, merged_into_trunk=True,
        ahead=1, trunk="main", stale_after_minutes=STALE)
    assert state == "merged"
    assert note == ""


def test_classify_squash_merge_classifies_merged_via_the_merge_tree_test(main_repo):
    """8.4 — the case `merge-base --is-ancestor` gets wrong forever."""
    _run("checkout", "-q", "-b", "feature", cwd=main_repo)
    (main_repo / "feature.txt").write_text("x\n", encoding="utf-8")
    _run("add", "-A", cwd=main_repo)
    _run("commit", "-q", "-m", "feature work", cwd=main_repo)
    _run("checkout", "-q", "main", cwd=main_repo)
    _run("merge", "-q", "--squash", "feature", cwd=main_repo)
    _run("commit", "-q", "-m", "squash merge feature", cwd=main_repo)

    assert worktrees.is_merged_into_trunk(main_repo, "main", "feature") is True
    # The ancestor test says NO — precisely why 8.4 exists.
    assert git_helper.is_ancestor("feature", "main", tree=main_repo) is False

    state, _ = worktrees.classify(
        adw_id="x", dirty=False, has_session=True, session_status="success",
        live_processes=0, latest_event_age_minutes=None, merged_into_trunk=True,
        ahead=1, trunk="main", stale_after_minutes=STALE)
    assert state == "merged"


# ── prune_plan: pure function, the refusal ──────────────────────────────────

@pytest.mark.parametrize("state", ["alive", "orphan", "unmerged"])
@pytest.mark.parametrize("dirty", [True, False])
def test_prune_plan_refuses_everything_but_merged(state, dirty):
    row = WorktreeRow(adw_id="x", branch="adw/x_y", path="/tmp/x_y", state=state, dirty=dirty)
    plan = worktrees.prune_plan([row])
    assert len(plan) == 1
    assert plan[0].prunable is False
    assert plan[0].commands == []


def test_prune_plan_for_a_merged_row_is_exactly_remove_then_delete_no_force():
    row = WorktreeRow(adw_id="x", branch="adw/x_y", path="/tmp/x_y", state="merged")
    plan = worktrees.prune_plan([row])

    assert len(plan) == 1
    action = plan[0]
    assert action.prunable is True
    assert action.commands == [["worktree", "remove", "/tmp/x_y"],
                               ["branch", "-d", "adw/x_y"]]
    flat = [token for command in action.commands for token in command]
    assert "--force" not in flat
    assert "-D" not in flat


# ── exit code / render: invariant 5 — a stranded row is never silent ───────

def test_exit_code_is_zero_when_nothing_is_stranded():
    rows = [WorktreeRow(adw_id="a", state="alive"), WorktreeRow(adw_id="b", state="merged")]
    assert worktrees.exit_code_for(rows) == 0


@pytest.mark.parametrize("state", ["unmerged", "orphan"])
def test_exit_code_is_one_when_anything_is_stranded(state):
    rows = [WorktreeRow(adw_id="a", state="alive"), WorktreeRow(adw_id="b", state=state)]
    assert worktrees.exit_code_for(rows) == 1


def test_render_names_a_stranded_row_and_reports_the_matching_exit_code():
    rows = [WorktreeRow(adw_id="deadbeef", branch="adw/deadbeef_x", state="unmerged",
                        ahead=7, note="HOLDS WORK: 7 commit(s) not in main, tree clean, "
                                     "session finished 'success'")]
    table = worktrees.render(rows)
    assert "deadbeef" in table
    assert "HOLDS WORK" in table
    assert "exit 1" in table


def test_render_is_headed_even_when_empty():
    # A table with just the header says "nothing is stranded"; no output at
    # all would read as "the tool broke" (8.5).
    table = worktrees.render([])
    assert "STATE" in table
    assert "exit 0" in table


def test_render_shows_a_title_column_before_the_adw_id():
    # "an id tells me nothing - I want to know which worktree ran which
    # ticket": TITLE leads, ADW_ID trails.
    rows = [WorktreeRow(adw_id="deadbeef", branch="adw/deadbeef_x", title="Add a login flow",
                        state="alive")]
    table = worktrees.render(rows)
    assert "TITLE" in table
    assert "Add a login flow" in table
    assert table.index("TITLE") < table.index("ADW_ID")
    header_line = table.splitlines()[0]
    row_line = next(line for line in table.splitlines() if "deadbeef" in line)
    assert row_line.index("Add a login flow") < row_line.index("deadbeef")
    assert header_line.index("TITLE") < header_line.index("ADW_ID")


# ── inventory: the full outer join ───────────────────────────────────────────

def test_inventory_joins_worktree_branch_and_session(main_repo, wcfg, tmp_path):
    db_path = tmp_path / "sssf.db"
    tracer = Tracer(db_path, tmp_path / "events.jsonl")
    tracer.session_start("aaaaaaaa", "tester", adw_name="adw_build")
    tracer.session_request("aaaaaaaa", "add a feature")
    tracer.session_finish("aaaaaaaa", ok=True)
    tracer.conn.close()

    rw = worktrees.ensure_run_worktree(main_repo, "aaaaaaaa", "add a feature", wcfg)
    (Path(rw.path) / "new.txt").write_text("x\n", encoding="utf-8")
    _run("add", "-A", cwd=Path(rw.path))
    _run("commit", "-q", "-m", "work", cwd=Path(rw.path))

    rows = worktrees.inventory(main_repo, wcfg, db_path)
    row = next(r for r in rows if r.adw_id == "aaaaaaaa")
    assert row.branch == rw.branch
    assert row.status == "success"
    assert row.request == "add a feature"
    assert row.state == "unmerged"          # a real commit not in trunk


def test_inventory_title_comes_from_the_trace_when_the_run_stamped_one(main_repo, wcfg, tmp_path):
    db_path = tmp_path / "sssf.db"
    tracer = Tracer(db_path, tmp_path / "events.jsonl")
    tracer.session_start("aaaaaaaa", "tester", adw_name="adw_build")
    tracer.event(EventRecord(adw_id="aaaaaaaa", type="log", name="branch",
                             payload={"branch": "adw/aaaaaaaa_add-a-login-flow",
                                      "path": "/tmp/x", "title": "Add a login flow"}))
    tracer.session_finish("aaaaaaaa", ok=True)
    tracer.conn.close()
    worktrees.ensure_run_worktree(main_repo, "aaaaaaaa", "add a feature", wcfg)

    rows = worktrees.inventory(main_repo, wcfg, db_path)

    row = next(r for r in rows if r.adw_id == "aaaaaaaa")
    assert row.title == "Add a login flow"


def test_inventory_title_falls_back_to_humanized_slug_without_a_trace_title(
        main_repo, wcfg, tmp_path):
    # Telemetry recorded before this fix: the old-style bare {"branch": ...}
    # payload, no "title" key at all.
    db_path = tmp_path / "sssf.db"
    tracer = Tracer(db_path, tmp_path / "events.jsonl")
    tracer.session_start("aaaaaaaa", "tester", adw_name="adw_build")
    tracer.event(EventRecord(adw_id="aaaaaaaa", type="log", name="branch",
                             payload={"branch": "adw/aaaaaaaa_add-a-clamp-helper"}))
    tracer.session_finish("aaaaaaaa", ok=True)
    tracer.conn.close()
    worktrees.ensure_run_worktree(main_repo, "aaaaaaaa", "add a clamp helper", wcfg)

    rows = worktrees.inventory(main_repo, wcfg, db_path)

    row = next(r for r in rows if r.adw_id == "aaaaaaaa")
    assert row.title == "Add a clamp helper"


def test_inventory_missing_db_is_not_fatal(main_repo, wcfg, tmp_path):
    worktrees.ensure_run_worktree(main_repo, "aaaaaaaa", "add a feature", wcfg)

    rows = worktrees.inventory(main_repo, wcfg, tmp_path / "does-not-exist.db")

    row = next(r for r in rows if r.adw_id == "aaaaaaaa")
    assert row.status == ""
    assert row.state == "orphan"            # no session row to name it


def test_inventory_duplicate_adw_id_raises(main_repo, wcfg):
    worktrees.ensure_run_worktree(main_repo, "aaaaaaaa", "first slug", wcfg)
    # A second, DIFFERENT branch sharing the same adw_id prefix — an operator
    # or another tool's mistake, not something this factory would itself do.
    _run("branch", "adw/aaaaaaaa_a-second-branch", cwd=main_repo)

    with pytest.raises(worktrees.ReconciliationError, match="share an adw_id"):
        worktrees.inventory(main_repo, wcfg, None)


def test_inventory_is_read_only(main_repo, wcfg, tmp_path):
    db_path = tmp_path / "sssf.db"
    tracer = Tracer(db_path, tmp_path / "events.jsonl")
    tracer.session_start("aaaaaaaa", "tester")
    tracer.conn.close()
    worktrees.ensure_run_worktree(main_repo, "aaaaaaaa", "add a feature", wcfg)

    before_bytes = db_path.read_bytes()
    before_mtime = db_path.stat().st_mtime_ns

    worktrees.inventory(main_repo, wcfg, db_path)

    assert db_path.read_bytes() == before_bytes
    assert db_path.stat().st_mtime_ns == before_mtime


# ── paths: session runtime stays in the main repo (5.3) ─────────────────────

def test_paths_keep_session_runtime_in_the_main_repo_when_repo_root_is_a_worktree(
        main_repo, monkeypatch):
    monkeypatch.chdir(main_repo)
    cfg = SSSFConfig(
        defaults=ConfigDefaults(data_dir="adw_data"),
        observability=ObservabilityConfig(db="adw_data/sssf.db"),
        worktrees=WorktreesConfig(root=str(main_repo.parent / "wts"), trunk="main"),
    )

    run = session.ensure(cfg, adw_id="aaaaaaaa")
    try:
        session_dir_before = run.session_dir
        handoff_before = run.context_handoff_dir

        run.enter_worktree("add a feature")

        assert run.repo_root != run.main_root
        assert not Path(run.repo_root).is_relative_to(run.main_root)
        # the session runtime never moved, even though repo_root did.
        assert run.session_dir == session_dir_before
        assert run.context_handoff_dir == handoff_before
        assert Path(run.session_dir).is_relative_to(run.main_root)
        assert Path(run.context_handoff_dir).is_relative_to(run.main_root)
    finally:
        run.tracer.conn.close()


# ── trace recording: the branch/title event (worktree-naming ticket) ───────
#
# The pre-worktree `branch` PHASE's `ph.log(branch=...)` stamped a
# `type=log, name=branch` event - morning-brief's collector still queries
# exactly that shape (fetch_branch). Once branching moved inside a phase
# named "worktree", `ph.log()` alone stamps `name="worktree"` instead (it
# always takes the ENCLOSING phase's name) and that query silently stopped
# matching anything. These pin `Run.enter_worktree` writing the event back
# under the name every reader expects, carrying the run's title too - with no
# assumption about which phase happens to be open when it runs.

def _branch_events(run) -> list[dict]:
    rows = run.tracer.conn.execute(
        "SELECT payload_json FROM events WHERE adw_id=? AND type='log' AND name='branch'",
        (run.adw_id,)).fetchall()
    return [json.loads(r[0]) for r in rows]


def test_enter_worktree_logs_a_branch_event_readers_can_find(main_repo, wcfg, monkeypatch):
    monkeypatch.chdir(main_repo)
    run = session.ensure(_sdlc_cfg(wcfg), adw_id="aaaaaaaa")
    try:
        rw = run.enter_worktree("Add a login flow\n\nsome body text")

        payloads = _branch_events(run)
        assert len(payloads) == 1
        assert payloads[0]["branch"] == rw["branch"]
        assert payloads[0]["path"] == rw["path"]
        assert payloads[0]["title"] == "Add a login flow"
    finally:
        run.tracer.conn.close()


def test_enter_worktree_logs_the_branch_event_regardless_of_the_open_phase_name(
        main_repo, wcfg, monkeypatch):
    # Regression coverage for the actual bug: ph.log() alone would have
    # stamped name="worktree" here, not "branch" - this proves the event
    # lands under the fixed name even though the ADW opens its phase as
    # "worktree", exactly like every real writing ADW does.
    monkeypatch.chdir(main_repo)
    run = session.ensure(_sdlc_cfg(wcfg), adw_id="bbbbbbbb")
    try:
        with run.phase(PhaseParams(name="worktree", kind="code", owner="git",
                                   description="Cut or join this run's branch and its own working tree")) as ph:
            ph.log(**run.enter_worktree("Add a login flow"))

        names = {row[0] for row in run.tracer.conn.execute(
            "SELECT name FROM events WHERE adw_id=? AND type='log'", (run.adw_id,)).fetchall()}
        assert "branch" in names
        assert len(_branch_events(run)) == 1
    finally:
        run.tracer.conn.close()


def test_enter_worktree_rejoin_logs_a_fresh_branch_event_each_call(main_repo, wcfg, monkeypatch):
    # A joined run (a second phase, or a fix-loop re-prompt) calls
    # enter_worktree again - each call logs its own event rather than
    # relying on the first one, so a reader always finds the latest.
    monkeypatch.chdir(main_repo)
    run = session.ensure(_sdlc_cfg(wcfg), adw_id="cccccccc")
    try:
        run.enter_worktree("Add a login flow")
        run.enter_worktree("now write the tests")

        payloads = _branch_events(run)
        assert len(payloads) == 2
        assert {p["title"] for p in payloads} == {"Add a login flow", "now write the tests"}
        assert len({p["branch"] for p in payloads}) == 1   # same branch both times
    finally:
        run.tracer.conn.close()


def test_enter_worktree_worktrees_disabled_still_logs_branch_and_title(main_repo, monkeypatch):
    # worktrees.enabled: false keeps pre-worktree behaviour (repo_root ==
    # main_root) - the trace-recording fix must not depend on the worktree
    # layer being on.
    monkeypatch.chdir(main_repo)
    cfg = SSSFConfig(
        defaults=ConfigDefaults(data_dir="adw_data"),
        observability=ObservabilityConfig(db="adw_data/sssf.db"),
        worktrees=WorktreesConfig(enabled=False),
    )
    run = session.ensure(cfg, adw_id="dddddddd")
    try:
        rw = run.enter_worktree("Add a login flow")

        assert run.repo_root == run.main_root
        payloads = _branch_events(run)
        assert len(payloads) == 1
        assert payloads[0]["branch"] == rw["branch"]
        assert payloads[0]["title"] == "Add a login flow"
    finally:
        run.tracer.conn.close()


# ── gates: relative artifacts resolve against run.repo_root (5.4) ──────────

def test_gates_resolve_relative_artifacts_against_repo_root_not_process_cwd(tmp_path):
    worktree_dir = tmp_path / "some-worktree"
    worktree_dir.mkdir()
    (worktree_dir / "plan.md").write_text("the plan\n", encoding="utf-8")

    run = SimpleNamespace(repo_root=worktree_dir)
    envelope = SimpleNamespace(artifacts=["plan.md"])

    report = gates.artifacts_exist(envelope, run)

    assert report.passed is True
    # It really came from repo_root, not some cwd fallback: no such file sits
    # next to wherever pytest happens to be running from.
    assert not (Path.cwd() / "plan.md").exists()


# ── permissions: the main-checkout tripwire is armed from phase one (5.5) ──
#
# Regression coverage for the bug the fix closes: the baseline used to be
# seeded lazily, on the FIRST call to `permissions.enforce()` — which happens
# at the END of the first agent phase, after that phase already ran. That left
# the tripwire blind for the entire first agent phase of every writing ADW,
# and completely inert for a single-agent-phase ADW (`adw_build`,
# `adw_document`), where that first call is also the only call. The fix seeds
# `run._main_checkout_snapshot` inside `Run.enter_worktree()` — before any
# agent runs — so these tests exercise exactly that ordering: enter the
# worktree, THEN open the (only) agent phase, THEN check enforcement.

def _sdlc_cfg(wcfg: WorktreesConfig) -> SSSFConfig:
    return SSSFConfig(
        defaults=ConfigDefaults(data_dir="adw_data"),
        observability=ObservabilityConfig(db="adw_data/sssf.db"),
        worktrees=wcfg,
    )


def _builder_agent(writes: list[str] | None = None) -> AgentConfig:
    return AgentConfig(
        name="builder",
        prompt_engineering=PromptEngineering(system="system.md", user="user.md"),
        writes=writes,
    )


def test_tripwire_catches_a_protected_write_into_main_during_the_first_agent_phase(
        main_repo, wcfg, monkeypatch):
    monkeypatch.chdir(main_repo)
    run = session.ensure(_sdlc_cfg(wcfg), adw_id="aaaaaaaa")
    try:
        run.enter_worktree("add a feature")            # seeds the baseline HERE (5.5 fix)
        assert run.repo_root != run.main_root
        assert run._main_checkout_snapshot is not None  # armed before any agent runs

        agent = _builder_agent()
        with (
            pytest.raises(permissions.PermissionBreach, match="protected"),
            run.phase(PhaseParams(name="build", kind="agent", owner="builder",
                                  description="Implement the request")) as ph,
        ):
            tree_before = permissions.snapshot(run)
            # A bash escape: the agent works in its OWN worktree, but also
            # reaches an absolute path into the MAIN checkout and edits
            # protected factory machinery there — invisible to `enforce`'s
            # own-tree diff, which is exactly why the tripwire exists.
            protected_dir = main_repo / "adws" / "adw_modules"
            protected_dir.mkdir(parents=True)
            (protected_dir / "runner.py").write_text("# tampered\n", encoding="utf-8")

            permissions.enforce(run, ph.phase, agent, tree_before)
    finally:
        run.tracer.conn.close()


def test_tripwire_logs_benign_main_checkout_drift_without_failing_the_first_phase(
        main_repo, wcfg, monkeypatch):
    monkeypatch.chdir(main_repo)
    run = session.ensure(_sdlc_cfg(wcfg), adw_id="bbbbbbbb")
    try:
        run.enter_worktree("add a feature")

        agent = _builder_agent()
        with run.phase(PhaseParams(name="build", kind="agent", owner="builder",
                                   description="Implement the request")) as ph:
            tree_before = permissions.snapshot(run)
            # The operator editing something unprotected in the main checkout
            # while this run is in flight — normal life on this laptop, must
            # not abort the run.
            (main_repo / "notes.md").write_text("operator notes\n", encoding="utf-8")

            touched = permissions.enforce(run, ph.phase, agent, tree_before)
            assert touched == []       # the agent itself touched nothing in ITS tree

        rows = run.tracer.conn.execute(
            "SELECT payload_json FROM events WHERE adw_id=? AND name='main_checkout_drift'",
            (run.adw_id,)).fetchall()
        assert len(rows) == 1
        assert "notes.md" in rows[0][0]
    finally:
        run.tracer.conn.close()
