"""Deterministic lint, typecheck, test, and AI-defect-scan blocks.

A known command is not a judgement call. Anything whose invocation you can write
down belongs here as code — it runs in milliseconds, costs nothing, and returns
the same answer every time. Agents are for the parts that need reading and
deciding.

Every block below runs through `uv run --group <name>`, which resolves the
pinned toolchain in the root pyproject.toml — the same ruff/mypy/pytest/skylos
on every host. Every other binary is still called by BARE NAME (the rule that
gave this file its original banner: never bake a machine path into the trace);
`uv` itself is the one exception, resolved through `utils.uv_cmd()`, because
these blocks inherit `utils.operator_env()` — which strips the ADW's own venv
bin back off PATH — and because under systemd the service PATH does not carry
`~/.local/bin`, where uv is installed. A bare `uv` there resolved to nothing,
and the gate read RED on the resulting OSError for reasons that had nothing to
do with the code being judged.

There is no `build` block: this repo is the factory's own Python, and there is
no bundle step to run. Re-add one the day this repo grows something that is
actually built.
"""

from __future__ import annotations

import shlex
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

from . import git_helper
from .data_types import (
    EventRecord,
    QualityArea,
    QualityCheckResult,
    QualityCheckSpec,
    QualityConfig,
    QualityOperation,
    QualityResult,
    QualityStatus,
    VerifyOutput,
)
from .utils import now_iso, operator_env, uv_cmd

# How much of a failing command's output rides back inside the envelope. Enough
# for a builder to act on without opening the artifact; bounded so a runaway
# stack trace can't swamp the next agent's context.
TAIL_CHARS = 4_000

# Every "real tool" block runs through the project's own pinned dev toolchain
# (root pyproject.toml, `[dependency-groups] dev`), never whatever happens to
# be on the operator's PATH under some other name.
#
# `--project <run.repo_root>` (never a bare `uv run --group dev`) is what
# keeps this correct once `run.repo_root` is a worktree: with cwd = the
# worktree but no --project, uv still resolves relative to cwd and would
# usually get the right project anyway — the study's real flag is
# UV_PROJECT_ENVIRONMENT (below), which an inherited value from the
# operator's shell or the `uv run` that launched the ADW could otherwise
# silently redirect. Both are made fully explicit — nothing ambient, nothing
# inferred (spec section 6).
#
# These two are what `{dev}` and `{scan}` expand to in a `quality:` template
# (see `resolve_command`, which is now what every block below goes through).
# Kept as named helpers because they are the definition of the prefix and
# because callers outside this module read them.
def _dev(run) -> list[str]:
    return [uv_cmd(), "run", "--project", str(run.repo_root), "--group", "dev"]


# skylos lives in its OWN group (`scan`), never `dev` — see pyproject.toml for
# why: one of its dependencies is sdist-only and needs an MSVC toolchain this
# laptop does not have, and a single shared group would take ruff/mypy/pytest
# down with it on every `uv sync`.
def _scan(run) -> list[str]:
    return [uv_cmd(), "run", "--project", str(run.repo_root), "--group", "scan"]


def resolve_command(template: str, repo_root: Path | str) -> list[str]:
    """A `quality:` template string -> the argv to run in `repo_root`.

    Split with `shlex` FIRST, then expanded token by token, so `{dev}` and
    `{scan}` become several arguments each and no path a placeholder expands
    to is ever re-parsed as shell text (a Windows tree path is full of
    backslashes; string-substituting it before splitting would eat them).

    An empty (or whitespace-only) template returns `[]` — "this project has
    decided not to run this check", which every caller treats as skip-and-say-
    so rather than as a command that passed.

    `{dev}`/`{scan}` expand with a RESOLVED uv (`utils.uv_cmd()`), not the bare
    name. This function is what the engine's integration gate builds its argv
    with too (`engine.quality_commands`), so this one line is what stops the
    gate from reading red on "uv is not on the service's PATH" — see the module
    banner. A token a project wrote itself is never rewritten: only the two
    placeholders carry the resolved launcher.
    """
    uv = uv_cmd()
    dev = [uv, "run", "--project", str(repo_root), "--group", "dev"]
    scan = [uv, "run", "--project", str(repo_root), "--group", "scan"]
    argv: list[str] = []
    for token in shlex.split(template.strip(), posix=True):
        if token == "{dev}":
            argv.extend(dev)
        elif token == "{scan}":
            argv.extend(scan)
        else:
            argv.append(token)
    return argv


