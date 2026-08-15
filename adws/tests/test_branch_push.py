"""The branch return (MAP.md two-box model): a finished run's own branch has
to reach `origin` for the laptop's Gate to see and merge it.

Three layers, tested bottom-up, real git throughout — a local bare repo
stands in for GitHub, exactly the way test_worktrees.py's `main_repo` stands
in for the operator's own checkout. No network anywhere: "local bare origin"
means a second directory under `tmp_path`, never a real remote.

  1. git_helper.has_remote / push_branch — the raw git plumbing, no ADW
     concepts involved.
  2. adw_modules.worktrees.push_run_branch — the decision (push / skip-empty
     / skip-no-remote / report-failure), pure w.r.t. the filesystem beyond
     the git calls it makes.
  3. runner.Run._push_run_branch, exercised through the one real call site,
     `run.finish()` — proves the whole thing wires together and, above all,
     that a push failure never fails the run.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from adw_modules import git_helper, worktrees
from adw_modules.data_types import PhaseParams, SSSFConfig, WorktreesConfig
from adw_modules.runner import Run
from adw_modules.tracer import Tracer


def _run(*args: str, cwd: Path) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                            encoding="utf-8", check=False)
    assert result.returncode == 0, f"git {' '.join(args)} failed: {result.stderr}"
    return result.stdout.strip()


@pytest.fixture
def bare_origin(tmp_path):
    """A local bare repo standing in for GitHub — real git, no network."""
    origin = tmp_path / "origin.git"
    origin.mkdir()
    _run("init", "-q", "--bare", "-b", "main", cwd=origin)
    return origin


@pytest.fixture
def main_repo(tmp_path):
    """A throwaway git repo standing in for the main checkout. No remote by
    default — tests that need one add it themselves, so the no-remote skip
    path is exercised by a repo that genuinely has none.

    Carries `integration` alongside `main`, at the same tip (MAP.md's
    integration-branch ruling, 2026-08-15) — run branches are measured
    against `integration` now, never `main`."""
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


def _commit_something(repo: Path, name: str = "work.txt") -> None:
    (repo / name).write_text("x\n", encoding="utf-8")
    _run("add", "-A", cwd=repo)
    _run("commit", "-q", "-m", f"add {name}", cwd=repo)


# ── layer 1: git_helper.has_remote / push_branch — raw plumbing ────────────

def test_has_remote_is_false_until_origin_is_added(main_repo, bare_origin):
    assert git_helper.has_remote("origin", tree=main_repo) is False
    _run("remote", "add", "origin", str(bare_origin), cwd=main_repo)
    assert git_helper.has_remote("origin", tree=main_repo) is True


def test_push_branch_lands_a_real_branch_on_the_local_bare_remote(main_repo, bare_origin):
    _run("remote", "add", "origin", str(bare_origin), cwd=main_repo)
    _run("checkout", "-q", "-b", "adw/cafef00d_thing", cwd=main_repo)
    _commit_something(main_repo)

    ok, error = git_helper.push_branch("adw/cafef00d_thing", tree=main_repo)

    assert ok is True
    assert error == ""
    branches = _run("branch", "--list", "adw/cafef00d_thing",
                    "--format=%(refname:short)", cwd=bare_origin)
    assert branches.splitlines() == ["adw/cafef00d_thing"]


def test_push_branch_never_raises_and_returns_stderr_on_failure(main_repo, tmp_path):
    # A remote pointed at a path that does not exist - local-only, no network,
    # but git refuses it exactly the way a dead/unreachable GitHub would.
    _run("remote", "add", "origin", str(tmp_path / "does-not-exist.git"), cwd=main_repo)

    ok, error = git_helper.push_branch("main", tree=main_repo)

    assert ok is False
    assert error != ""


def test_push_branch_never_force_pushes_a_diverged_ref(main_repo, bare_origin):
    # Make origin's main diverge ahead of local main, then try to push local
    # main anyway - a real (non-force) push must be REJECTED, and origin's
    # ref must stay exactly where it was. This is what "never --force" means
    # in practice: push_branch has no flag that could win this race by force.
    _run("remote", "add", "origin", str(bare_origin), cwd=main_repo)
    _run("push", "-q", "-u", "origin", "main", cwd=main_repo)
    _commit_something(main_repo, "ahead.txt")
    _run("push", "-q", "origin", "main", cwd=main_repo)
    diverged_sha = _run("rev-parse", "main", cwd=bare_origin)
    _run("reset", "-q", "--hard", "HEAD~1", cwd=main_repo)   # local main now BEHIND origin

    ok, error = git_helper.push_branch("main", tree=main_repo)

    assert ok is False
    assert error != ""
    assert _run("rev-parse", "main", cwd=bare_origin) == diverged_sha


# ── layer 2: worktrees.push_run_branch — the decision ───────────────────────

def test_push_run_branch_pushes_when_the_branch_holds_commits(main_repo, bare_origin):
    _run("remote", "add", "origin", str(bare_origin), cwd=main_repo)
    _run("checkout", "-q", "-b", "adw/deadbeef_add-thing", cwd=main_repo)
    _commit_something(main_repo)

    status, detail = worktrees.push_run_branch(main_repo, "adw/deadbeef_add-thing", "integration")

    assert (status, detail) == ("pushed", "")
    branches = _run("branch", "--list", "adw/deadbeef_add-thing",
                    "--format=%(refname:short)", cwd=bare_origin)
    assert branches.splitlines() == ["adw/deadbeef_add-thing"]


def test_push_run_branch_skips_silently_when_nothing_was_committed(main_repo, bare_origin):
    _run("remote", "add", "origin", str(bare_origin), cwd=main_repo)
    # A branch cut but never advanced - the worktree phase ran, nothing else did.
    _run("checkout", "-q", "-b", "adw/deadbeef_nothing-yet", cwd=main_repo)

    status, detail = worktrees.push_run_branch(
        main_repo, "adw/deadbeef_nothing-yet", "integration")

    assert (status, detail) == ("no-commits", "")
    branches = _run("branch", "--list", "adw/deadbeef_nothing-yet", cwd=bare_origin)
    assert branches == ""


def test_push_run_branch_skips_when_no_origin_is_configured(main_repo):
    _run("checkout", "-q", "-b", "adw/deadbeef_add-thing", cwd=main_repo)
    _commit_something(main_repo)

    status, detail = worktrees.push_run_branch(main_repo, "adw/deadbeef_add-thing", "integration")

    assert (status, detail) == ("no-remote", "")


def test_push_run_branch_reports_failure_without_raising(main_repo, tmp_path):
    _run("remote", "add", "origin", str(tmp_path / "does-not-exist.git"), cwd=main_repo)
    _run("checkout", "-q", "-b", "adw/deadbeef_add-thing", cwd=main_repo)
    _commit_something(main_repo)

    status, detail = worktrees.push_run_branch(main_repo, "adw/deadbeef_add-thing", "integration")

    assert status == "failed"
    assert detail != ""


# ── layer 3: Run.finish() — the one real call site ──────────────────────────

def _make_run(main_repo: Path, tmp_path: Path, *, adw_id: str = "deadbeef") -> Run:
    """A minimally real Run: worktrees disabled (the branch is cut straight
    in `main_repo`, so no `.venv`/toolchain sync is triggered), a real Tracer
    against a throwaway sqlite db. Nothing here is mocked - every git/tracer
    call inside `Run` runs for real against `tmp_path`."""
    cfg = SSSFConfig(worktrees=WorktreesConfig(enabled=False, trunk="integration"))
    tracer = Tracer(tmp_path / "sssf.db", tmp_path / "events.jsonl")
    return Run(cfg=cfg, adw_id=adw_id, tracer=tracer, engineer="test",
              main_root=main_repo, data_dir=tmp_path / "data")


def test_finish_pushes_the_run_branch_to_origin(main_repo, bare_origin, tmp_path):
    _run("remote", "add", "origin", str(bare_origin), cwd=main_repo)
    run = _make_run(main_repo, tmp_path)

    with run.phase(PhaseParams(name="worktree", kind="code", owner="git", description="test")) as ph:
        ph.log(**run.enter_worktree("Add a thing"))
    with run.phase(PhaseParams(name="commit", kind="code", owner="git", description="test")) as ph:
        (run.repo_root / "new.txt").write_text("x\n", encoding="utf-8")
        ph.log(sha=git_helper.commit_all("work", tree=run.repo_root))

    exit_code = run.finish()

    assert exit_code == 0
    assert run.worktree is not None
    branches = _run("branch", "--list", run.worktree.branch,
                    "--format=%(refname:short)", cwd=bare_origin)
    assert branches.splitlines() == [run.worktree.branch]


def test_finish_never_crashes_the_run_when_the_push_fails(main_repo, tmp_path):
    _run("remote", "add", "origin", str(tmp_path / "does-not-exist.git"), cwd=main_repo)
    run = _make_run(main_repo, tmp_path)

    with run.phase(PhaseParams(name="worktree", kind="code", owner="git", description="test")) as ph:
        ph.log(**run.enter_worktree("Add a thing"))
    with run.phase(PhaseParams(name="commit", kind="code", owner="git", description="test")) as ph:
        (run.repo_root / "new.txt").write_text("x\n", encoding="utf-8")
        ph.log(sha=git_helper.commit_all("work", tree=run.repo_root))

    exit_code = run.finish()   # must not raise

    assert exit_code == 0   # the RUN succeeded; only the push failed
    events = run.tracer.conn.execute(
        "SELECT type, name, payload_json FROM events WHERE adw_id=? AND name='push_branch'",
        (run.adw_id,)).fetchall()
    assert len(events) == 1
    assert events[0][0] == "error"
    assert run.worktree.branch in events[0][2]


def test_finish_skips_quietly_when_there_is_no_origin(main_repo, tmp_path, capsys):
    run = _make_run(main_repo, tmp_path)   # no remote configured at all

    with run.phase(PhaseParams(name="worktree", kind="code", owner="git", description="test")) as ph:
        ph.log(**run.enter_worktree("Add a thing"))
    with run.phase(PhaseParams(name="commit", kind="code", owner="git", description="test")) as ph:
        (run.repo_root / "new.txt").write_text("x\n", encoding="utf-8")
        ph.log(sha=git_helper.commit_all("work", tree=run.repo_root))

    exit_code = run.finish()

    assert exit_code == 0
    assert "no 'origin' remote" in capsys.readouterr().out


def test_finish_pushes_nothing_when_the_run_never_committed(main_repo, bare_origin, tmp_path):
    _run("remote", "add", "origin", str(bare_origin), cwd=main_repo)
    run = _make_run(main_repo, tmp_path)

    with run.phase(PhaseParams(name="worktree", kind="code", owner="git", description="test")) as ph:
        ph.log(**run.enter_worktree("Add a thing"))
    # no commit phase - the branch is cut but holds nothing beyond trunk

    run.finish()

    branches = _run("branch", "--list", run.worktree.branch, cwd=bare_origin)
    assert branches == ""


def test_finish_is_a_noop_for_a_run_that_never_entered_a_worktree(main_repo, bare_origin, tmp_path):
    # The four read-only ADWs' shape: no enter_worktree() call at all.
    _run("remote", "add", "origin", str(bare_origin), cwd=main_repo)
    run = _make_run(main_repo, tmp_path)

    with run.phase(PhaseParams(name="request", kind="engineer", owner="test", description="test")) as ph:
        ph.log(input="just reading")

    exit_code = run.finish()   # must not raise despite self.worktree being None

    assert exit_code == 0
    assert run.worktree is None
