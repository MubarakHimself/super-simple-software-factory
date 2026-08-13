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
| **A UI** | Board / Trace / Gate, one app, shadcn, T3 Code's five patterns (`docs/research/t3code-ui-notes.md`), plus a settings panel (roster config, provider auth/keys). Reads SQLite; pi RPC is an option, not the spine. Ships as a desktop app (Electron — Tauri needs the MSVC toolchain this laptop lacks). **Operator ruling 2026-08-12: it is a *control surface / dashboard*, not an "ADE" — the coding happens in the factory, never locally in this window.** |
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

**Operator revision 2026-08-13 morning** (supersedes the earlier pool; GPT subscription lapsed —
out by choice, "overkill", returns only deliberately for big ML batches via the pre-batch panel):

- **Reviewer: Claude only** — Opus 5 or Opus 4.8, operator's pick per run. The one family he
  trusts for review. Cross-family rule fully satisfied (workhorses are xAI/Z.ai/Moonshot/Alibaba).
- **Workhorses: Grok 4.5 · GLM 5.2 · Kimi K2.7 · Qwen (latest)**. Catalog facts: plain "kimi-k2.7"
  does not exist on any lane — `kimi-k2.7-code` IS k2.7 (same weights, sampling tag; plain
  alternative is kimi-k2.6); latest Qwen on opencode-go is **qwen3.8-max** (1M ctx). **Grok 4.5 is
  on BOTH xai AND opencode-go** — two separate quota pools for the same workhorse, a natural
  fallback pair that works before the xai re-login.
- **Documenter: a model we don't lean on** — MiniMax M3, Qwen, or Sonnet 5 ("sitting there doing
  nothing; documenting is not a huge deal").
- **Stick to old models**: Grok 4.6 (released 2026-08-13) explicitly NOT used — protects the
  weekly limit. Most models code well when the work is scoped properly; failures come from
  long-running tasks, which the chunking pipeline prevents upstream.

Sub-agent fan-out counts against the parent's lane.

