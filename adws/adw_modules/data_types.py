"""Concrete data types for the SSSF ADW system.

RULE (four-param rule): any function that takes more than 4 parameters takes
ONE of these objects instead. AgentCall and PhaseParams are the pattern.

Every agent call declares a concrete output type — an EnvelopeBase subclass —
that its final JSON response is parsed against. No untyped handoffs.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationInfo, field_validator

PhaseKind = Literal["engineer", "agent", "code"]
PhaseStatus = Literal["queued", "running", "success", "fail"]


# ── Phases ────────────────────────────────────────────────────────────────────

class PhaseParams(BaseModel):
    """Everything run.phase() needs. Passed as one object, never loose params."""

    name: str                       # short id, unique within the run: "plan", "build"
    kind: PhaseKind                 # which lane the block renders in
    owner: str                      # engineer's name, "git", or an agent name from config
    description: str                # REQUIRED: what this phase does and why — see below
    retries: int = 0                # agent phases: gate-failure retries via continue

    @field_validator("description")
    @classmethod
    def _description_must_be_earned(cls, value: str, info: ValidationInfo) -> str:
        """A phase name identifies; a description explains. Both are required.

        The description is the only sentence the trace, the console, and the
        phase block in the UI ever show about intent — everything else is ids,
        statuses, and timings. `commit_plan: "Commit the plan"` tells a reader
        nothing they could not already see, so an echo is rejected the same way
        a blank one is. This is a construction-time error on purpose: it fires
        before the phase opens, not after a run is already in the trace.
        """
        text = " ".join(value.split())
        name = str(info.data.get("name", "?"))
        if not text:
            raise ValueError(
                f"phase {name!r}: description is required - one sentence on what this "
                f"phase does and why. It is what the trace and the UI show.")
        if text.rstrip(".").casefold() == name.replace("_", " ").casefold():
            raise ValueError(
                f"phase {name!r}: description {text!r} only restates the phase name - "
                f"say what it does and why instead.")
        return text


class Phase(BaseModel):
    """The persisted phase record — PhaseParams plus lifecycle."""

    phase_id: str
    adw_id: str
    seq: int
    params: PhaseParams
    status: PhaseStatus = "fail"    # success must be earned
    attempt: int = 0
    error: str | None = None
    started_at: str | None = None
    ended_at: str | None = None


# ── Envelopes (agent output types) ───────────────────────────────────────────

class EnvelopeBase(BaseModel):
    """Base of every agent's final JSON response. Output types extend this."""

    status: Literal["success", "fail"]
    summary: str = ""
    artifacts: list[str] = Field(default_factory=list)
    notes_for_next_agent: str = ""


class GenericOutput(EnvelopeBase):
    pass


class PlanOutput(EnvelopeBase):
    # Subject for committing the PLAN — the spec file the planner wrote, not the
    # implementation it describes. Each agent's commit_message covers its own
    # work product, so a chain that commits per step never reuses one agent's
    # words for another agent's diff.
    commit_message: str = ""


class BuildOutput(EnvelopeBase):
    changed_files: list[str] = Field(default_factory=list)
    commit_message: str = ""        # consumed by the git commit phase


class ScoutFinding(BaseModel):
    file: str
    note: str = ""


class ScoutOutput(EnvelopeBase):
    findings: list[ScoutFinding] = Field(default_factory=list)


class ReviewFinding(BaseModel):
    """One thing the request (or plan) asked for, and whether it is there."""

    requirement: str                # the ask, in the requester's words
    met: bool
    evidence: str = ""              # where it lives, or what is missing


class ReviewOutput(EnvelopeBase):
    """Confirmation that what was built is what was asked for — not a test run."""

    approved: bool = False
    findings: list[ReviewFinding] = Field(default_factory=list)
    blocking: list[str] = Field(default_factory=list)   # what must change before approval


class DocumentOutput(EnvelopeBase):
    """Where the write-up of a completed change landed."""

    document_path: str = ""         # the doc in the repo, e.g. app_docs/<adw_id>_<slug>.md
    documented_files: list[str] = Field(default_factory=list)
    commit_message: str = ""


# ── Deterministic quality blocks ─────────────────────────────────────────────

QualityArea = Literal["frontend", "backend", "repo"]
QualityOperation = Literal["lint", "typecheck", "build", "test", "scan"]

