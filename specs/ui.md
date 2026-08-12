# specs/ui.md - Phase 3: the UI

Build phase 3 of MAP.md: **Board / Trace / Gate, one app, plus a settings panel.**
Authority order: MAP.md > `docs/research/t3code-ui-notes.md` > live data
(`adws/adw_modules/tracer.py`, `adws/adw_data/sssf.db`) > the shipped Vue visualizer
(read-only reference). Parked material is archaeology.

Taste, from the operator: *"it needs to look like an actual development environment,
not a dashboard."* Dark, IDE-like, dense. shadcn. **Don't overcook it.**

ASCII only throughout - source, console output, and UI strings. cp1252 killed 100% of
headless runs once already (MAP landmine).

---

## 1. Scope

| In v1 | Out of v1 |
|---|---|
| Trace: sessions -> run -> phases/events/envelopes/gates, live by polling | Any write to sssf.db (incl. archive) |
| Board: the queue, read from `queue/*.md` | Kill / requeue / start-a-run buttons |
| Gate: runs waiting on the pre-merge brief, with the PR link | Auth, accounts, TLS |
| Settings: read-only roster + lane status + paths | Editing config from the UI |
| One Bun process, loopback only | pi RPC, websockets, SSE |
| Dark theme only | Light theme, mobile layout, multi-project switcher |

**Non-negotiables**

1. The db is opened **readonly** and the HTTP server answers **GET only** (405 on
   anything else). This deliberately drops the shipped visualizer's one write
   (`POST /api/sessions/:id/archive`).
2. `Bun.serve({ hostname: "127.0.0.1" })`. The shipped visualizer omits `hostname` and
   therefore binds 0.0.0.0 - the MAP landmine. Reach it over Tailscale or an SSH tunnel.
3. **Never mock data** (MAP rule 6). A surface with no upstream renders a real empty
   state that names what will fill it. Copy is fixed in section 8.
4. **Never render a bare enum, never invent progress.** Every status is
   `dot + bold identifier + one plain sentence`; there is no progress bar and no percent
   anywhere, because nothing in the system knows how far along a run is.
5. Do not touch `.claude/skills/sssf/templates/`, `adws/adw_modules/`, or `adws/adw_*.py`.
   `just obs` keeps working, on its own ports, untouched.

---

## 2. Stack and process shape

- **React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui** (components vendored into
  `apps/ui/src/components/ui/`, `components.json` at the app root).
- **One Bun process** (`apps/ui/server/index.ts`) serves the built `dist/` and the JSON
  API from the same origin. No proxy in production, no second process to babysit.
- **Port 4700, fixed.** If the port is taken the process exits 1 with
  `[ui] port 4700 is in use - stop the other ui process` - it never auto-increments,
  because an operator has to know where the UI is. (`just obs` uses 4600/4601; the Vite
  dev server, when used, takes 4710 and proxies `/api` to 4700.)
- **Db path is a CLI argument**, not an env var: `--db <abs path>`. `just obs` needs an
  OS-specific body only because it must set an env var and background a process; passing
  `--db` and running one foreground process makes `just ui` a single body for
  cmd.exe and sh alike.
- Deps beyond the framework: `yaml` (parse `sssf.config.yaml`). Nothing else new.
  SQLite is `bun:sqlite`; git is the `git` binary via `Bun.spawn`.

### justfile

Appended after the `obs` recipe; `obs` is not modified.

```
# --- factory ui -------------------------------------------------------------
# One Bun process: builds the SPA, then serves it plus the read-only JSON API
# on 127.0.0.1 only. The db path is passed explicitly so the server can run
# from the app dir. Needs bun.

# boot the factory ui, http://127.0.0.1:4700  (Board / Trace / Gate / Settings)
ui:
    cd apps/ui && bun install && bunx vite build && bun run server/index.ts --db {{justfile_directory()}}/{{db}}

# ui with hot reload for development, http://127.0.0.1:4710 (api still on 4700)
ui-dev:
    cd apps/ui && bun install && bunx vite
```

`ui-dev` assumes `just ui` is already running for the API; the Vite config proxies
`/api` to `http://127.0.0.1:4700`. That is stated in the dev-server banner.

---

## 3. Data: only what already exists

The 7 tables in `tracer.py` plus files on disk. Nothing is added, no migration, no
new writer.

