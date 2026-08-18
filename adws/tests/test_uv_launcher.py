"""How `uv` is resolved, and what the engine does when it cannot be
(adw_modules/utils.uv_bin/uv_cmd, engine.uv_launchable, engine.spawn).

THE FAILURE THESE PIN. Every child argv in this factory starts with `uv`: the
engine's dispatch children, the dispatch script's own ADW child, and every
command of the integration gate's suite. All three used a BARE name, which the
OS resolves against the child's PATH — and the child's PATH is
`utils.operator_env()`'s, which strips the ADW's own venv bin back off, on a
systemd PATH that does not carry `~/.local/bin` where uv installs. Every
`Popen` raised OSError, every card was written into `engine.refused` (which
nothing ever retries), and the quality gate returned red on its OSError branch
— a service `systemctl is-active` called `active`, all night, shipping nothing.

Hermetic: nothing here launches uv. The resolver is driven through `$UV` and a
monkeypatched PATH, and the engine's spawn failure is provoked with a command
name that cannot exist.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import dispatch
import engine
import pytest
from adw_modules import utils

# ── the resolver ────────────────────────────────────────────────────────────

def test_the_uv_environment_variable_is_trusted_first(monkeypatch, tmp_path):
    """uv sets `$UV` to its own absolute path for every child it launches, and
    every ADW, the engine and every quality block already run under `uv run`.
    That is the source that answers on a correctly deployed server no matter
    what systemd put in PATH, so it is asked first."""
    real = tmp_path / "uv.exe"
    real.write_text("", encoding="utf-8")
    monkeypatch.setenv("UV", str(real))

    assert utils.uv_bin() == str(real)
    assert utils.uv_cmd() == str(real)


def test_a_stale_uv_variable_naming_a_deleted_binary_falls_through_to_path(
        monkeypatch, tmp_path):
    """A uv upgrade that moves the binary leaves `$UV` pointing at nothing.
    Trusting it would pin the whole factory to a dead path; the PATH search is
    the fallback, and it wins."""
    on_path = tmp_path / "bin"
    on_path.mkdir()
    found = on_path / ("uv.exe" if sys.platform == "win32" else "uv")
    found.write_text("", encoding="utf-8")
    found.chmod(0o755)

    monkeypatch.setenv("UV", str(tmp_path / "moved-by-an-upgrade" / "uv"))
    monkeypatch.setenv("PATH", str(on_path))

    assert Path(utils.uv_bin()) == found


def test_an_unresolvable_uv_reads_empty_and_never_raises(monkeypatch):
    """`uv_bin` is a question, like `git_helper.ref_exists`. The engine's
    preflight is what turns the answer into a held cycle - the resolver itself
    must never throw into the middle of an argv being built."""
    monkeypatch.delenv("UV", raising=False)
    monkeypatch.setenv("PATH", "")

    assert utils.uv_bin() == ""


def test_uv_cmd_falls_back_to_the_bare_name_rather_than_an_empty_argv0(monkeypatch):
    """`""` as argv[0] is a `subprocess` error with no useful text in it. The
    honest fallback is the behaviour the factory always had: hand the bare name
    over and let the launch fail with the OS's own message."""
    monkeypatch.delenv("UV", raising=False)
    monkeypatch.setenv("PATH", "")

    assert utils.uv_cmd() == "uv"


def test_the_resolver_is_uncached_so_a_repair_needs_no_restart(monkeypatch, tmp_path):
    """The whole point of resolving at the CALL (the rule `agent_pi.pi_cmd`
    already follows): an operator who installs uv while the service is running
    is picked up on the next cycle, not the next restart."""
    monkeypatch.delenv("UV", raising=False)
    monkeypatch.setenv("PATH", "")
    assert utils.uv_bin() == ""

    installed = tmp_path / "uv.exe"
    installed.write_text("", encoding="utf-8")
    monkeypatch.setenv("UV", str(installed))

    assert utils.uv_bin() == str(installed)


# ── every child argv carries it ─────────────────────────────────────────────

def test_the_engines_dispatch_children_carry_the_resolved_uv(tmp_path, monkeypatch):
    resolved = tmp_path / "uv.exe"
    resolved.write_text("", encoding="utf-8")
    monkeypatch.setenv("UV", str(resolved))

    instance = engine.Engine(main_root=tmp_path, queue_dir=tmp_path / "queue",
                             config="roster.yaml")
    argv = engine.dispatch_command(instance, tmp_path / "queue" / "001-a.md")

    assert argv[0] == str(resolved)
    assert argv[1] == "run"


