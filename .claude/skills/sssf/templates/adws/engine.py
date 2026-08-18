#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""engine - the always-on worker that makes the Kanban actually run.

Usage:
    uv run adws/engine.py                          # the service: loop until stopped
    uv run adws/engine.py --once                   # exactly one cycle, then exit
    uv run adws/engine.py --interval 30 --cap 4
    uv run adws/engine.py --lanes "xai=2,opencode-go=1"
    uv run adws/engine.py --queue-dir /path/to/queue

`just engine` is the justfile wrapper; on the server systemd runs this same
command as `sdl-engine.service` (specs/engine.md 10).

The two-box model (MAP.md, ratified 2026-08-14): the laptop plans and
publishes cards, the server ships them, git is the only transport. This is the
piece that closes the unattended gap - the trigger the upstream project never
built (`docs/research/video-2-notes.md:726`). Without it a card sits on the
Board until a human types `just work`; with it, publishing IS the trigger.

THE INTEGRATION BRANCH (MAP.md, ratified 2026-08-15). The factory's working
line is `integration`, never `main`. Runs are cut from it, and the ENGINE
merges them back into it by itself once deterministic checks pass - rebase the
run's branch onto current integration, re-run the quality suite against the
rebased tree, then fast-forward. `main` is human-owned: one squash commit per
finished chunk, merged by hand in the UI. Nothing in this file ever checks out,
commits to, or pushes `main`.

One cycle (~60s), in order:

    0. Re-read the roster's scheduling blocks (`lanes:`, `router.builder_pool`)
       when its bytes changed - the app edits that file and git delivers it
       mid-service. Then: can git name a committer here? A checkout with no
       identity fails every `git commit` (fresh container, service user with no
       `~/.gitconfig`), so the cycle stops before it can grind on that once a
       minute forever. And can this box launch `pi` and resolve `uv` at all? If
       not, the cycle holds rather than turning every ready card into a blocked
       one - or, for uv, into a refused one nothing ever retries.
    1. Be on `integration`. Create it (from `main`, published with `push -u`)
       if this checkout has never seen it; plain checkout if it exists but is
       not current. Everything below writes to that branch and no other, so a
       cycle that cannot get onto it does nothing at all.
    2. Reap finished children. Each one's card was written back by dispatch
       itself (ready-for-agent -> running -> done|blocked); the engine commits
       that write-back (`factory: 003-slug.md -> done`), so the laptop's Board
       learns what happened without anyone asking.
    3. Adopt any card write-back still sitting uncommitted on disk - one this
       process has no child for (an engine restarted mid-run) or one whose
       commit failed earlier. Then push whatever is pending.
    4. `git pull --ff-only` in the main checkout - the laptop's new cards, its
       docs and everything else arrive this way and no other. When the hub and
       the server have each moved `integration` (the normal steady state of two
       boxes committing to one living line), the fast-forward is refused and
       this server's own card commits are replayed on top of the hub's history
       instead.
    5. INTEGRATE every card sitting at `Status: done` in `queue/` - READ OFF
       DISK, not remembered from a reap, so a run whose engine restarted (or
       whose `--once` invocation exited) before it could be merged is picked up
       by the next cycle instead of stranding forever. One at a time, in the
       loop thread: rebase a DETACHED COPY of the run's branch onto current
       integration in its own worktree, re-run the deterministic quality suite
       there, `merge --ff-only` that rebased commit into integration, push,
       then PARK the card in `queue/done/`, commit, push. Parking is what
       satisfies another card's `Needs:`, so waves roll on by themselves. A
       conflict or a red suite writes `Status: blocked` plus a
       `Blocked-reason:` line into the card and moves on. Deterministic only -
       there is never an agent at this gate (MAP.md's dead list: that is
       exactly what killed no-mistakes-the-tool).
    6. Scan `queue/*.md` for `ready-for-agent` cards whose `Needs:` are
       satisfied (`dispatch.needs_satisfied`), oldest NNN first.
    7. While live children < cap AND every lane the run draws on has a free
       slot, spawn `dispatch.py <card>` as a NON-blocking child, wait briefly
       for its ready->running claim to land, and commit + push that claim in
       the same cycle - a card the server is already building must never still
       look free on the laptop. When the roster carries a `router.builder_pool`,
       the builder's model is CHOSEN here first (the pool entry whose lane has
       the most free slots) and the run gets its own derived copy of the roster
       with that model in it.
    8. Sleep, and go again.

`--once` runs exactly one cycle and does NOT wait for the children it started:
a run takes minutes, a cycle takes seconds. That is honest rather than lossy
now, because step 5 reads the queue off disk - whatever a child finishes after
this process exits is integrated by the NEXT invocation of the engine, and the
last line `--once` prints says so.

Steps 2-3 run BEFORE the pull on purpose. They are the recovery: they clear
the local state - an uncommitted write-back, an unpushed commit - that a pull
would otherwise trip over. Behind the pull they could never run on the cycle
that needed them, and one failed push plus one laptop publish would wedge the
service until a human logged into the server. The integrate step runs AFTER
the pull for the opposite reason: "rebase onto current integration" is only
true if integration is current.

KISS (MAP rule 1): a command that loops, not a framework. One thread, so every
git operation in this file happens in the loop and nowhere else, sequentially -
which is also exactly what makes sibling run branches fast-forwardable one
after another instead of racing for the same tip.

What it deliberately does not do: it never re-dispatches a card. A card left
`Status: running` with no live child (a killed run, a previous engine stopped
mid-flight) is named once as stranded and then left alone - reconciliation
(`just worktrees`) owns that, and a silent re-dispatch would orphan a branch
and a worktree every time. It never prunes a worktree or deletes a branch
either (same owner), never force-pushes anything, and never touches `main`.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import dispatch
import yaml
from adw_modules import agent_pi, git_helper, worktrees
from adw_modules.data_types import QualityConfig
from adw_modules.quality import resolve_command
from adw_modules.utils import now_iso, operator_env, uv_bin, uv_cmd

# The hub (MAP.md's two-box model): one remote. Not configurable - a second
# remote would be a different architecture, not a flag.
REMOTE = "origin"

# The factory's working line, and the human's. `integration` is what the engine
# pulls, pushes, commits cards to and merges runs into; `main` only ever moves
# by the operator's own squash merge in the UI, and no code path here writes to
# it. `SSSF_INTEGRATION_BRANCH` is the ONE way to name a different working line
# (the same contract the worktree/dispatch side reads), so a systemd unit can
# select it with an `Environment=` line.
INTEGRATION_BRANCH = git_helper.FACTORY_TRUNK_DEFAULT
HUMAN_TRUNK = "main"

DEFAULT_INTERVAL = 60.0

# Total parallelism, and `$SSSF_CAP` is its knob on a server. The systemd unit
# both converge paths render is byte-compared by the installer
# (`installer/steps.py`'s `detect_engine_service`) and overwritten by the deploy
# script, so a hand-edited `ExecStart=... --cap 4` is parked on the next
# converge - which left the always-on server pinned at this number with no
# supported way to change it, whatever lanes or pool the operator configured.
# The environment is the way in, exactly as it already is for the roster
# (`SSSF_CONFIG`) and the lanes (`SSSF_LANES`): the checkout's `.env` reaches
# this process through `adw_modules.utils`'s `load_dotenv()` at import - the
# same channel the ADWs get their provider keys on - and a `Environment=` line
# in a systemd drop-in (`sdl-engine.service.d/*.conf`, which neither writer
# touches) is the other. `--cap` on the command line still beats both.
DEFAULT_CAP = 2

# Slots per lane when nothing overrides it (operator-ratified 2026-08-15).
# Deliberately conservative: a slot counts a RUN, and a run fans out inner
# pi-subagents that draw on the same lane as their parent, so two runs on one
# provider account is already more than two concurrent calls against that
# quota pool.
DEFAULT_LANE_SLOTS = 2

# The one agent the router pool belongs to. The builder is the concurrency-
# critical agent - it is the longest-running one and the one that actually runs
# in parallel across runs (operator's roster ruling, 2026-08-15) - so it is the
# one whose model is chosen per run. Every other agent runs on whatever the
# roster says, once, and the engine never rewrites it.
BUILDER_AGENT = "builder"

# The roster every dispatch this engine starts will use. `SSSF_CONFIG` is the
# factory's ONE way of naming a different one (the justfile reads the same
# variable, `config := env_var_or_default("SSSF_CONFIG", ...)`), which is what
# lets the systemd unit choose a roster with an `Environment=` line instead of
# a hand-edited ExecStart the next converge would park. The fallback is the
# test lane, exactly as `just` behaves - the engine logs which one it got, so
# the journal always names the roster the server is actually shipping on.
DEFAULT_CONFIG = "adws/adw_sssf_config/sssf.config.yaml"

# How long a cycle waits for dispatch's ready->running write-back before giving
# up and recording it on a later cycle. It is a claim landing on disk in
# another process, not real work - a second is generous, ten is paranoid.
CLAIM_TIMEOUT = 10.0
CLAIM_POLL = 0.1

# How many of its own CARD commits a replay may drop before the engine gives up
# and leaves the checkout alone (see `pull`; a commit that is not a card
# write-back is never dropped at all). A bound, not a policy: one stop per
# conflicting commit, and the engine has at most three commits per card in
# flight (-> running, -> done, integrated).
MAX_REPLAY_SKIPS = 20

# Per-command ceiling for the integration gate's suite. Generous - it re-runs
# the whole test block - but bounded, because a hung check would otherwise stop
# the loop forever, and the loop is single-threaded on purpose.
GATE_TIMEOUT = 900.0

# The committer the factory writes card status commits as when the host has no
# identity of its own. Named here only to be QUOTED in the refusal below -
# nothing in this file ever writes git config. The installer's engine-service
# step sets exactly this pair, repo-locally, when it converges a server
# (`installer/steps.py`'s ENGINE_GIT_NAME / ENGINE_GIT_EMAIL - the same two
# strings, kept in both because the installer is stdlib-only and imports
# nothing from `adws/`).
COMMITTER_NAME = "sdl-factory engine"
COMMITTER_EMAIL = "engine@sdl-factory.local"


def log(message: str) -> None:
    """One line per event, on stdout, flushed - the engine's whole UI.

    Under systemd this IS the journal (`journalctl -u sdl-engine -f`), which
    is why every line is timestamped here rather than trusting the reader's
    console. Scrubbed to ASCII on the way out: this process is headless by
    definition, and a single non-ASCII glyph reaching a cp1252 stdout takes
    the whole service down (MAP.md's platform landmine). Losing an accent in a
    log line is the cheaper failure by a mile.
    """
    line = f"{now_iso()} engine: {message}"
    print(line.encode("ascii", "replace").decode("ascii"), flush=True)


def _one_line(text: str, limit: int = 200) -> str:
    """git's own words, flattened to one line and truncated - a failure the
    engine survives is worth exactly one line, never a wall of stderr."""
    flat = " ".join(text.split())
    return flat[:limit] if flat else "no output"


def _tail(text: str, limit: int = 240) -> str:
    """The same, kept from the END. A test runner's verdict ("3 failed, 41
    passed") is the last thing it says, so truncating from the front would
    throw away the only part worth reading."""
    flat = " ".join(text.split())
    return flat[-limit:] if flat else "no output"


