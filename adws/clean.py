#!/usr/bin/env -S uv run
"""Sweep regenerable tool caches from the repo — codebase hygiene (MAP.md
"Codebase hygiene", open question, 2026-08-13). Nothing here is source: every
directory this removes is re-created automatically the next time ruff/mypy/
pytest runs, so there is no data loss possible.

NEVER touches (park-never-delete extends to never even looking inside these):
  - .venv/            the interpreter itself — a toolchain, not a cache
  - adws/adw_data/     the trace db + every run's session/prompt/context
                       output — real history, not a cache
  - a worktree         unmerged agent work; also structurally out of reach —
                       worktrees live OUTSIDE the repo (specs/worktrees.md),
                       and this walk never leaves repo_root()
  - .claude/, .git/, node_modules/   not caches this tool owns; pruned so the
                       walk stays fast and .claude/skills/sssf/templates (the
                       skill's own tree) is never touched by anything here

Usage: uv run adws/clean.py [--dry-run]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from adw_modules import git_helper

CACHE_DIR_NAMES = {".ruff_cache", ".mypy_cache", ".pytest_cache", "__pycache__"}
NEVER_DESCEND = {".git", ".venv", ".claude", "node_modules", "adw_data"}


def find_caches(root: Path) -> list[Path]:
    """Every regenerable cache directory under `root`. A cache dir's own
    contents are never recursed into — the whole thing is one removal unit."""
    found: list[Path] = []

    def walk(directory: Path) -> None:
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            return
        for entry in entries:
            if not entry.is_dir() or entry.is_symlink():
                continue
            if entry.name in NEVER_DESCEND:
                continue
            if entry.name in CACHE_DIR_NAMES:
                found.append(entry)
                continue
            walk(entry)

    walk(root)
    return found


def main(dry_run: bool = False) -> int:
    root = git_helper.repo_root()
    caches = find_caches(root)
    if not caches:
        print("clean: nothing to remove")
        return 0
    for path in caches:
        rel = path.relative_to(root)
        if dry_run:
            print(f"would remove {rel}")
            continue
        shutil.rmtree(path, ignore_errors=True)
        print(f"removed {rel}")
    verb = "would be removed" if dry_run else "removed"
    print(f"clean: {len(caches)} cache dir(s) {verb}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true",
                        help="list what would be removed; remove nothing")
    args = parser.parse_args()
    sys.exit(main(dry_run=args.dry_run))