| Source | Surface |
|---|---|
| `sessions` (adw_id, adw_name, request, status, engineer, started/ended, tokens, cost, archived) | Trace L1 rows, Gate eligibility |
| `phases` (seq, name, kind, owner, description, status, attempt, retries, error, started/ended) | Trace L2 timeline + work-log headers |
| `events` (rowid cursor; types seen live: `log`, `tool_call`, `phase_start`, `phase_end`, `handoff`, `agent_start`, `agent_end`, `error`, `gate_pass`) | The work log, the live tail |
| `envelopes` (agent, output_type, payload_json, valid, attempt) | Inspector: Envelopes tab, incl. invalid attempts |
| `gate_results` (gate, passed, violations_json, checks_json) | Inspector: Gates tab, Gate cards |
| `processes` (pid, command, ended_at NULL = believed alive) | Run header: "2 processes alive", stall detection |
| `agent_sessions` (coding_agent, model, color, session_id, context_tokens/window) | Agent chips, lane colors, Settings lane status |
| `adws/adw_data/sessions/<adw_id>/<agent>/prompts/{system,user}.md` | Inspector: Prompts tab |
| `adws/adw_data/sessions/<adw_id>/context_handoff/changes.diff` | Diff surface, Gate diff summary |
| `adws/adw_sssf_config/sssf.config.yaml` | Settings |
| `queue/*.md` | Board |
| `git` (read-only commands) | Branch state, compare URL, per-phase diffs |

### Reading the schema honestly

Three traps in the live data, each with a required rendering rule:

1. **`phases.status` defaults to `fail`** in the table DDL but the runner inserts
   `running` and updates on completion. A phase with `ended_at IS NULL` is **running**,
   never failed - derive liveness from `ended_at`, not from the string alone.
2. **A killed run leaves `status='running'` forever.** If a session is `running` and
   (no event newer than 5 minutes) and (no `processes` row with `ended_at IS NULL`),
   render `Stalled - no events for 14m, no live process. Last phase: build.` It is not a
   new status; it is an honest sentence attached to `running`.
3. **`total_tokens` is a spend number** (every turn re-sends the conversation). Show it
   as `spend`, and show the derived read/written split beside it, exactly as the
   visualizer's `usage()` does - derived from `agent_end` payloads, no migration.

`sessions.archived` is displayed as a dim `archived` tag if some other tool set it.
This UI never writes it.

---

## 4. API - GET only, read-only

All JSON, `cache-control: no-store`. Every handler wrapped so a malformed query returns
500 with a message instead of killing the server. `adw_id`, agent names and phase ids are
validated against `/^[A-Za-z0-9._-]+$/`; shas against `/^[0-9a-f]{7,40}$/`. Nothing from a
request is ever interpolated into a shell string - `Bun.spawn` with an argv array only.

```
GET /api/health              { ok, db, journal_mode, read_only: true, sessions,
                               queue_dir, git: { repo, branch, remote } }
GET /api/sessions?limit=200  [ session + phases[] + agents[] ]           (L1 needs all three)
GET /api/sessions/:id        { session, usage, phases, agents, processes }
GET /api/sessions/:id/events?after=<rowid>&limit=500   { events, cursor, has_more }
GET /api/sessions/:id/envelopes
GET /api/sessions/:id/gates
GET /api/sessions/:id/prompts/:agent   { system, user }   (null when the agent never ran)
GET /api/sessions/:id/diff?scope=run|<phase_id>          { base, files[], added, deleted, patch, truncated }
GET /api/queue               { dir, items[], unparsed[] }
GET /api/gate                { items[] }
GET /api/config              { roster, lanes, observability, paths }
```

Anything else: 404 for `/api/*`, SPA fallback otherwise. Non-GET: 405
`{"error":"this ui is read-only"}`.

**Polling** (no push; the data path is agents -> sqlite -> ui, as tracer.py says):
sessions list every 2s; events for a *running* session every `observability.poll_ms`
(500ms) using the rowid cursor; a finished session is fetched once and then left alone;
all polling pauses when `document.visibilityState === "hidden"`. The top bar carries
`Live . updated 2s ago` / `Paused` / `Stale` with a manual refresh - T3's
`Checked 1m ago` idiom.

---

## 5. Surfaces

### 5.1 Shell