# A quality check has THREE possible outcomes, not two. "pass" and "fail" both
# mean the tool ran to completion and reported a real verdict about the code.
# "incomplete" means the tool never ran at all — a missing binary, a uv
# provisioning failure, a timeout — so it has said NOTHING about the code
# either way. Collapsing that into a bool forces a choice between two lies:
# `passed=True` reads as a verified pass it never earned ("must never read
# green"), and `passed=False` reads as a code defect the builder gets sent to
# fix and cannot, because the defect is a missing toolchain on the machine
# running the check, not a line of code (see quality.ai_defects / skylos on
# Windows). `status` is the source of truth; `passed` is kept as a derived
# convenience (`status == "pass"`) so nothing that only reads passed silently
# starts lying either.
QualityStatus = Literal["pass", "fail", "incomplete"]


class QualityCheckSpec(BaseModel):
    """One deterministic quality command."""

    name: str
    area: QualityArea
    operation: QualityOperation
    argv: list[str]
    timeout_seconds: int = 120


class QualityCheckResult(BaseModel):
    """Captured evidence from one quality command."""

    name: str
    area: QualityArea
    operation: QualityOperation
    command: str
    returncode: int
    status: QualityStatus
    passed: bool             # == (status == "pass"); see QualityStatus
    duration_seconds: float
    output_artifact: str
    # The tail of stdout+stderr, verbatim and unparsed. A failure has to travel
    # back to the builder as an envelope, and the builder cannot open a log file
    # it was never handed — so the evidence rides along. Deliberately raw: every
    # runner formats failures differently and a generic parser would be
    # confidently wrong. The full log is always at output_artifact.
    output_tail: str = ""


class QualityResult(BaseModel):
    """Aggregate result from a quality block: every check it ran, and the verdict.

    `passed` is strict: True only when every check's status is "pass" — an
    incomplete check (a tool that could not run, e.g. skylos with no MSVC on
    Windows) keeps this False exactly like a real failure would, so nothing
    downstream (commit gating, `run.finish`) can read a run as verified when a
    check never actually ran. `failures` and `incomplete` are then split by
    WHO can act on them: `failures` is genuine code defects, meant to become
    the builder's repair spec; `incomplete` is tool-unavailable notes, meant to
    be recorded and surfaced to a human, never handed to an agent as something
    to fix — see quality.run_quality and quality.as_envelope.
    """

    passed: bool
    checks: list[QualityCheckResult] = Field(default_factory=list)
    failures: list[str] = Field(default_factory=list)
    incomplete: list[str] = Field(default_factory=list)
    artifacts: list[str] = Field(default_factory=list)


# ── Change capture (git diff, deterministic) ─────────────────────────────────

class ChangeCapture(BaseModel):
    """Everything documentation.capture() needs. One object, never loose params."""

    base: str = "main"              # the ref the work is measured against
    max_diff_lines: int = 2000      # the diff artifact is truncated past this
    include_untracked: bool = True  # a brand-new file is part of the change


class BaseRef(BaseModel):
    """The commit a change is measured from, and why that one.

    `reason` is the line the trace shows. A diff is only as trustworthy as the
    thing it was taken against, so the ADW records that choice instead of
    leaving the reader to infer it.
    """

    ref: str                        # what was asked for: "main", or a pinned sha
    commit: str                     # the commit actually diffed against
    reason: str = ""

    @property
    def label(self) -> str:
        """Display form — a named ref as itself, a pinned raw sha shortened."""
        if len(self.ref) == 40 and all(c in "0123456789abcdef" for c in self.ref):
            return self.ref[:7]
        return self.ref


class ChangeSet(BaseModel):
    """What changed since the base commit — pure git facts, no judgement."""

    base: BaseRef
    files: list[str] = Field(default_factory=list)
    untracked: list[str] = Field(default_factory=list)
    insertions: int = 0
    deletions: int = 0
    stat: str = ""                  # `git diff --stat` output, verbatim
    diff_path: str = ""             # the full diff, written into context_handoff/
    truncated: bool = False

    @property
    def empty(self) -> bool:
        return not (self.files or self.untracked)


class ChangesOutput(EnvelopeBase):
    """A ChangeSet shaped as an envelope so an agent can be handed it directly.

    Same adapter idea as VerifyOutput: code computes the diff, the documenter
    consumes it through the one door every agent handoff uses.
    """

    base: str = ""                  # "<ref> @ <commit> — <reason>"
    changed_files: list[str] = Field(default_factory=list)
    insertions: int = 0
    deletions: int = 0
    stat: str = ""
    diff_path: str = ""             # read this for the full diff


