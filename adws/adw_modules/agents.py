"""Config loading/validation and agent execution.

Every ADW validates its agents before running (fail fast, nothing spawns
against a half-valid config). Every agent call parses against a concrete
output type; parse failures and gate violations re-prompt the SAME session
with a correction — context intact, bounded retries. Agent proposes, code
disposes.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import yaml

from . import agent_pi, git_helper, permissions, prompts
from .data_types import (
    AgentCall,
    AgentConfig,
    EnvelopeBase,
    EventRecord,
    GateCheck,
    GateReport,
    Phase,
    PiRequest,
    SSSFConfig,
    UsageBreakdown,
)
from .utils import new_id

JSON_FIX_ATTEMPTS = 2      # continue-with-correction attempts for malformed JSON


class GateFailure(RuntimeError):
    pass


# ── config ───────────────────────────────────────────────────────────────────

def load_config(path: str = "adws/adw_sssf_config/sssf.config.yaml") -> SSSFConfig:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    _apply_trunk_env(raw)
    defaults = raw.get("defaults", {}) or {}
    default_harness = expand_harness_paths(defaults.get("harness_engineering", []) or [])
    for agent in raw.get("agents", []) or []:
        for key in ("coding_agent", "model", "thinking", "color", "tools", "writes"):
            if key in defaults:
                agent.setdefault(key, defaults[key])
        # harness_engineering does NOT setdefault/replace like the keys above:
        # it MERGES. defaults.harness_engineering is roster-wide (e.g. a bridge
        # extension every claude-bridge lane needs); an agent's own list is its
        # extra, specific needs (e.g. planner's subagents.ts). A plain
        # setdefault/replace here is the landmine MAP rule 3 calls out - an
        # agent that already names its own list would silently never gain a
        # roster-wide extension added to defaults later.
        agent["harness_engineering"] = merge_unique(
            default_harness, expand_harness_paths(agent.get("harness_engineering", []) or []))
    return SSSFConfig(**raw)


def _apply_trunk_env(raw: dict) -> None:
    """`$SSSF_INTEGRATION_BRANCH` over `worktrees.trunk`, in place.

    THE ONE VARIABLE THAT NAMES THE FACTORY'S WORKING LINE (specs/engine.md 2:
    "the worktree and dispatch side read the same variable"). It did not reach
    this side. `engine.py`, `adws/worktrees.py`'s default and
    `quality.ai_defects` all resolve the trunk through
    `git_helper.factory_trunk()`, which is env-aware - while everything loaded
    from here read `worktrees.trunk` literally off the roster. Set the variable
    and the factory split down the middle: the engine merged into the branch it
    named, and `ensure_run_worktree` kept cutting runs from `integration` while
    `push_run_branch` kept measuring "ahead" against it. Inert at the defaults,
    and a quiet bifurcation the day the documented configuration was used.

    Applied to the RAW mapping before `SSSFConfig` validates it, so there is one
    answer for every reader of the loaded config and no second code path.

    Only an explicitly set, non-empty value overrides. `factory_trunk()` answers
    `"integration"` for both unset and empty, and using that answer here would
    quietly overwrite a roster that deliberately names some other line - the
    file has to keep the last word whenever the environment says nothing.
    """
    trunk = (os.environ.get(git_helper.FACTORY_TRUNK_ENV) or "").strip()
    if not trunk:
        return
    block = raw.get("worktrees")
    if not isinstance(block, dict):
        block = {}
        raw["worktrees"] = block
    block["trunk"] = trunk


def expand_harness_paths(entries: list[str]) -> list[str]:
    """$VAR / ${VAR} (os.path.expandvars also covers %VAR% on Windows), then
    ~, applied to every harness_engineering entry before it is ever used -
    so a per-host, outside-the-repo extension path (e.g. PI_BRIDGE_PATH; see
    sssf.shipping.config.yaml's own comment) never has to be a literal
    absolute path baked into a config file tracked in git, the way the two-box
    model's laptop/server split requires (MAP.md "Platform landmines": PI_PATH
    is re-derived per host the same way).

    An unresolved ${VAR} (the env var was never set - expandvars leaves the
    string verbatim, e.g. "${PI_BRIDGE_PATH}/src/index.ts") is NOT caught
    here: it is left exactly as written, a literal path that does not exist,
    and fails LOUD downstream at validate() time when
    agent_pi.resolve_model() cannot find a real pi extension there (the
    existing SystemExit behavior - see validate() below).
    """
    return [os.path.expanduser(os.path.expandvars(entry)) for entry in entries]


def merge_unique(base: list[str], extra: list[str]) -> list[str]:
    """Union of two lists, order-stable, no duplicates.

    Every `base` item first (in its own order), then any `extra` item not
    already present (in its own order). Used to compose
    `defaults.harness_engineering` with each agent's own list.
    """
    merged = list(base)
    for item in extra:
        if item not in merged:
            merged.append(item)
    return merged


def resolve(cfg: SSSFConfig, name: str) -> AgentConfig:
    for agent in cfg.agents:
        if agent.name == name:
            return agent
    raise SystemExit(f"agent {name!r} is not defined in the config - "
                     f"available: {[a.name for a in cfg.agents]}")


def validate(cfg: SSSFConfig, required: list[str]) -> None:
    """Fail fast: every required name must resolve to a usable agent."""
    problems = []
    for name in required:
        try:
            agent = resolve(cfg, name)
        except SystemExit as e:
            problems.append(str(e))
            continue
        if agent.coding_agent != "pi":
            problems.append(f"agent {name!r}: coding_agent {agent.coding_agent!r} "
                            f"is not implemented in v1 (pi only)")
        for label, ref in (("system", agent.prompt_engineering.system),
                           ("user", agent.prompt_engineering.user)):
            if not Path(ref).is_file():
                problems.append(f"agent {name!r}: {label} prompt not found: {ref}")
        try:
            # The catalog probe must carry the SAME extensions this agent
            # actually runs with (its merged harness_engineering, composed by
            # load_config's merge_unique above) - a claude-bridge/* model is
            # registered only once the bridge extension that names it loads,
            # so validating without -e makes every bridge lane structurally
            # unresolvable and SystemExits a config that is actually fine.
            agent_pi.resolve_model(agent.model, extensions=tuple(agent.harness_engineering))
        except ValueError as e:
            problems.append(f"agent {name!r}: {e}")
    if problems:
        raise SystemExit("config validation failed:\n- " + "\n- ".join(problems))


# ── execution ────────────────────────────────────────────────────────────────

def execute(run, phase: Phase, call: AgentCall) -> EnvelopeBase:
    """One agent call: render prompts -> pi run -> typed parse -> gates -> envelope."""
    agent = resolve(run.cfg, phase.params.owner)
    agent_dir = run.session_dir / agent.name
    agent_dir.mkdir(parents=True, exist_ok=True)

    variables = {
        "prompt": call.prompt,
        "previous_envelope": call.previous.model_dump_json(indent=2) if call.previous else "(none)",
        "context_handoff_dir": str(run.context_handoff_dir),
    }
    system_text = prompts.render(agent.prompt_engineering.system, variables)
    user_text = prompts.render(agent.prompt_engineering.user, variables)
    prompts.save(agent_dir / "prompts", "system.md", system_text)
    prompts.save(agent_dir / "prompts", "user.md", user_text)

    session_id = _agent_session_id(run, agent)
    run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                 type="agent_start", name=agent.name,
                                 payload={"model": agent.model, "thinking": agent.thinking,
                                          "color": agent.color,
                                          "session_id": session_id,
                                          "coding_agent": agent.coding_agent,
                                          "purpose": agent.purpose,
                                          "tools": agent.tools,  # None = all tools
                                          "harness_engineering": agent.harness_engineering}))
    run.console.agent_started(agent.name, agent.model, session_id)

    # Parse retries and gate corrections re-enter the SAME pi session, so the
    # last send is the one whose context occupancy is current — while spend is
    # the opposite: every send costs, so usage accumulates across all of them.
    latest: agent_pi.PiResult | None = None
    spent = UsageBreakdown()

    def send(prompt_text: str) -> agent_pi.PiResult:
        nonlocal latest
        request = PiRequest(
            prompt=prompt_text,
            system_prompt=system_text,
            model=agent.model,
            thinking=agent.thinking,
            session_id=session_id,
            # absolute: these are read by the pi subprocess, which runs in repo_root
            session_dir=str((agent_dir / "pi_sessions").resolve()),
            raw_output_path=str((agent_dir / "raw_output.jsonl").resolve()),
            tools=agent.tools,
            extensions=agent.harness_engineering,
            cwd=str(run.repo_root),
        )
        result = agent_pi.run(
            request,
            on_event=_event_forwarder(run, phase, agent.name),
            on_spawn=lambda pid: run.tracer.process_start(
                run.adw_id, "agent", agent.name, pid,
                f"{agent.coding_agent} {agent.name} {agent.model}"),
            on_exit=lambda pid: run.tracer.process_end(run.adw_id, pid))
        run.add_usage(result.tokens, result.cost)
        spent.merge(result.usage)
        latest = result
        return result

    # What the tree looked like before this agent got its hands on it. Every
    # send in this phase — first prompt, JSON retries, gate corrections — is
    # measured against this one baseline.
    #
    # The refs are recorded beside it, and they are the half that does not go
    # blind: `tree_before` is a diff against HEAD, so an agent that commits
    # moves its own work behind the baseline and the content comparison reports
    # nothing at all. `ref_before` catches exactly that (permissions.enforce_refs).
    tree_before = permissions.snapshot(run)
    ref_before = permissions.snapshot_refs(run)

    result = send(user_text)
    envelope, attempt = _parse_with_retries(run, phase, call, result, send)

    # claim gates — violations flow back into the SAME session as corrections
    for gate_attempt in range(1, max(1, phase.params.retries + 1) + 1):
        violations = []
        for gate in call.gates:
            report = _as_report(gate(envelope, run))
            found = report.violations
            run.tracer.gate_row(phase, gate.__name__, report, gate_attempt)
            run.tracer.event(EventRecord(
                adw_id=run.adw_id, phase_id=phase.phase_id,
                type="gate_fail" if found else "gate_pass", name=gate.__name__,
                payload={"attempt": gate_attempt, "violations": found,
                         "checks": [c.model_dump() for c in report.checks]}))
            run.console.gate_result(gate.__name__, report)
            violations.extend(found)
        if not violations:
            break
        if gate_attempt > phase.params.retries:
            raise GateFailure(f"{agent.name} failed gates after {gate_attempt} attempt(s):\n- "
                              + "\n- ".join(violations))
        phase.attempt = gate_attempt
        run.console.retry(agent.name, gate_attempt, phase.params.retries,
                          f"{len(violations)} gate violation(s)")
        correction = ("Your previous response failed validation:\n- "
                      + "\n- ".join(violations)
                      + "\n\nFix these problems, then re-emit ONLY your Report JSON.")
        result = send(correction)
        envelope, attempt = _parse_with_retries(run, phase, call, result, send)

    # Permission is checked after every send is done, and before the envelope is
    # accepted: an agent does not get to report success on a phase in which it
    # wrote somewhere it was not allowed to.
    #
    # Refs FIRST, then content. A commit made during the phase is what makes
    # the content comparison meaningless, so checking it second would mean
    # reporting "touched nothing" about a run that rewrote the repo.
    try:
        permissions.enforce_refs(run, agent, ref_before)
        touched = permissions.enforce(run, phase, agent, tree_before)
    except permissions.PermissionBreach as breach:
        run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                     type="error", name="permission_breach",
                                     payload={"agent": agent.name, "error": str(breach),
                                              "writes": agent.writes,
                                              "protected_files": run.cfg.defaults.protected_files}))
        raise
    if touched:
        run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                     type="log", name="paths_touched",
                                     payload={"agent": agent.name, "paths": touched}))

    _persist_envelope(run, phase, agent.name, call, envelope, attempt, valid=True)
    run.console.envelope_summary(envelope)
    context = latest or result
    run.tracer.agent_session_row(run.adw_id, agent, session_id,
                                 context_tokens=context.context_tokens,
                                 context_window=context.context_window)
    run.save_agent_map(agent.name, {"session_id": session_id, "model": agent.model,
                                    "coding_agent": agent.coding_agent})
    run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                 type="handoff", name=agent.name,
                                 payload={"artifacts": envelope.artifacts,
                                          "summary": envelope.summary}))
    run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                 type="agent_end", name=agent.name,
                                 # Phase totals, not the last send's: a retried
                                 # phase paid for every attempt.
                                 tokens=spent.total_tokens,
                                 payload={"cost": spent.total_cost,
                                          "usage": spent.model_dump(),
                                          "context_tokens": context.context_tokens,
                                          "context_window": context.context_window}))
    run.console.agent_finished(agent.name, spent.total_tokens, spent.total_cost)
    if envelope.status != "success":
        raise RuntimeError(f"{agent.name} reported status={envelope.status!r}: {envelope.summary}")
    return envelope


# ── internals ────────────────────────────────────────────────────────────────

def _as_report(result) -> GateReport:
    """Accept a GateReport, or a legacy gate that returned a violations list."""
    if isinstance(result, GateReport):
        return result
    return GateReport(checks=[GateCheck(item=str(v), ok=False) for v in (result or [])])


def _agent_session_id(run, agent: AgentConfig) -> str:
    entry = run.agent_map.get(agent.name)
    if entry and entry.get("model") == agent.model:
        return entry["session_id"]           # rejoin the existing context window
    return f"sssf-{run.adw_id}-{agent.name}-{new_id(4)}"


def _event_forwarder(run, phase: Phase, agent_name: str):
    """One tool_call event per real tool call, with its exact args and result."""
    tracker = agent_pi.ToolCallTracker()

    def forward(event: dict) -> None:
        record = tracker.observe(event)
        if record is None:
            return
        # The call's span rides the columns; duration_ms stays in the payload as
        # pi's own authoritative number.
        run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                     type="tool_call", name=record.pop("label"),
                                     started_at=record.pop("started_at", None),
                                     ended_at=record.pop("ended_at", None),
                                     payload={**record, "agent": agent_name}))
    return forward


def _extract_json(text: str) -> dict:
    candidate = text
    if "```" in text:
        for block in text.split("```")[1::2]:
            block = block.removeprefix("json").strip()
            if block.startswith("{"):
                candidate = block
                break
    start, end = candidate.find("{"), candidate.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object found in the response")
    return json.loads(candidate[start:end + 1])


def _parse_with_retries(run, phase: Phase, call: AgentCall, result, send):
    """Parse the final response against the declared output type; on failure,
    continue the SAME session with a correction (bounded)."""
    for attempt in range(1, JSON_FIX_ATTEMPTS + 2):
        try:
            payload = _extract_json(result.text)
            return call.output_type.model_validate(payload), attempt
        except Exception as error:
            _persist_envelope(run, phase, phase.params.owner, call, None, attempt,
                              valid=False, raw=result.text)
            if attempt > JSON_FIX_ATTEMPTS:
                raise RuntimeError(
                    f"{phase.params.owner} never produced valid "
                    f"{call.output_type.__name__} JSON: {error}") from error
            run.console.retry(phase.params.owner, attempt, JSON_FIX_ATTEMPTS,
                              f"invalid {call.output_type.__name__} JSON: {error}")
            fields = ", ".join(call.output_type.model_fields.keys())
            result = send(
                f"Your response was not valid JSON for the required structure "
                f"({error}). Respond again with ONLY a JSON object with these "
                f"fields: {fields}. No prose, no code fences.")


def _persist_envelope(run, phase: Phase, agent_name: str, call: AgentCall,
                      envelope: EnvelopeBase | None, attempt: int,
                      valid: bool, raw: str = "") -> None:
    payload_json = envelope.model_dump_json(indent=2) if envelope else json.dumps({"raw": raw[-2000:]})
    run.tracer.envelope_row(phase, agent_name, call.output_type.__name__,
                            payload_json, valid, attempt)
    if envelope:
        record = {"agent_name": agent_name, "purpose": resolve(run.cfg, agent_name).purpose,
                  "output_type": call.output_type.__name__, "attempt": attempt,
                  **envelope.model_dump()}
        (run.session_dir / agent_name / "envelope.json").write_text(
            json.dumps(record, indent=2), encoding="utf-8")
