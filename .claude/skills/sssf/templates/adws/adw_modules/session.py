"""Session lifecycle: pin-or-create an adw_id, build the Run object.

`ensure(cfg, adw_id)` joins the session if it exists or creates it under
exactly that id (pinned ids for repeatable runs); omitted, a fresh id is
minted and printed so the next ADW can pick it up.
"""

from __future__ import annotations

import os
import signal
import sys
from pathlib import Path

from . import git_helper
from .data_types import SSSFConfig
from .runner import Run
from .tracer import Tracer
from .utils import engineer_name, minutes_since, new_id, under


def _finalize_when_killed(run: Run) -> None:
    """A killed run still closes its own trace.

    Python's default SIGTERM handling exits without unwinding, so `just kill`
    (or any `kill <pid>`) would leave the session reading `running` forever and
    its process rows open — the trace would claim work is in flight that is
    already dead. Turning the signal into SystemExit both finalizes here and
    lets the phase context manager record the phase as failed on the way out.
    """
    def handler(signum, _frame):
        run.tracer.session_finish(run.adw_id, ok=False)   # also closes process rows
        raise SystemExit(128 + signum)

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, handler)


def _guard_live_rejoin(tracer: Tracer, cfg: SSSFConfig, adw_id: str) -> None:
    """Refuse — or loudly proceed — when `--adw-id` names a run this process
    could collide with (4.5). Checked against the row as it stood BEFORE this
    call touches anything, so `status == 'running'` here means a PRIOR
    process, not this one about to start.

    Two processes in one worktree is the one thing in this design that can
    actually destroy work — no pid probing: `os.kill(pid, 0)` TERMINATES the
    target on Windows (CPython routes non-signal values to
    `TerminateProcess`), so a timestamp comparison against the newest traced
    event is what is cheap and honest. pi streams a `tool_call` event per
    tool call, so a healthy phase is never silent this long.
    """
    row = tracer.conn.execute("SELECT status FROM sessions WHERE adw_id=?",
                              (adw_id,)).fetchone()
    if not row or row[0] != "running":
        return
    latest = tracer.conn.execute(
        "SELECT MAX(started_at) FROM events WHERE adw_id=?", (adw_id,)).fetchone()
    newest = latest[0] if latest and latest[0] else ""
    age = minutes_since(newest)
    limit = cfg.worktrees.stale_after_minutes
    if age < limit:
        raise SystemExit(
            f"adw_id {adw_id} looks like it is still running - its newest traced "
            f"event was {age:.1f}m ago, inside the {limit}m staleness window. Two "
            f"processes in one worktree is the one thing this factory cannot "
            f"recover from. Run `just procs {adw_id}` to check, or wait it out.")
    print(f"WARNING: adw_id {adw_id} is marked 'running' but its newest traced event "
         f"was {age:.1f}m ago (past the {limit}m staleness window) - treating it as "
         f"dead and rejoining anyway.")


def ensure(cfg: SSSFConfig, adw_id: str | None = None) -> Run:
    joining = adw_id is not None
    adw_id = adw_id or new_id(8)
    # The process cwd is still the main repo — no ADW ever chdir's (5.1) — so
    # this is `Run.main_root`. `db`/`data_dir` resolve absolute against it,
    # never against whatever a later worktree phase rebinds `repo_root` to;
    # see utils.under for why that matters (the silent-loss landmine, 5.3).
    main_root = git_helper.repo_root()
    db = under(main_root, cfg.observability.db)
    data_dir = under(main_root, cfg.defaults.data_dir)
    tracer = Tracer(db, data_dir / "sessions" / adw_id / "events.jsonl")
    if joining:
        _guard_live_rejoin(tracer, cfg, adw_id)
    run = Run(cfg=cfg, adw_id=adw_id, tracer=tracer, engineer=engineer_name(),
             main_root=main_root, data_dir=data_dir)
    tracer.session_start(adw_id, run.engineer, adw_name=Path(sys.argv[0]).stem)
    # This process is the run. Record it before any phase opens, so a run that
    # hangs in its first agent call is still killable by adw_id.
    tracer.process_start(adw_id, "adw", "", os.getpid(),
                         " ".join([Path(sys.argv[0]).name, *sys.argv[1:]]))
    _finalize_when_killed(run)
    run.console.session_started(adw_id, run.engineer)
    return run
