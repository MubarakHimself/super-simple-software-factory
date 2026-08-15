# User journeys — the desktop app's behavioral contract (v2)

**What this file is.** The context handoff for the UI implementation session — rewritten against
the operator's v3 screen packet (`factory-ui.zip`: `index.html` + Home, Board, Runs, Docs,
Settings) and the ratified backend that now exists. The screens carry the layout and feel
("Editorial Instrument" — warm dark canvas, amber accent, serif display, mono data); this file
carries what happens, in what order, against which backend contract — and **section "Where the
screens must change"** lists every place a mock's behavior must shift to match the ratified
model. Where a screen and this file disagree about *behavior*, this file wins (the model was
ratified after the mocks were drawn); where this file is silent on *looks*, the screens win
without discussion.

**Authority:** MAP.md "The two-box model" (including THE INTEGRATION BRANCH bullet). The screens'
own index states the thesis correctly: *"Factory is autonomous end-to-end — only human touchpoint
is merge to main."*

**The model in one paragraph.** The laptop is the workplace: planning happens in the operator's
CLI sessions (documentation-factory → `/to-kanban`), and publishing a batch commits cards + docs
and pushes — publishing IS the sync. The server's engine works branch `integration` for as long
as there is work: picks ready cards whose `Needs:` are satisfied, runs them in worktrees on
provider lanes, then autonomously rebases (detached copy), re-verifies, ff-merges each green run
into `integration` and parks its card in `queue/done/` — which is what unblocks dependents.
`main` is human-owned: the operator reviews the assembled shipping report and ships a chunk as
ONE squash commit. `adws/ship_report.py` assembles that report deterministically; the
`/ship-check` skill is the opt-in deep-dive (and can perform the squash on the operator's
explicit word). One provider account = one lane = one quota pool; a lane's slots (default 2) cap
concurrent runs drawing on it.

---

## The screens, inventoried

| Surface | File | What it is (as drawn) |
|---|---|---|
| Shell | all | Sidebar: project switcher (color-codes the accent per project), search, nav Home/Board/Runs/Docs/Settings (+counts), factory-status footer (pulse · "Factory running · 3 active lanes" · queue counts · uptime · Help). Topbar: breadcrumb with project dropdown + **Sync** button. **No Terminal surface** — dropped by design. |
| Home | `home-v2.html` | The arrival surface: time-of-day greeting, the report card ("Is this what we agreed?" + summary + **Review merge queue** CTA → Runs), then run groups: Running / Lane cooldown / In merge queue / Recently merged / Failed. |
| Board | `board-v3.html` | Kanban: Ready / Running / Done columns. Ready cards: T-id, title, lane "unassigned", priority chip. Running cards: adw-id, lane dot+model, phase, elapsed, machine chip. Topbar shows **"Auto-pick from Ready"** pulse. Inspector rail: ticket detail, status rows, **Blocks / Blocked by**, Est. runs, and the note "The factory will auto-pick this when a lane frees up. No dispatch needed — just wait." |
| Runs | `runs-gate-v3.html` | Three columns: run list · detail pane · **Merge queue rail**. Detail views per state: running (beat rail scout→plan→build→review→document + work log), cooldown (banner, last activity, "factory is autonomous — auto-resumes or switches lane, no action required"), merge-queue (diff summary + file list, acceptance walk with per-criterion evidence, commit row, "Park for later"), merged, failed (failure log). Every view has an **Export bar: Copy prompt / Open in Claude Code**. Merge rail: checkbox rows, Select all, **"Merge to main · N selected"**, hint "Each merge creates one commit on main." |
| Docs | `docs-v3.html` | File tree (adws/ · tests/ · docs/ · queue/ · root files) + serif reader pane rendering markdown. |
| Settings | `settings-v3.html` | Split + scope: **per-project tabs = Roster, Lanes**; **global (Factory defaults) tabs = Providers, Machines, Appearance** (enforced in the JS scope switcher). Roster: workhorses table + single reviewer + cross-family auto-detection box. Lanes: "one provider account = one rate-limit bucket" callout, lane rows with enable toggles, Balancing section (max concurrent lanes, retry budget, auto-pick toggle, reviewer-gets-own-lane toggle). Providers: connected list with per-provider auth mechanism + Reconnect/Rotate/Add key + **"Add a new provider…"**. Machines: server rows (name, spec, IP, factory version, status) incl. **"localhost — planning only · no factory"**, default-machine + failover selects, and the callout "Planning happens on your laptop. Factory execution happens on a VPS." Appearance: six named themes, density, mono font, motion. **Add-project modal**: name, repo path, detection rows (Git repository / Factory initialized), sync mode, roster inheritance (defaults / copy / empty). Auto-save status bar, no save button. |