def quality_config(run) -> QualityConfig:
    """This run's `quality:` block, with the factory's own defaults when the
    roster names none — which is every roster written before the block existed,
    so nothing that worked yesterday changes shape today."""
    return getattr(getattr(run, "cfg", None), "quality", None) or QualityConfig()


def _configured(run, name: str) -> list[str]:
    return resolve_command(getattr(quality_config(run), name), run.repo_root)


def _skipped(name: str, area: QualityArea, operation: QualityOperation) -> QualityCheckResult:
    """The record left when a project has emptied a check out of its roster.

    `status="incomplete"`, never `pass`: nothing was verified, and the run must
    not be able to call itself green on the strength of a check nobody ran.
    `incomplete` is already the state that stays out of the builder's repair
    spec (there is no code defect here) while still keeping `QualityResult.passed`
    False — exactly the honest shape this needs.
    """
    return QualityCheckResult(
        name=name,
        area=area,
        operation=operation,
        command="(none - this project's roster sets quality." + name + " to an empty string)",
        returncode=0,
        status="incomplete",
        passed=False,
        duration_seconds=0.0,
        output_artifact="",
        output_tail=f"quality.{name} is empty in this project's sssf.config.yaml, so nothing was run for it.",
    )


def _check_dir(run, name: str) -> Path:
    seq = run.phases[-1].seq if run.phases else 0
    path = run.context_handoff_dir / "quality" / f"{seq:02d}_{name}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _classify_exit_code(returncode: int, stdout: str, stderr: str) -> QualityStatus:
    """Default classifier: a known command either exits 0 or it does not.

    Correct for test/lint/typecheck — ruff, mypy and pytest are already
    installed by the time this runs (`uv sync --group dev` succeeds on every
    platform this factory targets), so a non-zero exit here means the tool ran
    and found something wrong, never that the tool itself is missing.
    """
    del stdout, stderr
    return "pass" if returncode == 0 else "fail"


# Substrings that mean uv (or the C toolchain it shelled out to) never managed
# to PROVISION the tool — the tool itself never ran, so its exit code says
# nothing about the code being scanned. Collected from real uv output, not
# guessed: `uv run --group scan skylos --version` on this exact Windows laptop
# fails with exit 1 (the same exit code skylos itself uses for "found
# defects") and this exact text:
#
#   x Failed to build `tree-sitter-dart-orchard==0.5.0`
#   ...
#   error: Microsoft Visual C++ 14.0 or greater is
#   required. Get it with "Microsoft C++ Build Tools": ...
#
# Matched case-insensitively against stdout+stderr. Kept narrow on purpose: a
# false positive here (real findings misread as "tool unavailable") would hide
# a genuine defect from the builder, which is exactly the silently-green
# failure this classifier exists to prevent.
TOOL_UNAVAILABLE_SIGNATURES = (
    "failed to build",              # uv could not build a dependency's sdist
    "microsoft visual c++",         # the specific missing toolchain on Windows
    "no solution found",            # uv's resolver could not provision at all
    "no virtual environment found", # uv could not locate/create a venv
    "distribution not found",       # uv could not locate the package at all
)


def _classify_ai_defects(returncode: int, stdout: str, stderr: str) -> QualityStatus:
    """skylos is fail-closed: a provisioning failure reads incomplete, never pass.

    `uv run --group scan skylos ...` can fail two structurally different ways:
    uv could not even build/install skylos's own dependency (the tool never
    ran — the LAPTOP is the problem, not the code, and the exit code is uv's,
    not skylos's), or skylos ran and found real issues (a genuine non-zero
    exit with an actual report in it). Only the first is "incomplete"; the
    second is a real "fail" the builder should see. Exit 127 (missing binary,
    raised by `_run`'s OSError branch) and 124 (timeout) are unambiguous cases
    of the same thing — the tool never ran — and are classified the same way
    without needing to inspect any text.
    """
    if returncode == 0:
        return "pass"
    if returncode in (124, 127):
        return "incomplete"
    haystack = (stdout + stderr).casefold()
    if any(signature in haystack for signature in TOOL_UNAVAILABLE_SIGNATURES):
        return "incomplete"
    return "fail"


