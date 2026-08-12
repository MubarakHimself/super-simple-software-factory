# MAP — SDL Factory

**The only planning record.** One file, kept current, no layers. It distills two days of design
work (2026-08-11/12) into what is decided, what is dead, and what is open. Everything older lives
in the parked archive (see [Provenance](#provenance)) and is superseded by this file. If a session,
spec, or ticket disagrees with this file, this file wins — or the disagreement gets written here.

## Destination

A **cloud-hosted software factory**: disler's Super Simple Software Factory running headless on the
operator's Contabo VPS, driven by `pi` against his own flat-rate subscriptions, fed by planning
sessions from his laptop (Matt Pocock skill chain → Kanban queue), documenting its projects in OKF,
observable through a UI. The operator appears at exactly two moments — ratifying the plan, and the
pre-merge morning brief. Done when a queue item ships to `main` without him between those gates.

## The shape — disler's core, four additions

The core is **untouched**: deterministic Python ADWs own sequencing/retries/acceptance; agents are
bounded nodes inside named phases; typed JSON envelopes cross the seams; gates verify claims; every
event streams to SQLite. *Agent proposes, code disposes.* The videos are primary sources —
`docs/research/video-1-notes.md` and `video-2-notes.md` before inventing any architecture.

We add exactly four things (plus one gate layer):

| Addition | What |
|---|---|
| **A host** | Contabo VPS for v1. Installer makes the host swappable — laptop / server / container. Tailscale is a convenience, never a dependency. |
| **A queue** | The Kanban — durable board of `ready-for-agent` briefs, the seam between laptop planning and the server factory. Local, **not** GitHub Issues. |
| **A UI** | Board / Trace / Gate, one app, shadcn, T3 Code's five patterns (`docs/research/t3code-ui-notes.md`), plus a settings panel (roster config, provider auth/keys). Reads SQLite; pi RPC is an option, not the spine. |
| **A roster + lane balancer** | One provider account = one lane = one rate-limit bucket. See [Roster](#roster). |
| **Skylos** | Deterministic AI-defect layer: quality block (`--ai-defects`) + gate (`verify --file --range`), three states pass/fail/incomplete, **fail-closed**. |

## Standing rules — argued once, do not re-argue

1. **KISS.** If a ticket's answer is "add a system," it is probably wrong. A discovered capability
   is not a reason to add a node: if a boundary already has a check, the discovery is filed, not
   deployed.
2. **Deterministic review wherever a predicate can decide it.** Exactly **one** agent reviewer,
   never stacked, narrowed to the one question no predicate can check: *does this do what the
   ticket asked.* (Models are built to find fault; that leads to over-engineering.)
3. **Cross-family review STANDS.** The family that writes the code is never the family that reviews
   it (GPT ↔ Claude; operator's own rule, reaffirmed 2026-08-12 — an earlier session recorded it
   "withdrawn," which was never ratified and is void). Reviewer lane candidate: **Opus 4.8**.
   Consequence: the `defaults.harness_engineering:` **merge fix is needed** — pi extension lists are
   per-agent and *replace* rather than merge (~12 lines in the config loader + `agent_pi`).
4. **No Anthropic models for testing.** Smoke tests and lane checks run on ollama-cloud, xai or
   opencode-go. Anthropic in the *shipping* roster is fine (Opus 4.8).
5. **Park, never permanently delete.** Uninstall paths move, never remove.
6. **Production-grade code, never mock data.** The reason Skylos exists at all.
7. **No paid services.** Flat-rate subscriptions only; zero marginal token spend is a hard
   constraint. No per-token APIs, no GCP billing, no Context7.
8. **Never bury code inside a skill.** Every lint/test/status-write/provision step is an
   orchestrator-invoked process with an observable exit code.
9. **Context engineering upstream.** Decisions are made before coding starts. Pin skills per phase —
   never model-chosen. The builder does not search; it receives what scout and planner selected.
10. **Two human gates, never in the middle.** Gate 1: ratify the decision ledger before prose or
    code exists. Gate 2: the pre-merge morning brief. Mid-run escalation is a defect report against
    the intake, not a feature.
11. **Trunk-based.** `main` + short-lived `adw/<adw_id>_<slug>`, merged by PR. A run either merges
    or leaves a visible, named artifact explaining why not — silence is the bug. One branch per unit
    of work; one worktree per *concurrently running* agent; sandbox is a third thing and not in v1.
12. **Never depend on ambient state.** `-ne` plus explicit `-e` paths; `--no-skills` plus explicit
    `--skill`; factory-critical config never lives only in files pi rewrites.
13. **The factory never builds the factory.** `protected_files` covers the ADW machinery; enforced
    after every call.
14. **Installation converges in the wizard.** By the time anyone runs pi, nothing installs at
    launch.
15. **Claude-side helpers** (dynamic workflows / subagents on the operator's harness): Sonnet 5,
    Opus 5, or Opus 4.8 — **never Fable** (operator's usage-limit rule).

## Roster

Settled pool (operator-confirmed): workhorses **Grok 4.5 · GLM 5.2 · Kimi K2.7-code ·
Qwen3-Coder-Next**, escalating to **GPT 5.5 or Opus 4.8** when the work needs real intelligence.
Opus 4.8 is the universal slot ("all the other models have specific jobs"). Reviewer: opposite
family to the builder (rule 3), Opus 4.8 the leading candidate. Sub-agent fan-out counts against
the parent's lane.

Lanes: ollama-cloud, opencode-go, openai-codex, xai, claude-bridge (+ a possible direct GLM
account, unconfirmed). **ollama-cloud and opencode-go share one quota** (the key script reads
OpenCode's `auth.json`). Balancing: **least-connections weighted by remaining weekly headroom**;
lane picked when a phase starts and **pinned through that phase and its correction rounds** (a
correction re-prompts the same `--session-id`; per-call balancing converts every fix into a cold
start). 503/529 → backoff and retry same lane; quota exhausted → switch lane; cache support is a
lane-selection criterion. **Test lane: `ollama-cloud/kimi-k2.7-code` — says nothing about the
shipping roster.**

Dead models (cost/evidence, do not re-propose): DeepSeek V4, Kimi K3, GPT 5.6 Luna, Fable 5,
Opus 4.6/4.7, MiniMax M3.

## Build phases

1. **Make it run, honestly** — **DONE 2026-08-12** (commit `e7c9855`): stamped, landmines fixed,
   real quality commands, branch-per-run, suite green, real round trips traced on the test lane.
2. **Installer / wizard** — **DONE 2026-08-12** (spec `specs/installer-wizard.md`; verified: real
   converge exit 0, idempotent re-runs, `just demo` green from a fresh terminal; V1 cold-launch
   probe and the no-mistakes Windows binary deferred to the server phase) — one command, three
   targets (laptop/server/container), installs pi +
   extensions (`pi-claude-bridge`, `@tintinweb/pi-subagents`) + providers + uv/just/skylos/
   no-mistakes/CodeGraph, prompts for auth, restart after. Server install also installs the UI, and
   Claude Code + Codex CLIs as the credential surface the bridges read
   (`CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)`).
3. **UI** — Board/Trace/Gate + settings; shadcn; "don't overcook it."
4. **Server + shipping roster** — factory on the VPS, real T02 roster applied, lanes verified by
   real round trips.

Out of scope: a deployment ADW (deploy locally in a normal session — "it's overkill"), mobile
(permitted, not wanted; the PR is the merge button), porting the operator off Claude Code.

## Platform landmines — already paid for, do not re-hit

- **Never invoke `pi` by name.** `pi.cmd` → cmd.exe truncates arguments at the first newline: every
  multi-line `--system-prompt` silently empties and pi exits 0. Resolve once via `PI_PATH` to
  `node <path>/cli.js`. Use forward slashes so `shlex` survives Windows paths.
- **Pin `encoding="utf-8"` at every site** — subprocess pipes, `open`, `read_text`/`write_text` —
  and keep non-ASCII glyphs off stdout. cp1252 killed 100% of headless runs. Per-site pins, not an
  ambient `PYTHONUTF8` (portability).
- **Upstream `quality.py` blocks exit 0 — theatre.** Wire real `ruff` / `mypy` / `pytest` (uv dev
  group) before trusting any green.
- **Upstream's starter roster does not resolve in pi** (no openrouter/fireworks providers; `openai`
  is really `openai-codex`). Set the test lane immediately after stamping.
- **Skylos does not install on Windows** (`tree-sitter-dart-orchard` is sdist-only, needs MSVC).
  Keep it in a separate uv group; unavailable reads **incomplete, never pass** (fail-closed). The
  laptop is a planning box; the chains that build software need the Linux server.
- **`pi auth check` lies in both directions.** A lane is verified only by a real round trip
  returning non-zero tokens; probe liveness before batches.
- **pi reads `~/.claude/skills/` directly** (shared with Claude Code, nothing to port), **rewrites
  its own `settings.json`**, and per-agent `harness_engineering:` lists **replace** rather than
  merge — the merge fix (rule 3) is real work that is needed.
- **`--session-id` is create-or-continue** — but continuation is unverified per provider. A lane
  that cannot continue a session cannot sit at a loop node (fix/revise phases).
- **The shipped trace viewer binds 0.0.0.0** (`apps/visualizer/server/index.ts`) — loopback +
  Tailscale on the server.
- **Two mirrored trees** (`adws/` and the skill's `templates/adws/`) drift when maintained by hand.
  Decide one source of truth and sync mechanically; the previous attempt drifted within hours.
  Until mirror-sync lands (installer phase), the factory's own lint/typecheck gates scope to the
  live `adws/` tree — the templates mirror is ruff-excluded, not silently scanned-and-failing.
- ~~**`just` is not installed on the laptop**~~ **Resolved 2026-08-12**: the wizard installed
  just 1.58.0; the justfile carries `set windows-shell := ["cmd.exe","/c"]` and a token-free
  `doctor` recipe the wizard executes as its probe. Winget's "already installed" exit code
  (-1978335189 / 2316632107) reads as installed-PATH-stale, never as failure.
- **Kimi K2.7-code envelope compliance is imperfect** — first response of the first real round trip
  was invalid envelope JSON, recovered on retry 1/2 in the same session. Watch the retry budget
  before batch runs on the test lane.
- **Rich's own box-drawing glyphs still reach stdout** (library output, not source literals). Fine
  on this console; a headless cp1252 pipe on another host is where the bill comes due. Decide before
  the server phase: force an ASCII box style, or pin the child's IO encoding at the spawn site.

## Dead list — killed with reasons, do not resurrect

| Killed | Why |
|---|---|
| `codex review` as a reviewer | Would be the 8th check and 2nd model reviewer. "It's an overkill." |
| Skylos GitHub Action | Raised for an install blocker that turned out Windows-only; a workaround whose reason disappeared is dropped, not re-jobbed. Skylos runs in-run only. |
| git-flow (dev→staging→release) | Three more merge points = three more places finished work strands. Trunk-based instead. |
| Sandboxes in v1 | Own server, own code. Worktrees give parallelism; `writes:`/`protected_files` give safety. pi ships containerization for later. |
| `apps/inkwell` / any external pilot | disler's personal app on `upstream/example` (merge-topology problem); a pilot over-fits the factory to one project. |
| llms.txt / llms-full.txt | Abstract index, no depth — useless for unmonitored coding agents. |
| Context7; NotebookLM as corpus | Cost. |
| GitHub Issues as map/queue | The Kanban and the map would be the same thing in two places; nowhere to put traces or gates. |
| Shepherd | Early alpha; wants to own traces/sessions/isolation — all owned. Kept one idea: `claude setup-token`. |
| agent-os / design-os | Ideas absorbed (selective standards injection → doc-factory; design → its UI/design lens); tools not installed. |
| AEC (prior project) | "Very, very poisonous. Don't even look at it." |
| A custom pi extension for the bridge/merge problem | Config-layer fix (rule 3's merge key), not a new extension. |
| The 2026-08-12 "withdrawal" of cross-family review | Never ratified by the operator. Void — see rule 3. |

## Open questions

- **The daily loop, made legible.** How the operator's day actually runs — which skill fires when
  per entry path (greenfield / brownfield / import / small feature / big feature), and exactly what
  documentation-factory contributes at each. The previous diagram confused him; needs a clean
  visual + a short discussion. **Deferred by the operator (2026-08-12) until the factory is
  visibly running — not load-bearing for the build.** Related fact: **documentation-factory was never edited** — five
  enhancements are agreed but unbuilt: a *front door* ("what are you trying to do?" on invocation,
  then it picks its own mode), *architecture-preflight* (prove reuse-or-new before building), OKF
  provenance frontmatter, plus lens/skeleton additions. Project specifics enter as **rider files at
  Stage 1**, never as edits to the skill.
- **Whether `/to-spec` can batch** (tickets and triage batch; spec looks singular). Parked —
  operator's call after a real attempt.
- **The import path** — the operator's ~60-page platform docs went doc-factory → git → server crash
  → GitBook recovery → 6-7 edit rounds over two months; "probably not an LLM wiki any more." Open
  the docs before choosing a mode.
- **Gate 2 skill** — the pre-merge morning brief conversation; `/code-review`'s axes are the right
  starting shape but it reviews rather than converses.
- **no-mistakes** — decided shape: trimmed to disposable worktree + merge-check into *current*
  `main` + open the PR (its own review/test/docs/lint off). But the operator wants **a proper deep
  study before anything is wired**. Do the study first.
- **OKF bundle shape** and documentation currency (what a project's knowledge base bundle looks
  like on disk).
- **Coding standards** — stored in constitution.md/AGENTS.md/variables registry; operator-seeded on
  greenfield via rider file; extracted on brownfield; injected selectively per agent; enforced by
  code where a predicate can. Fine print unsettled.
- **Session continuity per lane · real concurrency ceilings · provider auth on the headless server
  · artifact retention · multi-project support** (one factory, many projects — answer is probably a
  manifest file, not a system) · **how the factory builds UI for its workload projects**.
- **Lane status is not a design fact** — as of 2026-08-12: Grok token revoked, Codex expired
  (operator re-login pending); ollama-cloud and opencode-go work.

## Provenance

The first attempt (2026-08-11 → 12) lives in **git tag `park/opus5-2026-08-12`** (13 commits) and
**`C:\Users\Mubarak\Documents\sdl-factory-parked-20260812\`** (session transcript, wayfinder
record, CONTEXT.md + its 21 verification corrections, research docs, .env backup). Archaeology
only — this file supersedes all of it. If you must cite the parked CONTEXT.md, check its
corrections file first: 21 of its claims are known wrong.