## Backend contracts the app consumes (all exist today unless marked)

| Contract | Shape |
|---|---|
| Queue card | `queue/NNN-slug.md` — header `Status / Adw / Adw-Id / Created / Context / Needs / Feature` + AGENT-BRIEF with acceptance checkboxes. Written by `/to-kanban`'s `publish_batch.py`. Parked in `queue/done/` **by the engine** when integrated. |
| Card lifecycle | `ready-for-agent → running → done (run finished) → integrated (parked in done/, dependents unblock) → shipped (inside a chunk squash on main)`. `blocked` carries a `Blocked-reason:` written into the card. Holding states are engine log truths: "waiting on <cards>" (Needs) and "waiting for lane: <lane>". |
| Engine | `adws/engine.py` on the server (`sdl-engine.service`): pull → adopt → integrate (rebase detached copy + quality re-run + ff-merge + park) → scan → dispatch (cap + lane slots, default 2/lane) → push. Never touches `main`. Health = the footer strip's source of truth. |
| Shipping report | `uv run adws/ship_report.py` (`--pr` / `--changelog` / `--range`): chunk = last shipped tree-point → `integration`; per-card acceptance walk with verdicts only ever `confirmed-by-record` / `cannot-confirm-from-record`. Feeds Home's report card, the merge rail, and the squash body. |
| /ship-check | Installed skill; fires on the copy-prompt or "ship check". Reads the report + range + cards + docs; performs the squash only on the operator's explicit in-session word. |
| Merge (ship) | Laptop-side: `git merge --squash integration` on `main`, commit with the `--pr` body, push. The engine notices main's new tree and the cycle continues. |
| Roster / lanes / providers | `sssf.config.yaml` (per-project roster, git-tracked; UI splice-writes it). Lanes = provider accounts; slots via `--lanes`/`SSSF_LANES`. Providers: pi reads `providers.<id>` in `~/.pi/agent/models.json` (server-side), auth in `~/.pi/agent/auth.json` (0600) — **definitions git-tracked, credentials written over SSH, never git** (see `docs/research/pi-provider-mechanism-2026-08-15.md`). Multi-account = distinct provider ids (`opencode-go-2`). |
| Server connection | SSH under the hood; host+credentials in app settings (main process only). v1: ONE server; the Machines tab renders it + localhost-planning-only. Live run detail (work log, phases) reads the server's `sssf.db` over the connection; card/branch truth arrives by git. |

---

## J1 — First run: install, connect, the factory comes up alone

Screens: Settings → Machines (+ Add server) · footer status strip.

1. Install the desktop app, open it. Nothing blocks on network; empty states are honest and directive.
2. Settings → Machines → **Add server**: host + credentials, one Connect. The app provisions over SSH invisibly: clone if absent, installer server target (which now converges the engine service, its git identity, and `PI_BRIDGE_PATH`), engine up. Plain-words progress, logs one click away.
3. The row appears exactly as drawn: name · spec · IP · "factory · vX" · "connected · N runs". The footer strip goes live (engine health: running/lanes/queue/uptime). `localhost` renders as drawn: "planning only · no factory".
4. Reconnect later = quiet re-verify + idempotent converge (drift repaired, never re-asked).
5. Provider sign-ins that need a human are mediated step-by-step in Providers (J6).

Failure states: unreachable / bad credentials / step failed — named step, retry, never a hiding spinner.

## J2 — Add a project (the modal is the init journey)

Screens: Add-project modal (from switcher or Settings scope list).

1. Name + local repo path. The **Detection** rows probe live: Git repository ✓/✗, Factory initialized ✓/✗ — exactly as drawn.
2. On Add, initialization converges deterministically what detection found missing: git init (offered, never silent), factory stamp, **the `integration` branch** (self-healed from main, pushed), `queue/` seam, KB scaffold, config, engine registration on the bound machine. Park-never-delete throughout.
3. **Sync mode** select maps to engine reality: "Pull on boot" and "Watch" are the engine's normal pull cycle (the engine always pulls; the select tunes cadence/labels, not mechanism); "Manual" is not how the ratified model works — see change-list #10.
4. **Inherit roster from** works as drawn (defaults / copy from project / empty).
5. Project appears in switcher with its color; per-project scope (Roster + Lanes) becomes editable.

