"""The stamp's own tests — what install.py must never do again.

Run them from a live sdl-factory checkout (they are not collected by
`pytest -q adws/tests`, which is the STAMPED suite's path, not this skill's):

    uv run --group dev pytest -q .claude/skills/sssf/scripts/test_install.py

Every test here builds a throwaway project in tmp_path and runs the real
install.py against it as a subprocess, exactly the way an operator does. The
first one reproduces the 2026-08-18 field failure before it proves the fix:
that is the only way to know the fix is aimed at the right thing.

Two of them shell out to `uv run` inside the fixture (the import check), which
needs uv on PATH and pydantic/pyyaml/dotenv/rich resolvable from the uv cache.
They skip, loudly, when uv is missing rather than reporting a green suite that
checked nothing.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent
INSTALL = SCRIPTS / "install.py"
TEMPLATES = SCRIPTS.parent / "templates"

# The four names adw_modules/worktrees.py imports from data_types.py. A stamp
# that leaves an old data_types.py under a new worktrees.py breaks on the first
# of them — this is the actual content of the field ImportError.
WORKTREE_NAMES = ("RunWorktree", "WorktreeRow", "WorktreesConfig", "WorktreeState")

# Where the worktree-era classes live in the template, by the section comments
# that bracket them. The "old" data_types.py in the field predated this whole
# block; deleting it is how a v-old project is simulated here.
WORKTREE_SECTION_START = "# ── Worktrees ─"
WORKTREE_SECTION_END = "# ── Tracing ─"


# ── helpers ──────────────────────────────────────────────────────────────────

def run_install(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """The install exactly as an operator runs it: cwd = the target project."""
    proc = subprocess.run(
        [sys.executable, str(INSTALL), *args],
        cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    assert proc.returncode == 0, f"install failed:\n{proc.stdout}\n{proc.stderr}"
    return proc


def uv_import_worktrees(root: Path) -> subprocess.CompletedProcess[str]:
    """`import adw_modules.worktrees` inside the fixture, through uv — the
    cheapest thing that reproduces what `uv run adws/engine.py --help` proved
    on the server. Not asserted here: both the red and the green case call it.
    """
    if shutil.which("uv") is None:
        pytest.skip("uv is not on PATH — this check runs the fixture's own interpreter")
    code = (
        "import sys; sys.path.insert(0, r'{adws}'); "
        "import adw_modules.worktrees; print('import ok')"
    ).format(adws=root / "adws")
    return subprocess.run(
        ["uv", "run", "python", "-c", code],
        cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )


def age_the_project(root: Path) -> None:
    """Turn a freshly stamped project into one an OLDER skill stamped.

    Two edits, both taken from the field case: the worktree-era classes never
    existed in that project's data_types.py, and neither engine.py nor
    adw_modules/worktrees.py had been written yet when it was stamped.
    """
    data_types = root / "adws" / "adw_modules" / "data_types.py"
    text = data_types.read_text(encoding="utf-8")
    start = text.index(WORKTREE_SECTION_START)
    end = text.index(WORKTREE_SECTION_END)
    assert start < end, "the template's Worktrees section no longer precedes Tracing"
    data_types.write_text(text[:start] + text[end:], encoding="utf-8")
    # WorktreesConfig lives further up the file, with the other config blocks,
    # and is not part of the section just removed - the three below are.
    aged = data_types.read_text(encoding="utf-8")
    for name in ("RunWorktree", "WorktreeRow", "WorktreeState"):
        assert name not in aged, f"{name} survived the ageing"
    (root / "adws" / "engine.py").unlink()
    (root / "adws" / "adw_modules" / "worktrees.py").unlink()


def old_rule_stamp(root: Path) -> None:
    """What install.py DID before 2026-08-18: copy a template file only when
    the destination does not exist. Reproduced here, in six lines, because the
    defect is a property of that rule and a test that cannot show the red has
    not shown anything."""
    for src in sorted((TEMPLATES / "adws").rglob("*.py")):
        if "__pycache__" in src.parts:
            continue
        dest = root / "adws" / src.relative_to(TEMPLATES / "adws")
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)


def mtimes(root: Path) -> dict[Path, int]:
    return {p: p.stat().st_mtime_ns for p in sorted(root.rglob("*"))
            if p.is_file() and "__pycache__" not in p.parts and ".venv" not in p.parts}


# ── the field failure ────────────────────────────────────────────────────────

def test_a_restamp_cannot_leave_a_mixed_generation_adws_tree(tmp_path: Path) -> None:
    """2026-08-18, a real server deploy, in one test.

    RED: age the project, then stamp it the old way (add what is missing, keep
    what exists). The new worktrees.py lands on top of the old data_types.py
    and `import adw_modules.worktrees` dies on ImportError: cannot import name
    'RunWorktree'. That was a passing install, and a factory that could not
    start.

    GREEN: run the real install.py on the same aged project. data_types.py is
    refreshed to the template's bytes, engine.py and worktrees.py are stamped,
    and the import succeeds. No --force anywhere: refreshing the factory's own
    code is not something the operator should have to know to ask for.
    """
    run_install(tmp_path)
    age_the_project(tmp_path)

    old_rule_stamp(tmp_path)
    red = uv_import_worktrees(tmp_path)
    assert red.returncode != 0, "the aged project imported cleanly — ageing it did nothing"
    assert any(name in red.stderr for name in WORKTREE_NAMES), \
        f"expected the field ImportError on one of {WORKTREE_NAMES}, got:\n{red.stderr}"

    out = run_install(tmp_path).stdout
    data_types = tmp_path / "adws" / "adw_modules" / "data_types.py"
    template = TEMPLATES / "adws" / "adw_modules" / "data_types.py"
    assert data_types.read_bytes() == template.read_bytes(), \
        "data_types.py was not refreshed — the mixed-generation tree survives"
    assert "refreshed" in out and "data_types.py" in out, \
        f"the refresh went unreported:\n{out}"
    assert (tmp_path / "adws" / "engine.py").is_file()
    assert (tmp_path / "adws" / "adw_modules" / "worktrees.py").is_file()

    green = uv_import_worktrees(tmp_path)
    assert green.returncode == 0, \
        f"the refreshed tree still cannot import:\n{green.stdout}\n{green.stderr}"


def test_every_factory_owned_file_is_refreshed_not_kept(tmp_path: Path) -> None:
    """Not just data_types.py: every file under adws/ that the skill owns, plus
    queue/TEMPLATE.md. Each one is dirtied, and a plain re-stamp must undo it.
    """
    run_install(tmp_path)
    factory_files = [p for p in (tmp_path / "adws").rglob("*.py")
                     if "__pycache__" not in p.parts] + [tmp_path / "queue" / "TEMPLATE.md"]
    assert len(factory_files) > 20, f"only {len(factory_files)} factory files — bad fixture"
    for path in factory_files:
        path.write_text("# forked by the project\n", encoding="utf-8")

    run_install(tmp_path)

    forked = [str(p) for p in factory_files
              if p.read_text(encoding="utf-8") == "# forked by the project\n"]
    assert not forked, f"factory-owned files a re-stamp left forked: {forked}"


# ── the operator's half ──────────────────────────────────────────────────────

def test_an_operators_roster_survives_a_restamp(tmp_path: Path) -> None:
    """sssf.config.yaml holds the operator's model choices. A re-stamp that
    resets it silently re-points every agent at the starter lane."""
    run_install(tmp_path)
    roster = tmp_path / "adws" / "adw_sssf_config" / "sssf.config.yaml"
    mine = roster.read_text(encoding="utf-8").replace(
        "defaults:", "# my box, my lane\ndefaults:", 1)
    roster.write_text(mine, encoding="utf-8")
    before = roster.read_bytes()

    out = run_install(tmp_path).stdout

    assert roster.read_bytes() == before, "the re-stamp overwrote the operator's roster"
    assert "kept" in out, f"the roster was not reported as kept:\n{out}"


def test_a_queue_card_survives_a_restamp(tmp_path: Path) -> None:
    """Cards are work state — a card is a job someone queued, sometimes one an
    engine is mid-run on. Nothing in a stamp may touch one."""
    run_install(tmp_path)
    card = tmp_path / "queue" / "007-do-the-thing.md"
    card.write_text("# Do the thing\n\nStatus: ready-for-agent\nAdw: simple-sdlc\n",
                    encoding="utf-8")
    before, before_mtime = card.read_bytes(), card.stat().st_mtime_ns

    run_install(tmp_path)

    assert card.read_bytes() == before, "the re-stamp rewrote a queue card"
    assert card.stat().st_mtime_ns == before_mtime, "the re-stamp touched a queue card"


def test_the_operator_owned_files_are_kept_by_name(tmp_path: Path) -> None:
    """The whole operator-owned list in one pass: edit each, re-stamp, and every
    edit must still be there. pyproject.toml and .gitignore are edited by
    APPENDING, since those two have their own append-only merges."""
    run_install(tmp_path)
    owned = [
        tmp_path / "adws" / "adw_sssf_config" / "sssf.config.yaml",
        tmp_path / "adws" / "adw_data" / "prompt_engineering" / "planner" / "system.md",
        tmp_path / "adws" / "adw_data" / "harness_engineering" / "subagents.ts",
        tmp_path / "justfile",
        tmp_path / ".env.sample",
        tmp_path / "pyproject.toml",
        tmp_path / ".gitignore",
    ]
    marker = "# operator was here\n"
    for path in owned:
        assert path.is_file(), f"{path} was never stamped — fixture is wrong"
        path.write_text(path.read_text(encoding="utf-8") + marker, encoding="utf-8")

    run_install(tmp_path)

    lost = [str(p) for p in owned if marker not in p.read_text(encoding="utf-8")]
    assert not lost, f"a re-stamp threw away the operator's edits in: {lost}"


def test_force_still_overwrites_everything(tmp_path: Path) -> None:
    """--force keeps meaning what it always meant, or the escape hatch the
    cookbook documents is gone."""
    run_install(tmp_path)
    roster = tmp_path / "adws" / "adw_sssf_config" / "sssf.config.yaml"
    roster.write_text("# mine\n", encoding="utf-8")

    run_install(tmp_path, "--force")

    assert roster.read_bytes() == (TEMPLATES / "sssf.config.yaml").read_bytes(), \
        "--force no longer overwrites an operator-owned file"


# ── the no-op run ────────────────────────────────────────────────────────────

def test_a_restamp_that_changes_nothing_writes_nothing(tmp_path: Path) -> None:
    """Byte-identical means untouched, mtime included. A refresh rule that
    rewrites every factory file on every run dirties every mtime in the repo,
    wakes every watcher, and makes `git status` useless as a signal that the
    stamp actually moved."""
    run_install(tmp_path)
    before = mtimes(tmp_path)
    assert before, "nothing was stamped"

    out = run_install(tmp_path).stdout

    changed = [str(p) for p, t in mtimes(tmp_path).items() if before.get(p) != t]
    assert not changed, f"a no-op re-stamp rewrote: {changed}"
    assert "current" in out, f"the untouched files went unreported:\n{out}"
    assert "refreshed" not in out, f"a no-op re-stamp reported a refresh:\n{out}"


def test_the_first_stamp_reports_no_refresh_and_no_keep(tmp_path: Path) -> None:
    """An empty directory has nothing to keep and nothing to refresh — every
    file is new. Guards the reporting against counting a fresh stamp twice."""
    out = run_install(tmp_path).stdout
    assert "refreshed" not in out and "kept" not in out, out
    assert "new file(s)" in out, out


def test_a_project_with_its_own_pyproject_still_gets_the_gates_group(tmp_path: Path) -> None:
    """The merge gate's toolchain contract, unchanged by the ownership split:
    pyproject.toml is operator-owned and kept, so the `dev` group has to be
    APPENDED to the project's own file or every finished card blocks forever."""
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "theirs"\nversion = "0.1.0"\n', encoding="utf-8")

    run_install(tmp_path)

    text = (tmp_path / "pyproject.toml").read_text(encoding="utf-8")
    assert 'name = "theirs"' in text, "the project's own pyproject was overwritten"
    assert "[dependency-groups]" in text and "dev = [" in text, text
    assert "[tool.ruff]" in text, text


def test_the_gitignore_merge_is_still_append_only(tmp_path: Path) -> None:
    (tmp_path / ".gitignore").write_text("node_modules/\n", encoding="utf-8")

    run_install(tmp_path)

    lines = (tmp_path / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert lines[0] == "node_modules/", "the project's own .gitignore line moved"
    for entry in (".env", "__pycache__/", ".venv/", "adws/adw_data/sessions/"):
        assert entry in lines, f"{entry} missing from .gitignore"


def test_both_copies_of_this_skill_are_byte_identical() -> None:
    """There are two copies of this skill on a laptop and nothing syncs them —
    install.py's own refusal message says so. Whichever resolves first is the
    one that stamps, so a fix that landed in only one copy is not landed."""
    other = Path.home() / ".claude" / "skills" / "sssf" / "scripts" / "install.py"
    if not other.is_file() or os.path.samefile(other.parent, SCRIPTS):
        pytest.skip(f"no second copy at {other}")
    assert other.read_bytes() == INSTALL.read_bytes(), \
        f"{other} differs from {INSTALL} — the two copies have drifted"
