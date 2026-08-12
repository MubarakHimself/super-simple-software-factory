#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""SDL Factory installer / wizard.

One command converges a host into a working SDL Factory box. Three targets:
laptop, server, container. Interactive by default, flag-driven for CI.
Authority: specs/installer-wizard.md (MAP.md wins on any conflict).

Usage:
    uv run installer/install.py [--target {laptop,server,container}] [--yes]
                                 [--dry-run] [--verify-only] [--json]

Six ordered passes, each complete before the next begins (spec section 3):
    detect -> plan -> confirm -> converge -> verify -> restart

Exit codes (spec 2.2):
    0  every required step ok/installed (+ declared expected-unavailable);
       verification passed.
    1  a required step failed, or verification failed.
    2  everything the wizard can do is done, but something needs a human.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import steps  # steps.py lives beside this file - sys.path is set just above


def _ascii(text: str) -> str:
    """ASCII only reaches stdout, ever (spec 5.2) - a defensive backstop on
    top of every string in steps.py already being plain ASCII."""
    return text.encode("ascii", "replace").decode("ascii")


def _say(ctx: steps.Ctx, line: str) -> None:
    """Human text goes to stderr under --json, stdout otherwise (spec 2.1)."""
    out = sys.stderr if ctx.json_mode else sys.stdout
    print(_ascii(line), file=out)


def _report_line(step_id: str, title: str, result: steps.Result) -> str:
    marker = steps.MARKERS.get(result.outcome, "[??]")
    return f"{marker} {step_id} ({title}): {result.message}"


def _run_verify(ctx: steps.Ctx) -> list[tuple[str, steps.Result]]:
    _say(ctx, "")
    _say(ctx, "VERIFY")
    out: list[tuple[str, steps.Result]] = []
    for check in steps.VERIFY_CHECKS:
        if ctx.target not in check.targets:
            continue
        result = check.check(ctx)
        out.append((check.id, result))
        marker = steps.MARKERS.get(result.outcome, "[??]")
        _say(ctx, f"{marker} {check.id} ({check.title}): {result.message}")
    return out


def _compute_exit_from_verify(verify_results: list[tuple[str, steps.Result]]) -> int:
    outcomes = [result.outcome for _id, result in verify_results]
    if any(outcome == "failed" for outcome in outcomes):
        return 1
    if any(outcome == "needs-operator" for outcome in outcomes):
        return 2
    return 0


def _print_restart_notes(ctx: steps.Ctx) -> None:
    _say(ctx, "")
    running = steps.detect_running_pi(ctx)
    if running:
        _say(ctx, "[??] a pi process appears to be running (best effort, by process name) - "
             "not stopped, it is yours to exit")
    _say(ctx, "[ok] restart pi to pick up models.json and packages:  exit any running pi, "
         "then run:  pi")
    _say(ctx, "     extensions under ~/.pi/agent/extensions/ and .pi/extensions/ support "
         "/reload; models.json does not.")


def _emit_json(ctx: steps.Ctx, args: argparse.Namespace, mode: str,
               step_results: list[tuple[steps.Step, steps.Result]],
               verify_results: list[tuple[str, steps.Result]], code: int) -> None:
    del args
    payload = {
        "run_id": ctx.run_id,
        "target": ctx.target,
        "mode": mode,
        "steps": [{"id": step.id, "title": step.title, "outcome": result.outcome,
                   "message": result.message} for step, result in step_results],
        "verify": [{"id": check_id, "outcome": result.outcome, "message": result.message}
                   for check_id, result in verify_results],
        "exit_code": code,
        "log_path": str(ctx.log_path),
    }
    print(json.dumps(payload, indent=2))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="install.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", choices=sorted(steps.ALL), default=None,
                        help="skip the 'where am I landing' question")
    parser.add_argument("--yes", action="store_true",
                        help="non-interactive: accept every detected default")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the full plan, change nothing")
    parser.add_argument("--verify-only", action="store_true",
                        help="skip install; run verification only (the drift check)")
    parser.add_argument("--json", action="store_true",
                        help="emit plan/result as one JSON object on stdout")
    args = parser.parse_args(argv)

    try:
        repo_root = steps.find_repo_root(Path(__file__).resolve())
    except steps.RepoNotFoundError as exc:
        print(_ascii(f"[!!] {exc}"), file=sys.stderr)
        return 1

    target = args.target or steps.detect_target()
    ctx = steps.build_ctx(repo_root=repo_root, target=target, yes=args.yes,
                          dry_run=args.dry_run, verify_only=args.verify_only,
                          json_mode=args.json)

    _say(ctx, f"SDL Factory installer - target={ctx.target} run_id={ctx.run_id}")
    _say(ctx, f"os={platform.system()} arch={platform.machine()} "
         f"python={platform.python_version()} cwd={Path.cwd()}")
    _say(ctx, f"log: {ctx.log_path}")

    applicable = [step for step in steps.STEPS if ctx.target in step.targets]

    if args.verify_only:
        verify_results = _run_verify(ctx)
        code = _compute_exit_from_verify(verify_results)
        _say(ctx, "")
        _say(ctx, f"exit {code}  (log: {ctx.log_path})")
        if args.json:
            _emit_json(ctx, args, "verify-only", [], verify_results, code)
        return code

    # ---- plan pass: pure. detect() + apply() forced into dry-run, so this
    # pass can never mutate the host regardless of the real --dry-run flag
    # (spec 3: "plan ... This is exactly what --dry-run prints.") ----
    plan_ctx = replace(ctx, dry_run=True)
    plan = [(step, step.apply(plan_ctx)) for step in applicable]

    _say(ctx, "")
    _say(ctx, "PLAN")
    for step, result in plan:
        _say(ctx, _report_line(step.id, step.title, result))

    if args.dry_run:
        _say(ctx, "")
        _say(ctx, "exit 0  (dry-run: nothing was changed)")
        if args.json:
            _emit_json(ctx, args, "plan", plan, [], 0)
        return 0

    # ---- confirm pass ----
    if not args.yes:
        _say(ctx, "")
        try:
            input("Press Enter to converge, or Ctrl-C to abort: ")
        except (EOFError, KeyboardInterrupt):
            _say(ctx, "")
            _say(ctx, "aborted - nothing changed")
            return 1

    # ---- converge pass: the ONLY pass that mutates the host ----
    _say(ctx, "")
    _say(ctx, "CONVERGE")
    step_results: list[tuple[steps.Step, steps.Result]] = []
    for step in applicable:
        result = step.apply(ctx)
        step_results.append((step, result))
        _say(ctx, _report_line(step.id, step.title, result))
        if result.outcome == "failed" and step.required:
            _say(ctx, f"[!!] {step.id} is required and failed - stopping the run "
                 "(later steps would be built on sand)")
            break

    # ---- verify pass: always runs, even after needs-operator or a stop ----
    verify_results = _run_verify(ctx)

    code = steps.compute_exit_code(step_results, verify_results)

    _print_restart_notes(ctx)
    _say(ctx, "")
    _say(ctx, f"exit {code}  (log: {ctx.log_path})")
    if args.json:
        _emit_json(ctx, args, "converge", step_results, verify_results, code)
    return code


if __name__ == "__main__":
    sys.exit(main())
