"""The Run object: config + adw_id + agent_map + tracer + console, bound once.

`run.phase(PhaseParams(...))` is the ONE phase primitive — a context manager
for all three kinds (engineer, agent, code). Success must be earned: every
phase defaults to fail; only a clean exit flips it (agent phases additionally
require a parsed envelope + green gates, enforced inside ph.call).
"""

from __future__ import annotations

import json
import time
from contextlib import contextmanager
from pathlib import Path

from . import agents, git_helper, permissions, worktrees
from .console import Console
from .data_types import AgentCall, EnvelopeBase, EventRecord, Phase, PhaseParams, RunWorktree
from .utils import ensure_dir, now_iso


class PhaseHandle:
    def __init__(self, run: Run, phase: Phase):
        self.run = run
        self.phase = phase

    def log(self, **payload) -> None:
        self.run.tracer.event(EventRecord(adw_id=self.run.adw_id,
                                          phase_id=self.phase.phase_id,
                                          type="log", name=self.phase.params.name,
                                          payload=payload))
        self.run.console.note(", ".join(f"{k}: {v}" for k, v in payload.items()))
        if self.phase.params.kind == "engineer" and "input" in payload:
            self.run.tracer.session_request(self.run.adw_id, str(payload["input"]))

    def call(self, call: AgentCall) -> EnvelopeBase:
        if self.phase.params.kind != "agent":
            raise RuntimeError("ph.call() is only valid inside an agent phase")
        return agents.execute(self.run, self.phase, call)