def _run(spec: QualityCheckSpec, run,
         classify: Callable[[int, str, str], QualityStatus] = _classify_exit_code
         ) -> QualityCheckResult:
    phase = run.phases[-1]
    output_dir = _check_dir(run, spec.name)
    output_artifact = output_dir / "command.log"
    command = shlex.join(spec.argv)
    # UV_PROJECT_ENVIRONMENT, absolute and per-tree, pins WHICH venv uv uses —
    # fixes it against an inherited value from the operator's shell (or the
    # `uv run` that launched this ADW) silently redirecting every parallel
    # run into one shared venv (section 6.1). Harmless to set for non-uv
    # commands too, so it rides in the base env unconditionally rather than
    # per-block.
    env = {**operator_env(), "UV_PROJECT_ENVIRONMENT": str(Path(run.repo_root) / ".venv")}

    run.console.note(f"quality {spec.name}: {command}")
    started_at = now_iso()
    clock = time.monotonic()
    stdout = ""
    stderr = ""
    try:
        completed = subprocess.run(
            spec.argv,
            cwd=run.repo_root,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=spec.timeout_seconds,
            check=False,      # returncode is inspected explicitly below via `classify`
        )
        returncode = completed.returncode
        stdout = completed.stdout
        stderr = completed.stderr
    except subprocess.TimeoutExpired as error:
        returncode = 124
        # TimeoutExpired.stdout/.stderr are typed bytes|str and a timeout can
        # interrupt the stream reader before it decodes anything, so this can
        # genuinely be bytes even though the call above passed encoding=.
        raw_out, raw_err = error.stdout, error.stderr
        stdout = raw_out.decode("utf-8", errors="replace") if isinstance(raw_out, bytes) else (raw_out or "")
        stderr = (raw_err.decode("utf-8", errors="replace") if isinstance(raw_err, bytes) else (raw_err or "")) \
            + f"\nTimed out after {spec.timeout_seconds}s."
    except OSError as error:
        # A missing binary lands here as exit 127 with the real message — no
        # pre-flight probe needed, and none wanted.
        returncode = 127
        stderr = str(error)

    duration = time.monotonic() - clock
    output_artifact.write_text(
        f"$ {command}\nexit: {returncode}\nduration_seconds: {duration:.3f}\n"
        f"\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}\n",
        encoding="utf-8",
    )
    status = classify(returncode, stdout, stderr)
    passed = status == "pass"
    run.tracer.event(EventRecord(
        adw_id=run.adw_id,
        phase_id=phase.phase_id,
        type="tool_call",
        name=f"quality:{spec.name}",
        payload={
            "area": spec.area,
            "operation": spec.operation,
            "command": command,
            "returncode": returncode,
            "status": status,
            "passed": passed,
            "output_artifact": str(output_artifact),
        },
        started_at=started_at,
        ended_at=now_iso(),
    ))
    run.console.note(
        f"quality {spec.name}: {status} (exit {returncode}, {duration:.1f}s)"
    )
    return QualityCheckResult(
        name=spec.name,
        area=spec.area,
        operation=spec.operation,
        command=command,
        returncode=returncode,
        status=status,
        passed=passed,
        duration_seconds=duration,
        output_artifact=str(output_artifact),
        output_tail=(stdout + stderr)[-TAIL_CHARS:],
    )


# ── Blocks ────────────────────────────────────────────────────────────────────

def test(run) -> QualityCheckResult:
    """Run the suite — WHICHEVER suite this project's roster names.

    The default is the factory's own (`{dev} pytest -q adws/tests`), which is
    correct in the repo that IS the factory and wrong in a repo the factory was
    stamped into: there, the project's own tests are the ones that matter and
    `quality.test` in its sssf.config.yaml is where it says so.

    The reason a test block still has to point at something real: pytest exits
    5 when it collects nothing, which `_run` reads as a failure forever, so a
    wired test block aimed at an empty directory is worse than no block at all.
    """
    argv = _configured(run, "test")
    if not argv:
        return _skipped("test", "repo", "test")
    return _run(QualityCheckSpec(
        name="test",
        area="repo",
        operation="test",
        argv=argv,
        timeout_seconds=600,
    ), run)


