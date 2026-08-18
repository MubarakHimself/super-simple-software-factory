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

TWO WORLDS, and every file stamped belongs to exactly one of them:

  FACTORY-OWNED - adws/*.py, adws/adw_modules/**, adws/tests/** and
  queue/TEMPLATE.md. The factory's own machinery, plus the card-header contract
  dispatch.py parses. EVERY run brings these to this skill's bytes; --force is
  not needed and never was the right gate for them. A file whose bytes already
  match is not rewritten at all (mtimes stay stable) and is reported as
  "current"; one that differs is overwritten and reported as "refreshed", so
  the operator sees exactly which machinery moved.

  OPERATOR-OWNED - adws/adw_sssf_config/sssf.config.yaml (the roster: the
  operator's model choices live there), adws/adw_data/** (prompt and harness
  engineering, plus runtime state), pyproject.toml, justfile, .env.sample,
  .gitignore, and every queue/ card. NEVER overwritten without --force, exactly
  as before. pyproject.toml and .gitignore additionally get the append-only
  merges below, which only ever add a table or a line the project does not
  already have.

--force still means what it always meant: overwrite everything, both worlds.

WHY THE SPLIT EXISTS (2026-08-18, a real server deploy). This script used to
skip EVERY file that already existed. A project stamped by an older copy of the
skill was re-stamped by the current one to pick up new machinery: the new files
(adws/engine.py, adws/adw_modules/worktrees.py) landed, and every file that was
already on disk - adw_modules/data_types.py among them - stayed at its old
version. What came out was an adws/ tree of two generations, in which the NEW
worktrees.py imported RunWorktree, WorktreeRow, WorktreesConfig and
WorktreeState from a data_types.py written before any of those classes existed.
`uv run adws/engine.py --help` died on ImportError, and the deploy's
engine-service preflight caught it one step before that box ran a factory that
could not start. The skip rule GUARANTEED that outcome for any project
re-stamped after the skill grew a cross-module reference, which is every time
the skill evolves - so for the code the factory owns, the skip rule is gone.
"""

import argparse
import shutil
import sys
from dataclasses import dataclass, field
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


# Directory names that are OPERATOR-OWNED wherever they turn up, even inside a
# tree handed to stamp() as factory-owned. Nothing under templates/adws matches
# one today (it is all *.py, adw_modules/ and tests/); this is what keeps the
# rule true the day a template drops a config or a runtime directory in there,
# rather than silently refreshing the operator's roster along with the code.
OPERATOR_OWNED_DIRS = {"adw_data", "adw_sssf_config"}


@dataclass
class Tally:
    """What the run did, in the four categories the report prints.

    stamped   - the file did not exist; it was written (either world).
    refreshed - it existed with DIFFERENT bytes and was brought to this skill's
                version (factory-owned always, operator-owned only under
                --force).
    current   - it existed with the SAME bytes: nothing written, mtime intact.
    kept      - operator-owned, existing, left exactly as it was.
    """

    stamped: list[str] = field(default_factory=list)
    refreshed: list[str] = field(default_factory=list)
    current: list[str] = field(default_factory=list)
    kept: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def stamp(src: Path, dest: Path, force: bool, tally: Tally, *, factory: bool = False) -> None:
    """Copy one template file (or tree) into the project under its world's rule.

    `factory=True` is the fix for the mixed-generation ImportError in this
    file's docstring: factory-owned code is refreshed to the template's bytes on
    every run, so a project can never end up with one generation of adws/
    importing names from another. Everything else keeps the original rule -
    existing means untouched unless --force.

    A byte-identical file is never rewritten in either world. That is not an
    optimisation: `git status` and every mtime-driven watcher in the project
    stay quiet on a re-stamp that changed nothing.
    """
    if src.is_dir():
        for child in sorted(src.iterdir()):
            if child.name == "__pycache__":
                continue
            stamp(child, dest / child.name, force, tally,
                  factory=factory and child.name not in OPERATOR_OWNED_DIRS)
        return
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        tally.stamped.append(str(dest))
        return
    if not (factory or force):
        tally.kept.append(str(dest))
        return
    if dest.read_bytes() == src.read_bytes():
        tally.current.append(str(dest))
        return
    shutil.copy2(src, dest)
    tally.refreshed.append(str(dest))


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


def ensure_dev_group(root: Path, tally: Tally) -> None:
    """Make sure the project has the toolchain group the merge gate resolves.

    THE CORNER THIS EXISTS FOR. pyproject.toml is operator-owned, so `stamp()`
    keeps whatever the project already had, and a project that arrived with its
    OWN pyproject.toml never got the `dev`
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
        tally.stamped.append(f"{path} (+ {', '.join(added)} - what the merge gate needs)")

    if "[dependency-groups]" in stripped and not any(
        line.replace(" ", "").startswith("dev=") for line in stripped.splitlines()
    ):
        tally.notes.append(
            f"{path} has a [dependency-groups] table with no `dev` group. The merge gate resolves\n"
            f"    ruff, mypy and pytest through it and is FAIL-CLOSED, so every card this project\n"
            f"    finishes would block forever. Add this line to that table yourself:\n"
            f'      dev = ["ruff", "pytest", "mypy", "types-PyYAML", "pydantic", "python-dotenv", "pyyaml", "rich"]'
        )
    if "[tool.ruff]" in stripped:
        tally.notes.append(
            f"{path} already configures [tool.ruff], so this install left it alone. The merge gate\n"
            f"    runs `ruff check .` across the whole repo, and the stamped adws/ tree needs\n"
            f"    `extend-exclude = [\"adws/adw_data\"]`, `line-length = 100` and lint.ignore\n"
            f"    [\"PLW1510\"] to pass it. Add those, or point `quality.lint` in\n"
            f"    adws/adw_sssf_config/sssf.config.yaml at your own command instead."
        )


def ensure_gitignore(root: Path, tally: Tally) -> None:
    """Append-only, always: .gitignore is the operator's file, so this adds the
    entries the runtime needs and never removes or reorders a line."""
    gitignore = root / ".gitignore"
    existing = gitignore.read_text().splitlines() if gitignore.exists() else []
    missing = [e for e in GITIGNORE_ENTRIES if e not in existing]
    if missing:
        with gitignore.open("a") as f:
            f.write("\n# sssf runtime\n" + "\n".join(missing) + "\n")
        tally.stamped.append(f"{gitignore} (+{len(missing)} entries)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="overwrite existing files")
    args = parser.parse_args()

    root = Path.cwd()
    tally = Tally()

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

    # FACTORY-OWNED, refreshed every run: the whole templates/adws tree is the
    # factory's machinery - the starter ADWs, adw_modules/ and adws/tests/. They
    # are one program split across files and only work at ONE generation; the
    # mixed-generation ImportError in this file's docstring is what refreshing
    # them exists to prevent.
    stamp(TEMPLATES / "adws", root / "adws", args.force, tally, factory=True)
    # OPERATOR-OWNED from here down. The prompt and harness directories are the
    # two the cookbook calls "yours the moment they are stamped", and the roster
    # carries the operator's model choices - a re-stamp that rewrote either
    # would throw away the tuning the factory exists to let them do.
    stamp(TEMPLATES / "prompt_engineering",
          root / "adws" / "adw_data" / "prompt_engineering", args.force, tally)
    stamp(TEMPLATES / "harness_engineering",
          root / "adws" / "adw_data" / "harness_engineering", args.force, tally)
    stamp(TEMPLATES / "sssf.config.yaml",
          root / "adws" / "adw_sssf_config" / "sssf.config.yaml",
          args.force, tally)
    # The merge gate's toolchain contract. adws/engine.py refuses to merge a
    # card unless `uv run --project <tree> --group dev {ruff,mypy,pytest}` all
    # exit 0, and that gate is fail-closed: without a project carrying a `dev`
    # group uv answers "program not found" and every finished run lands
    # `Status: blocked` forever while the service reports itself active. The
    # starter suite under adws/tests/ (stamped with adws/ above) is the other
    # half - pytest exits 5 on an empty directory and the gate reads 5 as red.
    # Kept like any other operator-owned file when the project already has one,
    # so a repo with its own toolchain keeps it; see the deploy's stamp step,
    # which says so out loud when the contract is not there. ensure_dev_group
    # below is what makes a project's OWN pyproject.toml carry the gate's group.
    stamp(TEMPLATES / "pyproject.toml", root / "pyproject.toml", args.force, tally)
    stamp(TEMPLATES / "env.sample", root / ".env.sample", args.force, tally)
    # The queue is the seam between planning and the factory - a stamped repo
    # without queue/ has a Board pointing at nothing and readiness reporting
    # queue_template absent right after a successful install.
    #
    # FACTORY-OWNED, and it is the only file in queue/ this script ever writes.
    # TEMPLATE.md is not a card: dispatch.py and engine.py both skip it by name
    # when they scan queue/*.md, and it is the written half of the header
    # contract dispatch.py parses (Status/Adw/Adw-Id/Needs). A stale copy
    # teaches the operator to write cards the engine cannot read - the same
    # mixed-generation failure as the ImportError, in prose. The operator's
    # actual cards are never touched, by construction: they have no template.
    stamp(TEMPLATES / "queue" / "TEMPLATE.md", root / "queue" / "TEMPLATE.md",
          args.force, tally, factory=True)
    # The recipes are part of the operating experience, and several cookbooks
    # plus the run banner tell you to use them, so a stamped repo has to have
    # them. OPERATOR-OWNED: the file's own first line says "stamped by
    # install.py, then yours to edit", and repos add their own recipes to it.
    stamp(TEMPLATES / "justfile", root / "justfile", args.force, tally)
    # After the stamp, never before: this only has work to do when the project
    # arrived with its own pyproject.toml, which is exactly the file `stamp`
    # just kept.
    ensure_dev_group(root, tally)
    ensure_gitignore(root, tally)

    print(f"sssf installed into {root}")
    print(f"  stamped:   {len(tally.stamped)} new file(s)")
    for s in tally.stamped:
        print(f"    + {s}")
    if tally.refreshed:
        # Named out loud, one path per line: these are the only files a re-stamp
        # CHANGED under the operator's feet, and they will show up in the next
        # `git status`. Everything factory-owned that already matched is a count
        # on the next line, not a wall of paths.
        print(f"  refreshed: {len(tally.refreshed)} factory-owned file(s) brought to this "
              f"skill's version")
        for s in tally.refreshed:
            print(f"    * {s}")
    if tally.current:
        print(f"  current:   {len(tally.current)} factory-owned file(s) already matched "
              f"(not rewritten)")
    if tally.kept:
        print(f"  kept:      {len(tally.kept)} operator-owned file(s) left exactly as they "
              f"were (--force overwrites)")
    if tally.notes:
        print("\n  NEEDS YOU - the merge gate will block every card until this is done:")
        for note in tally.notes:
            print(f"    ! {note}")
    if tally.refreshed and not args.force:
        # The one thing an operator should do after a re-stamp that moved code:
        # look at it. Said once, here, because this is the only run where those
        # paths are in front of them.
        print("\n  the refreshed files above are the factory's own code, now all at this")
        print("  skill's version. Read the diff before you commit it:")
        print("    git diff -- adws/")
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
