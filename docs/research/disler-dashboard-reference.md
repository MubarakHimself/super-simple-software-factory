# The disler dashboard, precisely

What disler's (IndyDevDan's) own web UI for the Super Simple Software Factory actually shows, and how — the thing the operator remembers as "simple, all it showed him was what's going on currently, which agent is doing what, and the responses or the outcomes."

## Sources and how they were checked against each other

1. **Local visualizer source** — `.claude/skills/sssf/apps/visualizer/` (Vue 3 + TypeScript client, Bun server, reads a SQLite file). This is the primary source below.
2. **The videos** — `docs/research/video-1-notes.md` (pure lecture, no UI shown at all) and `docs/research/video-2-notes.md` ("My Super Simple Software Factory", the one that shows the dashboard on screen). YouTube captions 429-rate-limited again on this pass, exactly as flagged; a frames-only re-check was run with the `watch` skill against 15 specific timestamps in video 2 (0:10, 2:36, 3:52, 4:03, 11:40, 12:12, 13:05, 13:12, 13:58, 14:22, 14:48, 20:48, 21:10, 27:21, 28:20).

Those 15 frames **confirm the local visualizer source is a near pixel-for-pixel match of what disler actually runs** — same breadcrumb text ("Super Simple Software Factory › sessions › {adw_id}"), same run header layout (status chip, started-at, cost, duration, tokens, read, written icons), same swim-lane layout (engineer / code / planner / builder / reviewer / documenter), same session-card grid with mini timelines, same phase-drawer sections (agent config, compiled prompts with line counts, gates with checks/attempt, cost, outputs as JSON, right-column event list). Everything below is written from the code, with the frame evidence noted inline where it directly confirms a claim. One feature in the code (an "archive"/× button on each session card) was **not** visible or exercised in any of the captured frames — noted as unconfirmed-on-screen where it appears below.

---

## The surfaces

Disler's dashboard is one single-page app with exactly three views, reached by clicking, never by typing a command:

### 1. Sessions gallery (the home screen)

Confirmed on screen at t=13:58/14:22 (list of 6 session cards, header "53 runs" / "54 runs" a few minutes later — the count moves as new runs land) and described narrated in video-2-notes.md §4 ("54 runs").

One card per run (ADW execution), newest first, laid out as a grid. Each card shows, and nothing else:

- **ADW ID** (short hash, e.g. `d140d7dd`) and **ADW name** (e.g. `adw_simple_sdlc`, `adw_plan_build_test`)
- The **request text** — the actual sentence the engineer typed, truncated
- A **miniature swim lane per agent** inside the card: one row per agent that touched the run (`planner`, `builder`, `reviewer`, `documenter`, …), each a horizontal strip of small dots marking events over time — a shrunk copy of the full trace view, so you can tell "who did what, roughly when" without opening the run
- A **status pill** (success / fail / running) and a row of small dot glyphs, one per phase, colored by that phase's outcome
- **Cost, wall-clock duration, and total tokens** as three small stat chips
- The date/time it started

Nothing on the card is a button that starts anything. Clicking anywhere on the card (except one small corner control, see below) navigates into that run's trace view.

### 2. Run trace view ("swim lanes" / waterfall)

Confirmed on screen at t=2:36, 12:12, 13:12(top), 20:48–27:21 across three different runs.

One horizontal lane per actor in the run, top to bottom:

- **The engineer** (a named person, e.g. "IndyDevDan") — the request that started the run
- **`code`** — the deterministic, non-agent steps (commit, quality checks) shown as small blocks, no cost/tokens attached
- **One lane per agent** that participated (`planner`, `builder`, `reviewer`, `documenter`, `scout`, ...) — each lane header shows the agent's name, the exact model it ran on (e.g. `kimi-k3`, `gemini-3.6-flash`, `claude-opus-5`), and a **context-window occupancy bar** ("CONTEXT 6%") for that agent

Each phase appears as a block positioned left-to-right on a shared time axis, so its horizontal position and width literally show when it ran and how long it took. A block carries: a status glyph (✓/✗/●/○), the phase name, its duration, a one-line description, and small tick marks for every tool call inside it. A dashed, unfilled block means "queued, not started yet." Hovering an agent's name or the run's breadcrumb highlights every block that agent owns, tracing its path through the whole run (confirmed at t=21:10 — the planner→builder→reviewer→documenter chain lights up green on hover).

The run header above the lanes repeats the same five numbers as the card: status, started-at, cost, duration, tokens (plus a read/written token split not shown on the card).

### 3. Phase detail drawer (click any block)

Confirmed on screen at t=13:05–14:48 (the `plan` and `build` phases of run `ad066baa`).

Clicking a phase block opens a two-column drawer under the timeline. Left column, each section collapsed by default and opened on click:

- **agent config** — the resolved model, thinking level, tool allowlist, harness extensions, session ID
- **description** — the one-line purpose of this phase
- **compiled prompts** — the *exact* system and user prompt text sent to the agent, with line counts, rendered as markdown with a raw-text toggle
- **gates** — each deterministic pass/fail check the phase had to clear (e.g. `artifacts_exist`, `files_non_empty`), with a checks-count, attempt number, and (when recorded) a per-item breakdown of what was actually verified
- **cost** — a token/dollar table broken into input, output, thinking, cache-read, cache-write, and total
- **outputs** — the raw JSON envelope the agent produced (e.g. a `PlanOutput` with `summary`, `artifacts`, `notes_for_next_agent`, or a `BuildOutput` with `changed_files`, `commit_message`)

Right column: a chronological **event log** for that phase — every `phase_start`, `agent_start`, `tool_call` (with the literal command and its duration), `gate_pass`/`gate_fail`, `handoff`, `agent_end`, `phase_end` — each row expandable to show the tool's raw arguments and result snippet.