def lint(run) -> QualityCheckResult:
    argv = _configured(run, "lint")
    if not argv:
        return _skipped("lint", "repo", "lint")
    return _run(QualityCheckSpec(
        name="lint",
        area="repo",
        operation="lint",
        argv=argv,
    ), run)


def typecheck(run) -> QualityCheckResult:
    argv = _configured(run, "typecheck")
    if not argv:
        return _skipped("typecheck", "repo", "typecheck")
    return _run(QualityCheckSpec(
        name="typecheck",
        area="repo",
        operation="typecheck",
        argv=argv,
    ), run)


def ai_defects(run, trunk: str | None = None) -> QualityCheckResult:
    """Skylos: a deterministic scan for the failure modes of the agent that
    just wrote the code — missing guards, fake/unfinished helpers, invented
    package APIs, disabled controls, impossible dependency versions.

    SCOPED TO THIS RUN'S DIFF via `--diff <merge-base with trunk>`: an
    unscoped scan reports every pre-existing finding in the whole repo, which
    becomes the builder's repair spec for defects it did not write and cannot
    attribute to this change. `--diff` reports only findings on lines this run
    touched while still parsing unchanged files, so cross-file accuracy (e.g.
    dead-code detection) is preserved. The base is the merge-base with trunk —
    the same notion of "base" `git_helper.merge_base` already gives every
    other diff-scoped block in this codebase. If the base cannot be resolved
    (no git, no trunk, a single-commit repo), the scan falls back to the whole
    repo: noisy beats a gate that silently always passes.

    `trunk=None` means the factory trunk (`git_helper.factory_trunk()` -
    `integration`, MAP.md 2026-08-15), NOT `main`. Runs fork from integration
    now, so a merge-base against `main` would reach back to the operator's
    last squash and scope the scan over every OTHER run integrated since -
    precisely the "someone else's findings become this builder's repair spec"
    failure this block is scoped to avoid.

    FAIL-CLOSED on Windows: skylos depends on tree-sitter-dart-orchard, an
    sdist-only package that needs an MSVC toolchain uv cannot provision on
    this laptop (see pyproject.toml's `scan` group). `_classify_ai_defects`
    tells that failure apart from a real scan finding real issues, and a
    provisioning failure comes back `status="incomplete"` — never "pass", and
    excluded from `run_quality`'s builder-facing `failures` (see there for
    why: a missing MSVC toolchain is not something a repair loop can fix).
    """
    argv = _configured(run, "scan")
    if not argv:
        return _skipped("ai_defects", "repo", "scan")
    try:
        base = git_helper.merge_base(trunk or git_helper.factory_trunk(), tree=run.repo_root)
    except (RuntimeError, OSError):
        base = ""
    if base:
        argv += ["--diff", base]
    return _run(QualityCheckSpec(
        name="ai_defects",
        area="repo",
        operation="scan",
        argv=argv,
        timeout_seconds=300,
    ), run, classify=_classify_ai_defects)


def run_tests(run) -> QualityResult:
    """The test suite alone, as a QualityResult — the deterministic test phase.

    This is what replaces a `tester` agent once the command is written down. An
    agent rediscovering the runner on every run costs a fortune to learn what a
    subprocess already knows; the repair loop is unchanged, because a failure
    still reaches the builder through `as_envelope` below.
    """
    check = test(run)
    # Keyed on STATUS, not on `passed`, for the same reason `run_quality` is: a
    # check that never ran (a project that emptied `quality.test` in its roster,
    # a tool that would not provision) is not a code defect, and handing the
    # builder "fix every failure below" against one burns a repair round on
    # nothing. It still keeps `passed` False, so no caller can merge on it.
    failures = ([f"{check.name}: `{check.command}` exited {check.returncode}\n"
                 f"{check.output_tail}".rstrip()] if check.status == "fail" else [])
    incomplete = ([f"{check.name}: `{check.command}` - not evaluated\n"
                   f"{check.output_tail}".rstrip()] if check.status == "incomplete" else [])
    return QualityResult(passed=check.passed, checks=[check], failures=failures,
                         incomplete=incomplete,
                         artifacts=[check.output_artifact] if check.output_artifact else [])