## J3 — Plan and publish (the app reflects; planning stays in the CLI)

Screens: Board · Docs · topbar Sync.

1. Planning happens outside the app: documentation-factory (now design-packet-aware, SDLC capture, grill-with-recommendations) → `/to-kanban` (obeys the inventory's `--handoff` order; one subagent per feature on real batches; one publish = cards + changed docs, committed and pushed). **Publishing is the sync — zero app clicks.**
2. Board reflects within a poll: Ready cards named from their files, **Blocked by / Blocks** in the inspector straight from `Needs:`/reverse-`Needs:`, and the auto-pick indicator telling the truth: no dispatch button exists anywhere.
3. Sync states are visible per card: published/on-server/local-only; a card waiting on dependencies shows "waiting on 001-…" rather than sitting mute (change-list #6).
4. Docs renders the same repo the planning wrote: KB docs, specs, queue cards, README — the reader pane as drawn.

## J4 — Watch the factory work

Screens: Board (Running) · Runs (running + cooldown views) · footer.

1. Runs appear with lane, phase, elapsed, machine chip; the detail pane's beat rail + work log stream from the server's db over the connection. The beat rail renders the run's *actual* phase list (chains differ — see change-list #8).
2. **Cooldown** is drawn exactly right and matches the engine: a rate-limited lane pauses the run, the banner counts down, "the factory is autonomous — it will auto-resume… no action required." (Auto-*switch* lane is a later balancer capability — change-list #9.)
3. Green runs integrate autonomously (rebase → re-verify → ff-merge → park). A conflict or red gate flips the card to **blocked with its reason** — a first-class visible state, not a vanished run.
4. The footer strip is the engine's health endpoint; if the engine is down, the strip says so plainly with the one honest action.

## J5 — Review and ship (the merge queue, corrected)

Screens: Home (report card) · Runs (merge-queue view + rail) · export bar.

1. Home greets with the **shipping report** (label changes from "Morning Brief" — change-list #1): the assembled summary from `ship_report.py`, the "Is this what we agreed?" question, CTA → Runs.
2. The merge rail lists **integrated-but-not-yet-shipped** cards, in integration order. Per card, the detail view walks acceptance criteria against the record — verdicts only ever confirmed-by-record / cannot-confirm-from-record, with evidence lines as drawn.
3. **Ship = cut a point on a line, not pick from a basket** (change-list #2): integration is linear, so selection means "ship everything up to here." One bulk action = **one squash commit on main** carrying the `--pr` report as its message. "Park for later" on a mid-line card means "cut the chunk below it" (change-list #3).
4. **Copy prompt** = the `/ship-check` handoff: card names + adw-ids + range, pasted into Claude Code/Codex for the deep-dive; the squash can happen there instead, on the operator's explicit word — same gate, different room. "Open in Claude Code" launches exactly that.
5. After the squash lands on the hub, the engine notices by itself; shipped cards render as shipped (change-list #4).

## J6 — Providers, lanes, roster

Screens: Settings (all three tabs) — drawn almost exactly right.

1. **Providers (global):** the connected list with per-provider auth mechanism is the two-layer truth; **"Add a new provider…"** writes a pi `providers.<id>` entry + lane registration — definitions synced by git, the credential written server-side over SSH, never git. A second account of one provider = a second row = a second lane, as the Lanes callout already teaches.
2. **Lanes (per-project):** the callout is verbatim-correct ("one provider account = one rate-limit bucket"). Lane rows enable/disable; "Max concurrent lanes" = the engine cap; per-lane **slots** (default 2) joins the Balancing section (change-list #5). "Reviewer gets its own lane" as drawn.
3. **Roster (per-project):** workhorses + the one reviewer + cross-family auto-detection served as an API fact. A planning-models section is a later addition (operator's note).
4. Model choice is the operator's alone; the UI never recommends.

## J7 — When things go wrong (the honesty catalog)

Every state is designed, not accidental: engine down (footer + Runs banner) · card `blocked` with `Blocked-reason:` on the card itself (rebase conflict / red gate / missing branch) · run `failed` with its failure log (as drawn) · card holding on Needs ("waiting on <card>") · card holding on a full lane ("waiting for lane: <lane> — 0 free of N") · lane cooldown (as drawn) · publish push rejected ("pull first" as a button) · ship squash refused (dirty tree / diverged — named, never forced) · committer identity missing (loud preflight line naming the fix) · connection lost (state preserved, honest banner). The rule everywhere: name the thing, show the evidence, offer the one honest action. Silence is the bug.

## J8 — A project that trains a model

1. `/to-kanban` publishes the training feature as a **script + runbook card**: acceptance = pipeline runs end-to-end on a smoke slice + runbook present. The factory ships the script; it never starts a full training.
2. The operator runs training on his own machine (workstation, GPU) — one command, out of the box; the runbook says what happens when it finishes.
3. Downstream model-dependent cards state the artifact precondition in their acceptance; a run that can't find it fails fast to `blocked` with the reason.
4. Continuous retraining / shadow rollout is the project's own DevOps code — the factory ships it, never runs it.

---

## Where the screens must change (the operator asked these noted)

1. **Home's "Morning Brief" label** → the shipping report. Same card, same question, same CTA; the summary text comes from `ship_report.py --pr`. The morning-brief *skill* is retired from the flow (parked).
2. **Merge queue semantics**: checkbox-any-subset can't survive linear integration — you cannot ship adw-0472 while skipping adw-0471 below it. Selection becomes a **cut point** ("ship everything up to here"); Select-all = ship the whole line. The rail keeps its look; the interaction gains order-awareness.
3. **"Each merge creates one commit on main"** — keep the sentence, sharpen the meaning: one bulk action = ONE squash commit for the whole selected chunk (never one per run). "Park for later" = lower the cut point, not pluck a card out.
4. **Run/card states**: "merged · main" per-run splits into **integrated** (on integration, in the merge rail) and **shipped** (inside a chunk on main). Board's Done column badges the three: integrated / shipped / failed. The merged-view caption "merged by operator · main branch" becomes chunk-aware ("shipped in chunk of N · <sha>").
5. **Lanes tab gains slots**: per-lane concurrent-run slots (default 2) alongside the existing toggles; "Retry budget per lane" stays drawn but lands with the later balancer round (no backend today).
6. **Board Ready cards** need the two holding states surfaced ("waiting on <card>", "waiting for lane: <lane>") — the inspector's Blocked-by row exists; the card face should hint it too.
7. **Priority chip and "Est. runs"** have no backend field yet: either add optional `Priority:` to the card contract (small) or drop the chip; Est. runs can read the inventory's size hints when present — decide at build.
8. **Beat rail** renders the run's actual phase list from the record (chains differ: some have test, some quality — the two mocks already disagree with each other; the db is the truth).
9. **Cooldown "automatically switch to an available lane"** — engine v1 pauses + auto-resumes; auto-lane-switch is the balancer round. Soften the sentence or gate it on the capability.
10. **Add-project "Manual" sync mode** contradicts the always-on engine — drop it or re-word to cadence choices; the engine always pulls.
11. **Machines**: v1 is one server + localhost; default-machine and failover selects are multi-factory future — keep drawn, disable with an honest "one server in v1" note.
12. **Providers tab title** says "Project 1" in the mock while the scope logic correctly makes it global — fix the label to "Factory defaults."
13. **Docs tree** shows code files with a rendered doc; decide scope at build: KB + specs + queue + README (rendered), code files as plain read-only view.
14. **"Gate 1 removed" (index note)** is right for the app but must not read as removing the rule: Gate 1 (ratifying the plan) lives upstream in the planning sessions (`/to-kanban`'s HITL); the app's only human act is the ship. Keep the two-gates language in Help.
15. **Copy-prompt tooltips** mention "for the morning brief" — becomes "/ship-check".

## Open decisions for the build session

- Where the ship squash executes from the UI: the app shells out to git locally (same as ship-check's sequence) — recommended — or the app only hands off to `/ship-check`. Both keep the human gate.
- Live-detail transport: SSH-stream reads of `sssf.db` (recommended, v1-simple) vs a tunneled read-only API.
- The Sync button's exact scope: fetch+pull laptop repo + refresh server state, with per-card sync badges.
- Whether `Priority:` enters the card contract (change #7).
