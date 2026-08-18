"""The template parity gate (.claude/skills/sssf/scripts/sync_templates.py).

WHAT THIS IS FOR. The skill carries a mirror of `adws/` under
`templates/adws/`, and that mirror is what gets stamped into every project the
factory is installed into. Nothing enforced that it stayed in step: an edit to
the live `adws/` tree that skipped the mirror passed every check here and was
discovered later, on somebody else's box, as a stamped factory whose modules
did not match the scripts importing them.

`--dry-run` is the gate, and it now exits NON-ZERO when it finds drift (it used
to report drift and exit 0, which is why nothing could gate on it). The first
test below shells exactly that command, so an `adws/` change that skips the
mirror goes red in the engine's merge gate on the branch that caused it.

SCOPE. This suite runs in the sdl-factory repo, which is the only checkout that
carries the skill. `adws/tests/` is deliberately NOT mirrored by
`sync_templates` (the template ships its own hand-written starter suite,
`templates/adws/tests/test_stamp.py`), so this file never reaches a stamped
project - but every test here still guards for a missing skill directory and
skips, so it stays green anywhere it is ever run from.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest
from adw_modules.utils import uv_bin

SCRIPT_REL = Path(".claude") / "skills" / "sssf" / "scripts" / "sync_templates.py"


def _repo_root() -> Path | None:
    """The checkout that carries the skill, or None when this is a stamped
    project (or any tree without it)."""
    for candidate in [Path(__file__).resolve().parent.parent.parent, Path.cwd().resolve()]:
        if (candidate / SCRIPT_REL).is_file():
            return candidate
    return None


def _load_module(script: Path):
    """Import the script by path — it is not on any import path, and it is a
    PEP 723 `uv run` script rather than a package module."""
    spec = importlib.util.spec_from_file_location("sync_templates_under_test", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def root():
    found = _repo_root()
    if found is None:
        pytest.skip("no .claude/skills/sssf in this checkout - a stamped project "
                    "carries the stamped files, not the skill that stamps them")
    return found


@pytest.fixture
def script(root):
    return root / SCRIPT_REL


# ── the gate itself ─────────────────────────────────────────────────────────

def test_templates_are_in_sync_with_the_live_adws_tree(root, script):
    """THE PARITY GATE. Any change under `adws/` that was not mirrored into
    `templates/adws/` fails here - on the branch that made it, in the same
    merge gate that runs the rest of this suite, instead of on a stamped
    project weeks later.

    To fix a failure: run the command in the assertion message, then commit the
    templates alongside the adws/ change.
    """
    uv = uv_bin()
    if not uv:
        pytest.skip("uv is not resolvable here; the gate shells `uv run`")

    result = subprocess.run([uv, "run", str(script), str(root), "--dry-run"],
                            cwd=root, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=300)

    assert result.returncode == 0, (
        f"templates/adws has drifted from adws/ (exit {result.returncode}).\n"
        f"Mirror it with:  uv run {SCRIPT_REL.as_posix()} . \n"
        f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}")


# ── both exit codes, hermetically ───────────────────────────────────────────
#
# Driven against a throwaway templates directory (`TEMPLATES_ADWS` is
# monkeypatched) so the real mirror is never written by a test.

def test_dry_run_exits_non_zero_when_a_file_would_change(root, script, tmp_path, capsys):
    """The whole point of the change. This used to exit 0 no matter what it
    found, so `--dry-run` could report drift in its own output while every
    caller read "fine"."""
    module = _load_module(script)
    empty = tmp_path / "templates" / "adws"
    empty.mkdir(parents=True)
    module.TEMPLATES_ADWS = empty

    code = module.main([str(root), "--dry-run"])

    assert code == 1
    assert "DRIFT" in capsys.readouterr().out


def test_dry_run_exits_zero_when_everything_matches(root, script, tmp_path, capsys):
    """The other direction, so the gate cannot be satisfied by a script that
    simply always fails: sync for real, then ask again."""
    module = _load_module(script)
    mirror = tmp_path / "templates" / "adws"
    mirror.mkdir(parents=True)
    module.TEMPLATES_ADWS = mirror

    assert module.main([str(root)]) == 0            # the real run fixes the drift
    capsys.readouterr()

    assert module.main([str(root), "--dry-run"]) == 0
    assert "DRIFT" not in capsys.readouterr().out


def test_a_real_run_exits_zero_even_though_it_changed_files(root, script, tmp_path):
    """A non-dry run that copies files has FIXED the drift, so there is nothing
    left to report and it must not fail the caller that asked it to sync."""
    module = _load_module(script)
    mirror = tmp_path / "templates" / "adws"
    mirror.mkdir(parents=True)
    module.TEMPLATES_ADWS = mirror

    assert module.main([str(root)]) == 0
    assert (mirror / "engine.py").is_file()
    assert (mirror / "adw_modules" / "git_helper.py").is_file()


def test_a_path_that_is_not_a_live_checkout_is_still_its_own_exit_code(
        root, script, tmp_path):
    """Exit 2 stays distinct from drift: "you pointed me at the wrong
    directory" is not "the mirror is stale"."""
    module = _load_module(script)

    assert module.main([str(tmp_path), "--dry-run"]) == 2


def test_the_test_suite_itself_is_never_mirrored(root, script, tmp_path):
    """Why this file does not ship. `sync_templates` copies only `adws/*.py`
    and `adws/adw_modules/*.py`; `tests/` is excluded by design, because the
    template carries its own hand-written starter suite instead. If that ever
    changed, this test would be shipped into stamped projects that have no
    skill directory to check."""
    module = _load_module(script)
    sources = module.collect_sources(root / "adws")

    assert not any(rel.startswith("tests/") for rel in sources)
    assert "test_sync_templates.py" not in sources
    assert "engine.py" in sources


def test_both_copies_of_the_skill_are_byte_identical(root):
    """The repo's skill and the user-level one at `~/.claude/skills/sssf` are
    two copies of the same thing, and only one of them is under version
    control. A change mirrored into the repo copy but not the installed one
    means the next `/sssf install` on this machine stamps yesterday's factory.

    Skipped rather than failed when the user copy does not exist: not every
    machine that runs this suite has the skill installed."""
    installed = Path.home() / ".claude" / "skills" / "sssf"
    if not installed.is_dir():
        pytest.skip("no user-level sssf skill installed on this machine")

    repo_copy = root / ".claude" / "skills" / "sssf"
    # `__pycache__` is a build artifact python drops beside whichever copy was
    # executed last. It is not part of the skill and is never copied, so it
    # would make this comparison fail forever for no reason.
    result = subprocess.run(["diff", "-rq", "--exclude=__pycache__",
                             str(repo_copy), str(installed)],
                            capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=120)
    if result.returncode == 127 or "not found" in (result.stderr or "").lower():
        pytest.skip("no `diff` on this machine")

    assert result.returncode == 0, (
        f"the two copies of the sssf skill differ:\n{result.stdout}\n"
        f"re-copy {repo_copy} over {installed} after syncing templates")


def test_the_skill_scripts_are_importable_without_side_effects(script):
    """`_load_module` above executes the file. It must define its CLI and stop -
    a script that did work at import would run against the operator's real
    templates the moment a test imported it."""
    module = _load_module(script)

    assert callable(module.main)
    assert module.TEMPLATES_ADWS.name == "adws"


if __name__ == "__main__":     # pragma: no cover - convenience only
    sys.exit(pytest.main([__file__, "-q"]))
