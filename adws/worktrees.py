#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""Worktree reconciliation - `just worktrees` / `just worktrees-prune`.

Usage:
    uv run adws/worktrees.py                      # table (default)
    uv run adws/worktrees.py --json                # machine-readable; a future Gate tab reads this
    uv run adws/worktrees.py --all                 # include sessions that never cut a tree
    uv run adws/worktrees.py --prune                # dry run: prints exactly what it would do
    uv run adws/worktrees.py --prune --yes          # perform it
    uv run adws/worktrees.py --trunk integration --config adws/adw_sssf_config/sssf.config.yaml
    SSSF_INTEGRATION_BRANCH=integration uv run adws/worktrees.py   # same, via env override

Exit codes: 0 nothing stranded - 1 at least one unmerged/orphan row - 2 the
tool could not answer (not a git repo, unreadable db, two branches sharing an
adw_id).

Deliberately NOT an `adw_*.py` script: no session, no phases, no envelopes, no
agents. Opening a session here to print a report would write a `sessions` row
into the very table this reads, crowding real runs out of `just sessions`
(spec 8.1). Just a plain script with an observable exit code (MAP rule 8).
"""

import argparse
import json
import os
import sys

import yaml
from adw_modules import agents, git_helper, worktrees
from adw_modules.utils import under
from pydantic import ValidationError


def _action_dict(action: worktrees.PruneAction) -> dict:
    return {"adw_id": action.adw_id, "branch": action.branch, "path": action.path,
           "prunable": action.prunable, "reason": action.reason,
           "commands": action.commands}


def _prune(main_root, rows, do_it: bool, json_mode: bool) -> int:
    plan = worktrees.prune_plan(rows)
    kept = [a for a in plan if not a.prunable]
    prunable = [a for a in plan if a.prunable]

    if not do_it:
        if json_mode:
            print(json.dumps([_action_dict(a) for a in plan], indent=2))
        else:
            for a in kept:
                print(a.reason)
            for a in prunable:
                print(f"would prune {a.adw_id} {a.branch}")
                for command in a.commands:
                    print(f"  $ git {' '.join(command)}")
            print(f"\n{len(prunable)} row(s) would be pruned, {len(kept)} kept. "
                 f"Pass --yes to actually do it.")
        return worktrees.exit_code_for(rows)

    report = worktrees.apply_prune(main_root, plan)
    if json_mode:
        print(json.dumps({"kept": [a.reason for a in kept], "report": report}, indent=2))
    else:
        for a in kept:
            print(a.reason)
        for line in report:
            print(line)
    return worktrees.exit_code_for(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--trunk", default=os.environ.get(git_helper.FACTORY_TRUNK_ENV),
                        help="override worktrees.trunk for this run (default: "
                             "worktrees.trunk in --config, else "
                             f"${git_helper.FACTORY_TRUNK_ENV} when set)")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--all", action="store_true",
                        help="include sessions that never cut a tree (no-tree rows)")
    parser.add_argument("--prune", action="store_true",
                        help="print (or, with --yes, perform) removal of merged rows")
    parser.add_argument("--yes", action="store_true", help="actually perform --prune")
    args = parser.parse_args(argv)

    try:
        cfg = agents.load_config(args.config)
    except (OSError, yaml.YAMLError, ValidationError) as error:
        print(f"worktrees: could not load {args.config}: {error}", file=sys.stderr)
        return 2

    wcfg = cfg.worktrees
    if args.trunk:
        wcfg = wcfg.model_copy(update={"trunk": args.trunk})

    main_root = git_helper.repo_root()
    db_path = under(main_root, cfg.observability.db)

    try:
        rows = worktrees.inventory(main_root, wcfg, db_path)
    except worktrees.ReconciliationError as error:
        print(f"worktrees: {error}", file=sys.stderr)
        return 2

    visible = rows if args.all else [r for r in rows if r.state != "no-tree"]

    if args.prune:
        return _prune(main_root, visible, args.yes, args.json)

    if args.json:
        print(json.dumps([row.model_dump() for row in visible], indent=2))
    else:
        print(worktrees.render(visible))
    return worktrees.exit_code_for(visible)


if __name__ == "__main__":
    sys.exit(main())