class VerifyOutput(EnvelopeBase):
    """A deterministic result, shaped as an envelope so an agent can consume it.

    Agents hand each other typed envelopes; code blocks return QualityResult.
    This is the adapter, so a failing lint or test run flows back into the
    builder through exactly the same door a tester agent's report used to —
    the ADW script is the only thing that knows the difference.
    """

    passed: bool = False
    failures: list[str] = Field(default_factory=list)


# ── Agent calls ──────────────────────────────────────────────────────────────

class GateCheck(BaseModel):
    """One thing a gate looked at, and what it found.

    `note` is the evidence — "exists, 2.1KB", "exit 0", "not in the diff". On a
    failed check it doubles as the reason, so it is what the agent is told.
    """

    item: str                       # what was checked: a path, a command, a test
    ok: bool
    note: str = ""


class GateReport(BaseModel):
    """What every gate returns: the checks it ran. Violations are derived.

    Authoring stays a one-liner per item — `report.check(...)` appends and
    returns self, so a gate is a loop and a return.
    """

    checks: list[GateCheck] = Field(default_factory=list)

    def check(self, item: str, ok: bool, note: str = "") -> GateReport:
        self.checks.append(GateCheck(item=item, ok=ok, note=note))
        return self

    @property
    def violations(self) -> list[str]:
        return [f"{c.item}: {c.note or 'failed'}" for c in self.checks if not c.ok]

    @property
    def passed(self) -> bool:
        return not self.violations


class AgentCall(BaseModel):
    """One agent invocation: prompt in, typed envelope out, gates verified."""

    model_config = {"arbitrary_types_allowed": True}

    output_type: type[EnvelopeBase]
    prompt: str
    previous: EnvelopeBase | None = None
    gates: list[Callable] = Field(default_factory=list)   # gate(envelope, run) -> list[str]


# ── Config ───────────────────────────────────────────────────────────────────

class PromptEngineering(BaseModel):
    system: str                     # path to system.md
    user: str                       # path to user.md


class AgentConfig(BaseModel):
    name: str
    coding_agent: Literal["pi", "claude_code"] = "pi"
    model: str = "google/gemini-3.6-flash"
    thinking: str = "medium"        # off | minimal | low | medium | high | xhigh | max
    color: str = ""                 # hex swatch for this agent's lane in the UI
    purpose: str = ""
    prompt_engineering: PromptEngineering
    # pi extensions loaded into the harness (-e). Raw YAML on this field is
    # per-agent only; `agents.load_config` MERGES it with
    # `defaults.harness_engineering` (union, order-stable, no duplicates)
    # before this model is constructed — see ConfigDefaults.harness_engineering.
    harness_engineering: list[str] = Field(default_factory=list)
    tools: list[str] | None = None    # allowlist; None = all tools usable
    # What this agent may MODIFY in the repo, enforced in code after every call
    # (see adw_modules/permissions.py). `tools` cannot express this: `bash` runs
    # anything and `write` reaches any path, so an agent's capability list is a
    # statement of intent that nothing checks.
    #   None  -> unrestricted, except the roster-wide `protected_files` paths
    #   []    -> read-only: may modify nothing tracked
    #   [...] -> only these. A trailing "/" means a directory prefix; a "*"
    #            makes it a glob; anything else is an exact path.
    writes: list[str] | None = None


class ConfigDefaults(BaseModel):
    coding_agent: Literal["pi", "claude_code"] = "pi"
    model: str = "google/gemini-3.6-flash"
    thinking: str = "medium"
    color: str = ""
    # Roster-wide pi extensions. MERGES into every agent's own
    # harness_engineering (union, order-stable, no duplicates) — it does NOT
    # replace it. Composed in `agents.load_config` (merge_unique), before any
    # AgentConfig is constructed, so this field and AgentConfig.harness_engineering
    # never need to be reconciled again downstream. Getting this wrong (a plain
    # setdefault/replace) is the exact landmine MAP rule 3 calls out: wiring an
    # extension in here for one lane (e.g. pi-claude-bridge for a reviewer)
    # would silently vanish for any agent that already names its own list
    # (e.g. planner's subagents.ts) instead of gaining this one too.
    harness_engineering: list[str] = Field(default_factory=list)
    tools: list[str] | None = None    # roster-wide allowlist; None = all tools usable
    # Off-limits to every agent that has not named them in its own `writes`.
    # The factory's own code is the default: an agent must not be able to edit
    # the machinery that decides whether its work passed.
    protected_files: list[str] = Field(default_factory=lambda: [
        "adws/adw_modules/", "adws/adw_sssf_config/", "adws/adw_*.py",
    ])
    data_dir: str = "adws/adw_data"