def test_the_integration_gates_whole_suite_carries_the_resolved_uv(tmp_path, monkeypatch):
    """The gate is the OTHER half of the bug: `{dev}` expands to `uv run
    --project ... --group dev`, so an unresolvable uv made every merge read RED
    on an OSError that said nothing about the code being judged."""
    resolved = tmp_path / "uv.exe"
    resolved.write_text("", encoding="utf-8")
    monkeypatch.setenv("UV", str(resolved))

    instance = engine.Engine(main_root=tmp_path, queue_dir=tmp_path, config="cfg.yaml")
    commands = engine.quality_commands(instance, tmp_path / "wt")

    assert commands, "the gate fell back to no commands at all"
    for argv in commands:
        assert argv[0] == str(resolved)


def test_the_adw_child_dispatch_launches_carries_it_too(tmp_path, monkeypatch):
    """The second rung of the same chain. The engine spawns dispatch with a
    resolved uv, but dispatch spawns the ADW itself - and left bare there, the
    engine's fix would have bought nothing under systemd: every dispatch would
    start, fail to launch its ADW, and write `blocked` onto its card."""
    resolved = tmp_path / "uv.exe"
    resolved.write_text("", encoding="utf-8")
    monkeypatch.setenv("UV", str(resolved))

    main_root = tmp_path / "repo"
    (main_root / "adws").mkdir(parents=True)
    (main_root / "adws" / "adw_simple_sdlc.py").write_text("", encoding="utf-8")
    (main_root / "queue").mkdir()
    card = main_root / "queue" / "001-a.md"
    card.write_text(
        "# Add a thing\n\nStatus: ready-for-agent\nAdw: simple-sdlc\nAdw-Id:\n"
        "Created: 2026-08-18\nContext:\n\n## Agent Brief\n\n**Summary:** one line\n",
        encoding="utf-8")

    launched: list[list[str]] = []
    monkeypatch.setattr(dispatch, "_stream",
                        lambda cmd, *, cwd, env: launched.append(cmd) or 0)

    dispatch.dispatch(card, main_root=main_root, config="cfg.yaml", adw_id_override=None)

    assert launched and launched[0][0] == str(resolved)


def test_worktree_provisioning_carries_it_too(tmp_path, monkeypatch):
    """The fourth site, and the least forgiving: `uv sync` provisions every
    worktree the engine creates, and a missing binary raises FileNotFoundError
    that nothing below catches - so it escapes `ensure_run_worktree` and blocks
    the card before a single agent has run."""
    from adw_modules import worktrees

    resolved = tmp_path / "uv.exe"
    resolved.write_text("", encoding="utf-8")
    monkeypatch.setenv("UV", str(resolved))

    tree = tmp_path / "wt"
    tree.mkdir()
    (tree / "pyproject.toml").write_text("[project]\nname='x'\nversion='0'\n", encoding="utf-8")

    seen: list[list[str]] = []

    def fake(argv, **kwargs):
        seen.append(list(argv))
        return subprocess.CompletedProcess(args=argv, returncode=0, stdout="", stderr="")
    monkeypatch.setattr(worktrees.subprocess, "run", fake)

    worktrees._sync_toolchain(tree)

    assert seen and seen[0][0] == str(resolved)
    assert seen[0][1] == "sync"


# ── the preflight ───────────────────────────────────────────────────────────

def test_an_unresolvable_uv_holds_the_cycle_and_names_the_repair(monkeypatch, capsys):
    """HOLD, never dispatch. A held card is still ready on the Board waiting
    for one PATH to be right; a card burned into `refused` needs a human and
    there would be one per card, once a minute, all night."""
    monkeypatch.delenv("UV", raising=False)
    monkeypatch.setenv("PATH", "")
    instance = engine.Engine(main_root=Path("."), queue_dir=Path("queue"), config="cfg.yaml")

    assert engine.uv_launchable(instance) is False
    out = capsys.readouterr().out
    assert "UV IS NOT LAUNCHABLE" in out
    assert ".local/bin" in out            # the actual repair, not just the complaint