def integration_branch() -> str:
    """The factory's working line: `$SSSF_INTEGRATION_BRANCH`, else
    `integration`. Read at startup, never per cycle - a branch that changed
    under a running service would be a different factory.

    Delegates to `git_helper.factory_trunk()` rather than reading the variable
    itself: the worktree layer cuts run branches from whatever that answers,
    so a second reading here is a way for the loop and the branches it merges
    to end up on two different lines.
    """
    return git_helper.factory_trunk()


@dataclass
class Child:
    """One live `dispatch.py` process, the card it is running, and the lanes
    its roster draws on (one slot of each is occupied for as long as it runs).

    `derived_config` is this run's own copy of the roster - written by the
    router with the builder's chosen model in it, deleted when the child is
    reaped BY A RUNNING ENGINE. An invocation that exits with this child still
    live (`--once`, Ctrl-C, a service stop) leaves the file behind and names it
    in the log: the dispatch is still reading it, so deleting it on the way out
    would break the run. None means the run was dispatched on the operator's
    roster exactly as it stands, which is every run on a roster with no
    `router.builder_pool`.
    """
    card: Path
    process: subprocess.Popen
    started: float          # time.monotonic() at spawn
    lanes: tuple[str, ...] = ()
    derived_config: Path | None = None


@dataclass
class Plan:
    """What ONE card is about to be dispatched with: the roster path to pass as
    `--config`, the lanes that roster draws on (the slots this run will occupy),
    and the derived copy to delete when it is reaped (None = the operator's own
    roster, nothing to clean up)."""
    config: str
    lanes: tuple[str, ...] = ()
    derived: Path | None = None


@dataclass
class Engine:
    """The loop's whole state. Plain data - every behavior below is a function
    that takes one of these, so a test can drive a single cycle and look."""
    main_root: Path
    queue_dir: Path
    config: str
    cap: int = DEFAULT_CAP
    # The factory's working line. Everything this file pulls, commits, pushes
    # and merges into is this branch; `main` is never any of those.
    trunk: str = INTEGRATION_BRANCH
    children: list[Child] = field(default_factory=list)
    # A commit was made but its push has not landed yet - retried every cycle
    # until it does. Losing the network never loses the record.
    pending_push: bool = False
    # (There is deliberately no in-memory list of runs waiting to be
    # integrated. `integrate_candidates` reads `Status: done` off the queue on
    # disk every cycle instead - the only record that survives a restart, an
    # `--once` invocation, or a crash between a run finishing and its merge.)
    # Cards whose dispatch RAN, read the card, and came back refusing to run it
    # (bad `Adw:`, a config that will not load, an already-claimed card).
    # Retrying those on a 60s loop is pure noise, so each is named once and then
    # skipped. A verdict about the CARD, and only ever written by `reap` - a
    # dispatch that never STARTED (an unresolvable `uv`, a box out of pids) is a
    # verdict about the box and leaves the card untouched, so a repaired box
    # picks it straight back up. See `spawn`.
    refused: set[str] = field(default_factory=set)
    # key -> the last line announced for it, so "waiting on X" is logged when
    # it becomes true and when it changes, not 1440 times a day. Keys are
    # namespaced (`needs:<card>`, `lane:<card>`, `trunk`).
    waiting: dict[str, str] = field(default_factory=dict)
    # `--lanes` / $SSSF_LANES, per-lane slot overrides; the resolved map every
    # lane the roster uses -> its slot count; and whether the roster has ever
    # resolved (the first cycle's read, or any later one after an edit).
    lane_overrides: dict[str, int] = field(default_factory=dict)
    lane_slots: dict[str, int] = field(default_factory=dict)
    lanes: tuple[str, ...] = ()
    lanes_resolved: bool = False
    # The exact bytes of the roster the lane/pool state above was resolved
    # from. `resolve_lanes` runs EVERY cycle and compares against this, so an
    # edit the app pushed (or the operator made on the box) takes effect on the
    # next turn - and an unchanged file costs one small read and no log line.
    roster_seen: str | None = None
    # The roster's `router.builder_pool`, in the operator's own order, already
    # validated - empty means no routing at all and the engine behaves exactly
    # as it did before the router existed.
    builder_pool: tuple[str, ...] = ()
    opened: bool = False    # first-cycle-only work (roster + stranded scan) has run


def _say_once(engine: Engine, key: str, message: str) -> None:
    """Log `message` when it is new for `key`, and stay quiet while it holds.
    A hold that lasts an hour is one line, not sixty."""
    if engine.waiting.get(key) != message:
        engine.waiting[key] = message
        log(message)


# ── reading the board ────────────────────────────────────────────────────────

def cards(engine: Engine) -> list[Path]:
    """Every queue card, oldest NNN first. Non-recursive, exactly like the
    Board's own reader and `dispatch.pick_next`: `queue/done/` is a directory
    and never a candidate."""
    if not engine.queue_dir.is_dir():
        return []
    return sorted(p for p in engine.queue_dir.iterdir()
                  if p.is_file() and p.suffix.lower() == ".md" and p.name != "TEMPLATE.md")


def card_field(path: Path, key: str) -> str:
    """One header field of one card, or "" if the card cannot be read at all -
    a malformed card is the Board's "Unparsed" bucket, never the engine's
    business."""
    try:
        return dispatch.parse_header(path.read_text(encoding="utf-8")).fields.get(key, "")
    except (dispatch.DispatchError, OSError):
        return ""


def card_status(path: Path) -> str | None:
    """One card's `Status:`, or None if it cannot be read at all."""
    try:
        return dispatch.parse_header(path.read_text(encoding="utf-8")).fields.get("status")
    except (dispatch.DispatchError, OSError):
        return None


def _announce_wait(engine: Engine, name: str, unmet: list[str]) -> None:
    _say_once(engine, f"needs:{name}",
              f"holding {name}: needs not satisfied - waiting on: {', '.join(unmet)} "
              f"(a need is met when its card is integrated and parked in queue/done/)")


def ready_cards(engine: Engine) -> list[Path]:
    """The dispatchable cards, oldest NNN first: `Status: ready-for-agent`,
    `Needs:` all satisfied, not already held by a live child, not previously
    refused.

    The live-child check matters even though dispatch writes `running` itself:
    between spawn and that write-back the card still reads `ready-for-agent`
    on disk, and a cycle that looked in exactly that window would dispatch it
    twice.
    """
    live = {child.card.name for child in engine.children}
    out: list[Path] = []
    for path in cards(engine):
        if path.name in engine.refused or path.name in live:
            continue
        if card_status(path) != dispatch.READY:
            continue
        ok, unmet = dispatch.needs_satisfied(path, engine.main_root)
        if not ok:
            _announce_wait(engine, path.name, unmet)
            continue
        engine.waiting.pop(f"needs:{path.name}", None)
        out.append(path)
    return out


def integrate_candidates(engine: Engine) -> list[Path]:
    """Every card the factory still owes an integration, oldest NNN first:
    `Status: done`, still in `queue/`, not held by a live child.

    READ OFF DISK, every cycle, and remembered nowhere. That is the whole
    point: a card at `done` sitting in `queue/` with a mergeable branch is work
    that finished and was never merged, no matter WHICH process dispatched it.
    An engine that was restarted between a run's terminal write-back and its
    merge (systemd's `Restart=always`, a converge re-running `enable --now`),
    or an `--once` invocation that exited while its child was still going, used
    to leave exactly that card as a permanent dead end - `report_stranded` only
    names `running` ones, `ready_cards` only considers `ready-for-agent`, and
    the merge queue it was missing from lived in one process's memory. The
    queue on disk IS the queue.

    A card a live child still holds is skipped: dispatch writes `done` just
    before its process exits, and integrating a run whose worktree is still
    being written to would race it. The next cycle reaps that child and picks
    the card up from disk anyway.
    """
    live = {child.card.name for child in engine.children}
    return [path for path in cards(engine)
            if path.name not in live and card_status(path) == dispatch.DONE]


def report_stranded(engine: Engine) -> None:
    """Names, once at startup, every card sitting at `running` with nothing
    running it - a killed ADW, or an engine stopped mid-flight (systemd stops
    the whole cgroup, children included: specs/engine.md 10).

    Deliberately a report and nothing else. Re-dispatching one silently would
    orphan the branch and worktree its first attempt cut; `just worktrees`
    reconciles those against the sessions table, which is the only place that
    knows the truth.
    """
    for path in cards(engine):
        if card_status(path) == dispatch.RUNNING:
            log(f"stranded: {path.name} is {dispatch.RUNNING} with no live child. "
                f"The engine never re-dispatches it - reconcile with `just worktrees`.")


# ── lanes: one provider account = one lane = one quota pool ──────────────────

def parse_lanes(value: str) -> dict[str, int]:
    """`"xai=2,opencode-go=1"` -> `{"xai": 2, "opencode-go": 1}`.

    Raises ValueError on anything else, so a typo in an `SSSF_LANES=` line -
    in the checkout's `.env` or a systemd drop-in, the two channels
    specs/engine.md 10 names - fails loudly at startup instead of silently
    running a lane at its default while the operator believes otherwise.
    """
    slots: dict[str, int] = {}
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        name, sep, count = part.partition("=")
        name, count = name.strip(), count.strip()
        if not sep or not name or not count.isdigit():
            raise ValueError(f"--lanes: {part!r} is not <lane>=<slots>, e.g. \"xai=2\"")
        if int(count) < 1:
            raise ValueError(f"--lanes: {name} needs at least 1 slot (got {count}); "
                             f"a lane with no slots holds every card forever")
        slots[name] = int(count)
    return slots