class ObservabilityConfig(BaseModel):
    db: str = "adws/adw_data/sssf.db"
    poll_ms: int = 500


class WorktreesConfig(BaseModel):
    """`worktrees:` config block (spec 3.3). Config only — no environment
    variable, no auto-discovery (MAP rule 12); `SSSF_CONFIG=other.yaml`
    already swaps the whole file for one run.

    `enabled=False` exists for one reason: a box that cannot support
    worktrees (or a debugging session) must still be able to run the
    factory — pre-worktree behaviour, a branch cut in the main checkout —
    and turning the layer off must be a written decision in a config file
    rather than an accident.
    """

    enabled: bool = True
    root: str = ""                    # "" = <parent of repo>/<repo-name>-worktrees
    # What runs fork from and are measured against. `integration`, never `main`
    # (MAP.md's integration-branch ruling, 2026-08-15): main is human-owned and
    # moves only by the operator's squash merge. Kept as a literal rather than
    # imported from `git_helper.FACTORY_TRUNK_DEFAULT` so this stays a pure data
    # module with no subprocess dependency - git_helper is still the one place
    # the name is DECIDED, and `$SSSF_INTEGRATION_BRANCH` still overrides both:
    # `agents._apply_trunk_env` writes an explicitly set value over this field
    # while the roster is being loaded, so every reader of a loaded config sees
    # the same working line the engine and the worktrees CLI resolved.
    trunk: str = "integration"
    stale_after_minutes: int = 30      # a 'running' session silent this long is stale (4.5)


class QualityConfig(BaseModel):
    """`quality:` config block — WHAT THE TWO GATES ACTUALLY RUN.

    THE DEFECT THIS EXISTS FOR. `adw_modules/quality.py` and
    `engine.quality_commands` both hardcoded three commands aimed at the
    FACTORY'S OWN scaffolding — `ruff check .`, `mypy adws`,
    `pytest -q adws/tests`. In the repo that is the factory that is correct and
    this block's defaults reproduce it byte for byte. In a repo the factory was
    STAMPED INTO it is a lie by omission: the project's own tests never ran at
    either gate (only `adws/tests/test_stamp.py` did), the project's own code
    was never typechecked, and a non-Python project got no deterministic
    verification at all while every card still read green. There was no way to
    say otherwise, because there was no configuration to say it in. Now there
    is, and it lives beside the roster the same run already reads.

    ONE STRING PER CHECK, split with `shlex` and expanded token by token, so a
    project says what it runs in the words it would type:

        quality:
          lint:      "{dev} ruff check ."
          typecheck: "{dev} mypy adws"
          test:      "{dev} pytest -q adws/tests"

    `{dev}` and `{scan}` expand to `uv run --project <tree> --group dev|scan` —
    the pinned-toolchain prefix, resolved against the TREE BEING JUDGED (a
    worktree during a run, the rebased tree at the merge gate), which is why it
    is a placeholder and not something a config file could write out. Any
    command that does not need them simply does not use them:

        quality:
          lint:      "npm run lint"
          typecheck: "npx tsc --noEmit"
          test:      "npm test"

    An EMPTY string disables that check — a written decision, visible in the
    roster, rather than a gate that silently passes. `quality_commands` skips
    it and `run_quality` records nothing for it.
    """

    lint: str = "{dev} ruff check ."
    typecheck: str = "{dev} mypy adws"
    test: str = "{dev} pytest -q adws/tests"
    # The AI-defect scan keeps its own shape: it is diff-scoped at run time
    # (`--diff <merge-base>`), fail-closed-incomplete where its toolchain will
    # not provision, and is deliberately NOT part of the merge gate. Named here
    # so a project can point it somewhere else or turn it off, same rules.
    scan: str = "{scan} skylos . --ai-defects --format concise"


class SSSFConfig(BaseModel):
    defaults: ConfigDefaults = Field(default_factory=ConfigDefaults)
    observability: ObservabilityConfig = Field(default_factory=ObservabilityConfig)
    worktrees: WorktreesConfig = Field(default_factory=WorktreesConfig)
    quality: QualityConfig = Field(default_factory=QualityConfig)
    agents: list[AgentConfig] = Field(default_factory=list)


# ── Worktrees ────────────────────────────────────────────────────────────────

class RunWorktree(BaseModel):
    """What `Run.enter_worktree()` resolves — branch, path, whether this call
    cut a fresh tree or rejoined one, and the base it was cut from (empty on
    rejoin, since nothing was cut)."""

    branch: str
    path: str
    reused: bool
    base: str = ""