class Run:
    def __init__(self, cfg, adw_id: str, tracer, engineer: str,
                main_root: Path, data_dir: Path):
        self.cfg = cfg
        self.adw_id = adw_id
        self.tracer = tracer
        self.console = Console(tracer, adw_id)
        self.engineer = engineer
        self.phases: list[Phase] = []
        self.tokens = 0
        self.cost = 0.0
        self._seq = tracer.max_phase_seq(adw_id)   # a joined run continues the sequence
        # main_root is IMMUTABLE — the operator's own checkout, always on trunk
        # (spec invariant 1). repo_root is where THIS run's agents work: the
        # main checkout until enter_worktree() rebinds it to the run's own
        # tree. The four read-only ADWs never call enter_worktree, so for them
        # repo_root == main_root for the run's entire life — unchanged
        # behaviour, byte for byte.
        self.main_root = main_root
        self.repo_root = main_root
        self.worktree: RunWorktree | None = None
        self._main_checkout_snapshot: dict[str, str] | None = None  # permissions tripwire (5.5)
        self.session_dir = ensure_dir(data_dir / "sessions" / adw_id)
        self.context_handoff_dir = ensure_dir(self.session_dir / "context_handoff")
        self._agent_map_path = self.session_dir / "agent_map.json"
        self.agent_map: dict = (json.loads(self._agent_map_path.read_text(encoding="utf-8"))
                                if self._agent_map_path.exists() else {})

    # ── worktrees (spec section 4/5) ─────────────────────────────────────────
    def enter_worktree(self, prompt: str) -> dict:
        """Cut or join this run's branch AND its own working tree, then rebind
        `repo_root` to it. The only new call site an ADW needs — the
        `worktree` phase that replaces today's `branch` phase (4.2).

        `worktrees.enabled: false` keeps the pre-worktree behaviour: a branch
        cut in the main checkout, repo_root left pointing at main_root.

        Also arms the main-checkout tripwire (5.5): the baseline snapshot is
        taken HERE, before any agent runs, not lazily on the first call to
        `permissions.enforce()`. Seeding it there would make the tripwire
        blind for the first agent phase of every writing ADW (the "before"
        snapshot would be taken only AFTER that phase had already run) and
        completely inert for a single-agent-phase ADW like `adw_build` or
        `adw_document`, where that first call is also the only call.
        """
        wcfg = self.cfg.worktrees
        if not wcfg.enabled:
            existing = git_helper.find_run_branch(self.adw_id, tree=self.main_root)
            branch = git_helper.ensure_run_branch(self.adw_id, prompt, tree=self.main_root)
            rw = RunWorktree(branch=branch, path=str(self.main_root),
                             reused=existing is not None, base="")
        else:
            rw = worktrees.ensure_run_worktree(self.main_root, self.adw_id, prompt, wcfg)
        self.repo_root = Path(rw.path)
        self.worktree = rw
        self._main_checkout_snapshot = permissions.snapshot_main(self)
        self._log_branch_and_title(rw, prompt)
        return rw.model_dump()

    def _log_branch_and_title(self, rw: RunWorktree, prompt: str) -> None:
        """Trace-recording gap fix: the pre-worktree `branch` PHASE used to
        `ph.log(branch=...)`, which stamped a `type=log, name=branch` event —
        the morning-brief collector queries exactly that shape (`fetch_branch_event()`
        in its `collect_runs.py`). Once branching moved inside the "worktree" phase,
        `ph.log()` alone stamps `name="worktree"` instead (it always uses the
        ENCLOSING phase's own name), so that query silently stopped matching
        anything — the branch column read null forever, not because no branch
        was cut, but because nothing was looking in the right place any more.

        Written directly against the tracer, under the name every reader
        already expects, regardless of which phase is open when
        `enter_worktree` runs. The run's human title rides in the same
        payload (MAP.md's worktree-naming ticket, "extend the same payload")
        — one place a title is born, every other surface reads it back.
        """
        phase_id = self.phases[-1].phase_id if self.phases else ""
        self.tracer.event(EventRecord(
            adw_id=self.adw_id, phase_id=phase_id, type="log", name="branch",
            payload={"branch": rw.branch, "path": rw.path,
                     "title": git_helper.derive_title(prompt)}))

    # ── agent map (adw_id -> per-agent coding-agent session ids) ────────────
    def save_agent_map(self, agent: str, entry: dict) -> None:
        self.agent_map[agent] = entry
        self._agent_map_path.write_text(json.dumps(self.agent_map, indent=2), encoding="utf-8")

    # ── usage (run totals mirror what the tracer accumulates in sqlite) ─────
    def add_usage(self, tokens: int, cost: float) -> None:
        self.tokens += tokens
        self.cost += cost
        self.tracer.session_add_usage(self.adw_id, tokens, cost)

    # ── the phase primitive ─────────────────────────────────────────────────
    @contextmanager
    def phase(self, params: PhaseParams):
        self._seq += 1
        phase = Phase(phase_id=f"{self.adw_id}_{self._seq:02d}_{params.name}",
                      adw_id=self.adw_id, seq=self._seq, params=params,
                      status="running", started_at=now_iso())
        self.phases.append(phase)
        self.tracer.phase_upsert(phase)
        self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                      type="phase_start", name=params.name,
                                      payload={"kind": params.kind, "owner": params.owner,
                                               "description": params.description}))
        self.console.phase_started(phase)
        clock = time.monotonic()
        try:
            yield PhaseHandle(self, phase)
        except BaseException as error:
            phase.status = "fail"                      # success must be earned
            phase.error = str(error)[:1000]
            phase.ended_at = now_iso()
            self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                          type="error", name=params.name,
                                          payload={"error": phase.error}))
            self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                          type="phase_end", name=params.name,
                                          payload={"status": "fail"}))
            self.tracer.phase_upsert(phase)
            self.tracer.session_finish(self.adw_id, ok=False)
            self.console.phase_ended(phase, time.monotonic() - clock)
            self.console.session_finished(False, self.tokens, self.cost,
                                          self.cfg.observability.db)
            raise
        else:
            phase.status = "success"
            phase.ended_at = now_iso()
            self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                          type="phase_end", name=params.name,
                                          payload={"status": "success"}))
            self.tracer.phase_upsert(phase)
            self.console.phase_ended(phase, time.monotonic() - clock)

    # ── run outcome ─────────────────────────────────────────────────────────
    def finish(self, accepted: bool = True, reason: str = "") -> int:
        """Finalize the run and return its exit code. Call this exactly once.

        Two criteria, not one. Every phase must have passed, AND the ADW's own
        acceptance test must hold. They are different questions on purpose: a
        test phase that ran the suite did its job even when the suite came back
        red, so the PHASE succeeds while the RUN must not.

        This replaces a `succeeded` property that answered only the first
        question — and, being a property with side effects, wrote the session
        status and printed the banner before the caller's `and test.passed` was
        ever evaluated. A run whose suite never passed was recorded green in the
        db, on the terminal, and in the UI while exiting 1. Anyone reading the
        trace saw success; only a CI job checking `$?` saw the truth. One call
        now settles the db, the banner, and the exit code together, so the three
        cannot disagree.
        """
        phases_ok = bool(self.phases) and all(p.status == "success" for p in self.phases)
        ok = phases_ok and accepted
        if phases_ok and not accepted:
            note = reason or "the run's acceptance criterion was not met"
            self.tracer.event(EventRecord(
                adw_id=self.adw_id,
                phase_id=self.phases[-1].phase_id if self.phases else "",
                type="error", name="not_accepted", payload={"reason": note}))
            self.console.note(f"not accepted: {note}")
        self.tracer.session_finish(self.adw_id, ok=ok)
        self.console.session_finished(ok, self.tokens, self.cost, self.cfg.observability.db)
        self._push_run_branch()
        return 0 if ok else 1

    def _push_run_branch(self) -> None:
        """The branch return (MAP.md two-box model): push this run's own
        branch to origin here, at the one place every writing ADW's `main()`
        calls exactly once — success or failure of the run itself, as long
        as the branch actually holds commits (11: a run that leaves
        artifacts must be visible; silence is the bug). The four read-only
        ADWs never cut a branch (`self.worktree` stays None their whole
        life), so this is a no-op for them.

        Never raises: an unexpected error here (bad remote config, a git
        version quirk) must never take down an otherwise-finished run — the
        same guarantee `worktrees.push_run_branch` already gives for the
        ordinary push-failure case, extended to cover the freak one too.
        """
        if self.worktree is None:
            return
        branch = self.worktree.branch
        try:
            status, detail = worktrees.push_run_branch(
                self.main_root, branch, self.cfg.worktrees.trunk)
        except (RuntimeError, OSError) as error:   # never crash a finished run over this
            status, detail = "failed", str(error)

        if status == "pushed":
            self.console.note(f"pushed {branch} to origin")
        elif status == "no-remote":
            print(f"push skipped: no 'origin' remote configured - {branch} stays local")
        elif status == "failed":
            phase_id = self.phases[-1].phase_id if self.phases else ""
            self.tracer.event(EventRecord(
                adw_id=self.adw_id, phase_id=phase_id, type="error", name="push_branch",
                payload={"branch": branch, "error": detail}))
            print(f"PUSH FAILED: could not push {branch} to origin - {detail}")
        # "no-commits": nothing to make visible - silent, the common case for
        # a run that never got past its worktree phase.
