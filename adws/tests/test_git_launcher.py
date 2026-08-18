"""How every git subprocess in this factory is launched
(adw_modules/git_helper: `git_env`, `SIGNING_OFF`, the timeout tiers).

THE FAILURE THESE PIN. The factory runs unattended, and git asks questions. A
git that wants a password, an SSH host-key confirmation or a GPG passphrase has
no terminal to ask on under systemd, so it BLOCKS - holding the engine's single
loop thread forever while `systemctl is-active` still reports `active`, the
journal stays silent and the Board stops moving with no error anywhere. Every
one of those is a reachable state on a fresh server: an https remote with no
credential helper, a hub whose host key is not in known_hosts yet, a
`commit.gpgsign = true` inherited from the operator's global gitconfig.

Two of these tests spy on `subprocess.run` to prove the environment and the
argv actually REACH git; the rest drive the real thing in a temp repo.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from adw_modules import git_helper


def _spy(monkeypatch) -> list[dict]:
    """Record every `subprocess.run` git_helper makes, and answer success.

    Nothing here launches git: these assertions are about what git_helper HANDS
    the OS - the env overlay, the `-c` overrides, the timeout - which is exactly
    what a real invocation would swallow silently."""
    seen: list[dict] = []

    def fake(argv, **kwargs):
        seen.append({"argv": list(argv), **kwargs})
        return subprocess.CompletedProcess(args=argv, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(git_helper.subprocess, "run", fake)
    return seen


@pytest.fixture
def repo(tmp_path):
    """A real temp git repo with one commit, and an identity of its own so it
    never depends on the operator's."""
    root = tmp_path / "repo"
    root.mkdir()
    for args in (("init", "-q", "-b", "main"),
                 ("config", "user.email", "t@example.com"),
                 ("config", "user.name", "T")):
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
    (root / "a.txt").write_text("one\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=root, check=True, capture_output=True)
    return root


# ── the environment overlay ─────────────────────────────────────────────────

def test_git_never_prompts_for_credentials(monkeypatch):
    """`GIT_TERMINAL_PROMPT=0` is the difference between a push that FAILS in
    300ms with a usable error and one that hangs the loop thread forever."""
    seen = _spy(monkeypatch)
    git_helper.run("status", "--porcelain", tree=".")

    assert seen[0]["env"]["GIT_TERMINAL_PROMPT"] == "0"


def test_git_never_shells_out_to_a_gui_password_asker(monkeypatch):
    """Empty, not unset. An inherited GIT_ASKPASS/SSH_ASKPASS from the
    operator's desktop session is exactly what pops an invisible dialog on a
    headless box - unsetting ours would let theirs through."""
    monkeypatch.setenv("GIT_ASKPASS", "/usr/bin/some-gui-asker")
    seen = _spy(monkeypatch)
    git_helper.run("status", tree=".")

    assert seen[0]["env"]["GIT_ASKPASS"] == ""


def test_ssh_runs_in_batch_mode_and_accepts_a_new_host_key(monkeypatch):
    """BatchMode kills the passphrase prompt; accept-new kills the "Are you
    sure you want to continue connecting?" prompt on first contact with the hub
    WITHOUT blessing a key that changed (which `no` would not distinguish)."""
    seen = _spy(monkeypatch)
    git_helper.run("fetch", tree=".")

    command = seen[0]["env"]["GIT_SSH_COMMAND"]
    assert "-oBatchMode=yes" in command
    assert "-oStrictHostKeyChecking=accept-new" in command


def test_read_only_queries_do_not_take_the_index_lock(monkeypatch):
    """`GIT_OPTIONAL_LOCKS=0`: a status query running beside a run's commit
    must not be able to make that commit fail on a lock it never needed."""
    seen = _spy(monkeypatch)
    git_helper.run("status", "--porcelain", tree=".")

    assert seen[0]["env"]["GIT_OPTIONAL_LOCKS"] == "0"


def test_the_overlay_keeps_the_operators_own_environment(monkeypatch):
    """An overlay, not a replacement: git still needs HOME, the ssh agent
    socket, and whatever credential helper the operator configured."""
    monkeypatch.setenv("SDL_FACTORY_MARKER", "kept")
    seen = _spy(monkeypatch)
    git_helper.run("status", tree=".")

    assert seen[0]["env"]["SDL_FACTORY_MARKER"] == "kept"


def test_the_overlay_is_read_fresh_at_every_call(monkeypatch):
    """Uncached, the same rule `utils.uv_bin` and `agent_pi.pi_cmd` follow: a
    repaired `.env` or a newly started ssh-agent is picked up with no restart."""
    monkeypatch.setenv("SDL_FACTORY_MARKER", "before")
    assert git_helper.git_env()["SDL_FACTORY_MARKER"] == "before"
    monkeypatch.setenv("SDL_FACTORY_MARKER", "after")
    assert git_helper.git_env()["SDL_FACTORY_MARKER"] == "after"


# ── signing, neutralized centrally ──────────────────────────────────────────

def test_every_invocation_carries_the_signing_overrides(monkeypatch):
    """Prepended to EVERY git call rather than sniffed per verb: `-c
    commit.gpgsign=false` is inert for `status` and correct for commit, merge,
    rebase, cherry-pick and am alike - all of which create commits, and all of
    which this factory runs. Sniffing would have to enumerate that list
    correctly forever."""
    seen = _spy(monkeypatch)
    git_helper.run("status", tree=".")

    argv = seen[0]["argv"]
    assert argv[0] == "git"
    assert argv[1:5] == ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"]
    assert argv[5] == "status"


def test_a_commit_succeeds_under_a_gitconfig_that_demands_signing(repo):
    """The end-to-end proof, with a real repo and a real commit. `gpgsign =
    true` plus a signing program that does not exist is what an operator's
    inherited global gitconfig looks like on a server with no GPG key: without
    the override this commit fails (or, with a real gpg, hangs on a passphrase
    prompt with no terminal to show it)."""
    subprocess.run(["git", "config", "commit.gpgsign", "true"], cwd=repo,
                   check=True, capture_output=True)
    subprocess.run(["git", "config", "gpg.program", "sdl-factory-no-such-gpg"], cwd=repo,
                   check=True, capture_output=True)
    (repo / "b.txt").write_text("two\n", encoding="utf-8")

    sha = git_helper.commit_all("factory: a signed-config commit", tree=repo)

    assert sha
    assert git_helper.rev("HEAD", tree=repo)


def test_the_engines_own_commit_path_is_covered_by_the_same_override(repo):
    """engine.py's `commit_card`/`park_card` reach git through
    `git_helper.run`, which is why the override lives in one place instead of
    at three commit sites (and covers the fourth nobody remembers to add)."""
    subprocess.run(["git", "config", "commit.gpgsign", "true"], cwd=repo,
                   check=True, capture_output=True)
    subprocess.run(["git", "config", "gpg.program", "sdl-factory-no-such-gpg"], cwd=repo,
                   check=True, capture_output=True)
    (repo / "c.txt").write_text("three\n", encoding="utf-8")
    git_helper.run("add", "-A", tree=repo)

    result = git_helper.run("commit", "-m", "factory: via run()", tree=repo)

    assert result.returncode == 0, result.stderr


# ── timeouts ────────────────────────────────────────────────────────────────

def test_local_queries_get_the_short_ceiling(monkeypatch):
    seen = _spy(monkeypatch)
    git_helper.run("rev-parse", "HEAD", tree=".")

    assert seen[0]["timeout"] == git_helper.LOCAL_TIMEOUT


@pytest.mark.parametrize("verb", ["push", "fetch", "pull", "clone", "ls-remote"])
def test_network_verbs_get_the_generous_ceiling(monkeypatch, verb):
    """A push over a slow link legitimately takes minutes; `rev-parse` that has
    run for a minute is never going to answer. One ceiling for both would
    either kill real pushes or leave a stuck query holding the loop."""
    seen = _spy(monkeypatch)
    git_helper.run(verb, tree=".")

    assert seen[0]["timeout"] == git_helper.NETWORK_TIMEOUT


def test_the_verb_is_found_past_the_signing_options(monkeypatch):
    """The tier is chosen from the first argument that is not an option, so the
    `-c ...` prefix this module always prepends cannot hide a `push` behind
    itself and downgrade it to the 60s ceiling."""
    assert git_helper._timeout_for(("push", "-u", "origin", "x"), None) == \
        git_helper.NETWORK_TIMEOUT
    assert git_helper._timeout_for(("status",), None) == git_helper.LOCAL_TIMEOUT
    # An option's separate VALUE is not the verb - `-c key=value push` must
    # still read as a push, not as `key=value`.
    assert git_helper._timeout_for(("-c", "x=y", "push"), None) == git_helper.NETWORK_TIMEOUT
    assert git_helper._timeout_for(("--no-pager", "fetch"), None) == git_helper.NETWORK_TIMEOUT
    assert git_helper._timeout_for(("--git-dir=x", "fetch"), None) == git_helper.NETWORK_TIMEOUT
    assert git_helper._timeout_for(("-C", "some/dir", "status"), None) == \
        git_helper.LOCAL_TIMEOUT


def test_a_caller_can_override_the_ceiling(monkeypatch):
    seen = _spy(monkeypatch)
    git_helper.run("status", tree=".", timeout=1.5)

    assert seen[0]["timeout"] == 1.5


def test_a_timeout_comes_back_as_a_failed_completedprocess_never_an_exception(monkeypatch):
    """The shape every caller in this factory already branches on. A raw
    `TimeoutExpired` would sail past every `returncode != 0` check and land in
    `engine.run_cycle`'s catch-all as an unnamed `cycle failed` line."""
    def fake(argv, **kwargs):
        raise subprocess.TimeoutExpired(cmd=argv, timeout=kwargs.get("timeout", 0))
    monkeypatch.setattr(git_helper.subprocess, "run", fake)

    result = git_helper.run("push", tree=".")

    assert isinstance(result, subprocess.CompletedProcess)
    assert result.returncode == git_helper.TIMEOUT_RETURNCODE
    assert "timed out after 300s" in result.stderr


def test_a_timeout_on_a_raising_helper_is_the_runtimeerror_callers_expect(monkeypatch):
    """`_git`'s existing failure shape is RuntimeError, and every caller that
    guards one already catches it (`quality.ai_defects`, `runner._push_run_branch`).
    A timeout is one more failure, not a new exception type to handle."""
    def fake(argv, **kwargs):
        raise subprocess.TimeoutExpired(cmd=argv, timeout=kwargs.get("timeout", 0))
    monkeypatch.setattr(git_helper.subprocess, "run", fake)

    with pytest.raises(RuntimeError, match="timed out"):
        git_helper.rev("HEAD", tree=".")


def test_partial_output_captured_before_a_timeout_is_not_thrown_away(monkeypatch):
    """TimeoutExpired carries whatever git managed to write, typed bytes|str
    because the reader can be interrupted before it decodes. Both are
    normalized rather than assumed."""
    def fake(argv, **kwargs):
        raise subprocess.TimeoutExpired(cmd=argv, timeout=1, output=b"partial stdout",
                                        stderr=b"partial stderr")
    monkeypatch.setattr(git_helper.subprocess, "run", fake)

    result = git_helper.run("fetch", tree=".")

    assert result.stdout == "partial stdout"
    assert "partial stderr" in result.stderr


# ── the door is the only door ───────────────────────────────────────────────

def test_no_git_call_in_the_module_bypasses_the_shared_launcher():
    """The guarantees above hold everywhere only because `_run_git` is the one
    door. A future `subprocess.run(["git", ...])` added straight into this
    module would silently opt out of the environment, the signing override and
    the timeout - so the module is read and that is asserted directly."""
    source = Path(git_helper.__file__).read_text(encoding="utf-8")

    # Exactly one, and it is the one inside `_run_git`. The argv literal
    # `["git", *SIGNING_OFF, *args]` is likewise built in exactly one place
    # (`_argv`), so no call site can assemble its own.
    assert source.count("subprocess.run(") == 1
    assert source.count('["git",') == 1
