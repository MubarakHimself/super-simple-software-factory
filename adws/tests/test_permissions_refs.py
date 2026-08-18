"""The ref tripwire: what the content snapshot cannot see
(adw_modules/permissions.snapshot_refs / enforce_refs).

THE HOLE THIS CLOSES. `permissions.snapshot()` fingerprints the working tree
against HEAD. An agent that COMMITS erases its own evidence from that
comparison: after `git commit -am`, `git diff HEAD --numstat` reports nothing
and the untracked list is empty, so `enforce()` concludes the agent touched no
path at all and the phase passes clean. `git checkout <branch>`, `git reset
--hard` and `git stash` blind it the same way, and every one of them is
reachable from the `bash` tool a builder legitimately needs to run a test
suite.

Real temp git repos and real commits - the point is precisely that git's own
plumbing reports nothing after a commit, which a mock would not reproduce.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from adw_modules import permissions
from adw_modules.data_types import AgentConfig, PromptEngineering


def _git(*args, cwd):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                            encoding="utf-8")
    assert result.returncode == 0, f"git {' '.join(args)} failed: {result.stderr}"
    return result.stdout.strip()


@pytest.fixture
def tree(tmp_path):
    """A real repo with one commit and an identity of its own."""
    root = tmp_path / "tree"
    root.mkdir()
    _git("init", "-q", "-b", "main", cwd=root)
    _git("config", "user.email", "t@example.com", cwd=root)
    _git("config", "user.name", "T", cwd=root)
    _git("config", "commit.gpgsign", "false", cwd=root)
    (root / "a.txt").write_text("one\n", encoding="utf-8")
    _git("add", "-A", cwd=root)
    _git("commit", "-qm", "init", cwd=root)
    return root


@pytest.fixture
def run(tree):
    """The two attributes `snapshot_refs`/`enforce_refs` actually read."""
    return SimpleNamespace(repo_root=tree, main_root=tree)


AGENT = AgentConfig(
    name="builder",
    prompt_engineering=PromptEngineering(system="system.md", user="user.md"),
)


def test_a_quiet_agent_phase_trips_nothing(run):
    """The overwhelmingly common case: an agent edits files, the runner commits
    them later in its own code phase. Nothing moved during the phase."""
    before = permissions.snapshot_refs(run)
    (run.repo_root / "a.txt").write_text("edited by the agent\n", encoding="utf-8")

    permissions.enforce_refs(run, AGENT, before)      # does not raise


def test_an_agent_that_commits_is_caught_even_though_the_tree_reads_clean(run):
    """THE CASE THE CONTENT SNAPSHOT CANNOT SEE. The commit is made, the tree
    goes clean, `_snapshot_tree` reports an empty change-set - and the phase
    would have passed as "touched nothing" while the repo was rewritten."""
    before = permissions.snapshot_refs(run)
    tree_before = permissions.snapshot(run)

    (run.repo_root / "a.txt").write_text("rewritten\n", encoding="utf-8")
    _git("add", "-A", cwd=run.repo_root)
    _git("commit", "-qm", "the agent committed this itself", cwd=run.repo_root)

    # The old mechanism, on its own, sees absolutely nothing:
    assert permissions.changed_paths(tree_before, permissions.snapshot(run)) == []

    with pytest.raises(permissions.PermissionBreach, match="moved this run's git refs"):
        permissions.enforce_refs(run, AGENT, before)


def test_an_agent_that_switches_branches_is_caught(run):
    """The runner cuts branches in `enter_worktree()`, before any agent runs,
    and never inside an agent phase - so a branch that moved has one author."""
    before = permissions.snapshot_refs(run)
    _git("checkout", "-q", "-b", "somewhere-else", cwd=run.repo_root)

    with pytest.raises(permissions.PermissionBreach, match="branch main -> somewhere-else"):
        permissions.enforce_refs(run, AGENT, before)


def test_an_agent_that_resets_hard_is_caught(run):
    """`git reset --hard HEAD~1` is the most destructive of the set: it drops a
    commit AND leaves the tree looking clean."""
    (run.repo_root / "b.txt").write_text("two\n", encoding="utf-8")
    _git("add", "-A", cwd=run.repo_root)
    _git("commit", "-qm", "second", cwd=run.repo_root)

    before = permissions.snapshot_refs(run)
    _git("reset", "-q", "--hard", "HEAD~1", cwd=run.repo_root)

    with pytest.raises(permissions.PermissionBreach, match="HEAD"):
        permissions.enforce_refs(run, AGENT, before)


def test_the_breach_names_the_agent_the_movement_and_how_to_look(run):
    """A breach cannot be corrected by re-prompting, so the message is the
    whole remedy: who, what moved, both possible authors, and the one command
    that shows what happened."""
    before = permissions.snapshot_refs(run)
    (run.repo_root / "a.txt").write_text("rewritten\n", encoding="utf-8")
    _git("commit", "-qam", "agent commit", cwd=run.repo_root)

    with pytest.raises(permissions.PermissionBreach) as caught:
        permissions.enforce_refs(run, AGENT, before)

    message = str(caught.value)
    assert "builder" in message
    assert "HEAD" in message
    assert f"git -C {run.repo_root} log --stat -3" in message
    assert "Nothing was rolled back" in message      # history is never rewritten here


def test_nothing_is_rolled_back_by_the_ref_check(run):
    """This factory does not rewrite history it did not write. The tripwire
    REPORTS; a human decides."""
    before = permissions.snapshot_refs(run)
    (run.repo_root / "a.txt").write_text("rewritten\n", encoding="utf-8")
    _git("commit", "-qam", "agent commit", cwd=run.repo_root)
    head = _git("rev-parse", "HEAD", cwd=run.repo_root)

    with pytest.raises(permissions.PermissionBreach):
        permissions.enforce_refs(run, AGENT, before)

    assert _git("rev-parse", "HEAD", cwd=run.repo_root) == head


def test_a_non_git_directory_trips_nothing(tmp_path):
    """The four read-only ADWs run fine outside a repo. Both snapshots answer
    empty, which compares equal."""
    plain = SimpleNamespace(repo_root=tmp_path, main_root=tmp_path)

    before = permissions.snapshot_refs(plain)
    assert before == ("", "")
    permissions.enforce_refs(plain, AGENT, before)    # does not raise


def test_a_detached_head_is_a_value_like_any_other(run):
    """A tree the gate detached reads `HEAD` as its branch name. That is a
    perfectly good thing to compare - it CHANGING means the tree was reattached
    under the agent, which is exactly as interesting."""
    _git("checkout", "-q", "--detach", "HEAD", cwd=run.repo_root)
    before = permissions.snapshot_refs(run)
    assert before[1] == "HEAD"

    permissions.enforce_refs(run, AGENT, before)      # stable: does not raise

    _git("checkout", "-q", "main", cwd=run.repo_root)
    with pytest.raises(permissions.PermissionBreach, match="branch HEAD -> main"):
        permissions.enforce_refs(run, AGENT, before)


def test_the_refs_are_read_in_one_git_call(run, monkeypatch):
    """Cheap on purpose: one `rev-parse` answers both questions, so the
    tripwire costs two subprocesses per agent phase - nothing beside the coding
    agent turn it brackets."""
    calls: list[list[str]] = []
    real = permissions._git

    def counting(args, cwd):
        calls.append(list(args))
        return real(args, cwd)
    monkeypatch.setattr(permissions, "_git", counting)

    permissions.snapshot_refs(run)

    assert len(calls) == 1
    assert calls[0] == ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"]


def test_agents_execute_checks_refs_before_content():
    """Order is load-bearing: a commit is what BLINDS the content comparison,
    so discovering it afterwards would mean reporting "this agent touched
    nothing" about a run that rewrote the repo."""
    source = Path(permissions.__file__).parent.joinpath("agents.py").read_text(encoding="utf-8")

    assert source.index("permissions.enforce_refs(") < source.index("permissions.enforce(")
