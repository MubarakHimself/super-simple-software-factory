#!/usr/bin/env -S uv run
# /// script
# dependencies = []
# ///
"""/install — stamp the SSSF factory from the skill into the cwd. Idempotent.

Usage:
    uv run <skill>/scripts/install.py [--force]

Stamps: adws/ (modules + starter ADWs + adws/tests/), adws/adw_data/
prompt_engineering/ (4 starter agents), adws/adw_sssf_config/sssf.config.yaml,
pyproject.toml (the merge gate's toolchain), .env.sample, .gitignore entries.
Existing files are skipped unless --force.
"""

import argparse
import shutil
import sys
from pathlib import Path

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"

# What a copy of this skill MUST carry to stamp a project that can pass its own
# merge gate. Checked before anything is written, because the failure it
# prevents is a closed loop: a skill copy missing these stamps a project with no
# pyproject.toml and no adws/tests, the engine's fail-closed gate then dies on
# its first command ("--group dev has no effect ... Failed to spawn: ruff -
# program not found"), every finished card blocks forever, and the deploy's own
# remediation - "re-run Initialize factory on the laptop (it stamps one)" -
# re-runs THIS SAME COPY. There are two copies of this skill on a laptop (the
# repo's `.claude/skills/sssf` and the user-level `~/.claude/skills/sssf`),
# whichever one resolves first is the one that stamps, and nothing syncs them.
# So the copy checks ITSELF, out loud, rather than stamping a repo that can
# never merge.
REQUIRED_TEMPLATES = [
    ("pyproject.toml", "the merge gate's toolchain (its `dev` group resolves ruff, mypy and pytest)"),
    ("adws/tests", "the starter test suite (pytest exits 5 on an empty directory and the gate reads 5 as RED)"),
]

GITIGNORE_ENTRIES = [
    "adws/adw_data/sessions/",
    "adws/adw_data/sssf.db*",
    ".env",
    # The ADWs are Python, so importing adw_modules writes bytecode next to it.
    # Chains that end in a commit phase call `git add -A`, so without this a
    # stamped repo commits its own .pyc files — 15 of them showed up in the
    # first repo that was ever installed into from scratch.
    "__pycache__/",
    "*.pyc",
    # pyproject.toml (stamped below) makes `uv sync` and the merge gate's
    # `uv run --project <tree> --group dev ...` materialise a .venv in the
    # checkout AND in every worktree the engine builds. Chains that end in a
    # commit phase call `git add -A`, which would otherwise sweep a whole
    # virtualenv into a card's commit.
    ".venv/",
]


def stamp(src: Path, dest: Path, force: bool, stamped: list, skipped: list) -> None:
    if src.is_dir():
        for child in sorted(src.iterdir()):
            if child.name == "__pycache__":
                continue
            stamp(child, dest / child.name, force, stamped, skipped)
        return
    if dest.exists() and not force:
        skipped.append(str(dest))
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    stamped.append(str(dest))


def check_templates() -> list[str]:
    """Everything REQUIRED_TEMPLATES names that this copy of the skill is
    missing, in the operator's own words. Empty list = this copy can stamp a
    project that passes its own merge gate."""
    missing = []
    for rel, why in REQUIRED_TEMPLATES:
        if not (TEMPLATES / rel).exists():
            missing.append(f"templates/{rel} - {why}")
    return missing


# The `dev` group appended to a pyproject.toml that already existed. It repeats
# the four runtime packages on purpose: `adws/tests/` imports `adw_modules`,
# which imports pydantic, yaml, dotenv and rich, and this project's own
# `[project] dependencies` block is not ours to edit. A group holding only the
# three tools reds the gate on `ModuleNotFoundError: No module named 'yaml'`.
DEV_GROUP_BLOCK = """
# ── added by the sssf install ────────────────────────────────────────────────
# adws/engine.py's merge gate runs, against every branch, before it merges:
#     uv run --project <tree> --group dev ruff check .
#     uv run --project <tree> --group dev mypy adws
#     uv run --project <tree> --group dev pytest -q adws/tests
# and it is FAIL-CLOSED - a command that cannot run at all reads RED. Without
# this group uv answers "Failed to spawn: ruff - program not found" and every
# finished card blocks forever while the service still reports itself active.
# The last four repeat what adws/tests needs importable (adw_modules imports
# pydantic, yaml, dotenv and rich); this project's own [project] dependencies
# were left exactly as they were.
[dependency-groups]
dev = ["ruff", "pytest", "mypy", "types-PyYAML", "pydantic", "python-dotenv", "pyyaml", "rich"]

# skylos is SEPARATE from `dev` - it depends on an sdist-only package that needs
# an MSVC toolchain on Windows, and one shared group would take ruff, pytest and
# mypy down with it on every `uv sync`.
scan = ["skylos"]
"""