```
+--------------------------------------------------------------------------------+
| SDL FACTORY   trace / 92681586 / 02 scout        Live . updated 1s ago   [db]   |  28px
+--+------------------+-------------------------------------+-------------------+
|BB| SESSIONS      12 | 01 request  engineer - Mubarak       | DETAIL ENVELOPES  |
|TT| .................| Capture the incoming ask             | GATES PROMPTS DIFF|
|GG| * Running        |   Worked for 0.0s >                  | ................. |
|SS| 92681586    2m   |                                      | phase 02 scout    |
|  |   scout          | 02 scout  agent - scout              | ollama-cloud/     |
|44| * Success        | Find and report where things live    |  kimi-k2.7-code   |
|px| 2d747819    5m   |   >_ ls  .                        ok |                   |
|  | * Success        |   + 18 earlier tool calls            | envelope valid    |
|  | 81fb0565   34m   |   ... Working for 28s                | attempt 1         |
|  |            260px |                       flexible       |             420px |
+--+------------------+-------------------------------------+-------------------+
```

- **Activity rail, 44px**: four icon buttons - Board, Trace, Gate, Settings - with a
  count badge each (queue items ready, runs live, runs waiting on the gate). Active gets
  a 2px left accent bar. This is the whole navigation. No tabs, no router beyond
  `/board`, `/trace/:adw_id?`, `/gate`, `/settings`.
- **Sidebar, 260px**: surface-scoped. Trace -> run list. Board -> status filter + counts.
  Gate -> waiting runs. Settings -> section nav.
- **Main pane**: the surface.
- **Right inspector, 420px, toggleable** (`shadcn/resizable`): Trace only in v1.
- Keyboard: `Ctrl+K` opens a run/queue filter over the sidebar; `1..4` switch surface;
  `j/k` move the sidebar selection; `Esc` closes. A keycap legend footer on the filter
  overlay, as in T3.

### 5.2 Trace - first-class, real data now

**L1 (sidebar).** One row per session, 24px:
`[dot] [adw_id mono] [request, truncated] [relative time]`. Dot+word chip only for
`running` (cyan) and `fail` (red); `success` rows are dim with no chip, so the eye finds
what needs attention. Second line, dim 11px: `adw_name . engineer . N phases . agents`.
Hover swaps the timestamp for row actions (copy id, open trace). Two runs showing
`Running` at once is the point - concurrency legible with no extra chrome.

**L2 (main pane), top to bottom:**