WorktreeState = Literal["alive", "orphan", "unmerged", "merged", "no-tree"]


class WorktreeRow(BaseModel):
    """One reconciled row — the join of git worktree/branch state with the
    `sessions` table (8.2). `no-tree` is the fifth, informational,
    `--all`-only row type (8.3): a session that legitimately never cut
    anything (adw_scout, adw_prompt, adw_plan, adw_quality).
    """

    adw_id: str
    branch: str = ""
    path: str = ""
    title: str = ""                   # from the trace's branch event, else humanized slug
    state: WorktreeState = "no-tree"
    ahead: int = 0                    # commits on branch not in trunk — display only
    dirty: bool = False
    request: str = ""
    status: str = ""                  # sessions.status; "" when no session row (orphan)
    note: str = ""                    # HOLDS WORK / CANNOT NAME / staleness annotation


# ── Tracing ──────────────────────────────────────────────────────────────────

class EventRecord(BaseModel):
    """One traced event, always logged against adw_id + phase."""

    adw_id: str
    phase_id: str = ""
    type: str                       # phase_start | agent_start | tool_call | handoff | gate_pass | gate_fail | log | agent_end | phase_end | error
    name: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)
    parent_id: str = ""
    tokens: int | None = None
    # Spans: set both when an event covers real elapsed time (a tool call), so
    # the UI lays it out on a time axis without parsing payload JSON. Left unset,
    # the tracer stamps started_at with the moment the event was recorded.
    started_at: str | None = None
    ended_at: str | None = None


# ── Pi coding agent interface ────────────────────────────────────────────────

class PiRequest(BaseModel):
    """Everything one non-interactive pi run needs."""

    prompt: str
    system_prompt: str
    model: str                      # registry pattern, resolved to provider + id
    thinking: str = "medium"
    session_id: str                 # pi --session-id: creates or continues
    session_dir: str
    raw_output_path: str            # JSONL stream lands here
    tools: list[str] | None = None
    extensions: list[str] = Field(default_factory=list)
    cwd: str = "."                  # set from run.repo_root — the codebase root agents work in


class UsageBreakdown(BaseModel):
    """Tokens and the dollars they cost, per component, summed over a call.

    Mirrors pi's `usage` shape one-for-one so the numbers reconcile with what
    pi itself reports: `input` EXCLUDES cache reads, which bill at their own
    (cheaper) rate — add them to learn the size of the prompt that was sent.
    """
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    # Thinking tokens. NOT a fifth component: measured across every session on
    # disk, reasoning is always <= output and the four components above always
    # sum to totalTokens, so reasoning is the thinking SHARE of output, billed
    # at the output rate. Report it nested under output, never added to it.
    reasoning_tokens: int = 0
    total_tokens: int = 0
    input_cost: float = 0.0
    output_cost: float = 0.0
    cache_read_cost: float = 0.0
    cache_write_cost: float = 0.0
    total_cost: float = 0.0

    def add_turn(self, usage: dict, total_tokens: int) -> None:
        """Fold in one pi `message_end` usage object.

        `total_tokens` is passed in rather than re-derived: the caller already
        computes it pi's way (totalTokens, else the sum of the parts).
        """
        cost = usage.get("cost") or {}
        self.input_tokens += usage.get("input") or 0
        self.output_tokens += usage.get("output") or 0
        self.cache_read_tokens += usage.get("cacheRead") or 0
        self.cache_write_tokens += usage.get("cacheWrite") or 0
        self.reasoning_tokens += usage.get("reasoning") or 0
        self.total_tokens += total_tokens
        self.input_cost += cost.get("input") or 0.0
        self.output_cost += cost.get("output") or 0.0
        self.cache_read_cost += cost.get("cacheRead") or 0.0
        self.cache_write_cost += cost.get("cacheWrite") or 0.0
        self.total_cost += cost.get("total") or 0.0

    def merge(self, other: UsageBreakdown) -> None:
        """Add another call's usage — a phase that retries spends more than once."""
        for field in self.model_fields:
            setattr(self, field, getattr(self, field) + getattr(other, field))


class PiResult(BaseModel):
    text: str = ""
    returncode: int = 0
    session_id: str = ""
    tokens: int = 0
    cost: float = 0.0
    usage: UsageBreakdown = Field(default_factory=UsageBreakdown)
    # Context occupancy after the LAST turn — not a sum. `tokens` bills every
    # turn; this is how full the window is right now, which is what the
    # visualizer's context bar measures against `context_window`.
    context_tokens: int = 0
    context_window: int = 0         # 0 when the registry declares no ceiling