# The lint settings the STAMPED code needs to pass its own gate. Measured, not
# assumed: `uv run --group dev ruff check .` on a freshly stamped project whose
# pyproject.toml carried no [tool.ruff] reports 11 findings - all of them in
# adws/, all of them settings (line length, an explicit `check=` on subprocess
# calls that inspect returncode themselves, and runtime session output under
# adw_data that is not source at all). Every one of them would block every
# merge, forever, in code the operator never wrote.
RUFF_BLOCK = """
# ── added by the sssf install ────────────────────────────────────────────────
# What the stamped adws/ tree needs to pass `ruff check .`, which the merge gate
# runs. adw_data/ is runtime session output and copied prompt files, not source.
[tool.ruff]
extend-exclude = ["adws/adw_data"]
line-length = 100

[tool.ruff.lint]
ignore = [
    # every subprocess call in adws/ inspects returncode itself - an explicit
    # check= is noise there
    "PLW1510",
]
"""


def ensure_dev_group(root: Path, stamped: list, notes: list) -> None:
    """Make sure the project has the toolchain group the merge gate resolves.

    THE CORNER THIS EXISTS FOR. `stamp()` skips any file that already exists,
    so a project that arrived with its OWN pyproject.toml never got the `dev`
    group - and then `uv sync --group dev` fails outright with "Group dev is not
    defined in the project's `dependency-groups` table", which kills the run in
    worktree provisioning (`adw_modules/worktrees.py:_sync_toolchain`) before a
    single agent turn. Silently skipping was the defect; this appends the group
    the gate needs and says so, and it NEVER edits a table the project already
    wrote.

    TWO tables, on the same rule: `[dependency-groups]` (the toolchain the gate
    resolves through) and `[tool.ruff]` (the settings the STAMPED code needs to
    pass `ruff check .`, which the gate runs across the whole repo - without
    them a brand-new stamp reds the gate on eleven findings in code the operator
    never wrote).

    Three cases per table, and the third one refuses rather than guesses:
      * no pyproject.toml   -> nothing to do here (`stamp` wrote ours)
      * one without the table -> append it. A new table at the END of a TOML
        file is valid TOML and touches nothing above it.
      * one WITH the table -> leave it completely alone and say what it needs.
        Splicing a key into an existing table by hand-editing text is how a
        working file gets corrupted, and this script will not do it.

    Idempotent: the second run finds both table headers and appends nothing.
    """
    path = root / "pyproject.toml"
    if not path.is_file():
        return
    text = path.read_text(encoding="utf-8")
    stripped = "\n".join(line.split("#", 1)[0] for line in text.splitlines())

    added = []
    for table, block in (("[dependency-groups]", DEV_GROUP_BLOCK), ("[tool.ruff]", RUFF_BLOCK)):
        if table in stripped:
            continue
        text = text.rstrip("\n") + "\n" + block
        added.append(table)
    if added:
        path.write_text(text, encoding="utf-8")
        stamped.append(f"{path} (+ {', '.join(added)} - what the merge gate needs)")

    if "[dependency-groups]" in stripped and not any(
        line.replace(" ", "").startswith("dev=") for line in stripped.splitlines()
    ):
        notes.append(
            f"{path} has a [dependency-groups] table with no `dev` group. The merge gate resolves\n"
            f"    ruff, mypy and pytest through it and is FAIL-CLOSED, so every card this project\n"
            f"    finishes would block forever. Add this line to that table yourself:\n"
            f'      dev = ["ruff", "pytest", "mypy", "types-PyYAML", "pydantic", "python-dotenv", "pyyaml", "rich"]'
        )
    if "[tool.ruff]" in stripped:
        notes.append(
            f"{path} already configures [tool.ruff], so this install left it alone. The merge gate\n"
            f"    runs `ruff check .` across the whole repo, and the stamped adws/ tree needs\n"
            f"    `extend-exclude = [\"adws/adw_data\"]`, `line-length = 100` and lint.ignore\n"
            f"    [\"PLW1510\"] to pass it. Add those, or point `quality.lint` in\n"
            f"    adws/adw_sssf_config/sssf.config.yaml at your own command instead."
        )