def _roster_yaml(config: str | Path) -> dict:
    """A roster as plain data, or `{}` when it is not a mapping at all.

    Read DIRECTLY, not through `agents.load_config`, and every reader below
    goes through here for the same reason: these are SCHEDULING inputs, and a
    roster that fails validation must still tell the engine which quota pools it
    would touch (dispatch is the thing that refuses an invalid roster, per card
    and visibly - see `specs/dispatch.md`). Raises exactly what `read_text` and
    `yaml.safe_load` raise; the callers that must survive an unreadable roster
    catch those by name.
    """
    data = yaml.safe_load(Path(config).read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _lanes_of(data: dict) -> tuple[str, ...]:
    """Every lane a roster draws on: the distinct provider prefixes of its
    `provider/model` strings (`defaults.model` plus any per-agent `model:`).

    Takes DATA, not a path, because the router asks the same question about a
    roster that exists only in memory - the derived copy it is about to write
    for one run. One rule, one implementation, so a routed run's slots are
    counted exactly like an unrouted one's. A model string with no `/` names no
    provider and is skipped rather than guessed at.
    """
    models: list[object] = []
    defaults = data.get("defaults")
    if isinstance(defaults, dict):
        models.append(defaults.get("model"))
    agents = data.get("agents")
    if isinstance(agents, list):
        models += [agent.get("model") for agent in agents if isinstance(agent, dict)]
    return tuple(sorted({str(m).split("/", 1)[0].strip()
                         for m in models if isinstance(m, str) and "/" in m}))


def roster_lanes(config: str | Path) -> tuple[str, ...]:
    """`_lanes_of` for a roster on disk - the lanes one dispatch would occupy."""
    return _lanes_of(_roster_yaml(config))


def _lane_of(model: str) -> str:
    """The lane a `provider/model` string draws on: its provider prefix."""
    return model.split("/", 1)[0].strip()


def _is_provider_model(model: str) -> bool:
    """The one shape a pool entry may have: `<provider>/<model>`, both halves
    non-empty. Anything else names no lane, so the router cannot schedule it."""
    provider, _, name = model.strip().partition("/")
    return bool(provider.strip() and name.strip())


def builder_pool(config: str | Path) -> tuple[str, ...]:
    """The roster's optional `router.builder_pool`: the models the BUILDER may
    run on, in the operator's own order (the order that breaks ties below).

        router:
          builder_pool:
            - model: "ollama-cloud/kimi-k2.7-code"
            - model: "xai/grok-4.5"

    Absent block, absent key, or anything that is not a list -> `()`, which is
    "no routing" and byte-for-byte the behaviour this engine had before the
    router existed. A bare `"provider/model"` string is read the same way as the
    one-key mapping; anything whose model is not `<provider>/<model>` is named
    in one line and SKIPPED - the rest of the pool still routes. Fail-closed on
    the entry, never on the loop: a typo in one pool line must not stop a
    service that has four other perfectly good models to build on.
    """
    router = _roster_yaml(config).get("router")
    if not isinstance(router, dict):
        return ()
    entries = router.get("builder_pool")
    if not isinstance(entries, list):
        return ()
    pool: list[str] = []
    for entry in entries:
        model = entry.get("model") if isinstance(entry, dict) else entry
        if not isinstance(model, str) or not _is_provider_model(model):
            log(f"router: skipping a malformed builder_pool entry ({entry!r}) - an entry is "
                f"{{model: \"provider/model\"}}, both halves non-empty. The rest of the pool "
                f"still routes.")
            continue
        pool.append(model.strip())
    return tuple(pool)


def config_lanes(config: str | Path) -> dict[str, int]:
    """The roster's optional top-level `lanes:` block - `lane -> slots`.

        lanes:
          ollama-cloud: { slots: 2 }
          xai: { slots: 2 }

    This is the roster UI's way of writing down what `--lanes` says on a command
    line, so it REPLACES the default slot count for the lanes it names, and
    `--lanes` / `$SSSF_LANES` still override it on top (ops keeps the last
    word - the server must be able to narrow a lane without editing a file the
    laptop owns, which is what `$SSSF_LANES` in its `.env` or a systemd drop-in
    is for; specs/engine.md 10).

    A malformed entry is named in one line and skipped, and that lane keeps its
    default: a service must not die of one bad line in a roster, and a lane
    silently running at a count the operator did not write is the failure this
    log line exists to prevent.
    """
    block = _roster_yaml(config).get("lanes")
    if not isinstance(block, dict):
        return {}
    slots: dict[str, int] = {}
    for name, entry in block.items():
        count = entry.get("slots") if isinstance(entry, dict) else None
        if isinstance(count, bool) or not isinstance(count, int) or count < 1:
            log(f"lanes: skipping {str(name)!r} in the roster's lanes block - an entry is "
                f"<lane>: {{slots: N}} with N at least 1, and this one is {entry!r}. That "
                f"lane keeps its default of {DEFAULT_LANE_SLOTS}.")
            continue
        slots[str(name).strip()] = count
    return slots


def _builder_agent(data: dict) -> dict | None:
    """The roster's `builder` entry, as the mutable dict the derived copy swaps
    a model into - or None when the roster has no such agent."""
    agents = data.get("agents")
    if not isinstance(agents, list):
        return None
    for agent in agents:
        if isinstance(agent, dict) and str(agent.get("name", "")).strip() == BUILDER_AGENT:
            return agent
    return None


def worktrees_enabled(config: str | Path) -> bool:
    """The roster's `worktrees.enabled`, read from the same yaml `roster_lanes`
    reads and by the same rule (directly, not through `agents.load_config` -
    this is a startup decision, not a validation).

    The engine cannot run with the worktree layer off, and `main` refuses to
    start on a roster that says so (see there for why). Absent block, absent
    key, or a roster that cannot be read at all all answer True: True is
    `WorktreesConfig`'s own default, and an unreadable roster is dispatch's
    refusal to make, per card and visibly - never a service that will not come
    up at all.
    """
    try:
        data = yaml.safe_load(Path(config).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError, ValueError):
        return True
    if not isinstance(data, dict):
        return True
    block = data.get("worktrees")
    if not isinstance(block, dict):
        return True
    return block.get("enabled", True) is not False


def resolve_lanes(engine: Engine) -> None:
    """Turn the roster into `lane -> slots`, plus the builder pool the router
    will schedule against. Called EVERY cycle; it re-resolves only when the
    roster's bytes actually changed.

    Default `DEFAULT_LANE_SLOTS` for every lane the roster uses (its own models
    plus every lane its builder pool names); the roster's own `lanes:` block
    replaces that count where it names a lane; `--lanes` / `$SSSF_LANES` then
    override on top, so ops keeps the last word. An override for a lane nothing
    in the roster uses is named and ignored, from either source.

    A roster that cannot be read at all leaves lane slots unenforced and says
    so: dispatch refuses such a card anyway (it validates the config per card),
    so failing closed here would only turn one visible refusal into a silent
    stall.

    RE-READ, NOT READ ONCE. This used to run exactly once, on the first cycle,
    so `lanes:{slots}` and `router.builder_pool` froze for the life of the
    service - while `derive_config` re-read the same file per dispatch, so the
    agent/model half of an edit applied immediately and the scheduling half did
    not. That is a half-applied roster, and it is the normal case, not an exotic
    one: the roster UI (`apps/ui/server/app/roster.ts`) writes exactly those two
    blocks expecting effect, and the designed transport - the laptop pushes, the
    engine pulls - delivers the edited file mid-service with nothing restarting
    anything (`bootstrap.sh` only try-restarts when the unit FILE changed). An
    operator who added a model to the pool from the app watched the holds keep
    logging the old counts until a redeploy that happened to rewrite the unit.

    The re-read is one `read_text` of a file measured in kilobytes, and the
    engine already re-reads the QUEUE off disk every cycle for the same reason.
    Comparing the bytes is what keeps it silent: an unchanged roster resolves
    nothing and logs nothing, so the shape line, the router line and every
    "skipping a malformed entry" line appear exactly when something really
    changed - which is also the operator's confirmation that their edit landed.
    A roster that stops parsing keeps the LAST GOOD lanes rather than dropping
    to unenforced: the previous answer is the better one to hold, and the reason
    is logged once.
    """
    try:
        text = Path(engine.config).read_text(encoding="utf-8")
    except OSError as error:
        engine.roster_seen = None
        _say_once(engine, "roster",
                  f"lane slots not enforced: cannot read the roster {engine.config} "
                  f"({_one_line(str(error))}). The cap still bounds parallelism.")
        return
    if engine.lanes_resolved and text == engine.roster_seen:
        return
    if engine.lanes_resolved:
        log(f"the roster {engine.config} changed on disk - re-reading its lanes and "
            f"builder pool")
    engine.roster_seen = text
    engine.lanes_resolved = True
    try:
        lanes = roster_lanes(engine.config)
        pool = builder_pool(engine.config)
        block = config_lanes(engine.config)
        has_builder = _builder_agent(_roster_yaml(engine.config)) is not None
    except (OSError, yaml.YAMLError, ValueError) as error:
        _say_once(engine, "roster",
                  f"lane slots not enforced: cannot read the roster {engine.config} "
                  f"({_one_line(str(error))}). The cap still bounds parallelism.")
        return
    engine.waiting.pop("roster", None)
    if pool and not has_builder:
        log(f"router: {engine.config} has a builder_pool but no agent named "
            f"{BUILDER_AGENT!r} to route - the pool is ignored and every run uses the roster "
            f"exactly as it stands.")
        pool = ()
    engine.builder_pool = pool
    engine.lanes = tuple(sorted(set(lanes) | {_lane_of(model) for model in pool}))
    engine.lane_slots = {lane: DEFAULT_LANE_SLOTS for lane in engine.lanes}
    for source, overrides in (("the roster's lanes block", block),
                              ("--lanes", engine.lane_overrides)):
        for lane, slots in overrides.items():
            if lane not in engine.lane_slots:
                log(f"{source} names {lane}, which this roster does not use - ignored "
                    f"(roster lanes: {', '.join(engine.lanes) or 'none'})")
                continue
            engine.lane_slots[lane] = slots
    if not engine.lanes:
        log(f"no provider/model lanes found in {engine.config} - lane slots not enforced")
        return
    shape = ", ".join(f"{lane}={engine.lane_slots[lane]}" for lane in engine.lanes)
    log(f"lanes: {shape} (a slot counts one RUN; inner subagents draw on their parent's "
        f"lane and are not counted, which is why the default is {DEFAULT_LANE_SLOTS})")
    if engine.builder_pool:
        log(f"router: builder pool = {', '.join(engine.builder_pool)} - every run's builder "
            f"goes to whichever of those lanes has the most free slots, ties in that order")


def lane_free(engine: Engine, lane: str) -> tuple[int, int]:
    """`(free, slots)` for one lane. Children each occupy one slot of every lane
    they use, for as long as they live."""
    slots = engine.lane_slots.get(lane, DEFAULT_LANE_SLOTS)
    used = sum(1 for child in engine.children if lane in child.lanes)
    return max(slots - used, 0), slots


def full_lane(engine: Engine, lanes: tuple[str, ...] | None = None) -> tuple[str, int, int] | None:
    """The first lane with no free slot, as `(lane, free, slots)`, or None when
    every lane in `lanes` can carry one more run. `None` asks about the roster's
    own lanes, which is every run on a roster with no builder pool.

    Deterministic order (the roster's lanes are sorted, and a derived roster's
    lanes are sorted by the same rule), so the same full lane is named every
    time rather than whichever one iteration reached first.
    """
    for lane in (engine.lanes if lanes is None else lanes):
        free, slots = lane_free(engine, lane)
        if free <= 0:
            return lane, free, slots
    return None


# ── the router: which model this run's builder gets ─────────────────────────

def pick_pool_model(engine: Engine) -> str | None:
    """The pool entry whose lane has the most free slots right now, or None when
    every one of them is full.

    Deterministic arithmetic, and nothing more: no history, no usage log, no
    model judging where work should go. Ties go to the operator's own pool
    order (strictly-greater wins keep the earlier entry), so a pool that is
    tied - the normal state of an idle factory - always starts at the top of the
    list the operator wrote.
    """
    best: str | None = None
    most = 0
    for model in engine.builder_pool:
        free, _ = lane_free(engine, _lane_of(model))
        if free > most:
            best, most = model, free
    return best


def derive_config(engine: Engine, card: Path, model: str) -> tuple[Path, tuple[str, ...]] | None:
    """This run's OWN copy of the roster, with the builder's model swapped for
    `model`; answers `(path, the lanes that copy draws on)`.

    A copy, never an edit: the operator's roster is a file the laptop owns and
    git tracks, and two runs routed to two different models in the same cycle
    would otherwise be writing over each other's roster while dispatch is
    reading it. The copy is a temp file (utf-8, named after the card so a leaked
    one is identifiable), passed as `--config` to exactly one dispatch and
    deleted when that child is reaped by a running engine - an invocation that
    exits with the child still live leaves it, and says so (`_drop_derived`).

    Nothing else in the roster is touched, so the run's own record names the
    model without any extra plumbing: the ADW loads THIS file, and the model it
    reports in `agent_start` / the sessions table is the one chosen here.

    None (logged, one line) when the roster cannot be read or the copy cannot be
    written. The engine dispatches on the roster it MEANT to or not at all -
    silently falling back to the roster's own builder model would run a card on
    a lane the router just decided was full.
    """
    try:
        data = _roster_yaml(engine.config)
        agent = _builder_agent(data)
        if agent is None:
            log(f"router: {card.name} not dispatched this cycle - {engine.config} has no agent "
                f"named {BUILDER_AGENT!r} to route {model} to")
            return None
        agent["model"] = model
        handle, name = tempfile.mkstemp(prefix=f"sssf-{card.stem}-", suffix=".yaml")
        os.close(handle)
        path = Path(name)
        path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    except (OSError, yaml.YAMLError, ValueError) as error:
        log(f"router: {card.name} not dispatched this cycle - the derived roster for {model} "
            f"could not be written ({_one_line(str(error))})")
        return None
    return path, _lanes_of(data)


def _hold(engine: Engine, card: Path, reason: str) -> None:
    """One card held, named once per changed reason."""
    _say_once(engine, f"lane:{card.name}", f"holding {card.name}: {reason}")


def plan_run(engine: Engine, card: Path) -> Plan | None:
    """What this card is about to run on, or None when it is HELD (already
    logged, once per changed reason).

    With no builder pool this is exactly the lane check it has always been, and
    the plan is the operator's roster as it stands. With a pool, the builder's
    model is chosen FIRST - the pool entry whose lane has the most free slots -
    and then the lanes checked are the ones that CHOICE draws on: a pool entry
    whose lane is full is simply not picked, and only when every one of them is
    full does the card take the normal hold path.
    """
    if not engine.builder_pool:
        held = full_lane(engine)
        if held is not None:
            _hold(engine, card, f"waiting for lane: {held[0]} ({held[1]} free of {held[2]})")
            return None
        engine.waiting.pop(f"lane:{card.name}", None)
        return Plan(engine.config, engine.lanes)

    model = pick_pool_model(engine)
    if model is None:
        shape = []
        for lane in dict.fromkeys(_lane_of(entry) for entry in engine.builder_pool):
            free, slots = lane_free(engine, lane)
            shape.append(f"{lane} {free} of {slots}")
        _hold(engine, card, f"waiting for lane: no lane in the builder pool has a free slot "
                            f"({', '.join(shape)})")
        return None

    derived = derive_config(engine, card, model)
    if derived is None:
        return None
    path, lanes = derived
    held = full_lane(engine, lanes)
    if held is not None:
        path.unlink(missing_ok=True)
        _hold(engine, card, f"waiting for lane: {held[0]} ({held[1]} free of {held[2]})")
        return None
    free, slots = lane_free(engine, _lane_of(model))
    log(f"router: {card.name} builder -> {model} ({_lane_of(model)}: {free} free of {slots}) "
        f"- the run's own copy of the roster carries it, so its record names it too")
    engine.waiting.pop(f"lane:{card.name}", None)
    return Plan(str(path), lanes, path)


# ── git: the transport, and the only thing this file mutates in the checkout ─

def _repo_path(engine: Engine, path: Path) -> str | None:
    """A path as a repo-relative posix path, or None when it lives outside the
    checkout entirely (only reachable via `--queue-dir`, which is a test
    override) - nothing outside the repo can be committed."""
    try:
        return path.resolve().relative_to(engine.main_root.resolve()).as_posix()
    except ValueError:
        return None


def committer_identity_ok(engine: Engine) -> bool:
    """Can git in this checkout name who is committing? False = do nothing this
    cycle.

    `git commit` on a host where neither the repo nor the service user has an
    identity dies with *"unable to auto-detect email address"*, and every
    single thing this engine records is a commit. Without this check the
    service logs `commit failed, will retry next cycle` once a minute forever
    while `systemctl is-active` cheerfully reports `active` - the exact shape
    of failure `User=` was added to the unit to kill (specs/engine.md 10), and
    the exact shape a fresh container/VPS ships with.

    Asked with `git var GIT_COMMITTER_IDENT`, which is git's OWN answer to the
    question (config, environment and auto-detection all folded in, strict mode
    - the same resolution `git commit` itself does) rather than a guess at
    which of the four config layers might hold it. Asked once per CYCLE, not
    once at startup, so an operator who fixes it is picked up on the next turn
    with no restart; announced once per reason, so a host left unfixed costs
    one line, not 1440 a day.
    """
    result = git_helper.run("var", "GIT_COMMITTER_IDENT", tree=engine.main_root)
    if result.returncode == 0 and result.stdout.strip():
        engine.waiting.pop("identity", None)
        return True
    _say_once(engine, "identity",
              f"NO COMMITTER IDENTITY: git cannot name who commits in {engine.main_root} "
              f"({_one_line(result.stderr or result.stdout, 120)}), so every card write-back, "
              f"every park and every merge would fail. Nothing else runs until it is set. Fix "
              f"it with exactly these two commands: "
              f"git -C {engine.main_root} config user.name \"{COMMITTER_NAME}\" ; "
              f"git -C {engine.main_root} config user.email \"{COMMITTER_EMAIL}\"")
    return False


def pi_launchable(engine: Engine) -> bool:
    """Can this box launch the coding agent at all? False = do nothing this
    cycle.

    Every run this engine starts ends in `pi`, so a `PI_PATH` that is unset,
    unparseable, or names a file a pi upgrade moved means every card dispatched
    this cycle comes straight back `blocked`. Holding is the cheaper failure by
    a mile: a held card is still on the Board, ready, waiting for one line of
    `.env` to be right, while a blocked one needs a human to repair it - and
    there would be one per card, once a minute, all night.

    Asked once per CYCLE and never at import (see `agent_pi.pi_cmd`), so an
    operator who fixes the path is picked up on the next turn with no restart,
    and announced once per reason, so a box left unfixed costs one line and not
    1440 a day - the same shape as the committer-identity preflight above, for
    the same reason.

    `pi_cmd()` raises `RuntimeError` with the repair instructions in it;
    `ValueError` is `shlex.split` refusing an unbalanced quote in the value, and
    `OSError` is a path the filesystem itself will not answer for. All three are
    "this box cannot launch pi", and none of them is worth a traceback.
    """
    try:
        agent_pi.pi_cmd()
    except (RuntimeError, ValueError, OSError) as error:
        _say_once(engine, "pi",
                  f"PI IS NOT LAUNCHABLE: {_one_line(str(error), 400)} Nothing else runs "
                  f"until it resolves - every run this engine dispatches spawns pi, so "
                  f"dispatching now would only blocked-out one card per cycle. The engine "
                  f"itself never spawns pi and never dies of this; it holds and re-checks "
                  f"every cycle.")
        return False
    engine.waiting.pop("pi", None)
    return True


def uv_launchable(engine: Engine) -> bool:
    """Can this box resolve `uv` at all? False = do nothing this cycle.

    THE FAILURE THIS EXISTS FOR. Every child argv this engine builds starts
    with `uv` - the dispatch children (`dispatch_command`) and the integration
    gate's whole suite (`quality_commands`, where `{dev}` expands to `uv run
    --project ... --group dev`). A bare `"uv"` is resolved by the OS against the
    CHILD's PATH, which is `operator_env()`'s: the service PATH with the ADW's
    own venv bin stripped back off. Under systemd that PATH does not contain
    `~/.local/bin`, which is exactly where the bootstrap installs uv - so
    `Popen` raised OSError on every single spawn, `spawn` recorded every card
    refused, and the gate returned red on its OSError branch. A factory that
    `systemctl is-active` called `active`, all night, shipping nothing, with
    every card on the Board burned to a state nothing retries.

    HOLDING is the cheaper failure by a mile, exactly as it is for pi above: a
    held card is still ready on the Board waiting for one PATH to be right,
    while a refused one needs a human. So this runs BEFORE anything spawns and
    before the integrate step, and no card is burned on the way.

    Asked once per CYCLE and never at import (`utils.uv_bin` is deliberately
    uncached), so an operator who installs uv or fixes the unit is picked up on
    the next turn with no restart; announced once per reason, so a box left
    unfixed costs one line and not 1440 a day.
    """
    resolved = uv_bin()
    if resolved:
        _say_once(engine, "uv", f"uv resolves to {resolved}")
        return True
    _say_once(engine, "uv",
              "UV IS NOT LAUNCHABLE: neither $UV nor this process's PATH names a `uv` "
              "binary, and every child this engine starts - each dispatch and every "
              "command of the integration gate's suite - begins with it. Nothing else "
              "runs until it resolves; no card is dispatched, so none is burned to "
              "blocked on the way. Under systemd the usual cause is the unit's PATH: it "
              "does not include ~/.local/bin, where uv installs. Fix it with exactly "
              "this, then `systemctl daemon-reload && systemctl restart sdl-engine`: "
              "systemctl edit sdl-engine  ->  [Service] "
              "Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:"
              "/sbin:/bin:%h/.local/bin")
    return False


def ensure_trunk(engine: Engine) -> bool:
    """Put the main checkout on the factory's working line, creating and
    publishing it if this checkout has never seen it. False = do nothing this
    cycle.

    Everything else in this file commits, pulls, pushes and merges the CURRENT
    branch of the main checkout, so being on the wrong one is not a degraded
    cycle, it is a cycle that writes the right work to the wrong place. Hence
    the guard runs first, every cycle - it is one `rev-parse` in the normal
    case - and it also self-heals a checkout somebody left on another branch.

    Creation order: an existing local branch is checked out; else the hub's
    copy is tracked; else it is cut from `main` (the human-owned line the
    factory forks from and never writes to) and published with `push -u`.
    Publishing is what gives `git pull --ff-only` something to track; a failure
    there is logged once and the cycle continues - the pull will say so in its
    own words.
    """
    root, trunk = engine.main_root, engine.trunk
    head = git_helper.run("rev-parse", "--abbrev-ref", "HEAD", tree=root)
    if head.returncode != 0:
        _say_once(engine, "trunk", f"cannot read the current branch of {root}: "
                                   f"{_one_line(head.stderr or head.stdout)}")
        return False
    current = head.stdout.strip()

    if current != trunk:
        if git_helper.ref_exists(trunk, tree=root):
            result = git_helper.run("checkout", trunk, tree=root)
            made = f"switched from {current}"
        elif git_helper.ref_exists(f"{REMOTE}/{trunk}", tree=root):
            result = git_helper.run("checkout", "-b", trunk, "--track", f"{REMOTE}/{trunk}",
                                    tree=root)
            made = f"tracking {REMOTE}/{trunk}"
        else:
            base = HUMAN_TRUNK if git_helper.ref_exists(HUMAN_TRUNK, tree=root) else current
            result = git_helper.run("checkout", "-b", trunk, base, tree=root)
            made = f"created from {base}"
        if result.returncode != 0:
            _say_once(engine, "trunk",
                      f"cannot get onto {trunk} ({made}): "
                      f"{_one_line(result.stderr or result.stdout)}. Nothing else runs this "
                      f"cycle - every commit this engine makes belongs on {trunk}.")
            return False
        log(f"on {trunk}: {made}")

    if git_helper.has_remote(REMOTE, root) and not git_helper.ref_exists(f"{REMOTE}/{trunk}",
                                                                        tree=root):
        published = git_helper.run("push", "-u", REMOTE, trunk, tree=root)
        if published.returncode != 0:
            _say_once(engine, "trunk", f"could not publish {trunk} to {REMOTE}: "
                                       f"{_one_line(published.stderr or published.stdout)}")
        else:
            log(f"published {trunk} to {REMOTE}")
    engine.waiting.pop("trunk", None)
    return True


def rebase_in_progress(tree: Path | str) -> bool:
    """True while a rebase is stopped part-way in `tree` (git's own
    `rebase-merge` / `rebase-apply` state directory exists). Asked via
    `rev-parse --git-path` rather than by guessing at `.git/`, so it is right
    for a linked worktree as well as the main checkout."""
    for name in ("rebase-merge", "rebase-apply"):
        result = git_helper.run("rev-parse", "--git-path", name, tree=tree)
        if result.returncode == 0 and (Path(tree) / result.stdout.strip()).exists():
            return True
    return False


def touches_only_queue(engine: Engine, ref: str) -> bool:
    """True when every path in `ref`'s commit is under `queue/` - which is to
    say, when it is one of the engine's own card write-backs.

    The replay in `pull` may DROP a commit, and the one thing that makes that
    safe is that it only ever drops those: a card the hub has moved on from is
    a status this server no longer owes anyone. Since the engine started
    fast-forwarding finished runs into the working line, its local history also
    carries commits that are somebody's actual WORK - and dropping one of those
    would lose merged code silently, with the card already parked as
    integrated. So anything that is not purely a card commit is refused here,
    and `pull` aborts instead (5). Unreadable reads as "not a card commit":
    fail-closed, because the failure mode on the other side is lost work.
    """
    shown = git_helper.run("show", "--name-only", "--format=", ref, tree=engine.main_root)
    if shown.returncode != 0:
        return False
    paths = [line.strip() for line in shown.stdout.splitlines() if line.strip()]
    return bool(paths) and all(path.startswith("queue/") for path in paths)


def diverged(engine: Engine) -> bool:
    """True when the local working line and the hub's each hold commits the
    other does not - exactly the state `--ff-only` refuses.

    Measured with `rev-list --count` on both sides rather than read out of
    git's error text: the same answer in every locale, and it distinguishes a
    real divergence from an unreachable hub (which leaves the remote-tracking
    ref exactly where it was, so `behind` is 0).
    """
    trunk = engine.trunk
    upstream = f"{REMOTE}/{trunk}"
    if not (git_helper.ref_exists(trunk, tree=engine.main_root)
            and git_helper.ref_exists(upstream, tree=engine.main_root)):
        return False
    ahead = git_helper.rev_list_count(f"{upstream}..{trunk}", tree=engine.main_root)
    behind = git_helper.rev_list_count(f"{trunk}..{upstream}", tree=engine.main_root)
    return ahead > 0 and behind > 0


def dirty_outside_queue(engine: Engine) -> list[str]:
    """Paths the main checkout is dirty on that are NOT the engine's own card
    write-backs, oldest git order.

    `queue/` is excluded because the engine owns it and already has a recovery
    path for it: `adopt_writebacks` commits any card write-back sitting on disk
    at the top of every cycle, before the pull. Anything left dirty outside
    `queue/` came from somewhere else entirely - a half-finished edit somebody
    made on the box, a file an agent wrote into the main checkout, a merge
    somebody started by hand - and nothing in this engine will ever clean it up,
    because nothing in this engine is willing to throw away work it did not
    write.
    """
    result = git_helper.run("status", "--porcelain", tree=engine.main_root)
    if result.returncode != 0:
        return []
    paths = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        # Porcelain v1: two status columns, a space, then the path. A rename
        # reads `R  old -> new`; the new name is the one that is dirty.
        path = line[3:].strip().split(" -> ")[-1].strip('"')
        if path and not path.startswith("queue/"):
            paths.append(path)
    return paths


def pull(engine: Engine) -> bool:
    """`git pull --ff-only` in the main checkout: the ONLY way work arrives.

    A fast-forward first, always. When it is refused because the two boxes
    have BOTH moved the working line, the engine replays its own commits on
    top of the hub instead (`git pull --rebase`) and carries on.

    That case is not an operator standoff and never was: integration is the
    LIVING line (MAP.md 2026-08-15) - cards, their status write-backs and docs
    all move on it - so its local copy moves independently of the hub as a
    matter of routine. One failed push (a network blip) plus one
    `queue-publish` from the laptop is all it takes, with no conflicting edit
    anywhere - and refusing to proceed there stops the pull, the reap, the
    dispatch and the push, forever, until a human logs into the server. The
    only commits being replayed are this engine's own unpushed card commits,
    each scoped to one card file.

    A commit that cannot be replayed means the laptop changed that same card at
    the hub - and it is not a standoff: the card has moved on and the status
    line this server was still carrying for it is history. So that one commit
    is dropped (`rebase --skip`, one card file, named in the log) and the
    replay carries on. The hub wins, always; the engine never fights the
    operator over a card file and `--force` is never in this file's vocabulary.
    If even that cannot finish, the rebase is aborted - the checkout is left
    exactly as it was - and the cycle stops.

    A checkout with no `origin` is local-only (a laptop trying the engine out):
    nothing to pull, and `push_pending` has nothing to push either.

    A DIRTY MAIN CHECKOUT outside `queue/` is called out by name, ahead of the
    divergence question, because it defeats the fast-forward AND the replay
    alike and is the real cause in either case. It is neither a divergence nor
    a network problem, it never clears by itself, and it halts every later step
    of every later cycle - so it gets the paths, the repair command, and the
    same say-once treatment the identity/pi/uv/trunk holds get, instead of one
    anonymous `pull failed` line a minute.
    """
    if not git_helper.has_remote(REMOTE, engine.main_root):
        return True
    result = git_helper.run("pull", "--ff-only", tree=engine.main_root)
    if result.returncode == 0:
        engine.waiting.pop("dirty", None)
        return True
    detail = _one_line(result.stderr or result.stdout)

    # A DIRTY MAIN CHECKOUT is checked FIRST, before the divergence question,
    # because it defeats BOTH ways forward and is the real cause in either. The
    # fast-forward refuses with "Your local changes to the following files
    # would be overwritten by merge"; the replay below never even starts
    # ("cannot rebase: You have unstaged changes"). Both used to flatten into
    # one anonymous `pull failed` line a minute, forever, naming no file and no
    # remedy - while every later step of every later cycle (integrate, scan,
    # dispatch, push) stopped dead behind it. So a stray edit on the box
    # silently halted the whole factory.
    #
    # Said ONCE per distinct set of paths, through the same say-once identity
    # `identity`, `pi`, `uv` and `trunk` use, so a box left unfixed costs one
    # line and not 1440 a day - and re-announces if the set changes.
    #
    # git's OWN words are deliberately left out of this message. They vary
    # between cycles for reasons that have nothing to do with the problem (the
    # first pull enumerates objects and names the remote branch, later ones
    # have them cached and do not), and `_say_once` compares the whole string -
    # so including them turned "say it once" back into "say it every minute".
    # The paths and the repair are the reason; git's transient chatter is not.
    dirty = dirty_outside_queue(engine)
    if dirty:
        shown = ", ".join(dirty[:5])
        more = f" (+{len(dirty) - 5} more)" if len(dirty) > 5 else ""
        _say_once(engine, "dirty",
                  f"DIRTY MAIN CHECKOUT: {len(dirty)} path(s) outside queue/ are uncommitted "
                  f"in {engine.main_root}, so git will neither fast-forward nor replay onto "
                  f"{REMOTE}/{engine.trunk} - and NOTHING else runs until it is cleared: no "
                  f"card is pulled, integrated or dispatched. The paths: {shown}{more}. This "
                  f"engine never discards work it did not write, so a human decides. Clear it "
                  f"with exactly this: git -C {engine.main_root} stash --include-untracked "
                  f"(or commit the paths above if they are wanted).")
        return False

    if not diverged(engine):
        log(f"pull failed, skipping this cycle: {detail}")
        return False

    log(f"{REMOTE}/{engine.trunk} and this server both moved - replaying this server's own "
        f"card commits on top of the hub")
    result = git_helper.run("pull", "--rebase", tree=engine.main_root)
    skipped = 0
    while (result.returncode != 0 and rebase_in_progress(engine.main_root)
           and skipped < MAX_REPLAY_SKIPS):
        subject = _one_line(git_helper.run("log", "-1", "--format=%s", "REBASE_HEAD",
                                           tree=engine.main_root).stdout, 80)
        if not touches_only_queue(engine, "REBASE_HEAD"):
            git_helper.run("rebase", "--abort", tree=engine.main_root)
            log(f"pull failed, skipping this cycle: a commit that is NOT a card write-back "
                f"({subject}) will not replay onto {REMOTE}/{engine.trunk}. This engine drops "
                f"its own card commits and never a run's work, so nothing was dropped: the "
                f"rebase is aborted, the checkout is untouched, and a human decides.")
            return False
        log(f"the laptop's version of that card is already at the hub - dropping this "
            f"server's own commit ({subject}). The engine never fights the operator over a "
            f"card file, and a card the laptop has moved on from is not a status this "
            f"server still owes anyone.")
        result = git_helper.run("rebase", "--skip", tree=engine.main_root)
        skipped += 1
    if result.returncode == 0 and not rebase_in_progress(engine.main_root):
        # Whatever survived the replay is, by definition, not at the hub yet.
        engine.pending_push = True
        engine.waiting.pop("dirty", None)
        log(f"replayed onto {REMOTE}/{engine.trunk}")
        return True
    if rebase_in_progress(engine.main_root):
        git_helper.run("rebase", "--abort", tree=engine.main_root)
    log(f"pull failed, skipping this cycle: could not replay onto {REMOTE}/{engine.trunk} - "
        f"{_one_line(result.stderr or result.stdout)}. Rebase aborted, the checkout is "
        f"untouched.")
    return False


def commit_card(engine: Engine, card: Path, status: str) -> None:
    """Records ONE card's status write-back as its own commit.

    Path-scoped at every step (`git add -- <card>`, `git commit -- <card>`), so
    a commit carries that card's Status: line and nothing else - not another
    card, not whatever else happens to be dirty in the checkout. One card, one
    commit, a message the laptop can read at a glance.

    A dispatch that refused changed no bytes, so there is nothing staged and no
    commit is made - the engine never manufactures an empty commit to have
    something to push.
    """
    rel = _repo_path(engine, card)
    if rel is None:
        log(f"{card.name} is outside {engine.main_root} - status not recorded in git")
        return
    added = git_helper.run("add", "--", rel, tree=engine.main_root)
    if added.returncode != 0:
        log(f"git add {rel} failed: {_one_line(added.stderr)}")
        return
    staged = git_helper.run("diff", "--cached", "--quiet", "--", rel, tree=engine.main_root)
    if staged.returncode == 0:
        return   # nothing changed on disk - nothing to record
    message = f"factory: {card.name} -> {status}"
    committed = git_helper.run("commit", "-m", message, "--", rel, tree=engine.main_root)
    if committed.returncode != 0:
        # No retry state needed: the card is still dirty on disk, so
        # `adopt_writebacks` picks it up again at the top of the next cycle.
        log(f"commit failed, will retry next cycle: "
            f"{_one_line(committed.stderr or committed.stdout)}")
        return
    log(f"committed: {message}")
    engine.pending_push = True


def adopt_writebacks(engine: Engine) -> None:
    """Commits every queue card whose write-back is on disk but not in git.

    dispatch writes a card's `Status:` itself; the engine records it. `reap`
    can only record the cards of children THIS process is holding, and nothing
    else did. Two ways a write-back falls outside that:

      - the engine was restarted between dispatch's terminal write and the
        next reap (systemd's `Restart=always` after a crash, or a converge
        re-running `enable --now`). The new process has no child for that card
        and `report_stranded` only names `running` ones, so the card said
        `done` on the server's disk and `running` at the hub forever.
      - a `commit_card` that failed. It logs and moves on; without this step
        nothing would ever try again.

    Both also left the checkout dirty, which is what makes the next `git pull`
    refuse ("Your local changes ... would be overwritten by merge") - the very
    wedge this cycle's ordering exists to prevent. Recording is safe here:
    `queue/*.md` in the server's checkout has exactly one writer, and it is
    the dispatch this engine started.
    """
    diff = git_helper.run("diff", "--name-only", "HEAD", "--", "queue",
                          tree=engine.main_root)
    if diff.returncode != 0:
        return
    changed = {line.strip() for line in diff.stdout.splitlines() if line.strip()}
    if not changed:
        return
    for card in cards(engine):
        rel = _repo_path(engine, card)
        if rel is None or rel not in changed:
            continue
        status = card_status(card)
        if status is None:
            continue
        log(f"adopting an uncommitted write-back: {card.name} is {status} on disk")
        commit_card(engine, card, status)


def push_pending(engine: Engine) -> None:
    """Pushes the working line when there is something to push, and shrugs when
    there is not. A failed push keeps `pending_push` set, so the next cycle
    carries the same commits again - the record is already safe in the local
    history, the network is just late.

    The branch pushed is `engine.trunk` and nothing else. `main` is never an
    argument here, by construction: it is the operator's line, moved once per
    chunk by their own squash merge.
    """
    if not engine.pending_push:
        return
    if not git_helper.has_remote(REMOTE, engine.main_root):
        engine.pending_push = False
        return
    result = git_helper.run("push", REMOTE, engine.trunk, tree=engine.main_root)
    if result.returncode != 0:
        log(f"push failed, will retry next cycle: "
            f"{_one_line(result.stderr or result.stdout)}")
        return
    log(f"pushed {engine.trunk} to {REMOTE}")
    engine.pending_push = False


# ── the integration gate: deterministic, and never an agent ──────────────────

def quality_commands(engine: Engine, tree: Path) -> list[list[str]]:
    """The suite the gate re-runs against the rebased tree, in order.

    The one outside-world seam of the integrate step - the tests point it at a
    stand-in, exactly as they do with `dispatch_command`, so the suite never
    shells out to `uv` to test the gate's own logic.

    THESE ARE THE ROSTER'S OWN COMMANDS, read from the same
    `adws/adw_sssf_config/sssf.config.yaml` this engine already dispatches on
    (`quality:` block - see `adw_modules/data_types.QualityConfig`). They were
    three hardcoded literals aimed at the FACTORY'S scaffolding - `ruff check
    .`, `mypy adws`, `pytest -q adws/tests` - which is right in the repo that
    is the factory and hollow in a repo it was stamped into: the middle rung of
    the ratified ladder, "re-run the suite against the rebased tree", re-ran
    somebody else's suite. The defaults are unchanged, byte for byte, so a
    roster that says nothing behaves exactly as it did.

    Still resolved against THE TREE BEING JUDGED (`--project <tree> --group
    dev`, bare-name `uv`, no machine path). Still deliberately WITHOUT the
    AI-defect scan: Skylos judges the change in isolation and already ran inside
    the run's own chain (MAP.md's check placement), it is
    fail-closed-incomplete wherever its toolchain is missing, and re-running it
    would answer a question this gate is not asking. The gate asks exactly one
    thing: does this branch still work on top of integration as integration is
    NOW.

    An unreadable roster falls back to the defaults rather than merging with no
    gate at all - fail-closed is this gate's whole character, and "I could not
    read the config" must never become "so I checked nothing".
    """
    config = QualityConfig()
    try:
        block = _roster_yaml(engine.config).get("quality")
        if isinstance(block, dict):
            config = QualityConfig(**block)
    except Exception as error:      # noqa: BLE001 - see below
        # DELIBERATELY BROAD, and it is the fail-closed choice rather than the
        # lazy one. Everything from `read_text` (OSError, UnicodeDecodeError)
        # through `yaml.safe_load` (YAMLError) to pydantic's ValidationError (a
        # roster that wrote `lint: 5`) lands here, and the alternative is an
        # exception escaping into `integrate` - which would take down the cycle
        # that was about to merge, not just this gate. The defaults are the
        # factory's own suite, so a roster nobody can read is still GATED; it is
        # simply gated by the commands the engine shipped with, and the reason
        # is logged rather than swallowed.
        log(f"gate: could not read `quality:` from {engine.config} "
            f"({_one_line(str(error))}) - using the factory's default suite")
    commands = [resolve_command(template, tree)
                for template in (config.lint, config.typecheck, config.test)]
    # An empty template is a project's written decision to run nothing for that
    # check; it drops out here rather than becoming an empty argv `subprocess`
    # would raise on.
    return [argv for argv in commands if argv]


def quality_is_green(engine: Engine, tree: Path) -> tuple[bool, str]:
    """Run the gate's suite in `tree`. `(True, "")` only if every command
    exited 0.

    FAIL-CLOSED, the same rule the in-run quality block follows: a command that
    could not run at all (missing binary, a toolchain that will not provision,
    a timeout) reads RED here, never "unverified but fine". The gate's whole
    job is to refuse a merge it cannot vouch for.
    """
    env = {**operator_env(), "UV_PROJECT_ENVIRONMENT": str(Path(tree) / ".venv"),
           "PYTHONIOENCODING": "utf-8"}
    for argv in quality_commands(engine, tree):
        printable = " ".join(argv)
        try:
            result = subprocess.run(argv, cwd=tree, env=env, capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=GATE_TIMEOUT,
                                    check=False)
        except subprocess.TimeoutExpired:
            return False, f"`{printable}` timed out after {int(GATE_TIMEOUT)}s"
        except OSError as error:
            return False, f"`{printable}` could not run at all ({error})"
        if result.returncode != 0:
            detail = _tail(result.stdout + result.stderr)
            log(f"gate: {printable} -> {result.returncode}: {detail}")
            return False, f"`{printable}` exited {result.returncode}: {detail}"
        log(f"gate: {printable} -> 0")
    return True, ""


def block_card(engine: Engine, card: Path, reason: str) -> None:
    """`Status: blocked` plus a `Blocked-reason:` line in the card's header,
    committed and pushed.

    The reason goes in the CARD, not only the journal: a blocked card is what
    the operator sees on the Board, and MAP rule 11 is that a run either merges
    or leaves a visible, named artifact explaining why not. Flattened to one
    line so the header block stays a header block (`dispatch.parse_header`'s
    contiguous `Key: value` run, the same shape the Board's own parser reads).
    """
    flat = _one_line(reason, 300)
    try:
        header = dispatch.parse_header(card.read_text(encoding="utf-8"))
    except (dispatch.DispatchError, OSError) as error:
        log(f"{card.name} could not be marked blocked ({error}). The reason was: {flat}")
        return
    header.lines[header.field_lines["status"]] = f"Status: {dispatch.BLOCKED}"
    entry = f"Blocked-reason: {flat}"
    if "blocked-reason" in header.field_lines:
        header.lines[header.field_lines["blocked-reason"]] = entry
    else:
        # Last line of the header block, so the contiguous Key: value run - and
        # every byte of title and body around it - survives intact.
        header.lines.insert(header.body_start, entry)
    text = "\n".join(header.lines) + ("\n" if header.trailing_newline else "")
    card.write_text(text, encoding="utf-8")
    log(f"blocked {card.name}: {flat}")
    commit_card(engine, card, dispatch.BLOCKED)
    push_pending(engine)


def park_card(engine: Engine, card: Path) -> bool:
    """Move an integrated card to `queue/done/`, commit, push.

    THIS is what satisfies another card's `Needs:` (`dispatch.needs_satisfied`
    is a `queue/done/` existence check), so parking is not bookkeeping - it is
    the event that lets a wave roll on to its next card without anyone
    clicking anything. It happens only after the branch is really in
    integration, which is the whole reason the edge is honest.

    THE CARD IS STAGED FIRST, and that is a fix, not a flourish. `git mv`
    refuses a path that is not in the index - *"fatal: not under version
    control"* - and a card can perfectly well reach `done` having never been
    added: a hand-written card dispatched with `just work` is a documented
    first-class flow, and dispatch does no git at all, so that card exists only
    on disk. The old park failed on it every single cycle, forever, on work the
    engine had ALREADY merged - and it could never recover by itself, because
    the adopt sweep is blind to untracked files (`git diff HEAD -- queue`) and
    nothing else ever ran `git add` on a card at `done`. Every card naming it in
    `Needs:` then waited on a park that could not happen.
    """
    rel = _repo_path(engine, card)
    done_dir = card.parent / "done"
    dest = done_dir / card.name
    dest_rel = _repo_path(engine, dest)
    if rel is None or dest_rel is None:
        log(f"{card.name} is outside {engine.main_root} - not parked in queue/done/")
        return False
    done_dir.mkdir(parents=True, exist_ok=True)
    staged = git_helper.run("add", "--", rel, tree=engine.main_root)
    if staged.returncode != 0:
        log(f"could not stage {card.name} for parking: "
            f"{_one_line(staged.stderr or staged.stdout)}")
        return False
    # Asked BEFORE the move, while the answer still means something: does HEAD
    # carry this card at its old path? A path-scoped commit only accepts a
    # pathspec git already knows, and after the move the old path is gone from
    # both the index and the worktree - so naming it for a card HEAD never had
    # fails the whole commit with "pathspec ... did not match any file(s) known
    # to git". Named when HEAD does have it, because that is what records the
    # DELETION beside the addition; left out otherwise, when there is no
    # deletion to record in the first place.
    in_head = git_helper.run("cat-file", "-e", f"HEAD:{rel}",
                             tree=engine.main_root).returncode == 0
    moved = git_helper.run("mv", rel, dest_rel, tree=engine.main_root)
    if moved.returncode != 0:
        log(f"could not park {card.name} in queue/done/: "
            f"{_one_line(moved.stderr or moved.stdout)}")
        return False
    message = f"factory: {card.name} integrated"
    paths = [rel, dest_rel] if in_head else [dest_rel]
    committed = git_helper.run("commit", "-m", message, "--", *paths,
                               tree=engine.main_root)
    if committed.returncode != 0:
        log(f"parked {card.name} on disk but the commit failed: "
            f"{_one_line(committed.stderr or committed.stdout)}")
        return False
    log(f"committed: {message}")
    engine.pending_push = True
    return True


def reattach(engine: Engine, tree: Path, branch: str) -> None:
    """Put a run's worktree back on its own branch after the gate detached it.

    Called on EVERY exit from the gate - green, red, conflict, refused merge -
    because a repair dispatch for a blocked card rejoins that same worktree and
    expects to find its branch checked out there (`worktrees.ensure_run_worktree`
    step 1, and `integrate`'s own "is this tree on that branch" guard below).
    A tree left detached would be refused by both.

    A checkout that will not go back is named loudly, with the one command that
    fixes it - never silence: the tree still holds the run's work, and nothing
    here would ever `--force` it away.
    """
    result = git_helper.run("checkout", branch, tree=tree)
    if result.returncode != 0:
        log(f"{tree} is left DETACHED: {branch} could not be checked back out "
            f"({_one_line(result.stderr or result.stdout, 160)}). Its work is untouched, but a "
            f"repair run needs the tree on its own branch: git -C {tree} checkout {branch}")


def integrate(engine: Engine, card: Path) -> None:
    """One finished run, from its branch to `queue/done/`. The merge_check
    phase MAP.md has been describing since 2026-08-13, as code.

    The exact sequence, and why each step is where it is:

      1. Find the run: the card's `Adw-Id:` names the branch (`adw/<id>_*`) and
         the worktree that still holds it. Nothing is pruned here - `just
         worktrees` owns that, and it refuses anything unmerged. A card at
         `done` that fails one of those guards is BLOCKED with the reason on
         it, never left silently in `queue/`: the disk scan that feeds this
         step would otherwise re-read it every 60 seconds forever.
      2. Rebase a DETACHED COPY of the branch onto the working line, in that
         worktree: `checkout --detach <branch>` and then `rebase <trunk>`,
         which replays the run's commits onto trunk and leaves them on a
         detached HEAD. THE RUN'S BRANCH REF NEVER MOVES. Rebasing the branch
         itself (what this used to do) rewrote history the run had already
         pushed, so every later `push` of it - a repair run's, most of all -
         was refused forever unless someone forced it, and the hub's compare
         link kept showing pre-rebase code. `--force` does not exist in this
         factory, so the branch simply does not get rewritten. The main
         checkout never moves and never checks out a run branch either
         (specs/worktrees.md's invariant 1). A conflict is aborted at once, the
         tree is put back on its branch, and the card is blocked with the
         reason.
      3. Re-run the deterministic suite against the REBASED tree. This is the
         only question the gate asks and the only place it can be asked: the
         run's own chain judged the change in isolation, so what is left is
         "does it still work now that everything else merged". DETERMINISTIC
         ONLY - no agent, ever (MAP.md's dead list: an agent here is precisely
         what killed no-mistakes-the-tool).
      4. `git merge --ff-only <rebased sha>` into the working line. A commit is
         as good a merge argument as a branch name, and step 2 is what
         guarantees the fast-forward - which is what lets sibling branches
         integrate one after another instead of racing. Reconciliation still
         reads the un-rewritten branch as merged afterwards, because
         `worktrees.is_merged_into_trunk` compares CONTENT (`merge-tree`), not
         ancestry.
      5. Put the worktree back on its branch, push, then park the card in
         `queue/done/`, commit, push. Parking unblocks whatever named this card
         in `Needs:` - in the same cycle, because the scan runs after this step.

    Nothing about the run's branch is ever pushed from here. Its commits are
    already at the hub (the run pushed them itself) and they still match, which
    is the whole point of rebasing a copy. The rebased content reaches the hub
    on the working line instead, which is the only place it needs to be.
    """
    name = card.name
    adw_id = card_field(card, "adw-id")
    if not adw_id:
        block_card(engine, card, "no Adw-Id: on the card, so the engine cannot name this "
                                 "run's branch - nothing was merged")
        return
    branch = git_helper.find_run_branch(adw_id, tree=engine.main_root)
    if branch is None:
        block_card(engine, card, f"no adw/{adw_id}_* branch in this checkout, so there is "
                                 f"nothing to merge for a card that says {dispatch.DONE} - "
                                 f"reconcile with `just worktrees`")
        return
    ahead = git_helper.rev_list_count(f"{engine.trunk}..{branch}", tree=engine.main_root)
    if ahead == 0:
        # Nothing this branch has is missing from the line: a run that
        # committed nothing, or a card whose work already landed and whose
        # engine died before it could park it. Either way there is nothing to
        # merge and nothing to check, and leaving the card at `done` in
        # `queue/` would hold every dependent behind it forever.
        log(f"nothing to merge for {name}: {branch} holds no commits {engine.trunk} does not "
            f"already have - parking the card as it stands")
        if park_card(engine, card):
            push_pending(engine)
        return

    tree = worktrees.worktree_for(engine.main_root, adw_id)
    if tree is None:
        block_card(engine, card, f"no worktree holds {branch}, so it cannot be rebased onto "
                                 f"{engine.trunk} - reconcile with `just worktrees`")
        return
    head = git_helper.run("rev-parse", "--abbrev-ref", "HEAD", tree=tree)
    if head.returncode != 0 or head.stdout.strip() != branch:
        # The repair one-liner rides along, exactly as `reattach`'s message
        # carries it: this is the same tree in the same wrong state, and the
        # operator reading the card should not have to reconstruct the command
        # from the sentence. The usual cause is a gate that was interrupted
        # between its `checkout --detach` and its `reattach`.
        block_card(engine, card, f"{tree} is on {head.stdout.strip() or '?'}, not {branch} - "
                                 f"refusing to rebase a branch this run does not own. Put the "
                                 f"tree back with: git -C {tree} checkout {branch}")
        return

    detached = git_helper.run("checkout", "--detach", branch, tree=tree)
    if detached.returncode != 0:
        detail = _one_line(detached.stderr or detached.stdout, 160)
        block_card(engine, card, f"could not detach {branch} in {tree}, so the gate has nothing "
                                 f"safe to rebase ({detail})")
        return

    rebased = git_helper.run("rebase", engine.trunk, tree=tree)
    if rebased.returncode != 0:
        detail = _one_line(rebased.stderr or rebased.stdout, 160)
        conflicted = rebase_in_progress(tree)
        if conflicted:
            git_helper.run("rebase", "--abort", tree=tree)
        reattach(engine, tree, branch)
        block_card(engine, card,
                   f"rebase conflict with {engine.trunk} ({detail})" if conflicted else
                   f"rebase onto {engine.trunk} refused ({detail})")
        return
    rebased_head = git_helper.run("rev-parse", "HEAD", tree=tree).stdout.strip()
    if not rebased_head:
        reattach(engine, tree, branch)
        block_card(engine, card, f"the rebase of {branch} onto {engine.trunk} left no commit "
                                 f"this engine could name - nothing was merged")
        return
    log(f"rebased a detached copy of {branch} onto {engine.trunk} ({ahead} commit(s)) in {tree} "
        f"- the branch itself is untouched, so what the hub already holds still matches")

    green, why = quality_is_green(engine, tree)
    if not green:
        reattach(engine, tree, branch)
        block_card(engine, card, f"quality suite red on {branch} rebased onto "
                                 f"{engine.trunk}: {why}")
        return

    merged = git_helper.run("merge", "--ff-only", rebased_head, tree=engine.main_root)
    reattach(engine, tree, branch)
    if merged.returncode != 0:
        block_card(engine, card, f"ff-merge of {branch} into {engine.trunk} refused "
                                 f"({_one_line(merged.stderr or merged.stdout, 160)})")
        return
    engine.pending_push = True
    log(f"integrated {name}: {branch} rebased onto {engine.trunk} and ff-merged into it")
    push_pending(engine)
    if park_card(engine, card):
        push_pending(engine)


def integrate_finished(engine: Engine) -> None:
    """Integrate every card the queue says is finished, ONE AT A TIME, oldest
    NNN first.

    Sequential is not a simplification here, it is the mechanism: each rebase
    lands on the integration tip the previous merge just created, so two
    sibling branches cut from the same commit both fast-forward - the second
    one after being replayed on top of the first. Doing them at once is what
    used to make the second merge refuse.

    A card that could not be integrated is blocked (visibly, with its reason on
    the card), which is also what takes it out of `integrate_candidates`: the
    scan reads `done`, and a blocked card is not that. Nothing is retried on a
    60s loop - a conflict and a red suite are both human-shaped problems, and
    re-running them every minute would just be a louder way of being stuck.
    """
    for card in integrate_candidates(engine):
        if not card.is_file():
            continue    # parked or moved since the scan - nothing owed
        integrate(engine, card)


# ── running cards ────────────────────────────────────────────────────────────

def dispatch_command(engine: Engine, card: Path, config: str | None = None) -> list[str]:
    """The child's command line. Its own function because it is one of the two
    places this file touches the outside world - the tests swap in a stand-in
    script here, so the suite never launches a real ADW, a real harness, or
    `uv`.

    `config` is this run's roster: the derived copy when the router chose a
    builder model for it, and the operator's own roster otherwise.

    `uv` is RESOLVED (`utils.uv_cmd()`), never handed to the OS as a bare name.
    A bare name is resolved against the CHILD's PATH, and the child's PATH is
    `operator_env()`'s - the service PATH with the ADW's own venv bin stripped
    off, which under systemd does not contain `~/.local/bin` where uv is
    installed. Every spawn raised OSError there, every card was recorded
    refused, and the factory looked alive while shipping nothing. See
    `uv_launchable` for the preflight that stops a cycle ever reaching here
    with no uv at all.
    """
    target = _repo_path(engine, card) or str(card)
    return [uv_cmd(), "run", str(Path("adws") / "dispatch.py"), target,
            "--config", config or engine.config]


def spawn(engine: Engine, card: Path, plan: Plan | None = None) -> Child | None:
    """Starts one dispatch as a non-blocking child and returns immediately -
    that is the whole difference between the engine and `just work`.

    stdout/stderr are inherited, so an ADW's console output lands in the same
    journal as the engine's own lines and needs no lifecycle of its own (the
    authoritative per-run trace is SQLite, read by the UI). `PYTHONIOENCODING`
    is pinned on THIS child's env - a per-site pin like every other one in the
    factory, never an ambient interpreter setting - so the chain below never
    dies on a cp1252 console.

    The child carries the lanes its roster draws on, so the slots it occupies
    are released the moment it is reaped and not one cycle later - and the
    derived roster it was given, so that copy is deleted at the same moment.

    A LAUNCH FAILURE IS NOT A REFUSAL, and that distinction is this function's
    one piece of policy. `engine.refused` means "dispatch ran, read this card,
    and said no" (a bad `Adw:`, a roster that will not load, a card already
    claimed) - a verdict about the CARD, which is why it is never retried. An
    OSError here is the opposite: no dispatch ever started, nothing read the
    card, and the verdict is about the BOX. Recording it as a refusal is how an
    unresolvable `uv` turned every card on the Board into a permanently dead one
    that survived the repair - the engine would resolve uv again on the next
    cycle and still skip every card it had already written off. So the card is
    left exactly as it is: still `ready-for-agent`, still scanned next cycle,
    dispatched the moment the box can launch it again. The failure is named in
    the journal every time it happens, because a box that cannot spawn is worth
    saying out loud; in practice `uv_launchable` holds the cycle before this can
    be reached at all.
    """
    plan = plan or Plan(engine.config, engine.lanes)
    cmd = dispatch_command(engine, card, plan.config)
    env = operator_env()
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        process = subprocess.Popen(cmd, cwd=engine.main_root, env=env)
    except OSError as error:
        log(f"could not start {cmd[0]} for {card.name}: {error}. The card is left "
            f"{dispatch.READY} and will be dispatched again as soon as this box can launch "
            f"it - nothing started, so nothing refused it.")
        if plan.derived is not None:
            plan.derived.unlink(missing_ok=True)
        return None
    child = Child(card=card, process=process, started=time.monotonic(), lanes=plan.lanes,
                  derived_config=plan.derived)
    engine.children.append(child)
    log(f"dispatched {card.name} (pid {process.pid})")
    return child


def await_claim(engine: Engine, child: Child) -> str | None:
    """Waits briefly for dispatch's ready->running write-back, so the claim can
    be committed and pushed in the SAME cycle that made it: a card the server
    is already building must never still look free on the laptop's Board.

    Returns the status it saw, or None if the claim never landed - a child that
    exits without writing anything is a refusal, and the reap stage names it.
    """
    deadline = time.monotonic() + CLAIM_TIMEOUT
    while True:
        status = card_status(child.card)
        if status is not None and status != dispatch.READY:
            return status
        if child.process.poll() is not None:
            claimed = card_status(child.card)
            return claimed if claimed != dispatch.READY else None
        if time.monotonic() >= deadline:
            log(f"{child.card.name} not claimed after {int(CLAIM_TIMEOUT)}s - "
                f"its status will be recorded on a later cycle")
            return None
        time.sleep(CLAIM_POLL)


def _drop_derived(child: Child) -> None:
    """Delete a finished run's derived roster. It exists for exactly one
    dispatch, and nothing reads it after that process exits. A delete that fails
    is one line and nothing more - it is a temp file, and the run it belonged to
    is already over.

    This is the ONLY place a derived roster is deleted, and it is reached only
    from `reap` - that is, only while this engine is still running. An
    invocation that exits with live children (`--once`, Ctrl-C, a systemd stop)
    leaves their derived rosters in the temp directory: the still-running
    dispatch is reading the file, so deleting it on the way out would be worse
    than leaving it, and no later invocation reconstructs a `Child` to own it.
    `--once` says so in its own log line. A derived roster carries no credential -
    it is the roster with one `model:` swapped."""
    if child.derived_config is None:
        return
    try:
        child.derived_config.unlink(missing_ok=True)
    except OSError as error:
        log(f"could not delete the derived roster {child.derived_config} ({error}) - it is a "
            f"temp file and nothing reads it once its run has exited")


def reap(engine: Engine) -> None:
    """Collects every child that finished and records what it did.

    dispatch always writes a terminal status of its own (done on exit 0,
    blocked on anything else, including a launch failure), so the engine reads
    the card rather than inventing a status from the exit code - the card is
    what the Board shows, and the two must never disagree.

    Nothing is queued for integration HERE. The card is the record, and
    `integrate_candidates` reads it back off disk on the same cycle - which is
    what makes a run survive the engine dying between its last write-back and
    its merge. A child whose card does NOT say `done` is named in one line and
    integrated not at all; its branch was already pushed by the run itself, so
    the work is visible at the hub for a human to look at - it simply does not
    go near the working line.

    Commits only; `run_cycle` owns the pushes, so a cycle never asks the
    network twice for the same commits.
    """
    live: list[Child] = []
    for child in engine.children:
        code = child.process.poll()
        if code is None:
            live.append(child)
            continue
        _drop_derived(child)
        status = card_status(child.card)
        elapsed = int(time.monotonic() - child.started)
        log(f"finished {child.card.name} exit={code} status={status or '?'} after {elapsed}s")
        if status is None:
            log(f"{child.card.name} is unreadable after its run - status not recorded")
            continue
        if status == dispatch.READY:
            engine.refused.add(child.card.name)
            log(f"{child.card.name} came back still {dispatch.READY} - dispatch refused it "
                f"(its own reason is on the line above). Not retried until the engine "
                f"restarts.")
        elif status == dispatch.RUNNING:
            log(f"stranded: {child.card.name} is still {dispatch.RUNNING} but its child is "
                f"gone. The engine never re-dispatches it - reconcile with `just worktrees`.")
        commit_card(engine, child.card, status)
        if status != dispatch.DONE:
            log(f"not integrating {child.card.name}: its run exited {code} and the card says "
                f"{status}. Nothing reaches {engine.trunk} from a run that did not come back "
                f"clean.")
    engine.children = live


# ── the cycle ────────────────────────────────────────────────────────────────

def run_cycle(engine: Engine) -> None:
    """One turn: re-read the roster, name a committer, check pi is launchable,
    be on the working line, reap, adopt, publish, pull, integrate, scan, route
    and dispatch within cap and lane slots, publish.

    The order is the whole failure design. The roster re-read comes first and
    costs nothing when nothing changed, so the lane slots and builder pool the
    rest of the cycle schedules against are the ones on disk right now rather
    than the ones this process started with. The identity preflight comes next,
    because every record this engine keeps is a commit and a checkout that
    cannot commit can only grind; the pi preflight after it, because a cycle
    that dispatches into an unlaunchable coding agent turns every ready card
    into a blocked one; the uv preflight after THAT, because every child argv
    this file builds - each dispatch and every command of the integration gate -
    begins with `uv`, and a cycle that cannot resolve it can neither spawn nor
    merge anything. The branch guard comes next, because every
    write below belongs on that branch and nowhere else. Everything that CLEARS
    local state runs after that - reap, adopt, push - because that state (an
    uncommitted card, an unpushed commit) is exactly what a pull refuses to run
    over; behind the pull, those steps could never run on the cycle that needed
    them. The integrate step runs just after the pull, so "rebase onto current
    integration" means what it says, and just before the scan, so a card parked
    by an integration unblocks its dependents in the same cycle.

    Every step that can fail logs one line and lets the next cycle try again.
    A cycle doing nothing is the normal state of a factory with no work.
    """
    # Every cycle, not once: the roster is a file the app edits and git
    # delivers while the service runs, so its lanes and its builder pool are
    # re-read here rather than frozen at startup (`resolve_lanes` is silent
    # when the bytes have not changed).
    resolve_lanes(engine)
    if not engine.opened:
        engine.opened = True
        report_stranded(engine)

    if not committer_identity_ok(engine):
        return

    if not pi_launchable(engine):
        return

    if not uv_launchable(engine):
        return

    if not ensure_trunk(engine):
        return

    reap(engine)
    adopt_writebacks(engine)
    push_pending(engine)

    if not pull(engine):
        return

    integrate_finished(engine)

    for card in ready_cards(engine):
        if len(engine.children) >= engine.cap:
            break
        plan = plan_run(engine, card)
        if plan is None:
            continue
        child = spawn(engine, card, plan)
        if child is None:
            continue
        status = await_claim(engine, child)
        if status is not None:
            commit_card(engine, card, status)

    push_pending(engine)


# ── CLI ──────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--interval", type=float, default=DEFAULT_INTERVAL,
                        help=f"seconds between cycles (default: {DEFAULT_INTERVAL:g})")
    parser.add_argument("--cap", type=int, default=os.environ.get("SSSF_CAP") or DEFAULT_CAP,
                        help=f"how many ADWs may run at once (default: $SSSF_CAP, else "
                             f"{DEFAULT_CAP})")
    parser.add_argument("--lanes", default=os.environ.get("SSSF_LANES") or "",
                        help=f"per-lane slot overrides, e.g. \"xai=2,opencode-go=1\" "
                             f"(default: {DEFAULT_LANE_SLOTS} slots for every lane the roster "
                             f"uses; env SSSF_LANES)")
    parser.add_argument("--once", action="store_true",
                        help="run exactly one cycle, then exit - it does NOT wait for the runs "
                             "it starts; they are integrated by the next invocation, off the "
                             "queue on disk")
    parser.add_argument("--config", default=os.environ.get("SSSF_CONFIG") or DEFAULT_CONFIG,
                        help=f"the roster every dispatch uses (default: $SSSF_CONFIG, "
                             f"else {DEFAULT_CONFIG})")
    parser.add_argument("--queue-dir", default=None,
                        help="override the queue directory (default: <repo root>/queue)")
    args = parser.parse_args(argv)

    if args.cap < 1:
        parser.error("--cap must be at least 1")
    try:
        lane_overrides = parse_lanes(args.lanes)
    except ValueError as error:
        parser.error(str(error))

    trunk = integration_branch()
    if trunk == HUMAN_TRUNK:
        parser.error(
            f"the factory's working line cannot be {HUMAN_TRUNK!r}: {HUMAN_TRUNK} is "
            f"human-owned - one squash commit per finished chunk, merged by the operator "
            f"(MAP.md, 2026-08-15). Unset {git_helper.FACTORY_TRUNK_ENV} for "
            f"{INTEGRATION_BRANCH!r}, "
            f"or name another branch.")

    if not worktrees_enabled(args.config):
        parser.error(
            f"the engine requires worktrees.enabled: true - runs in the main checkout would be "
            f"destroyed, and {args.config} sets it false. With the layer off a run's branch is "
            f"cut IN the main checkout (git_helper.ensure_run_branch), and this engine checks "
            f"{trunk!r} out there every cycle: it would yank a live run's branch out from under "
            f"it mid-flight, and no worktree would ever hold a finished branch for the "
            f"integrate step to rebase. Turn it on in that roster, or dispatch cards by hand "
            f"with `just work`.")

    main_root = git_helper.repo_root()
    engine = Engine(
        main_root=main_root,
        queue_dir=Path(args.queue_dir) if args.queue_dir else main_root / "queue",
        config=args.config,
        cap=args.cap,
        trunk=trunk,
        lane_overrides=lane_overrides,
    )
    remote = "yes" if git_helper.has_remote(REMOTE, main_root) else "no (local only)"
    log(f"up: root={main_root} queue={engine.queue_dir} trunk={engine.trunk} cap={engine.cap} "
        f"interval={args.interval:g}s remote={remote} config={engine.config}")

    try:
        while True:
            try:
                run_cycle(engine)
            except Exception as error:     # noqa: BLE001 - a service never dies of one bad cycle
                log(f"cycle failed: {type(error).__name__}: {error}")
            if args.once:
                if engine.children:
                    log(f"--once: {len(engine.children)} run(s) still going. This invocation "
                        f"does not wait for them - a run takes minutes and a cycle takes "
                        f"seconds. Whatever finishes writes {dispatch.DONE} to its card, and "
                        f"the next invocation integrates it straight off the queue on disk.")
                    left = [str(child.derived_config) for child in engine.children
                            if child.derived_config is not None]
                    if left:
                        log(f"--once: {len(left)} derived roster(s) stay on disk - the runs still "
                            f"reading them outlive this invocation, and only a running engine "
                            f"reaps a child. Delete them once those runs are over: "
                            f"{', '.join(left)}")
                return 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        left = [str(child.derived_config) for child in engine.children
                if child.derived_config is not None]
        log("stopped. Live runs are left alone; their cards are reconciled by "
            "`just worktrees`."
            + (f" {len(left)} derived roster(s) stay on disk for the runs still reading them: "
               f"{', '.join(left)}" if left else ""))
        return 0


if __name__ == "__main__":
    sys.exit(main())