Lanes: ollama-cloud, opencode-go, openai-codex, xai, claude-bridge (+ a possible direct GLM
account, unconfirmed). **ollama-cloud and opencode-go share one quota** (the key script reads
OpenCode's `auth.json`). Balancing: **least-connections weighted by remaining weekly headroom**;
lane picked when a phase starts and **pinned through that phase and its correction rounds** (a
correction re-prompts the same `--session-id`; per-call balancing converts every fix into a cold
start). 503/529 → backoff and retry same lane; quota exhausted → switch lane; cache support is a
lane-selection criterion. **Test lane: `ollama-cloud/kimi-k2.7-code` — says nothing about the
shipping roster.**

Dead models (cost/evidence, do not re-propose): DeepSeek V4, Kimi K3, GPT 5.6 Luna, Fable 5,
Opus 4.6/4.7, Grok 4.6 (operator: protect the weekly limit). MiniMax M3 rehabilitated 2026-08-13
as a documenter candidate only.

**The balancer — operator-corrected 2026-08-13 noon.** He never refused an agent router (the old
"route is code, not a model" was over-recorded); his standing preference is code, with an agent
where code genuinely can't. Sanctioned hybrid: (a) **per-phase lane picking stays deterministic
code** (arithmetic over headroom, fast, auditable); (b) **a batch-level fan-out planner MAY be an
agent** — armed with usage TOOLS (not guesses), it sizes the night's batch: which cards, how many
worktrees active at once, which lanes carry which roles, staying inside weekly limits ("it can
handle a huge amount of work smartly — longer, but within limits"). (c) **Usage data needs NO
manual entry**: read the harness CLIs' local session logs the way T3/OpenCode do (Claude Code +
Codex write per-session token counts on disk; they land on the server anyway as the bridge
credential surface; pi's own trace covers factory spend) — research task: read T3 Code's and
OpenCode's source for the exact mechanism, incl. remaining-limit retrieval. (d) **The pre-batch
panel** — the deliberate door: GPT returns to subsidize load when the other subscriptions can't
carry it (5.5 for code, 5.6 Sol for intelligence — "GPT can replace Claude everywhere" if needed).
(e) **Activation threshold (decided 2026-08-13, orchestrator's call at operator request)**: the
deterministic balancer runs ALWAYS (it is free arithmetic). The agent fan-out planner activates
only when a batch is real: **more than 10 ready cards**, or **any needed lane under 30% weekly
headroom**, or the operator explicitly asks for an overnight batch. Below that, `work-next` +
arithmetic — no agent in the loop for 14 small things.
**Mid-run limits**: lanes pin per PHASE — a quota death fails one phase; the run parks on its
branch + worktree; `--adw-id` rejoin resumes without redoing finished phases. Build items:
"paused-for-quota" status + auto-resume after window reset; upstream chunking keeps runs cheap and
fast so limits rarely bite mid-run.

**The integration ("merging") answer — operator's 16-features/4-cores scenario, 2026-08-13:**
composition is solved upstream + continuously, never big-bang: (1) the feature inventory declares
**blocking edges** — dependent slices run sequentially, independent ones in parallel; (2)
**trunk-based means continuous integration** — each merged slice becomes the base the next slice
branches from, so "feature 5 builds on merged 1-4" automatically; (3) parallel slices that
secretly collide surface as visible conflicts on the compare page, never silently; (4) the
**merge_check phase** (the rebuilt no-mistakes idea) is the "does slice B still work now that
slice A merged" answer — **its evidence condition is met the moment parallel merging starts; build
it with the balancer round, not after**; (5) the KB's component contracts (interfaces declared
before code) are what make separately-built parts fit at all.

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
3. **UI** — **DONE v1 2026-08-12** (spec `specs/ui.md`; apps/ui — React+Vite+Tailwind+shadcn,
   one Bun process, 127.0.0.1:4700, GET-only over sssf.db; live-tail verified in a real browser;
   queue decided: `queue/*.md` agent-brief files, git-tracked; Gate's populated path now
   real-verified — the first branch-cutting runs exposed a `parentOf` guard bug that made Gate
   show the whole repo as the diff; fixed 2026-08-13, true diffs + compare URLs confirmed live).
   Known cosmetic wart: card titles under 4 words pick up a stray boilerplate token in the branch
   slug — clean fix is a `--slug` flag threaded to `enter_worktree` (small follow-up).
4. **Deployment + shipping roster** — **deployment is not a build phase** (operator ruling,
   restated 2026-08-12 night): run the wizard on any host — laptop, VPS, container — and the SAME
   factory with the SAME capabilities comes up; think "install the product", nothing bespoke per
   host. Anything heavy is a settings toggle, never a host assumption. What actually gates the
   remaining items, by real cause: the shipping roster + lane-balancer intelligence wait on **lane
   auth** (operator re-logins: Grok, Codex — buildable on the laptop the moment lanes answer);
   Skylos *acceptance* waits on a **non-Windows host** (MSVC platform fact); the V1 cold-launch
   probe and Linux desktop packaging wait on **the first fresh deployment**. Plus the two
   `origin/main` log lines (operator-approved "add for now") that evidence-gate the future
   merge_check phase.
5. **Worktree layer** — **DONE 2026-08-13** (spec `specs/worktrees.md`; pulled forward by operator
   overrule — parallel shipping out of the box). Verified live: two real runs overlapped 67s, each
   on its own branch + worktree + venv under `../sdl-factory-worktrees/`; the main checkout never
   moved; reconciliation flags stranded work and exits 1; prune refuses anything unmerged; rejoin
   reuses the tree; the main-checkout tripwire arms at worktree entry (regression-tested).
   Lane-balancer intelligence (weekly-headroom routing) still waits on multiple live lanes.
6. **Dispatcher** — **DONE 2026-08-13**: `just work <queue-file>` / `just work-next` — parses the
   card header, routes by `Adw:` to the 8 writing ADWs, writes `Status:` back
   (ready-for-agent → running → done/blocked), streams the run live, branch named from the card
   title. Proven end to end with a real card through a real run. Moving cards to `done/` stays
   the merge event (Gate's job, never dispatch).

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

**UI tooling note (operator-supplied 2026-08-12):** shadcn ships an official agent skill
(`skills add shadcn/ui` — reads `components.json`, grounds agents via `shadcn info --json`) and a
fully non-interactive CLI (`init --defaults --yes`, `add <c> --yes`, `search/view/docs --json`,
registry MCP). Install the skill into `apps/ui`; UI-touching agents load it — this is the concrete
case of "some agents need skills (the UI agents)". Docs: ui.shadcn.com/docs/skills, /docs/cli.

## Dead list — killed with reasons, do not resurrect

| Killed | Why |
|---|---|
| `codex review` as a reviewer | Would be the 8th check and 2nd model reviewer. "It's an overkill." |
| **no-mistakes (the tool)** | Study-verified 2026-08-12: its push is code-bound to its own agent review — the decided trim is impossible, and untrimmed it stacks a 2nd model reviewer. The idea survives as a future ~100-line `merge_check` code phase, evidence-gated. |
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
- **Whether `/to-spec` can batch** — **RESOLVED 2026-08-13**, the operator's own answer shape,
  built: `/to-spec` never batches; **documentation-factory now emits the feature inventory** at
  Stage 4 (`_docwork/feature_inventory.yaml`: FEAT-ids, scope, ledger tracing, blocking edges,
  size hints; gated by `validate_inventory.py`, selftest green). The spec loop consumes one
  feature per pass; tickets arrive pre-chunked. **Still to do: the first real run over the
  operator's platform docs** — that is day-one work, not charting.
- **Codex skills compatibility** — **RESOLVED 2026-08-12** (`docs/research/codex-skills.md`,
  verified). Codex scans `~/.agents/skills`; skills.sh already installed the whole Pocock chain
  there with `~/.claude/skills` symlinked in — it was live in Codex all along, including Pocock's
  own #516 fix (`agents/openai.yaml`, `allow_implicit_invocation: false`) on 27 skills. The two
  new skills (documentation-factory, queue-publish) were Claude-side-only; now junctioned into
  `~/.agents/skills` so Codex, Claude Code and pi read the same bytes. Wizard follow-up: an
  idempotent skill-address step (real copy or link present in `~/.agents/skills` per skill).
- **The import path** — the operator's ~60-page platform docs went doc-factory → git → server crash
  → GitBook recovery → 6-7 edit rounds over two months; "probably not an LLM wiki any more." Open
  the docs before choosing a mode.
- **Gate 2 skill** — **DONE 2026-08-13**: `/morning-brief` (installed, Codex-visible). Plain-words
  per-run narration from the real trace db (`scripts/collect_runs.py`, read-only, honest nulls),
  the "is this what we agreed?" conversation, ends with the compare link as the only merge button.
  Never runs a git/gh command that writes. Unproven end-to-end against a real GitHub compare link —
  first real merged run closes that. **What the review references (operator question, decided
  2026-08-13): the run's own TICKET — its acceptance checkboxes** — because the ticket is the
  sharpest distillation of docs → ledger → spec, so checking the ticket IS checking the docs.
  Enhancement queued: the brief pulls the run's Kanban card and walks its checkboxes against
  evidence, leveraging `/code-review`'s spec axis (no new skill family).
- **Codebase hygiene (operator standing want, 2026-08-13)**: clean, organized repo with a map.
  All cache dirs are gitignored; **`just clean` shipped same day** (`adws/clean.py` — regenerable
  caches only, hard-excludes .venv/.git/.claude/adw_data, structurally cannot reach worktrees).
  The wiki/KB syncs by GIT — the knowledge base lives as files in the project repo, so server
  agents read it from their checkout; laptop-to-server doc sync is push/pull, nothing extra.
- **Operator working split (2026-08-13)**: he front-loads the agentic-harness core in Claude Code
  by day (high-control work); the factory eats the pre-chunked Board slices overnight. Same
  project, distributed load — the design's intended shape, not an exception.
- **503/529 backoff does not exist in the agent path** (agent_pi/agents have no retry-on-overload;
  the lane has simply never 503'd during a verified run since the fix rounds). Add bounded backoff
  at the pi-spawn site before any batch run leans on the test lane.
- **no-mistakes** — **STUDY DONE 2026-08-12** (`docs/research/no-mistakes-study.md`, adversarially
  verified). The decided trim is **refused by the tool's own code**: `push.go` will not push/PR
  without a completed round of its own agent review, and no persistent skip exists — so adopting it
  means keeping an 8th check and a 2nd model reviewer (both dead-listed). 5 of its stages duplicate
  factory mechanisms. Its one unique signal — does this branch still work merged into *current*
  `main` — is real and nothing in the factory checks it today. Verdict per T26's own fallback:
  **the tool is out; rebuild the thin version ourselves (~100 lines, `kind="code"` merge_check
  phase) — but only after evidence**: first add two `ph.log()` calls recording `origin/main` at
  branch-cut and at Gate; build the phase when the log shows `main` actually moves mid-run (or the
  server phase lands parallelism). Follow-ups: drop the wizard's now-pointless no-mistakes install
  step; add the two log lines.
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