1. **Run header** - the status triple, never a bare enum:
   `* Failed - quality phase exited 1 after 10.3s, 4 attempts` /
   `* Running - phase 02 scout, 28s elapsed, 1 process alive`.
   Under it a row of static metadata pills (T3's composer pills, display-only): adw_name,
   engineer, model(s) with the agent's color dot, session id, branch if one exists,
   `spend 71,380` / `read 63k . written 1.2k`, base ref.
2. **Phase timeline** - a horizontal strip of `NN name` chips in seq order, colored by
   status, current one ringed. Click scrolls the log and loads the inspector. This is
   T3's `STEP 1 / STEP 2` stepper doing an honest job.
3. **Work log** - the heart. Rules, in order of importance:
   - Each phase renders as a **narrative header**: `NN name` bold white, then
     `kind - owner` dim, then the phase `description` as the sentence
     (the description is mandatory in `PhaseParams` precisely so this line exists).
   - Under it, events in rowid order. A run of `tool_call` events **collapses to a
     counted stub**: the most recent stays expanded, the rest fold into
     `+ 18 earlier tool calls`, expandable. Same treatment for consecutive `log` lines
     (`+ 12 log lines`). This is what lets a 400-event stream render as a screenful.
   - A tool call is one 22px row: `>_` glyph, bold type (`tool` / `ran command` /
     `changed files`), payload dim mono (`ls .`, `read README.md`), right edge `ok` /
     `err` plus a chevron. Expanded shows `args` and `result_snippet` from the payload.
   - `error` events **never collapse**. They render as a red-railed block: a plain
     English line first (`quality phase failed - lint exited 1`), then the raw output in
     a `<pre>`. Raw text is kept in full - T3's leaky `invariant failed` string is the
     anti-pattern only because nothing explained it, not because it was raw.
   - `agent_start` / `agent_end` / `handoff` render as thin hairline rules carrying the
     model chip, session id and, on end, the usage split.
   - **The elapsed component**: one component, two tenses, same row position.
     Running: `... Working for 2m 22s`, ticking, animated dots, dim. Ended:
     `Worked for 1m 51s >`, frozen, collapses the phase. No spinner, no bar, no percent.
   - A floating `v Scroll to end` pill appears when the log is tailing and you have
     scrolled up.
4. **Inspector tabs** (right pane, phase-scoped): **Detail** (phase row fields, attempt,
   retries, error, timings) . **Envelopes** (payload pretty-printed, `valid` badge,
   attempt number - invalid attempts are shown, not hidden; Kimi's first-attempt envelope
   failures are a real fact of this lane) . **Gates** (per gate: passed badge, the
   `checks_json` list as `item / ok / note`, violations) . **Prompts** (the exact system
   and user markdown the agent was sent) . **Diff** (5.2.1).

**5.2.1 Per-phase diff scoping.** The highest-value observability feature in the T3
notes, made honest against what this factory actually records:

- Selector: `Whole run | 01 commit_plan | 02 commit_build | 03 commit_docs`, built from
  the shas that git phases log (`ph.log(sha=...)` writes a `log` event whose payload
  carries `sha` and `message`).
- A commit phase diffs `<previous sha>..<sha>`; **Whole run** diffs first-parent..last
  sha, or falls back to `context_handoff/changes.diff` when the run captured one and made
  no commits.
- Header shows the `BaseRef.reason` string the factory already records, so nobody has to
  guess what a diff was measured against.
- Summary card first (`3 changed files  +47 -12  Show files`, grouped by directory, per
  file `+N -N`, `Show all N files`), patch below, unified, capped at 2000 lines with an
  explicit `truncated at 2000 lines` line.
- No commits and no captured diff: `This run made no commits and captured no diff.
  Diffs appear for chains that reach a git phase (plan-build and up).`

### 5.3 Board - the queue

**Decision: queue items are markdown files in `queue/` at the repo root, one file per
item, git-tracked.**

Why there, and why not in sssf.db: MAP calls the queue "local, **not** GitHub Issues",
durable, and the seam between laptop planning and the server factory. Markdown files in
git give exactly that - authored by a planning session with no server running, diffable,
reviewable, carried laptop -> server by `git pull`, and readable by the ADWs without the
UI being up. Putting the queue in sssf.db would make the UI a writer (breaking the
read-only posture), hide the items behind a running process, and mix human-authored
intent into a table that tracers own. A `Status:` line is a one-line write-back that any
future code node can do with a file edit; a db row is a system.

```
queue/
  TEMPLATE.md          the contract, copied to start a new item
  001-add-health-endpoint.md
  002-fix-cp1252-in-tail.md
  done/                items merged, moved here (park, never delete - MAP rule 5)
```

**Item format.** The body is the `AGENT-BRIEF.md` contract from the installed `triage`
skill (durability over precision, behavioral not procedural, complete acceptance
criteria, explicit scope). The UI only parses the header block - the contiguous run of
`Key: value` lines directly under the H1:

```markdown
# Add a /health endpoint

Status: ready-for-agent
Adw: simple-sdlc
Adw-Id:
Created: 2026-08-12
Context: DEC-0042, COMP-0007

## Agent Brief

**Category:** enhancement
**Summary:** one line
**Current behavior:** ...
**Desired behavior:** ...
**Key interfaces:** ...
**Acceptance criteria:**
- [ ] ...
**Out of scope:** ...
```

`Status:` is one of `ready-for-agent | running | blocked | done`. `Adw-Id:` is empty
until a run claims the item; when set, the card links straight to that run's trace.

**Rendering.** Four columns by Status, each a dense list of 3-line cards (title bold;
`Adw . Category . created` dim; acceptance-criteria progress as `0/4 criteria` - counted
from checkboxes, not invented). A fifth column, **Unparsed**, holds files that are missing
a `Status:` line or have an unknown value, each with the reason - a malformed item is
visible, never silently dropped. Clicking a card opens the rendered markdown in the main
pane, read-only, with a `queue/001-....md` path chip to open in an editor.

**The UI never writes queue files.** This phase ships the `queue/` directory, `TEMPLATE.md`
and this documented contract; authoring stays with the planning chain and the operator.

### 5.4 Gate - runs waiting on the pre-merge brief

**Eligibility** (all three, computed per request):
1. `sessions.status = 'success'`, and
2. a branch `adw/<adw_id>_*` exists (the `git_helper.run_branch_name` convention), and
3. that branch is **not** an ancestor of `main`
   (`git merge-base --is-ancestor <branch> main` returns non-zero).

Ordered by `ended_at` desc. A failed run is not gate work - it is trace work, and it
links there.

**Card** (this is Gate 2's raw material, not a decision engine):
- Status triple: `* Waiting - built 14m ago on adw/9268_add-health, 3 files +47 -12`.
- Diff summary card, from `context_handoff/changes.diff` plus the ChangeSet counts, with
  the same phase selector as 5.2.1.
- Verification strip: quality block result, gate rows (`artifacts_exist` etc.) with their
  `checks_json` items, and the reviewer envelope's `summary` verbatim - the one sentence
  that says whether this did what the ticket asked.
- **`Open pull request`** - the merge button, and it is a link. Built from
  `git remote get-url origin`, normalized (`git@github.com:o/r.git` and https forms) to
  `https://github.com/<owner>/<repo>/compare/main...<branch>?expand=1`. No remote, or a
  non-GitHub remote: the button is replaced by the branch name and the exact push command
  as copyable text. **The UI never runs `gh`, never pushes, never merges.** The merge
  stays human, on GitHub, from any device - which is the operator's stated merge button.
- `Open trace` next to it.

### 5.5 Settings - read-only in v1

Full-pane, own section nav, ~640px content column (this is the one place T3's low density
is right).

- **Roster** - one card per agent from `sssf.config.yaml`: color dot, bold name, model in
  dim mono, `purpose` as the sentence, then `thinking`, `tools`, `writes`
  (`writes: []` renders as `read-only with respect to the repo`),
  `harness_engineering`. Defaults shown once at the top, inherited values marked
  `inherited`.
- **Lanes** - the status triple, derived **only from real round trips**, because
  `pi auth check` lies in both directions (MAP landmine). Per distinct
  `provider/model` seen in `agent_sessions` + `agent_end` events:
  `* ollama-cloud/kimi-k2.7-code - last real round trip 2h ago, 71,380 tokens, 12 runs`.
  A lane configured but never exercised on this box:
  `* openai-codex/... - never exercised on this box. A lane is verified only by a round
  trip returning non-zero tokens.` No probing, no liveness claim, no traffic light that
  implies more than the data says.
- **Observability** - db path, `journal_mode`, `poll_ms`, session count, data dir,
  sessions dir, `protected_files`.
- **Paths and process** - bind address, port, build time, read-only banner.

**The settings API never reads `.env` and never returns a key, token or secret**, so
there is nothing to blur. Stated as a rule, enforced by not having the code path.

---

## 6. Design language

Dark only. Near-black, hairlines, dots not icons - T3's palette, at an IDE's density.

| Role | Value |
|---|---|
| Canvas / main pane | `#0A0A0B` |
| Chrome (rail, sidebar, top bar) | `#0F0F11` |
| Elevated (popover, inspector card) | `#17171A` |
| Hairline | `#232326` (1px, everywhere, never heavier) |
| Text primary / secondary / meta | `#EDEDEF` / `#A0A0A8` / `#6E6E76` |
| Accent / focus | `#3B82F6` |
| Running | `#3B9EFF` |
| Success, additions | `#22C55E` |
| Fail, deletions | `#EF4444` |
| Warning / gated / stalled | `#D9A441` |
| Agent lanes | `agent_sessions.color` from the db (`#a78bfa` planner, `#22d3ee` builder, `#fbbf24` scout, `#fb7185` reviewer, `#e879f9` documenter) |

**Density - the one deliberate deviation from the T3 notes.** T3 is Linear-like: 28px
rows, 24px of air, a 640px column. The operator asked for a development environment.
So: **22px log and tool rows, 24px sidebar rows, 12px/17px body, 11px meta, 11.5px mono,
8px gutters, full-width main pane** (no reading-width cap outside Settings and rendered
markdown). Legibility is bought back with the collapse-and-count log and hairlines, not
with whitespace. Elevation is background lightness plus a hairline; radii 4px chips,
6px cards; no shadows.

**Type.** One UI sans (`Inter var` if present, else the system stack) and
`ui-monospace, "Cascadia Code", Consolas, monospace` for anything machine-generated -
ids, models, paths, args, diffs, JSON. Bold is semantic: the thing you scan for.

**shadcn components used** (and no more): `badge`, `button`, `collapsible`,
`dropdown-menu`, `input`, `resizable`, `scroll-area`, `separator`, `tabs`, `tooltip`,
`skeleton`. Tailwind v4 with CSS variables; `class="dark"` fixed on `<html>`; no theme
toggle in v1.

---

## 7. The five stolen patterns, placed

| Pattern (t3code-ui-notes) | Where it lands |
|---|---|
| Collapse-and-count log | Trace work log: phase description as narrative header, last tool call expanded, `+ 18 earlier tool calls` |
| `Working for Xs` -> `Worked for Ys >` | One `<Elapsed>` component; phase rows, run header, Gate cards. No progress bar anywhere |
| Status triple | Run header, phase rows, Gate cards, Settings roster and lanes. `fail` becomes `* Failed - quality exited 1 after 10.3s` |
| Per-phase diff scoping | `Whole run / NN commit_*` selector over commit shas the git phases already log |
| Sidebar-as-run-board | Trace L1: 24px rows, chips only for running/failed, two concurrent `Running` rows legible at once |

Runners-up taken: the floating `Scroll to end` pill, the keycap legend footer, the
`STEP` strip as the phase timeline, borderless tables, `Checked 1m ago` + refresh.
Explicitly skipped: composer and everything hanging off it, interactive git, T3's
sub-agent table.

---

## 8. Honesty rules and empty-state copy (verbatim)

MAP rule 6 in UI form: a surface whose upstream does not exist yet says so, in plain
English, naming what will fill it. No placeholder cards, no sample rows, no "demo mode".

- **Board, empty `queue/`:**
  `No queue items. The Board reads queue/*.md - one markdown agent brief per item, with
  a Status: line. Nothing writes them yet: the planning chain (plan -> triage ->
  ready-for-agent) will. Start one by copying queue/TEMPLATE.md.`
- **Gate, no eligible runs:**
  `No runs are waiting on the pre-merge brief. A run appears here when it finishes
  successfully on its adw/<adw_id>_<slug> branch and that branch is not yet merged into
  main. Today's runs (adw_prompt, adw_scout) are read-only and cut no branch.`
- **Gate, no git remote:**
  `No origin remote, so there is no pull request to open. Push the branch first:
  git push -u origin <branch>.`
- **Trace, empty db:**
  `No sessions yet. Run one: just demo.`
- **Trace, run with no envelopes / gates / prompts:** each tab states which phase kinds
  produce that artifact, rather than showing an empty box.
- **Stalled run:** section 3 rule 2 wording.
- **Never** display `FAILED`, `fail`, `0`, or a raw exception with no sentence in front
  of it. Never display a spinner that implies known progress.

---

## 9. Layout on disk

```
apps/ui/
  package.json  vite.config.ts  tsconfig.json  index.html  components.json
  server/
    index.ts       Bun.serve on 127.0.0.1:4700; GET-only router; static dist
    db.ts          readonly bun:sqlite reader (sessions, phases, events, envelopes,
                   gates, processes, agents, usage) - shaped after the visualizer's
    queue.ts       queue/*.md header parser -> items[] + unparsed[]
    gate.ts        eligibility, diff summary, compare-url derivation
    gitro.ts       allowlisted read-only git via Bun.spawn (argv arrays only)
    config.ts      sssf.config.yaml -> roster, lanes, observability. Never .env
  shared/types.ts  one type file both sides import
  src/
    main.tsx  App.tsx  routes.tsx
    components/ui/*            shadcn
    components/
      Shell.tsx ActivityRail.tsx Sidebar.tsx TopBar.tsx
      RunList.tsx RunHeader.tsx PhaseTimeline.tsx WorkLog.tsx ToolCallRow.tsx
      Elapsed.tsx StatusTriple.tsx Inspector.tsx DiffView.tsx DiffSummary.tsx
      BoardColumns.tsx QueueCard.tsx GateCard.tsx SettingsPanes.tsx EmptyState.tsx
    lib/  api.ts  poll.ts  format.ts  status.ts  tokens.css
queue/
  TEMPLATE.md
```

`node_modules/` and `dist/` are already gitignored.

**Build order** (each step ends with something real on screen):
1. Server: health + sessions + detail + events, readonly, loopback, GET-only. `just ui`.
2. Shell + Trace L1/L2 against the 19 real sessions in the db.
3. Work log: collapse-and-count, `Elapsed`, error blocks, scroll-to-end.
4. Inspector: detail, envelopes, gates, prompts.
5. Diff: whole-run and per-phase.
6. Settings (roster + lanes).
7. Board (`queue/` + TEMPLATE + parser + columns + empty state).
8. Gate (eligibility + diff summary + compare URL + empty state).

---

## 10. Verification

Done means all of these, run for real:

1. `just ui` from a clean checkout serves the built SPA; `curl http://127.0.0.1:4700/api/health`
   returns `ok:true`, `journal_mode:"wal"`, `read_only:true`, `sessions:19`.
2. The listener is on `127.0.0.1` only - confirmed with `netstat -ano | findstr 4700`;
   a request to the machine's LAN address is refused.
3. `curl -X POST http://127.0.0.1:4700/api/sessions/92681586` returns 405.
4. Trace lists the real sessions. `92681586` shows 4 phases, its ~20 tool calls collapsed
   to one expanded plus a count, one `gate_pass` (`artifacts_exist`, `exists, 2.3KB`),
   and `Worked for 28.4s`. `d54475c1` shows the failed quality phase with the real ruff
   output in full, under a plain-English line.
5. `7315acee` shows both envelope attempts - the invalid `{"raw":"OK"}` first attempt and
   the valid retry - as `attempt 1 invalid` / `attempt 2 valid`.
6. A live run (`just scout "..."` in another terminal) appears within 2s and tails at
   500ms; its elapsed counter ticks and freezes on completion.
7. Board shows the empty state verbatim; adding a hand-written `queue/001-*.md` makes a
   card appear with its parsed Status; deleting the `Status:` line moves it to Unparsed
   with the reason.
8. Gate shows its empty state (no branch-cutting run exists yet in this db).
9. Settings lists 5 agents and one lane, `ollama-cloud/kimi-k2.7-code`, with a real
   last-round-trip timestamp; no key or `.env` value appears anywhere in any response.
10. `just obs` still boots on 4600/4601 with the UI running. No file under
    `.claude/skills/sssf/templates/`, `adws/adw_modules/`, or `adws/adw_*.py` changed.
11. Server console output and every UI string are ASCII.

---

## 11. Open items (deferred on purpose)

- **Writes.** Archive, kill-a-run (the `processes` table has the pids for it), and
  requeue are all one POST away and all deliberately absent from v1. Revisit only after
  the server phase, and with the read-only posture stated as the default.
- **Status write-back to `queue/*.md`** - a code node in the planning/dispatch chain, not
  a UI feature. The `Adw-Id:` field is the seam and is already in the format.
- **pi RPC** (`--mode rpc`, `get_entries` with a cursor, `abort`) - an option, not the
  spine (MAP). It buys live streaming and a stop button at the cost of the UI holding a
  process handle. Not v1.
- **Multi-project** - one factory, many projects is probably a manifest, not a system
  (MAP open question). The db path is already a CLI argument, which is the whole hook.
- **Gate 2 conversation skill** - the brief itself is a skill, not a screen. This surface
  only assembles its raw material.
- **Light theme** - the notes flag dark-only as a real risk for daylight work. Rejected
  for v1 as scope, not as a principle.

---

## 12. Desktop shell (Electron) - the control surface as a window (NOT an "ADE": operator ruling, coding never happens locally here)

The desktop app: the same server and web UI above, opened in a native window instead
of a browser tab. No server behavior changes - `just ui` is untouched, the server is still
127.0.0.1-only and GET-only, and nothing here writes to `sssf.db`. Windows laptop; prebuilt
binaries only (no Rust, no MSVC, nothing compiles native code).

**Process shape.** `apps/ui/electron/main.ts` (compiled by `tsc` to
`apps/ui/dist-electron/main.js`, referenced as `package.json`'s `main`):

1. `GET http://127.0.0.1:4700/api/health` once. If it answers `ok:true`, that server is
   **reused** untouched - the operator may already have `just ui` running.
2. Otherwise, walk up from the app's own location looking for the repo (a directory with
   both `justfile` and `adws/adw_data/sssf.db`), then spawn exactly what `just ui` runs:
   `bun run server/index.ts --db <resolved sssf.db path>`, cwd `apps/ui`, as a direct child
   (no shell, so `child.kill()` terminates `bun.exe` itself on Windows instead of an
   intermediate cmd.exe). Poll health every 400ms up to a 20s budget; on timeout, kill the
   child, show a plain-English error (`dialog.showErrorBox` outside `--smoke`), exit 1.
3. Open a `BrowserWindow` at `http://127.0.0.1:4700/`: title `SDL Factory`, dark titlebar
   (`nativeTheme.themeSource = "dark"`, set before window creation), `minWidth 1100 /
   minHeight 700`, `backgroundColor #0A0A0B` (the canvas color from section 6) to avoid a
   white flash before load. `contextIsolation: true`, `nodeIntegration: false`, no preload
   script - the renderer is the same web page `just ui` already serves, nothing new is
   exposed to it.
4. **Window state** - a stdlib approach, no library: bounds + maximized flag read/written
   as a small JSON file at `app.getPath("userData")/window-state.json`, on `resize`/`move`/
   `close`. A remembered position is only honored if it still lands on a currently
   connected display.
5. **Kill-on-quit is conditional**: the spawned child (if any) is killed on
   `window-all-closed`/`before-quit`. A server the operator started by hand is never
   touched, in either direction - verified by hand (start `just ui` manually, launch the
   app window, close it, confirm the manual server is still answering `/api/health`).

**`--smoke` flag** - the build's verifier hook: same boot sequence, window created but
never shown (`show: false`, `ready-to-show` never fires a `.show()`), then
`console.log("ADE_SMOKE_OK")` and `app.exit(0)`, budgeted to finish well under 30s. Any
failure to reach health prints the same plain-English error to stderr and exits 1 (no
`dialog` popups in `--smoke`, since nothing should block on operator input).

**Packaging** - `apps/ui/electron-builder.yml`:

- **Windows portable - buildable now**, and the actual target of this phase. A single
  unsigned `.exe`, no installer, no admin rights. Only `dist-electron/**` and
  `package.json` are bundled - the packaged app never embeds a copy of the server or the
  built SPA; at runtime it does the same repo-root walk as dev mode, so the portable `.exe`
  needs to live inside (or be run from within) a real checkout of this repo. Build with
  `CSC_IDENTITY_AUTO_DISCOVERY=false` (see the `app-build` justfile recipe) - without it,
  electron-builder auto-discovers any code-signing identity sitting in the local Windows
  cert store and reaches out to a network timestamp server for it, which can hang the build
  on a machine that has any signing identity at all. This build is deliberately unsigned.
- **Linux (AppImage + deb) - config decided, not built here.** Building either from this
  Windows laptop is out of scope for the UI phase: no Linux build tooling/Docker/WSL is
  assumed, and electron-builder's Linux targets fetch prebuilt tool binaries for the
  *target* platform that have never been exercised on this box. That's MAP build phase 4
  (the Contabo VPS) - the config exists now so the shape is reviewable, not to be run yet.
- If `electron`'s own postinstall binary download (or electron-builder's) resets/hangs on a
  given network, `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` is a working
  fallback CDN for the same signed artifacts - a troubleshooting note, not a default.

**justfile** (appended after `ui-dev`; `ui` and `ui-dev` untouched):

```
# launch the desktop app (builds the ui, compiles the electron shell, opens the window)
app:
    cd apps/ui && bun install && bunx vite build && bunx tsc -p electron/tsconfig.json && bunx electron .

# package a portable Windows .exe of the desktop app into apps/ui/release/
app-build:
    cd apps/ui && bun install && bunx vite build && bunx tsc -p electron/tsconfig.json && set CSC_IDENTITY_AUTO_DISCOVERY=false&& bunx electron-builder --win portable
```

**Layout on disk** (additions to section 9's tree):

```
apps/ui/
  electron/
    main.ts          the whole main process - health check, spawn-or-reuse, window,
                      window-state persistence, --smoke
    tsconfig.json     compiles to ../dist-electron (gitignored build output)
  electron-builder.yml
  dist-electron/      gitignored - compiled electron/main.ts
  release/            gitignored - electron-builder output (win-unpacked/, the portable .exe)
```

**Verified**, run for real on this laptop: `bun run typecheck` green (now three project
references: app, server, electron); `bunx electron . --smoke` prints `ADE_SMOKE_OK` and
exits 0 both when it has to spawn the server itself (and the spawned server is confirmed
killed after) and when a manually-started `just ui` is already healthy (confirmed left
running after); `just ui`'s recipe body still boots the real server and answers
`/api/health` with `ok:true`; `just --list` still parses the whole justfile and shows `app`:
and `app-build` alongside the untouched `ui`; `bunx electron-builder --win portable`
produced a real ~90MB `SDL Factory 0.1.0.exe` with no errors.