def ensure_gitignore(root: Path, stamped: list) -> None:
    gitignore = root / ".gitignore"
    existing = gitignore.read_text().splitlines() if gitignore.exists() else []
    missing = [e for e in GITIGNORE_ENTRIES if e not in existing]
    if missing:
        with gitignore.open("a") as f:
            f.write("\n# sssf runtime\n" + "\n".join(missing) + "\n")
        stamped.append(f"{gitignore} (+{len(missing)} entries)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="overwrite existing files")
    args = parser.parse_args()

    root = Path.cwd()
    stamped, skipped, notes = [], [], []

    # Before a single file is written: can this copy of the skill stamp a
    # project that passes its own merge gate? A copy that cannot must say so
    # instead of producing a repo that blocks every card forever.
    missing = check_templates()
    if missing:
        print(f"sssf install REFUSED - this copy of the skill is incomplete ({TEMPLATES}):")
        for line in missing:
            print(f"  ! missing {line}")
        print("\nNothing was written. This copy is stale: there are two copies of this skill on a")
        print("laptop - the repo's .claude/skills/sssf and the user-level ~/.claude/skills/sssf -")
        print("and nothing syncs them, so whichever resolves first is the one that stamps.")
        print("Copy the complete one over this one (they must be byte-identical), then re-run:")
        print("  Windows:  robocopy <complete>\\.claude\\skills\\sssf <this-one> /MIR")
        print("  POSIX:    rsync -a --delete <complete>/.claude/skills/sssf/ <this-one>/")
        return 1

    stamp(TEMPLATES / "adws", root / "adws", args.force, stamped, skipped)
    stamp(TEMPLATES / "prompt_engineering",
          root / "adws" / "adw_data" / "prompt_engineering", args.force, stamped, skipped)
    stamp(TEMPLATES / "harness_engineering",
          root / "adws" / "adw_data" / "harness_engineering", args.force, stamped, skipped)
    stamp(TEMPLATES / "sssf.config.yaml",
          root / "adws" / "adw_sssf_config" / "sssf.config.yaml",
          args.force, stamped, skipped)
    # The merge gate's toolchain contract. adws/engine.py refuses to merge a
    # card unless `uv run --project <tree> --group dev {ruff,mypy,pytest}` all
    # exit 0, and that gate is fail-closed: without a project carrying a `dev`
    # group uv answers "program not found" and every finished run lands
    # `Status: blocked` forever while the service reports itself active. The
    # starter suite under adws/tests/ (stamped with adws/ above) is the other
    # half - pytest exits 5 on an empty directory and the gate reads 5 as red.
    # Skipped like any other file when the project already has one, so a repo
    # with its own toolchain keeps it; see the deploy's stamp step, which says
    # so out loud when the contract is not there.
    stamp(TEMPLATES / "pyproject.toml", root / "pyproject.toml", args.force, stamped, skipped)
    stamp(TEMPLATES / "env.sample", root / ".env.sample", args.force, stamped, skipped)
    # The queue is the seam between planning and the factory - a stamped repo
    # without queue/ has a Board pointing at nothing and readiness reporting
    # queue_template absent right after a successful install.
    stamp(TEMPLATES / "queue" / "TEMPLATE.md", root / "queue" / "TEMPLATE.md",
          args.force, stamped, skipped)
    # The recipes are part of the operating experience, and several cookbooks
    # plus the run banner tell you to use them, so a stamped repo has to have
    # them. Skipped like any other file if the repo already has a justfile.
    stamp(TEMPLATES / "justfile", root / "justfile", args.force, stamped, skipped)
    # After the stamp, never before: this only has work to do when the project
    # arrived with its own pyproject.toml, which is exactly the file `stamp`
    # just skipped.
    ensure_dev_group(root, stamped, notes)
    ensure_gitignore(root, stamped)

    print(f"sssf installed into {root}")
    print(f"  stamped: {len(stamped)} file(s)")
    for s in stamped:
        print(f"    + {s}")
    if skipped:
        print(f"  skipped (already exist, use --force to overwrite): {len(skipped)}")
    if notes:
        print("\n  NEEDS YOU - the merge gate will block every card until this is done:")
        for note in notes:
            print(f"    ! {note}")
    print("\nnext steps:")
    print("  1. cp .env.sample .env   # then set the key(s) your roster needs")
    print("  2. just demo             # two cheap read-only runs, end to end")
    print("  3. just sessions         # what just happened")
    print("  4. just obs              # the trace UI, needs bun")
    # NAMED HERE BECAUSE NOTHING ELSE NAMES IT. A deploy checks out
    # `integration` and stops when the remote has none; the only thing that ever
    # CREATES that branch is the engine, which the deploy will not install until
    # the branch exists. Nothing in this install, and no button in the app,
    # closes that loop - so the three commands that do are printed at the one
    # moment the operator is looking at a freshly stamped repo.
    print("\nbefore you deploy this to a server (the deploy checks out `integration`,")
    print("and nothing creates that branch for you):")
    print("  git add -A && git commit -m 'stamp the factory'")
    print("  git push -u origin main")
    print("  git switch -c integration && git push -u origin integration")
    print("\n  no just? the raw form of step 2 is:")
    print("     uv run adws/adw_prompt.py \"say hello\" --agent scout")
    return 0


if __name__ == "__main__":
    sys.exit(main())