def as_envelope(result: QualityResult, what: str) -> VerifyOutput:
    """Wrap a deterministic result so an agent can be handed it directly.

    Agents hand each other typed envelopes; code blocks return QualityResult.
    This is the adapter, so a failing lint or test run flows back into the
    builder through exactly the same door an agent's report would — the ADW
    script is the only thing that knows the difference.

    Deliberately keyed on `result.failures` (genuine code defects), NOT on
    `result.passed`: `passed` is strict and goes False on an `incomplete`
    check too (see QualityResult), but an incomplete check is a tool that
    never ran — nothing here is a defect for the builder to fix, and telling
    it "fix every failure below" against an empty list wastes a real agent
    turn on nothing. `result.incomplete` still shows up in the summary, so the
    handoff is honest about what was NOT verified without asking the builder
    to act on it. The caller decides, separately, whether an incomplete-only
    result is good enough to stop looping (see run_quality's callers) — this
    function only decides what the AGENT is told.
    """
    actionable = bool(result.failures)
    parts = []
    if result.checks:
        n_pass = sum(1 for c in result.checks if c.status == "pass")
        parts.append(f"{n_pass}/{len(result.checks)} check(s) passed")
    if result.incomplete:
        parts.append(f"{len(result.incomplete)} unavailable "
                     f"(tool could not run - not a code defect)")
    summary = f"{what}: " + ", ".join(parts) if parts else what
    return VerifyOutput(
        status="fail" if actionable else "success",
        summary=summary,
        artifacts=result.artifacts,
        notes_for_next_agent=("Fix every failure below. The output is verbatim from the "
                              "command - trust it over any summary." if actionable else ""),
        passed=not actionable,
        failures=result.failures,
    )


def run_quality(run) -> QualityResult:
    """Run every block and collect ALL failures — one pass tells you everything.

    Ordering contract for the caller: a failing block does NOT fail the phase.
    The runner did its job; the CODE is what failed. Hand this result to the
    builder and let the bounded repair loop decide the run's fate.

    `failures` vs `incomplete` is a split by who can act on it. `failures`
    holds genuine code defects (status="fail") — that list is what
    `as_envelope` turns into the builder's repair spec. `incomplete` holds
    tool-unavailable notes (status="incomplete", e.g. skylos with no MSVC on
    this laptop) — recorded in the trace and in this result, but deliberately
    kept OUT of `failures`, because "skylos: failed to build
    tree-sitter-dart-orchard" is not a line of code a repair loop can fix.
    Routing it there would burn the bounded fix loop on an unwinnable round
    every single time.

    That said, `passed` stays strict: True only when EVERY check passed. An
    incomplete-only result is `passed=False` exactly like a real failure, so a
    caller gating a commit on `.passed` still correctly refuses to merge on an
    unverified run — the difference only matters for what gets told to the
    agent, not for whether the run is allowed to call itself done.
    """
    blocks: list[Callable] = [
        lint,
        typecheck,
        ai_defects,
        test,
    ]
    checks = [block(run) for block in blocks]
    for check in checks:
        if check.status == "incomplete":
            run.console.note(
                f"quality {check.name}: TOOL UNAVAILABLE (exit {check.returncode}) - "
                f"recorded in the trace, NOT sent to the builder as a defect, and it "
                f"still blocks the run from being accepted. See {check.output_artifact}.")
    failures = [
        f"{check.name}: `{check.command}` exited {check.returncode}\n{check.output_tail}".rstrip()
        for check in checks if check.status == "fail"
    ]
    incomplete = [
        f"{check.name}: `{check.command}` exited {check.returncode} - tool unavailable, "
        f"not evaluated\n{check.output_tail}".rstrip()
        for check in checks if check.status == "incomplete"
    ]
    return QualityResult(
        passed=all(check.status == "pass" for check in checks),
        checks=checks,
        failures=failures,
        incomplete=incomplete,
        # A skipped check leaves no artifact; an empty path in this list would
        # travel to an agent as a file it could try to open.
        artifacts=[check.output_artifact for check in checks if check.output_artifact],
    )