def test_the_uv_hold_is_said_once_per_reason_not_once_a_minute(monkeypatch, capsys):
    monkeypatch.delenv("UV", raising=False)
    monkeypatch.setenv("PATH", "")
    instance = engine.Engine(main_root=Path("."), queue_dir=Path("queue"), config="cfg.yaml")

    engine.uv_launchable(instance)
    capsys.readouterr()
    engine.uv_launchable(instance)

    assert "UV IS NOT LAUNCHABLE" not in capsys.readouterr().out


def test_a_repaired_uv_is_picked_up_on_the_next_cycle_with_no_restart(
        monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("UV", raising=False)
    monkeypatch.setenv("PATH", "")
    instance = engine.Engine(main_root=Path("."), queue_dir=Path("queue"), config="cfg.yaml")
    assert engine.uv_launchable(instance) is False

    installed = tmp_path / "uv.exe"
    installed.write_text("", encoding="utf-8")
    monkeypatch.setenv("UV", str(installed))

    assert engine.uv_launchable(instance) is True
    assert str(installed) in capsys.readouterr().out   # the journal names the launcher


def test_the_cycle_holds_before_anything_is_dispatched_when_uv_is_gone(
        monkeypatch, capsys, tmp_path):
    """The preflight sits in `run_cycle` ahead of the branch guard, the reap,
    the pull, the integrate step and the scan - so a box with no uv spawns
    nothing and merges nothing rather than failing card by card."""
    instance = engine.Engine(main_root=tmp_path, queue_dir=tmp_path / "queue",
                             config="cfg.yaml")
    spawned: list[str] = []
    monkeypatch.setattr(engine, "spawn",
                        lambda *a, **k: spawned.append("x") or None)
    monkeypatch.setattr(engine, "committer_identity_ok", lambda _e: True)
    monkeypatch.setattr(engine, "pi_launchable", lambda _e: True)
    monkeypatch.delenv("UV", raising=False)
    monkeypatch.setenv("PATH", "")

    engine.run_cycle(instance)

    assert spawned == []
    assert "UV IS NOT LAUNCHABLE" in capsys.readouterr().out


# ── a launch failure is not a refusal ───────────────────────────────────────

def test_a_card_is_not_burned_into_refused_when_the_launcher_itself_is_missing(
        tmp_path, monkeypatch, capsys):
    """THE BUG THIS IS THE OTHER HALF OF. `engine.refused` means "dispatch ran,
    read this card, and said no" - a verdict about the CARD, which is why
    nothing ever retries it. An OSError from `Popen` is the opposite: no
    dispatch started and nothing read the card. Recording it as a refusal is
    what made an unresolvable uv permanently kill every card on the Board -
    the engine would resolve uv again next cycle and still skip every card it
    had already written off."""
    card = tmp_path / "001-first.md"
    card.write_text("Status: ready-for-agent\n", encoding="utf-8")
    instance = engine.Engine(main_root=tmp_path, queue_dir=tmp_path, config="cfg.yaml")
    monkeypatch.setattr(engine, "dispatch_command",
                        lambda *a, **k: ["sdl-factory-no-such-launcher-anywhere", "run"])

    assert engine.spawn(instance, card) is None
    assert instance.refused == set()          # the card survives the box's problem
    assert "could not start" in capsys.readouterr().out


# The other side of that line - a dispatch that RAN, read the card and came
# back with it still `ready-for-agent` IS a verdict about the card, and `reap`
# still records it in `engine.refused` - is covered end to end by
# test_engine.py::test_a_refused_dispatch_is_named_once_and_not_retried. The
# loosening above narrows who may write that set; it does not empty it.


@pytest.mark.parametrize("derived_left", [True, False])
def test_a_failed_launch_still_cleans_up_the_runs_derived_roster(
        tmp_path, monkeypatch, derived_left):
    """The router writes a per-run copy of the roster before the spawn. A spawn
    that never happened must not leave it behind - nothing will ever reap a
    child for it."""
    card = tmp_path / "001-first.md"
    card.write_text("Status: ready-for-agent\n", encoding="utf-8")
    derived = tmp_path / "derived.yaml"
    if derived_left:
        derived.write_text("agents: []\n", encoding="utf-8")
    instance = engine.Engine(main_root=tmp_path, queue_dir=tmp_path, config="cfg.yaml")
    monkeypatch.setattr(engine, "dispatch_command",
                        lambda *a, **k: ["sdl-factory-no-such-launcher-anywhere"])

    plan = engine.Plan(config=str(derived), derived=derived)
    assert engine.spawn(instance, card, plan) is None
    assert not derived.exists()