This is the densest surface in the app. Nothing here is summarized or interpreted — it is the raw record of what the agent was told, what it did, and what it produced, laid out for reading, not for acting on.

---

## Data source

One local SQLite file (`adws/adw_data/sssf.db`, WAL mode) that a Python module (`tracer.py`) writes to directly and completely, in real time, as the ADW pipeline runs. The prompts shown in the drawer are the one exception — they live as separate markdown files on disk (`{data_dir}/sessions/{adw_id}/{agent}/prompts/`), not in the database.

The UI never talks to an agent, a model, or the pipeline. It talks to a small read-only JSON API (`GET /api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/events`, `/…/envelopes`, `/…/gates`, `/…/agents/:agent/prompts`) that queries that one file. The client polls every 500ms — there is no websocket, no push. The server's own doc comment states the design outright: *"Reads are read-only… There is no ingest endpoint and no websocket. The data path is agents → sqlite → web UI, and the UI gets there by polling."*

---

## Interaction surface — what you can actually do in the browser

- Browse the sessions gallery
- Click a card to open its trace
- Click a phase block to open/close its detail drawer
- Click any of the seven drawer sections to expand/collapse it independently
- Toggle a compiled prompt between rendered-markdown and raw text
- Hover an agent lane or the breadcrumb to highlight that agent's phases
- Navigate by breadcrumb (`sessions › {adw_id} › {phase}`) — this is the entire URL/routing scheme
- One write action exists in the code: a small "×" on a card that archives (hides) a finished run from the gallery — a personal triage flag, not something that touches the run itself. **This specific control was not visible or used in any of the captured video frames**, so treat it as present in the shipped code but not confirmed as something disler demonstrated on camera.

That is the complete list. There is no field anywhere in the UI you can type into to start, retry, or modify a run.

## Where the actual control lives — outside the browser entirely

The captured frames make this concrete, not just inferred:

- A `justfile` (shown on screen at t=11:40) exposes the real verbs: `plan *ARGS`, `build-test *ARGS`, `kill ADW_ID`, `tail ADW_ID`, `procs ADW_ID`, `phases ADW_ID`, `sessions`, `obs` (opens the dashboard), among others. **Killing a running agent is a terminal command, not a dashboard button.**
- All of it is normally driven through a **chat conversation with an orchestrator agent in the terminal** (his own tool, "Herder", standing in for tmux) — the frames at t=3:52 and t=14:22 show that orchestrator listing available ADWs, reporting a finished run's phase table and git diff stat in plain text, and asking "Worth an eyeball in the browser… or shall I leave it?" before taking the next prompt. The browser dashboard is where you go to *look*; the terminal is where you go to *act*.

---

## What it deliberately lacks

- **No terminal, no chat box, no way to send a new prompt** from inside the dashboard. Every run is started from a CLI or from the terminal-based orchestrator, never from the web page.
- **No start / stop / retry / kill controls.** Killing a run is `just kill ADW_ID` in a terminal window, not a button next to the running status pill.
- **No merge feature, no branch/worktree/sandbox indicator.** Disler says this on camera about the underlying pipeline itself, not just the UI: v1 "is just running this on the main branch… you're going to want a branch, you're going to want to put your agent in a sandbox, and then there's going to be a merge step later on" — none of that exists yet, so there's nothing for the dashboard to show or control.
- **No config editor.** The agent roster (`sssf.config.yaml` — models, tools, prompts per agent) is a YAML file edited by hand or by an agent in the terminal; the dashboard only ever displays the config that was already resolved for a given phase (in "agent config"), never lets you change it.
- **No settings page, no login, no auth of any kind.** It's `localhost` only.
- **No diff viewer.** A build phase's output lists `changed_files` and a `commit_message` as plain JSON text — there is no rendered code diff anywhere in the UI.
- **No cross-run view.** Cost, token, and pass/fail numbers exist per-card and per-run only; there is no weekly/aggregate cost chart, no "which gate fails most," no alerting on a stalled or failed run.
- **No push/websocket.** It is a polling reader, by explicit design, so it can never block or be blocked by the thing it's watching.

---

## The simplicity bar

A one-page checklist of what a status dashboard needs, per this reference, in plain words:

1. **One list of runs, newest first.** Each entry shows what was asked for, when it started, and whether it's running, done, or failed.
2. **A status you can read from across the room.** Green/red/blue/gray, plus a tiny row of dots for each step inside the run — pass, fail, running, or not-started-yet.
3. **A row per agent, showing who is doing what.** Not a generic activity feed — a named lane per actor (the human, the code checks, each agent by name and by the model it's using), so "which agent is on this right now" is a glance, not a search.
4. **A timeline, not just a list.** Steps laid out left to right by when they actually happened, so you can see what's happening *now* without doing math on timestamps.
5. **Click a step to see what it actually produced.** Not just a checkmark — the real output: what the agent decided, what it changed, what it handed to the next step.
6. **Cost and effort are always on screen**, per step and for the whole run — never a mystery you have to go dig for.
7. **When something fails, the reason is right there** next to the failure, not buried in a log you have to go find.
8. **It only shows — it never does.** No buttons to start, stop, retry, or configure anything. All control happens somewhere else (a terminal, an agent you talk to); the dashboard's one job is to tell the truth about what already happened and what's happening now, refreshed automatically.
9. **Dense detail is there, but hidden until asked for.** Nothing about the design load fires until it's clicked open — the default view stays as bare as the summary above.
10. **It doesn't break on old or partial data.** A run from months ago, or one missing a field a newer run has, still renders — it just shows less, never an error.
