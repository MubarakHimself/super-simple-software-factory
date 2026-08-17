#!/usr/bin/env -S uv run
# /// script
# dependencies = []
# ///
"""sync_templates - kill template mirror drift, mechanically. Re-syncs
templates/adws/ from a live sdl-factory checkout's adws/ tree, file by file,
live wins. This is the tool the drift needed: run it after any change to the
live adws/ tree instead of hand-copying files into the template.

Included (direct children only, non-recursive):
    <live>/adws/*.py                everything a stamped project needs to run
                                     the factory - adw_*.py, engine.py,
                                     ship_report.py, dispatch.py, worktrees.py,
                                     clean.py, and any future top-level script
    <live>/adws/adw_modules/*.py    every module the scripts above import from

Excluded (never read, never written):
    tests/, adw_data/, __pycache__, sssf.db*, adw_sssf_config/
    (adw_sssf_config/ carries the LIVE repo's own operator roster - a stamped
    project's templates carry their own sssf.config.yaml, hand-curated, not
    mirrored from here)

A file present in templates/adws with no corresponding source under
<live>/adws is an "unknown extra" - drift running the other way. This tool
refuses to touch ANYTHING until a human has looked, unless --prune is passed,
in which case it removes exactly those files and nothing else.

templates/justfile and templates/sssf.config.yaml are NOT written by this
tool - both are hand-curated (the justfile deliberately drops the
sdl-factory-only ui/app recipes the live justfile also carries; the config
carries commented router/lanes documentation the live self-hosting config
does not need). This tool only reports whether either one differs from its
live counterpart, as a nudge to go review it by hand.

Comparisons are byte-for-byte (read_bytes, never read_text/decode) so the
tool cannot misread either file's encoding regardless of platform default -
stronger than pinning utf-8, because nothing is ever decoded at all.

Usage:
    uv run <skill>/scripts/sync_templates.py <path-to-live-sdl-factory-checkout>
    uv run <skill>/scripts/sync_templates.py <path> --dry-run
    uv run <skill>/scripts/sync_templates.py <path> --prune

Exit codes: 0 synced (or already in sync) - 1 refused (unknown extras, no
--prune) - 2 <path> is not a live checkout (no adws/ under it).
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
TEMPLATES_ADWS = SKILL_ROOT / "templates" / "adws"
TEMPLATE_JUSTFILE = SKILL_ROOT / "templates" / "justfile"
TEMPLATE_CONFIG = SKILL_ROOT / "templates" / "sssf.config.yaml"


def _py_files(directory: Path) -> dict[str, Path]:
    """Direct-child *.py files of `directory`, name -> path. Non-recursive by
    design - the only subdirectory this tool ever looks inside is
    adw_modules/, and it is walked separately, one level, below."""
    if not directory.is_dir():
        return {}
    return {p.name: p for p in sorted(directory.iterdir())
            if p.is_file() and p.suffix == ".py"}


def collect_sources(live_adws: Path) -> dict[str, Path]:
    """Every file this tool will sync FROM, keyed by its path relative to
    adws/ (posix separators - doubles as the dest-relative key)."""
    sources: dict[str, Path] = dict(_py_files(live_adws))
    for name, path in _py_files(live_adws / "adw_modules").items():
        sources[f"adw_modules/{name}"] = path
    return sources


def collect_template_files() -> dict[str, Path]:
    """Every *.py file already sitting in templates/adws at the two levels
    this tool owns (top level + adw_modules/), same relative keys."""
    existing: dict[str, Path] = dict(_py_files(TEMPLATES_ADWS))
    for name, path in _py_files(TEMPLATES_ADWS / "adw_modules").items():
        existing[f"adw_modules/{name}"] = path
    return existing


def diff_status(src: Path, dest: Path) -> str:
    if not dest.exists():
        return "added"
    return "same" if src.read_bytes() == dest.read_bytes() else "updated"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("live_root",
                        help="root of a live sdl-factory checkout (the directory "
                             "that contains its own adws/), not adws/ itself")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the diff summary; write nothing")
    parser.add_argument("--prune", action="store_true",
                        help="remove template files with no live source, instead "
                             "of refusing")
    args = parser.parse_args()

    live_root = Path(args.live_root).resolve()
    live_adws = live_root / "adws"
    if not live_adws.is_dir():
        print(f"sync_templates: {live_adws} is not a directory - pass the root of "
              f"a live sdl-factory checkout, not adws/ itself")
        return 2

    sources = collect_sources(live_adws)
    existing = collect_template_files()
    extras = sorted(set(existing) - set(sources))

    if extras and not args.prune:
        print(f"sync_templates: refusing - {len(extras)} file(s) in "
              f"templates/adws have no source in {live_adws}:")
        for rel in extras:
            print(f"  ? {rel}")
        print("re-run with --prune to remove them, or investigate first - one may "
              "be a template-only file this tool's rules do not know about yet")
        return 1

    tag = " (dry-run)" if args.dry_run else ""
    added, updated, same, removed = [], [], [], []

    for rel in extras:  # only non-empty when --prune was passed
        removed.append(rel)
        if not args.dry_run:
            existing[rel].unlink()

    for rel in sorted(sources):
        src, dest = sources[rel], TEMPLATES_ADWS / rel
        status = diff_status(src, dest)
        if status == "same":
            same.append(rel)
            continue
        (added if status == "added" else updated).append(rel)
        if not args.dry_run:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)

    print(f"sync_templates: {live_adws} -> {TEMPLATES_ADWS}")
    for rel in removed:
        print(f"  - removed{tag}: {rel}")
    for rel in added:
        print(f"  + added{tag}: {rel}")
    for rel in updated:
        print(f"  * updated{tag}: {rel}")
    print(f"  {len(added)} added, {len(updated)} updated, {len(same)} unchanged, "
          f"{len(removed)} removed{tag}")

    # justfile / sssf.config.yaml: reported only, never written here - both are
    # hand-curated, not a mechanical mirror of the live files (see docstring).
    live_justfile = live_root / "justfile"
    if live_justfile.is_file() and TEMPLATE_JUSTFILE.is_file():
        same_bytes = live_justfile.read_bytes() == TEMPLATE_JUSTFILE.read_bytes()
        note = "matches live byte-for-byte" if same_bytes else "differs from live - review by hand"
        print(f"  justfile: {note} (not auto-synced)")
    live_config = live_adws / "adw_sssf_config" / "sssf.config.yaml"
    if live_config.is_file() and TEMPLATE_CONFIG.is_file():
        same_bytes = live_config.read_bytes() == TEMPLATE_CONFIG.read_bytes()
        note = "matches the live roster file byte-for-byte" if same_bytes else \
            "differs from the live roster file - review the schema by hand"
        print(f"  sssf.config.yaml: {note} (not auto-synced; template is hand-curated)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
