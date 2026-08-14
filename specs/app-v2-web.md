# specs/app-v2-web.md — App v2, the web app

**This is the single authoritative build spec for SDL Factory app v2's web app.**
Builders execute this and read nothing else. Sources synthesized: the three BDD walks
(entry ways / observe day / project lens, 2026-08-13 night), the binding operator record
`.scratch/app-v2/reactions-t3-gallery.md`, the T3 study `docs/research/t3code-codebase-study.md` §19,
the live API (`apps/ui/server/index.ts`, `db.ts`), and `specs/ui.md` (v1) for vocabulary continuity.
Scenario citations below use `W1-A2` = Walk 1 (entry ways) surface A scenario 2, `W2-B3` = Walk 2
(observe day), `W3-C1` = Walk 3 (project lens).

**Provenance of the citations.** The three walks were conducted in-session on 2026-08-13 night and
were **never written to disk** — no file in this repo contains a `W1-A1`. The citations are
provenance tags recording where a requirement came from, not references a builder can open. This
spec is self-contained by design ("read nothing else"); a builder who wants to know *why* a rule
exists asks the operator, and never invents a scenario to fill a gap. Writing the three walks into
`docs/design/walks/` is an open item for the morning (§5.22).

Binding operator constraints, restated once (from `reactions-t3-gallery.md`):

- **Web app FIRST**; Electron wrap later. "Usable by tomorrow."
- **T3's anatomy with our deltas** — amber accent family, less text, our vocabulary. Never an
  alternative aesthetic. Inspiration, not a copy.
- **Less text.** "Too much text makes it look like mock data." Text budgets in this spec are
  requirements, not preferences.
- **Sidebar navigation.** No top tabs, no docks.
- **Factory runs are observe-only.** No composer toward a factory run.
- **Never mock data.** Every number on screen traces to a row in `sssf.db`, a file on disk, a git
  fact, a live process, or app-owned state the operator created. Where a field is null, the element
  is absent — never `—`-padded, never invented. The fields this actually bites on, named once:
  `title` and `branch` are null on all 12 runs in this db; `context_tokens` / `context_window` are
  present (4428 / 262144) and render only because they are; and **`total_cost` is genuinely `0.0`
  on every real row** — a flat-rate lane — so it renders as `0`, *because that is the recorded
  value*. "Absent when null" and "show the zero that was recorded" are the same rule, not two.

---

## 1. Scope

### 1.1 Process shape

One Bun process, the existing one: `apps/ui/server/index.ts`, **port 4700, loopback only** —
unchanged. The v2 web app is a **new SPA** at `apps/ui-v2/` (Vite + React 19 + TypeScript +
Tailwind v4, its own `package.json`), served by that same process. Electron wrap comes later and
changes nothing here.

**The factory is frozen.** `adws/`, `installer/`, the `sssf.db` schema, `queue/TEMPLATE.md`,
`sssf.config.yaml` are read, never written, never edited. The existing `/api/*` routes and the
modules behind them (`db.ts`, `queue.ts`, `gate.ts`, `gitro.ts`, `config.ts`) keep byte-identical
behavior. `apps/ui/src` (the v1 SPA) is not touched.

**Exactly three permitted edits to `apps/ui/server/index.ts`:**

1. Import and spread a new `appRoutes` table (all keys under `/api/app/`) into the `routes` object.
2. `serveStatic` serves `apps/ui-v2/dist` **only when the process was started with the explicit
   `--ui-v2` flag** (which only the new `ui2` recipe passes), else `apps/ui/dist` exactly as
   today. **Directory existence must never re-route the served UI**: `apps/ui/electron/main.ts`
   loads this same origin (`win.loadURL('http://127.0.0.1:4700/')`, lines 508/517/753), so a
   presence check would silently switch `just app` and the packaged `.exe` from v1 to v2 the
   moment ui-v2 builds — which is exactly what "Electron wrap comes later and changes nothing
   here" forbids. With no flag, `just ui` and `just app` keep serving v1 byte-for-byte.
3. When serving `apps/ui-v2/dist/index.html` (both the direct `/index.html` file path and the
   SPA fallback), inject `<script>window.__APP_TOKEN__="<random>"</script>` before `</head>` — a
   per-process random token (see 1.2).

Everything else new lives in new files under `apps/ui/server/app/` (section 4).

### 1.2 The write plane — namespace split and security

The v1 server is GET-only by design (`safely()` returns 405 on anything else). That rule survives
**for `/api/*`**. The web app needs writes (add project, run init, spawn sessions), and a web app
has one channel, so the namespace is split (W1-C1, W3 cross-cutting):

- `/api/*` — unchanged, GET-only, read-only over the boot project's `sssf.db` / `queue/` / git.
- `/api/app/*` — the app plane. New reads and the only writes. **The server never writes factory
  state** — not `sssf.db`, not `adws/`, not `queue/`, not git history. It writes exactly:
  the app manifest (`~/.sdl-factory/`), and runs the two fixed-argv initialization jobs of §2.9
  and (v1.1) the harness processes of §2.3. No general exec endpoint exists.

**CSRF guard, mandatory on every non-GET `/api/app/*` request** (W1-C1): any page in the
operator's browser can POST to `127.0.0.1:4700`, so every write requires (a) an `Origin` header
equal to the app's own origin or absent, and (b) header `X-App-Token` matching the per-process
token injected at serve time. Failure → 403, one-line JSON error. Without this, spawning processes
over loopback HTTP is a remote-code-execution hole.

The harness-spawn security invariant from `apps/ui/electron/profiles.ts` survives verbatim: **the
browser never sends a command line.** It sends a `harness` id resolved against a fixed server-side
table. ("That is the whole difference between a terminal surface and a remote-code-execution hole
in a page a browser can also load.")

Server console output stays ASCII (cp1252 MAP landmine). UI glyphs (dots, checks, chevrons) are
drawn with CSS/SVG, not shipped to any console.

### 1.3 Backend additions — the complete list

All new, all under `/api/app/`, all JSON `cache-control: no-store`, all wrapped so a throw returns
`{error}` + 500, never a dead server. Path params validated with the existing `isSafeSegment`;
file paths confined with the existing `resolve(root, p).startsWith(root + sep)` guard. GET unless
marked. Per-project routes take the manifest project id.

| Endpoint | Serves | Shape (response) | Source of truth |
|---|---|---|---|
| `/api/app/health` | shell | `{ok, host:{name}, projects:N, bridge:"absent"\|"ready"}` | process + manifest |
| `/api/app/projects` GET, **POST** `{path}` | W1-A1/A2/B7, W3-A1/A2 | `[{id,name,root,added_at,last_opened_at}]`; POST validates exists+isDirectory, returns project or one-line error | `~/.sdl-factory/config.json` |
| `/api/app/projects/:id/readiness` | W1-B1/B8/E1, W3-A2/D | `{git:{is_repo,branch,remote,dirty}, factory:{config,queue_template,db,justfile,adws}, harnesses:{claude,codex,pi:{state:"ready"\|"missing",version,path,can_steer}}, runs:{count}}` | fs probes + git + `--version` (cached 60s) |
| `/api/app/projects/:id/browse?path=` | W3-A2 | directories only, `~` expanded, EACCES → empty | `readdir` |
| `/api/app/p/:id/live` | sidebar counts, Board, Runs list — **the one 2s poll** (W2-A3) | `{running:[{adw_id,title,adw_name,started_at,latest_event_at,latest_event_rowid,phase:{name,seq,owner},model,coding_agent,branch,worktree_path,open_processes}], queue_mtime, counts:{board_ready,runs_running,gate}}` | `sessions` WHERE running + newest event per adw_id + open phase + `processes` + `log/branch` payload + `/api/app/p/:id/queue` counts |
| `/api/app/p/:id/runs?limit=&self_checks=` | W2-C1, F1-kill | `db.sessions()` per project; default **excludes** rows where `adw_name='adw_prompt' AND request='reply with the single word OK'`; response carries `hidden_self_checks:N` | per-project `SssfDb` |
| `/api/app/p/:id/runs/:adw_id` | W2-B1 | existing `sessionDetail` + branch, plus derived `beat` per phase (§2.5) | per-project db + git |
| `/api/app/p/:id/runs/:adw_id/worklog?after=` | W2-B3/G1 | `{entries:[WorkLogEntry], cursor, has_more}` — server-side fold of `events` (§2.5); cursor-paged by rowid | `events` |
| `/api/app/p/:id/runs/:adw_id/quality` | W2-F2 | `[{area,operation,command,returncode,status:"pass"\|"fail"\|"incomplete",output_artifact}]` | `tool_call` events named `quality:%` |
| `/api/app/p/:id/runs/:adw_id/{events,diff,gates,envelopes}` | W2-B4 | identical to existing handlers, project-scoped | existing modules, per-project instances |
| `/api/app/p/:id/queue` | W2-A1/A2 | existing `QueueResponse` **plus** `items[].criteria:[{text,done}]` (regex `^[ \t]*-\s*\[( \|x\|X)\]`, the same one `queue.ts:countCriteria` already counts with and `~/.claude/skills/morning-brief/scripts/collect_runs.py` reads) | `queue/*.md` via `readQueue` + new criteria extractor |
| `/api/app/p/:id/gate` | W2-E1 | existing `GateResponse`, project-scoped | `computeGateItems` per project |
| `/api/app/p/:id/gate/:adw_id/acceptance` | W2-E2 | `{criteria:[{text,done_in_file,verdict:"met"\|"not-met"\|"unconfirmed",evidence:[{kind,text,source}]}]}` — mechanical matching only (§2.6) | card criteria × diff files × envelopes `changed_files` × `quality:%` events |
| `/api/app/p/:id/worktrees` | W2-C2 | `[{branch,path,state:"alive"\|"orphan"\|"unmerged"\|"merged"\|"no-tree",dirty,adw_id}]` — the words are copied from `adws/adw_modules/worktrees.py` `classify()` (lines 168–192) and its `_STATE_ORDER` (line 350); the word is **`alive`, never `live`**, and `no-tree` is the fifth state; **never shells `uv run`** in the request path; reads `stale_after_minutes` from `worktrees.stale_after_minutes`, the same config key `_guard_live_rejoin` reads | `git worktree list --porcelain` + `git branch --list 'adw/*'` + `sessions` + `processes` |
| `/api/app/p/:id/config` | W3-C1 | existing `ConfigResponse`, project-scoped | `sssf.config.yaml` + db lanes |
| `/api/app/p/:id/docs/tree` | W3-B1/B4 | `[{path,kind,title,role:"entry"\|"adr"\|null}]`; roots: repo root depth 1 (`*.md`) + `docs/ specs/ queue/ app_docs/` recursive; excludes `.git node_modules .venv adws/adw_data .claude _docwork` + worktrees | fs |
| `/api/app/p/:id/docs/file?path=` | W3-B1 | `{path,text,bytes,mtime}`; >1MB truncated with one stated line | the file, path-confined |
| `/api/app/p/:id/docs/search?q=` | W3-B3 | matching paths, capped | the tree |
| `/api/app/skills?project=` | W1-B2 | `[{name,description,scope:"project"\|"user",path,disable_model_invocation}]`; project scope wins collisions; cached, invalidated on project switch | `~/.claude/skills/*/SKILL.md` + `<root>/.claude/skills/*/SKILL.md` frontmatter |
| `/api/app/files?project=&q=&limit=80` | W1-B5 | project-scoped path search, 120ms client debounce | fs walk (same exclusion list as docs) |
| `/api/app/providers` | W3-C2 | `[{id,bin,resolved_path,version,state:"ready"\|"missing"\|"error",detail}]` — `<bin> --version`, fixed argv, no shell, 2s timeout, 60s cache, **no background poll**, no auth claims ever | `which()` + version spawn |
| **POST** `/api/app/p/:id/seen` | W2-D1 | writes `{at, cards:{path:status}}`; GET returns previous | `~/.sdl-factory/projects/<id>/seen.json` |
| **POST** `/api/app/p/:id/init/git` | W3-D1 | → `{job_id}`; guards: in manifest, not already a repo, not nested inside another repo (`git rev-parse --show-toplevel` first) | spawns `git init` |
| **POST** `/api/app/p/:id/init/factory` | W3-D2, W1-E2 | → `{job_id}`; argv `uv run <skill>/scripts/install.py`, cwd = root; skill resolved `<root>/.claude/skills/sssf/…` else `~/.claude/skills/sssf/…`; neither → button disabled with the missing path, no job | spawns the frozen installer |
| `/api/app/jobs/:job_id` | W3-D2 | `{state:"running"\|"done"\|"failed", exit_code, lines[], dropped:N}` — in-memory, **last 500 lines only** (the installer's real log is long and "never a dead server" is an invariant); when `dropped > 0` the strip renders one line saying so; **exactly two commands may ever create a job** | job record |

**Session bridge** (contract fixed tonight; live implementation is v1.1 if the night runs short —
see 1.5; scaffold behavior in §2.3):

| Endpoint | Shape |
|---|---|
| **POST** `/api/app/sessions` | `{projectId, harness:"claude"\|"codex"\|"pi", mode:"chain"\|"terminal"}` → `{sessionId}`; spawns **one long-lived harness process per Session** in the project cwd (W1-B6 forces this — a process-per-skill cannot serve the long-session entry way) |
| GET `/api/app/sessions` | `[{id,projectId,harness,mode,state,chain:{entered_at_step,steps},started_at}]` |
| GET `/api/app/sessions/:id/stream?after=` | SSE of normalized `SessionEvent`s, replaying from cursor (durable `events.ndjson`) |
| **POST** `/api/app/sessions/:id/input` | `{text, mode:"steer"\|"queue"}` — steer writes the live turn; queue drains at the next turn boundary; steer disabled-with-reason when the harness `can_steer` is false, never silently degraded (W1-C5) |
| **POST** `/api/app/sessions/:id/answer` | `{requestId, optionId\|text}` |
| **POST** `/api/app/sessions/:id/stop` | — |
| GET `/api/app/sessions/:id/raw` + **POST** `/:id/resize` | terminal escape hatch: SSE of raw pty bytes + resize. **Every attach replays the ported `pty.ts` in-memory replay buffer first, then streams live** — without that, leaving Terminal mode and coming back loses the backscroll, which is audit F2 reappearing in the one place `events.ndjson` does not cover (it carries normalized events, never raw bytes). The replay buffer's bound *is* the backscroll bound, and it dies with the server (Open Decision 6). |

The normalized event union (W1-C2), produced by one server-side adapter file per harness
(claude: `--output-format stream-json`; codex: `exec --json`; pi: unverified — Open Decision 2):

```ts
type SessionEvent =
  | {kind:"text",   text, streaming}
  | {kind:"tool",   title, detail?, files?: string[], status:"ok"|"fail"|"neutral"}
  | {kind:"ask",    requestId, question, options:[{id,label,description}]}
  | {kind:"status", step:"spec"|"tickets"|"triage"|"queue", state:"pending"|"running"|"done"|"failed"|"skipped"}
  | {kind:"conn",   attempt, of}
  | {kind:"error",  detail}
  | {kind:"exit",   code}
```

Two mechanical rules live in the adapters, not the UI: (a) every free-text field is clipped
server-side — title/summary 120 chars, detail 180 (the enforcement of "less text" no client can
violate); (b) pending assistant `text` is always flushed **before** an `ask` is emitted, so the
operator reads the reasoning before the question (W1-C4). Shell wrappers
(`pwsh -Command` / `cmd /c` / `bash -c`) are stripped from displayed commands; the raw form
survives in the expanded detail. Ported wholesale from `apps/ui/electron/`: `pty.ts` (replay
buffer, `spawnNotFound` honest-line path incl. its queueMicrotask ordering fix), `profiles.ts`
(fixed table, `resolvePi`, "never invoke `pi` by name"), `which.ts`. They are already tested;
only the sink changes from IPC sender to SSE.

### 1.4 App-owned state on disk

Machine-scoped, invisible to the factory, never inside a repo (W3 Open 2 → adopted):

```
~/.sdl-factory/
  config.json                      { version, active, projects:[{id,name,root,added_at}], ui:{} }
  projects/<id>/seen.json          { at, cards:{ "queue/001-….md": "ready-for-agent", … } }
  sessions/<sessionId>/meta.json   { projectId, harness, mode, chain, started_at, ended_at }
  sessions/<sessionId>/events.ndjson
```

Nothing derivable is stored: db path, queue dir, config path, git state are re-derived from `root`
on every read, so the manifest cannot go stale (W3-A1). When the server boots the legacy way
(`--db <path>`, as `just ui` does), that repo root is seeded as project #1 — the flag becomes
manifest seeding and nothing more. This kills the app-is-the-factory conflation (W3-A5):
`sdl-factory` is a project like any other.

### 1.5 V1 tonight / v1.1 / v2 later

**Read this first, because it is the one place this spec could lie to the operator.** The binding
record's headline is not "an app is up" — it is *"the six entry ways **working via the UI** is the
headline goal"* and *"I want to really use this by tomorrow."* V1 as scoped below does **not** meet
that headline: it ships the six entry ways as a scaffold that resolves real data and then hands
back a command line for the operator's own terminal. The headline is met when **K11 + K12** land —
the pty bridge and the live Sessions UI — and not before. Everything in V1 that is not the bridge
is the *observe* half of the app (Home, Board, Runs, Gate, Docs, Settings), which the operator can
already do today with `just ui`.

**Therefore the cut order, if the night runs short, is stated up front and is not the builders'
call:** K0 → K1 → K10 → **K11 → K12** → K2a → K5 → K2b/K3s/K9 → K4 → K6 → K8 → K7. Gate, Docs,
Home and Board are the things that get cut, in that order; the bridge is not. A morning where the
observe surfaces are half-built but `/to-spec` runs in the browser matches the record. A morning
where every observe surface is perfect and no entry way runs does not. (Reversible by the operator
— §5.21 — at the stated cost.)

**V1 — tonight. "Usable by tomorrow" means all of this works in a real browser at 07:00:**

1. **Shell** — sidebar, top bar, palette, routes `/p/:id/<surface>` (§2.1)
2. **Home / Overnight** — what ran overnight, per project (§2.2)
3. **Board** — columns + inspector, at the text budget (§2.4)
4. **Runs** — list + observe run view: header, beat rail, work log, diff rail, worktrees (§2.5)
5. **Gate** — observe version: cards, acceptance walk, compare link only (§2.6)
6. **Docs** — tree + reader + go-to-file (§2.7)
7. **Settings** — read view: Project, Roster, Providers, Appearance, Paths & data (§2.8)
8. **Initialization** — contextual Initialize Git / Initialize factory, the jobs primitive (§2.9)
9. **The six-entry-ways surface at SCAFFOLD level** (§2.3) — composer + slash menu + chain rail
   render against real data (real skills, real branch, real harness resolution); every entry point
   is clickable; the bridge **contract** is fixed above. Honest scaffold behavior: with the bridge
   absent, submitting produces a copyable command line, never a fake session. **This is a
   launcher, not the entry ways working in the UI** — it is the floor, not the goal.

**V1.1 — the headline goal, and the thing the cut order protects (K11 + K12):**
the live pty bridge — Sessions actually run in-app: streaming timeline, ask cards, steer/queue,
Terminal raw view, `/morning-brief` as a conversation.

**V2 — later:** Electron wrap; hosts / server lens (W3-E — manifest `hosts[]`, reachability probe,
tunnels stay outside the app); `All projects` aggregation; docs content grep; usage-by-day view;
Gate merge-in-app; sub-agent nesting UI (no traced run has ever recorded a nested event — W2-G1);
resource monitor (parked: runs-since-22:00 + host reachability already answer the 8am question,
W3-E4).

---

## 2. Surfaces

### 2.0 Vocabulary (fixes audit F9 — structural, not stylistic)

One noun per concept. Every UI string, route, component name, and API field uses only these.
Synonyms are forbidden in code review (§3.7).

| Noun | Is | Source of truth |
|---|---|---|
| **Project** | a repo root the app knows about | `~/.sdl-factory/config.json` |
| **Session** | one harness conversation the operator drives | app state + bridge |
| **Chain** | the `spec → tickets → triage → queue` progression inside a Session | derived from the invoked skill |
| **Run** | one factory ADW execution, observe-only | `sssf.db` `sessions` row (the table name never surfaces) |
| **Card** | one `queue/*.md` file | `/api/app/p/:id/queue` |
| **Board** | the card surface | same |
| **Gate** | the pre-merge surface | `/api/app/p/:id/gate` |
| **Docs** | the markdown surface | `/api/app/p/:id/docs/*` |
| **Terminal** | a Session's raw-pty view | bridge |
| **Lane** | provider/model pair | `agent_sessions` |

Deleted from the app's language: *Trace*, *SESSIONS* (as a surface), *queue item*, *workspace*,
*ADE*, *thread*. `adw_id` is never a primary label — demoted to a hover/copy affordance (audit F8/F14).

**The casing rule (the other half of F9, which is two defects, not one).** F9 is *three names for
one thing* **and** *three casings for one word* — v1 shipped rail `Trace`, sidebar `SESSIONS`,
breadcrumb `trace` on one screen. So: **sentence case everywhere, one spelling per noun, in every
position.** A noun is spelled identically in the sidebar, the breadcrumb, the surface heading, the
tooltip and the empty state — `Runs` in all five, never `RUNS` and never `runs`. No ALL-CAPS
labels anywhere in the app (not for section headers, not for column headers, not for
"eyebrow" labels — that idiom is deleted with `SESSIONS`). Machine strings keep their own casing
inside mono spans (`adw_prompt`, `ready-for-agent`, `main`) — they are data, not labels.

### 2.1 Shell

**Layout.** One sidebar (240px, collapsible to 0), one flat top bar (40px), the surface pane.
The sidebar is the only navigation — no top tabs, no icon rail, no docks (binding; kills audit F3's
dead 260px column by making one column that earns its place on every surface). Per-surface lists
(run list, docs tree) are a **second column the surface owns and may omit** — two columns are never
both chrome (W3 cross-cutting).

Sidebar, top to bottom, rendered identically on every surface (W1-A2):

```
sdl-factory  ▾            ← project switcher: name + chevron (T3 idiom, ratified)
Search                ⌘K  ← the palette (T14–T17, ratified "really nice")
＋ New session             ← head of five of the six entry ways

Sessions                  ← only when ≥1 Session exists
 ● to-spec · app v2       ← live dot = chain running; amber dot = asking (W1-C4)

Board                  3  ← counts render only when non-zero; no count on Docs/Settings
Runs                   1
Gate
Docs
─
Settings                  ← pinned bottom (W3); carries a dot when machine probes fail (W3-D4)
```

Every count sits beside its own noun. That alone does **not** kill F12 — F12's complaint was that
three identical-looking badges carry three different quantities (Board counted *ready* only, Trace
counted *running* only, Gate counted *all waiting*) with no way to tell which. So the quantities
are fixed here and each badge names its own on hover, at zero on-screen text cost:
`Board` = `counts.board_ready` → title `N ready`; `Runs` = `counts.runs_running` → title
`N running`; `Gate` = `counts.gate` → title `N waiting`. A badge whose quantity cannot be named in
two words does not ship.
Data: one 2s poll of `/api/app/p/:id/live` feeds every badge. Text budget: **9 labels, ~14 words
for the whole navigation surface.**

**Top bar — PyCharm-serious:** a working toolbar, not decoration. 40px, flat chrome color, 1px
hairline below, no glass, no blur. Left: breadcrumb `project / surface` (host name prefixes it
only when v2-later hosts exist). Right: **contextual actions only** — `Initialize Git`,
`Initialize factory` (§2.9), appearing only in the state that earns them and vanishing when it
clears (`t3-initialize-git-state.png` model). **No liveness chip anywhere** (reconciling W1-E1
over W2-A3): poll or read failure renders as an inline line in the affected panel — the panel
keeps its last good data and shows `read failed — <the server's own error string>` (W2-F4);
per-run staleness renders inside the run (§2.5). Status state never lives in per-surface
`useState` that navigation destroys (audit F5's lesson).

**Palette.** One overlay, three modes — go-to-file / commands / search — keyed by mode
(W3-B3; structural fix for audit F8: the commands mode always has content, so it can never open
empty). Centred, row geometry identical to the slash menu, keycap legend footer. `Ctrl/⌘K`;
**yields when a terminal pane owns focus** (Ctrl+K is kill-to-line in readline — audit F8).
Keybindings surface: ratified out; gestures are fixed and discoverable in the palette footer only
(W3-C5).

**Routes.** `/p/:projectId/{home|board|runs|runs/:adw_id|gate|docs/*path?|settings|session/:sessionId}`.
Project is a path segment, never global client state — two projects drive in two tabs, and an
action can never land on the wrong project (W3 cross-cutting). **No row from the previous project
survives a switch** (W3-A3, binding): every fetched collection is cached under a key whose first
component is `projectId`, and a panel renders only data whose key matches the current route's
project — on a switch the panel is empty (its own empty state) until its first response for the
new project lands, never one poll of the old project's rows under the new project's name. That is
the same rule as "never mock data": a run that belongs to another repo is invented data here.
Default route: no projects →
Add project; else `/p/<active>/home`. **The default is never Runs** — structural kill of audit F1
(the app can never open onto the installer's own smoke test, W1-A1).

**Empty states (shell).** Zero projects: sidebar reads `＋ Add project`; pane = heading
**Add a project** + one button **Choose folder** (which takes a typed/pasted absolute path with
live validation — no native picker in a web app, W1-B7). Total on-screen text: 5 words. Nothing
else renders.

### 2.2 Home — Overnight (W2-D1)

**Layout.** The per-project landing. One section, **Overnight**: one line per run whose
`ended_at` is after the last visit — `✓ Add a health endpoint · 6m · +84 −0` — and one line for
cards — `001 → done · 002 → blocked`. Below it, nothing above the fold. No welcome text, no
"here's what your factory did" paragraph.

**Scenarios:** W2-D1 (under ten words per run), W2-C3 (reopen at 07:00, nothing lost, nothing
invented).

**Data:** runs = `/api/app/p/:id/runs` filtered by `seen.at`; card movement = diff of current
`queue/*.md` statuses against `seen.json`'s snapshot (`dispatch.py` rewrites `Status:` in place
and never moves files, so movement is only observable via the app's own snapshot — app-owned
state, W2 Open 3 → adopted).

**When the snapshot advances (load-bearing, and the obvious design is wrong).** Home renders
against the **previous** `seen`, and the new snapshot is written **at most once per server
process**: the first Home open of a process POSTs the new `seen` and the response carries the
*previous* one, which is what the surface renders; every later Home open in that process re-renders
the same window from the same previous value. Refreshing the browser at 07:05 must show the same
overnight summary it showed at 07:00 — a POST on every open would erase the exact thing W2-C3
("reopen at 07:00, nothing lost") and W2-D1 exist to preserve. The window closes when the server
restarts, which is the operator's own next session.

**Text budget:** 1 line per run, 1 line for cards, ≤ 10 words per line.
**Empty state:** `Nothing ran since your last visit.`

### 2.3 Sessions — the six entry ways (SCAFFOLD in v1; live with the bridge)

This is where work enters. All six ways converge on **one composer component** — the ways differ
only in where the operator pressed start and which Chain step they enter at (W1-B3/B4). No
"what kind of work is this?" picker ever.

| Entry way | Start point | Chain enters at |
|---|---|---|
| Big feature | `＋ New session` → `/to-spec` | spec |
| Small feature | `＋ New session` or Board `＋` → `/triage` | triage (spec, tickets struck) |
| Import | `@`-mention a doc → `/to-tickets`, or Docs header `Plan from this` | tickets |
| Greenfield | `＋ Add project` (bare folder) → compose | spec |
| Brownfield | add existing repo → compose; `Initialize factory` contextual | any |
| Long session | `/to-spec` typed into a 40-turn Session, mid-timeline | spec, anchored at that turn (W1-B6) |

**Composer (W1-B1).** Headline **What should we build in `<project>`?** above the composer.
Directly **above** the input (operator's inversion of T3 — "Codex does the same thing"): one 24px
strip of four bare controls — `sdl-factory` · `main` · `Claude Code` · `Full access` — labels
only; descriptions live inside each dropdown (`t3-permission-modes-with-descriptions.png`), zero
pixels until opened. One resolved harness renders as a static label at the same strip height, not
a dead dropdown. No model picker in v1. No onboarding text, no tips, no example prompts.
Data: `/api/app/projects/:id/readiness` (one call: strip + empty state + top bar).

**Slash menu (W1-B2).** `/` at line start (regex `^\/(\S*)$` on the line prefix) opens a popover
anchored above the composer: icon · name left · one-line description **right-aligned**
(`codex-app-slash-menu.png` geometry). Rows 28px, one line, never wrap; descriptions clipped to
the first clause before an em-dash or 60 chars. Contents: the real skills on this machine from
`/api/app/skills` — never a hardcoded list. The `disable-model-invocation: true` skills
(`to-spec`, `to-tickets`, `triage`) are the justification: this popover is the only surface that
can invoke them. `@` opens the file popover with the same row geometry (`/api/app/files`); a
selected file renders as one chip whose underlying text is `[name.md](path)` so the prompt stays
a plain string (W1-B5).

**Chain rail (W1-B3/B4/B6).** One 20px strip: `spec · tickets · triage · queue`, states
pending (dim) / running (pulse) / done (✓) / failed (✕) / **skipped (struck, dim, no tooltip
prose)** — entering late strikes the earlier steps and the strike-through is the whole
explanation. 4 words of persistent chrome, total. Anchored inline at the turn that started it;
sticks to the viewport top while running. Chain state is app-owned, derived from the invoked
skill — identical across harnesses.

**Running chain (v1.1, W1-C2/C3):** the timeline renders normalized `SessionEvent`s — one-line
typed rows (`icon · verb-phrase · chevron`), visually indistinguishable across harnesses; the
declared escape hatch is the header's `Terminal` toggle onto the raw TUI. Collapse-and-count:
`MAX_VISIBLE_WORK_LOG_ENTRIES = 1` + `+13 previous tool calls`; adjacent same-shape rows group
(`Edited a file, ran commands ⌄`). Connection state is an **inline log row** — `Reconnecting 2/5`,
then `Disconnected` + inline `Reconnect` — never a banner or toast (binding operator callout).
Follow-at-end with a ≤40px re-arm band and a `↓` pill (T3 §5.6, incl. its documented failure
mode). Switching projects or surfaces never kills a Session — the process lives in the server, the
browser holds only a cursor (structural kill of audit F2). **F2 is only killed if the raw Terminal
view replays too**: normalized events replay from `events.ndjson`, raw pty bytes replay from
`pty.ts`'s in-memory buffer on every attach (§1.3). Backscroll that survives a tab switch but not a
surface switch is the v1 bug wearing new clothes.

**Asks (v1.1, W1-C4):** an ask renders inline as a card reusing the slash-menu row component
wholesale — question on one line, one row per option, description right-aligned (operator's
explicit ratification). Composer collapses to `Answer above`. Sidebar dot turns amber; if the
operator is elsewhere, **exactly one** non-auto-dismissing toast with the question's first line
and one `Answer` button — toasts are reserved for "the chain is blocked on you". Answered → one
line: `✓ <chosen label>`.

**Steer vs queue (v1.1, W1-C5):** typing during a running step pins a one-line bar atop the
composer with two buttons, `Steer` and `Queue`. Enter = Queue, ⌘/Ctrl+Enter = Steer (Open
Decision 3 — built on this default). Queued prompts chip and collapse past one (`2 queued ⌄`).
A harness that cannot steer renders `Steer` disabled with a 4-word hover reason — never hidden,
never silently degraded to Queue (the F6/F14 trust rule).

**Missing harness (W1-E3):** the Session's only row is the exact `profiles.ts` string —
`'codex' was not found on PATH.` — composer stays enabled, harness control open. No fake
terminal, no unresolving spinner.

**SCAFFOLD behavior (v1 tonight, stated honestly):** everything above renders and resolves real
data (skills, branch, harness availability, readiness). With the bridge absent
(`/api/app/health` → `bridge:"absent"`), submitting the composer renders one line —
`Sessions run in-app when the pty bridge lands (v1.1).` — followed by the equivalent command as
copyable text (e.g. `cd C:/Users/Mubarak/Documents/sdl-factory && claude` plus the typed prompt),
so every entry way is already usable tomorrow via the operator's own terminal. No fake session is
ever created. There is no Terminal nav row in v1; terminals are Sessions in terminal mode
(palette command `New terminal`), arriving with the bridge.

**Text budgets:** composer strip 4 labels; chain rail 4 words; slash row 1 line; failure copy
4 words + 1 button (W1-B7's `no queue/ in this project` + `Initialize factory`).

### 2.4 Board

**Layout.** Four fixed columns — Ready / Running / Blocked / Done — plus a visually quieter
**Unparsed** column rendered only when `unparsed.length > 0` (rule 11; W2 Open 7 → conditional
column). Clicking a card opens it in the **inspector rail** — the columns never disappear behind a
detail view (structural kill of audit F13; there is no "back to columns" button because there is
nothing to escape from).

**The width rule, without which F13 comes back in another form.** The audit measured the
operator's window at 1360px. Sidebar 240 + inspector 380 leaves 740px for four or five columns —
under 190px each, which cannot hold a card's own 3-line budget, so opening a card would destroy
the columns by squeezing rather than by unmounting. So: **columns hold a 220px minimum and scroll
horizontally inside their own container** (never the page, §3.4), and **below 1200px of content
width the inspector overlays as a right-anchored panel instead of taking layout width** — the
columns keep their geometry, one of them is covered, and Esc or a click outside closes it. The
inspector is a rail when there is room for one and an overlay when there is not; it is never a
route that replaces the Board.

Board header carries one `＋` that opens a
Session with `/triage ` pre-typed — the Board is an entry way, not only a display (W1-D2).

**Card = fixed-height row** (task budget: title + status chip + 2 metadata tokens MAX; T3 §7.5
discipline). **Height is fixed per column, not per app** — that is the honest form of the rule,
because line 3 exists only in Running:

- line 1: title (the H1), one line, ellipsis
- line 2: two metadata tokens — `0/4 · simple-sdlc` (criteria numeral, never a labeled progress bar)
- line 3 (**Running column only**): `● 0:42 · pi · kimi-k2.7-code` — live elapsed + lane (W2-A3)

So Ready / Blocked / Done cards are 2-line and Running cards are 3-line, and **within a column no
card ever changes height as its data changes** (the elapsed timer writes `textContent`, the lane
tokens are absent-when-null rather than blank-padded). A card gaining its third line is a card
that moved columns — a real event, not a reflow.

No description, no status sentence, no column-count duplication anywhere. Column header = noun +
count. Unparsed rows = filename + the parser's own `reason` verbatim, one line.

**Inspector (W2-A2):** title, status pill, `Adw:`, then the Agent Brief rendered as markdown by
the **same renderer Docs uses** (W3-B5 — kills the `<pre>` dump), acceptance criteria as real
disabled checkboxes with their texts, and the raw path as one copyable monospace line at the
bottom. The UI never writes a card (`queue/TEMPLATE.md`'s contract; W3 Open 10 → never).

**Live behavior:** dispatch is a command, not a button (`just work-next` in the operator's
terminal — observe-only is ratified). When `dispatch.py` writes `Status: running` + `Adw-Id:`,
the card moves columns within one poll and clicking it opens the **Run** (card body becomes a tab
in the run view). Card→Run join is `QueueItem.adw_id` × `sessions.adw_id` — the only link that
exists (W2-A3). After `/queue-publish` completes (v1.1), the app diffs the queue path set
snapshotted at chain start and links the new path — the app writes no queue file, ever (W1-D1).

**Data:** `/api/app/p/:id/queue` (+ criteria), `/api/app/p/:id/live` for elapsed/lane.
**Scenarios:** W2-A1/A2/A3, W1-D1/D2.
**Empty state:** columns render with the noun greyed, zero sentences per column; one sentence for
the whole surface: `No cards yet — start one with ＋.` (the `＋` is the real entry point).

### 2.5 Runs

**Layout.** Second column: the run list. Main pane: the run view. Right rail: Diff. A collapsed
one-line-per-tree **Worktrees** strip below the list (W2-C2).

**Run list row — 3 fixed lines** (W2-C1, answers audit F14's "12 identical rows"):

```
● Add a health endpoint          2m 41s
  build · builder · +12 tools     adw/a1b2c3d4_add-a-health-endpoint
  pi · kimi-k2.7-code · 41.2k tok
```

Title → branch → lane distinguish runs; `adw_id` is hover/copy only. Elapsed ticks by writing
`textContent` from one shared 1s interval — no React commit (T3 §5.7). Rows never reflow.
Installer self-checks are excluded by default; when hidden ones exist, one dim footer line —
`12 self-checks hidden` — toggles them (F1 kill, visible not silent).

**Run view, top to bottom:**

1. **Header, 2 lines:** title (from `titlesFor()`; fallback: `sessions.request` clipped, saying
   nothing extra) + `● Working for 0:42` ticking, freezing to `Worked for 4m 12s`; line 2:
   `branch · worktree path · lane · adw name` — each field absent when the record lacks it, never
   invented (every run in today's db has null title/branch: the header must degrade honestly).
   A composer is **structurally absent** — the Runs route never mounts one (W1-F1, "a Run is not a
   Session"; ratified observe-only). Where a Session shows a composer, a Run shows this header
   strip and nothing interactive: no input, no steer, no queue, no answering an ask.
2. **Beat rail (W2-B2):** five beats — Plan · Build · Test · Review · Document — `✓ ✓ ● ○ ○`,
   derived server-side from `phases.owner` through **one fixed table and nothing else**:
   `planner→Plan`, `builder→Build`, `quality→Test`, `reviewer→Review`, `documenter→Document`.
   **Every other owner contributes no beat**, and the set of "other" is larger than it looks:
   `owner='git'` (worktree / commit / changes bookkeeping — one-line work-log entries),
   `owner=<the engineer's own name>` (the `request` phase is `owner=run.engineer`, literally
   `Mubarak` on this box), and `owner=<any roster agent>` for `adw_prompt`, whose phase is
   `owner=<agent>` — `scout` on all 12 runs in this db. **A run with no beat-bearing phase renders
   no beat rail at all** — not five empty circles. On the only db that exists today that is *every*
   run (24 of 24 phases are `Mubarak` or `scout`), and five `○` would be structure the factory
   never recorded, which is the mock-data ban applied to shape instead of to numbers.
   Retries collapse into their beat carrying `test 2/3`. **Liveness is `ended_at IS NULL`, never
   `phases.status`** — the DDL default is `"fail"` (the rule-11 trap, stated so nobody "fixes" it).
3. **Work log (W2-B3/G1):** server-folded `WorkLogEntry` stream. Latest tool call as one line —
   `Write  apps/api/health.ts` — with `+22 previous tool calls` above it. Entry anatomy:
   icon · heading (verb table: `bash→Ran commands`, `write|edit→Edited a file`,
   `read|grep|ls→Read files` — one table, server-side) · preview (first arg) · trailing ✓/✕/—
   from `payload.ok` (an explicit boolean; do **not** port T3's string-scan failure heuristic —
   our tracer is stricter). Expanding shows args + `result_snippet` in a `max-h-64` mono block.
   `handoff.summary` renders as the phase's closing paragraph; `log/console` as dim mono. There
   is no token-level assistant stream in `sssf.db` — no streaming transcript is designed for Runs.
   Commits render as entries with sha + file count; failures carry `phases.error` **verbatim**
   (clipped with an expander) plus `attempt 2 of 2` on the beat (W2-F1). Every entry carries the
   agent's color chip (`agent_sessions.color` — real data). Nesting: flat with grouping; a
   one-level indent keys off `events.parent_id` when it ever appears — no fleet view on data we
   do not have (W2-G1). **The nesting test is truthiness, never null-ness** — `parent_id` is the
   **empty string** on all 255 rows in this db, never `NULL` (`tracer.py:130` inserts
   `record.parent_id`, whose default is `""` — `data_types.py:457`), so `parent_id !== null`
   indents every event in the app. Same class of trap as the `phases.status` default; stated so
   nobody "fixes" it.
4. **Diff rail (W2-B4):** scope selector `Whole run | NN commit_*` from `availableScopes()`;
   read-only — no commit/push controls on a factory run. Honest empty: render `resolveDiff`'s own
   `base` string (`no diff available`), add nothing.
5. **Quality (W2-F2):** three states rendered from `status` — `pass | fail | incomplete` —
   `incomplete` in its own neutral color with the tool's own reason
   (`scan unavailable (exit 127: skylos not found)`). `passed` is the trap field (false for
   incomplete too); never collapse a missing answer into a failure. `output_artifact` gets a
   one-line `open output` expander — evidence, not decoration.
6. **Stall (W2-C3/F3):** three states, never two — running / stalled / ended. A running run whose
   newest event is older than `stale_after_minutes` (the same config key `_guard_live_rejoin`
   reads — one definition of stale, not two) renders `No output for 41m` as an **inline log
   entry** (the Codex idiom), never a spinner, never a silent gap. Dead-without-phase_end reads
   `Stopped · no output for 41m · last step: build` with pid evidence from `processes` —
   **timestamps only, never probe the pid** (`os.kill(pid,0)` terminates on Windows — landmine
   stated so nobody improves it).

**Worktrees strip:** branch · path · `alive|orphan|unmerged|merged|no-tree` · dirty · owning run —
the exact words `just worktrees` prints, copied from `worktrees.py` `classify()` and `_STATE_ORDER`
(naming parity over code reuse). The word is **`alive`**; `live` is not a state this factory has.

**Data:** `/api/app/p/:id/live` (list), `/runs/:adw_id`, `/runs/:adw_id/worklog`, `/quality`,
`/diff`, `/worktrees`.
**Scenarios:** W2-B1–B5, C1–C3, F1–F4, G1.
**Text budget:** list row 3 lines · header 2 lines · tool entry 1 line · stall/conn state 1 line.
**Empty states:** no factory → `no factory here` + Initialize factory (a missing db is a state,
not a throw — the per-project opener returns `{factory:"absent"}`, never `process.exit`, W3-A4);
factory, no runs → `No runs yet — dispatch a card with just work-next.`; filtered →
`No runs match this filter.` Three distinct renderings, never merged.

### 2.6 Gate

**Layout.** One card per shippable run — `status='success'` + an `adw/<id>_*` branch + not an
ancestor of `main` (`computeGateItems()`'s existing rule, kept; failed runs are Runs work, not
Gate work). Card: title · branch · `+84 −0 across 6 files` · reviewer's one-sentence summary ·
the compare link.

**The acceptance walk (W2-E2):** the card's criteria list, one row each, three verdicts —
**met** (with inline evidence: the commit / changed file / quality check that speaks to it),
**not met** (what the record says instead), and **`cannot confirm from the record - check the
compare page for this one`** — the morning-brief skill's fixed phrase, copied byte for byte from
`~/.claude/skills/morning-brief/SKILL.md:96`, **ASCII hyphen, not an em-dash** (word for word means
byte for byte, or the operator learns to recognize two phrases instead of one). The file's `- [x]`
state is displayed but **never treated as evidence**.
Matching is mechanical and conservative: `met` only when a named file appears in the diff's
`files[]` or an envelope's `changed_files`, or a `quality:` event with `status='pass'` names it;
everything else `unconfirmed`. No fuzzy matching — an invented match is worse than a gap.
(`gate_results` has 0 rows on this machine; the surface must be correct from empty and verifiable
on the first real writing run.)

**The only button:** **Compare on GitHub** → `compare_url`. Non-GitHub remote: `push_command` as
copyable text, no button. No Merge, no Push, no PR-create anywhere — and the absence is not
explained in prose; the button simply isn't there (W2-E3; merge-in-app noted in Open Decisions).

**Data:** `/api/app/p/:id/gate`, `/gate/:adw_id/acceptance`.
**Scenarios:** W2-E1/E2/E3.
**Empty state:** `Nothing to ship yet — a run lands here when it succeeds on its branch.`

### 2.7 Docs

**Layout.** Second column: markdown tree (depth-1 expansion, empty directories flattened, compact
density — the behaviors of T3 §11.3, not the `@pierre/trees` library). Reader: one measure column
`max-w-[68ch]`, `react-markdown` + `remark-gfm` styled with shadcn/typeset (the explicit verdict
of `docs/research/shadcn-markdown-rendering.md` for static trusted files; Streamdown is reserved
for streamed output elsewhere). Opens the project's entry doc by first hit of `docs/index.md` →
`README.md` → `MAP.md`. No welcome paragraph, no breadcrumb explainer.

Relative `.md` links navigate in-app and reveal the tree row; URL becomes
`/p/:id/docs/<path>` — deep-linkable so an agent can be pointed at a doc (W3-B2). `>1MB` renders
truncated with one stated line.

**Taxonomy grouping by detection, not schema (W3-B4):** where documentation-factory output exists,
two groups render above the tree — **Entry** (`AGENTS.md`, `index.md`, `constitution.md`,
`glossary.md`) and **Decisions** (`ADR-NNNN · <H1>`). Where none exist (this repo today), neither
group renders — a project without the taxonomy is not "missing docs". `_docwork/` is excluded
(pipeline intake, not reading material).

**The header carries exactly one action, 3 words: `Plan from this`** — opens a Session with the
file pre-mentioned and the composer focused (W1-B5's import entry way; scaffold behavior per §2.3).

**Data:** `/docs/tree`, `/docs/file`, `/docs/search`.
**Scenarios:** W3-B1–B5, W1-B5.
**Empty state:** `No markdown here yet.`

### 2.8 Settings

Sidebar nav inside Settings: **Project · Roster · Providers · Appearance · Paths and data**.
No Keybindings (ratified out). No Usage in v1 (W3-C4 — mechanical reason: T3's usage is a
`~/.claude` crawl, out of scope; per-run totals already live in the run header).

- **Project:** root, db path, branch, remote — facts, one line each.
- **Roster (W3-C1):** defaults once at top (coding agent · model · thinking · data dir); five
  rows: color swatch · name · model (`inherited` marked) · one line of purpose. `tools` collapses
  to a count (`7 tools`); `writes` renders `read-only` / `unrestricted` / glob count.
  `protected_files` renders **once**, here (deleting the Observability duplicate is the F10 fix).
- **Providers (W3-C2):** one `StatusTriple` row each — `● pi 0.9.4 - on PATH` /
  `○ codex - not on PATH; set the binary in .env` — plus the lanes table (model, last round trip,
  tokens, run count): the only proof a model actually answers. **Nothing claims authentication**
  — we have no auth signal without reading credentials, and we must not (named difference from
  T3, deliberate). Refresh on page open + explicit control; no background poll.
- **Appearance (W3-C3):** light / dark / system segmented control; one density control. Bare
  labels — **no description line under controls** (that is precisely what makes T3's settings
  text-heavy). Theme in `localStorage` (T3 does the same); everything else app-owned in the
  manifest.
- **Paths and data (W3-D4):** server facts (bind 127.0.0.1:4700, build time, read-only) + the
  **Machine** block (not per-project): free probes `uv` / `just` / `pi`, dot + id + one sentence,
  and a **Full check** button whose label names its token cost (`--verify-only`'s V2 is a paid
  round trip — 39,501 tokens on this box). `expected-unavailable` is never counted as an issue
  (F6 fix: the count is `failed + needs-operator` only). Nothing runs at app start.

**Data:** `/api/app/p/:id/config`, `/api/app/providers`, readiness.
**Scenarios:** W3-C1–C5, D4.
**Rule kept from v1** (`specs/ui.md`:367): the settings API never reads `.env` and never returns a
key, token or secret — enforced by not having the code path. Nothing anywhere in the app opens
`.env`; the only thing any surface may know about it is whether the file exists (§2.9).

### 2.9 Initialization (contextual actions)

Top-bar contextual actions, computed from `/readiness`, rendered only when actionable, vanishing
when satisfied (W1-E1, W3-D1/D3). On a fully-initialized project **neither renders** and the slot
is empty.

- **Initialize Git** (`!git.is_repo`): one button, no dialog, no confirmation copy — the state
  change is the feedback. POST `/init/git` → job.
- **Initialize factory** (`git.is_repo && !factory.config`): a small panel of paths, not prose
  (`adws/`, `sssf.config.yaml`, `justfile`, `.env.sample`), one `Initialize` button →
  POST `/init/factory` → job; stdout streams into a short log strip via `/api/app/jobs/:id`.
  On exit 0 the roster appears in Settings, `Board/Runs/Gate` un-dim, the button disappears on
  the next readiness poll. Post-install checklist = three live probes, not prose (`.env` **exists**
  — a `stat`, and the file is **never opened**: `specs/ui.md`:367's rule is that this app never
  reads `.env` at all, and "key presence only" would already be reading it; `pi` on PATH; `runs`).
  The app never writes `.env` either.
  The installer is frozen: we call it, never edit it; re-running is a drift check, not a hazard
  (its idempotency is documented).
- With the bridge live (v1.1), `Initialize factory` upgrades to W1-E2's shape: a Session with
  `/sssf install` submitted — ordinary composer, ordinary ask cards, leavable by construction
  (kills F7's one-way door). **For a project, no wizard exists** — the wizard question survives
  only for machine/VPS setup, which is `installer/install.py`, a command.
- Uninitialized ≠ blocked: the operator can compose in a bare folder; failure arrives at the exact
  chain step that needs the missing thing — `queue` segment fails with `no queue/ in this project`
  + one inline `Initialize factory` button (W1-B7). 4 words + 1 button.
- Sidebar on a factory-less project: `Board / Runs / Gate` dimmed, non-interactive, tooltip
  `needs factory` — never an explanatory sentence (F4's lesson: no sidebar paragraphs, ever).

---

## 3. Design language

### 3.1 Derivation

From T3 §19, **adapted, not copied**: the token cascade (Tailwind v4 CSS-first `@theme` mapping
utilities onto bare CSS variables — no `tailwind.config.*`), hairline borders, dot-status,
dim-metadata hierarchy, fixed-height rows, system font stack, duty-cycled status animation.
Explicitly **not** adopted: glass/blur recipes, grain, the composer's clip-path shell, five theme
palettes, webfonts, the 10px radius scale — v2 is denser and more serious than T3 (the operator's
v1 ruling stands: "an actual development environment, not a dashboard"; the top bar is
PyCharm-serious — flat, working, undecorated). Our deltas over T3: the **amber mark**, less text,
our vocabulary.

### 3.2 Tokens

Dark-first: `:root` carries dark values; `html.light` overrides; `system` follows
`prefers-color-scheme`. Defined once in `apps/ui-v2/src/tokens.css`, consumed via `@theme inline`
mappings so Tailwind utilities (`bg-canvas`, `text-t2`, `border-hairline`) resolve to them.

| Token | Role | Dark | Light |
|---|---|---|---|
| `--canvas` | main pane | `#0A0A0B` | `#F7F7F8` |
| `--chrome` | sidebar, top bar | `#0F0F11` | `#EFEFF1` |
| `--raised` | cards, inspector, popover | `#17171A` | `#FFFFFF` |
| `--overlay` | palette, menus | `#1C1C20` | `#FFFFFF` |
| `--hairline` | every border, 1px, never heavier | `#232326` | `#E2E2E6` |
| `--t1` | primary text | `#EDEDEF` | `#1A1A1E` |
| `--t2` | secondary text | `#A0A0A8` | `#55555E` |
| `--t3` | dim metadata | `#6E6E76` | `#8A8A93` |
| `--accent` | **the amber mark**: focus ring, selection, live-ask dot, identity | `#F59E0B` | `#B45309` |
| `--accent-surface` | selected/ask backgrounds | `color-mix(in srgb, var(--accent) 12%, transparent)` | 8% mix |
| `--run` | running | `#3B9EFF` | `#2563EB` |
| `--ok` | success, additions, met | `#22C55E` | `#16A34A` |
| `--fail` | failure, deletions, not-met | `#EF4444` | `#DC2626` |
| `--warn` | stalled, truncation | `#D9A441` | `#A16207` |
| `--neutral` | the third state: incomplete, unconfirmed, skipped | `#8E8E96` | `#71717B` |
| `--row-hover` / `--row-active` | list rows | white 4% / 7% | zinc-100 / zinc-200 |

Amber is the "needs you" family — ask dots, blocked-on-operator, focus — which is semantically
aligned, not a coincidence. Agent lane colors come from `agent_sessions.color` in the db, never
from tokens. Status is always **dot + word**, never a bare color (color-blind safety + v1's
"never render a bare enum").

### 3.3 Typography

**No webfont** (T3's own choice, kept):

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
--font-mono: "Cascadia Mono", Consolas, Menlo, "SF Mono", "DejaVu Sans Mono",
             "Liberation Mono", monospace;
```

`ui-monospace` is deliberately dropped from the mono stack — T3's documented reason: some engines
alias it to the proportional UI font, breaking every code surface. Sizes (px, dense):
body 13/18 · meta 11/14 · mono 12 · surface headings 14 semibold · composer headline 20 semibold.
Bold is semantic — the thing you scan for. Mono for everything machine-generated: ids, models,
paths, args, branches, diffs.

### 3.4 Geometry and density

Sidebar 240px (collapsible 0); per-surface second column 280px; inspector rail 380px; top bar
40px flat; sidebar rows 24px; menu/slash/ask rows 28px; log/tool rows 22px; chain rail 20px;
composer strip 24px. Radii: 4px chips, 6px controls and cards. Elevation = background lightness +
hairline; no shadows except overlays (one soft shadow on `--overlay` surfaces). Content measures:
docs/markdown 68ch; Session timeline max-w 768px; everything else full-width. Wide content
(tables, diffs, logs) scrolls in its own container — the page never scrolls horizontally.

**The one responsive rule, because the operator's window is 1360px** (the audit measured it):
240 sidebar + 380 inspector leaves 740px, so **below 1200px of content width the inspector rail
becomes a right-anchored overlay** rather than taking layout width, and Board columns hold a 220px
minimum and scroll inside their own container (§2.4). No other breakpoint exists — this is a
loopback single-operator app, not a responsive site.

### 3.5 Motion

Minimal. One live dot pulse, duty-cycled with `steps()` (T3 §19.8's compositor rationale — a
handful of frames per cycle, not one per vsync). Chevron rotate 200ms; hover metadata
opacity 200ms. Elapsed timers tick via `textContent`, one interval per list. No progress bars,
no percent, no spinners that imply known progress — nothing in the system knows how far along a
run is (v1 rule, kept). `prefers-reduced-motion` removes the pulse.

### 3.6 Component idioms (the shared kit)

- **StatusTriple:** `dot · bold identifier · one plain sentence` — providers, machine probes,
  stall lines (carried from v1).
- **Collapse-and-count:** 1 visible entry + `+N previous …` toggle — work logs, queued prompts,
  tool groups.
- **Fixed-height rows:** changing data never changes row height (T3 AgentRow discipline) — run
  rows, cards, slash rows.
- **Honest inline log entries:** connection, staleness, read-failures are rows in sequence at the
  position they happened — never banners, never toasts (the one toast in the app is an open ask).
- **One markdown renderer** (Docs = card inspector = brief), one timeline component (Session =
  Run, the Run variant simply never mounts a composer), one row component (slash menu = ask card =
  palette), one composer (all six entry ways).
- **Empty state:** heading ≤ 3 words + at most one action + at most one sentence. Empty column:
  greyed noun, zero sentences.

### 3.7 Forbidden synonyms (enforced in review)

`Trace`→Run/Runs · `queue item`/`ticket`/`task`→Card · `kanban`→Board · `workspace`/`repo` (in
UI)→Project · `thread`/`chat`→Session · `console`/`shell` (in UI)→Terminal · `knowledge base`→Docs
· `funnel`/`pipeline` (in UI)→Chain · naming a run by `adw_id` in a primary label → title, branch,
lane, in that order. The word "session" never appears in UI for factory work (the db table
`sessions` renders as Runs).

---

## 4. Build plan

Target: **new** `apps/ui-v2/` + new `apps/ui/server/app/`. The v2 UI reads **exclusively**
`/api/app/*` (project-scoping comes free; the v1 routes stay untouched for the v1 SPA).

```
apps/ui/server/app/
  routes.ts     guard.ts     manifest.ts   projects.ts   readiness.ts
  scoped.ts     live.ts      worklog.ts    criteria.ts   acceptance.ts
  worktrees.ts  docs.ts      skills.ts     files.ts      providers.ts
  seen.ts       jobs.ts      init.ts
  sessions/     bridge.ts  store.ts  pty.ts  profiles.ts  which.ts
                adapters/claude.ts  adapters/codex.ts  adapters/pi.ts

apps/ui-v2/
  package.json  vite.config.ts  tsconfig.json  index.html
  src/
    main.tsx  App.tsx  routes.tsx  tokens.css
    lib/        api.ts  poll.ts  format.ts  token.ts
    shell/      Sidebar.tsx  TopBar.tsx  Palette.tsx  EmptyState.tsx
    shared/     Dot.tsx  StatusTriple.tsx  Elapsed.tsx  Markdown.tsx  Row.tsx
    home/       Overnight.tsx
    session/    Composer.tsx  ContextStrip.tsx  SlashMenu.tsx  MentionMenu.tsx
                ChainRail.tsx  Timeline.tsx  AskCard.tsx  FollowPill.tsx
    board/      Board.tsx  Card.tsx  CardInspector.tsx
    runs/       RunList.tsx  RunView.tsx  RunHeader.tsx  BeatRail.tsx  WorkLog.tsx
                DiffRail.tsx  QualityBlock.tsx  WorktreeStrip.tsx
    gate/       Gate.tsx  GateCard.tsx  AcceptanceList.tsx
    docs/       DocsTree.tsx  Reader.tsx
    settings/   Settings.tsx  RosterPane.tsx  ProvidersPane.tsx  AppearancePane.tsx  PathsPane.tsx
    init/       InitActions.tsx  JobStrip.tsx
```

Vite dev server: **4720**, proxying `/api` to 4700 (4710 belongs to v1's `ui-dev`). `just` recipes
appended, existing ones untouched: `ui2` (build ui-v2, then the same server body as `ui` **plus
`--ui-v2`** — the flag is the only thing that switches the served UI, §1.1 edit 2), `ui2-dev`.

Chunks. Parallel-safe: K0 first; then {K1} ∥ {K2a, K2b, K3s}; then K4–K9 all parallel (each owns
its own directory); K10 after K1; K11 independently after K0; K12 after K10+K11. No two chunks
touch the same file. **Priority when the night runs short is §1.5's cut order, not this table's
row order** — K10/K11/K12 outrank K4/K6/K7/K8.

**The scratch project (K4, K5, K6, K7 all need it, and none of them may use the boot project).**
The factory is frozen: `queue/` is read and never written, `sssf.db` is opened readonly. So no
chunk may hand-write a card into this repo's `queue/` (it would put cards the operator never wrote
on his own Board — mock data with a file behind it) and none may fabricate a `running` session row
here (all 12 rows are `success`, and there is no writer connection in this process by design).
Instead: **one throwaway repo added to the manifest as a second project**, with its own `queue/`
and its own `sssf.db` written by hand — `~/.sdl-factory-scratch/`, outside this repo, deleted
after. Acceptance is demonstrated there and read-only truth is demonstrated here.

| # | Chunk | Files touched | Done when |
|---|---|---|---|
| **K0** | Server app-plane foundation: guard (origin+token), manifest (+ `--db` seeding), projects, readiness, routes mount, `--ui-v2` static switch, token injection | `server/app/{routes,guard,manifest,projects,readiness}.ts` + the 3 permitted `index.ts` edits | `curl :4700/api/app/projects` lists the seeded project; POST without `X-App-Token` → 403; readiness shows real git/factory/harness facts; every existing `/api/*` response byte-identical to before (diff a captured snapshot); **without `--ui-v2`, `/` still serves the v1 SPA — verify by launching `just app` after ui-v2 has built and confirming the desktop window is still v1** |
| **K1** | Web shell: scaffold, tokens.css, Sidebar, TopBar, Palette, routes, empty states | all of `apps/ui-v2` scaffold + `shell/` + `shared/` | `just ui2` serves v2 at :4700; sidebar shows the real project, dark+light themes switch, zero-project state = 5 words; default route is Home, never Runs; every nav label, breadcrumb and heading spells its noun the same way, sentence case, no ALL-CAPS anywhere (§2.0) |
| **K2a** | Server scoped reads: per-project handles map (`{SssfDb,GitRepo,queueDir,configPath}`, lazy, non-fatal on missing db), live, runs, worklog, quality, queue+criteria, gate, acceptance, worktrees, config, seen | `server/app/{scoped,live,worklog,criteria,acceptance,worktrees,seen}.ts` | `curl /api/app/p/<id>/live` returns running runs + counts against the real db; worklog folds the 255 real events; queue returns criteria texts; a missing db returns `{factory:"absent"}`, not a crash |
| **K2b** | Server content reads: docs tree/file/search, skills, files, providers | `server/app/{docs,skills,files,providers}.ts` | skills lists the real 37+1 skills with clipped descriptions; docs tree shows this repo's real files with the exclusion list applied; providers reports the truth on this box, which as of 2026-08-13 is **`claude`, `codex` and `pi` all resolving** (`~/.local/bin/claude`, `…/Programs/OpenAI/Codex/bin/codex`, `…/npm/pi`) and **`just` missing** — do not "fix" the code until codex reports missing; re-probe before trusting any of this |
| **K3s** | Server init jobs | `server/app/{jobs,init}.ts` | POST init/git on a temp dir creates a repo and the job reports exit 0; nested-repo guard refuses; only the two commands can create jobs |
| **K4** | Board | `board/` | **in the scratch project** (never this repo's `queue/`): 3 hand-written cards render at their column's fixed height; clicking opens the inspector with rendered markdown + disabled checkboxes; columns never disappear, and at a 1360px window the inspector overlays instead of squeezing them; **in this repo**: the exact empty-state copy, since `queue/` holds only `TEMPLATE.md` |
| **K5** | Runs | `runs/` | the 12 real runs are hidden as self-checks with the visible footer line; toggling shows them; a run view renders header/worklog/diff honestly from this db's null-title, no-commit reality and **renders no beat rail at all** (every phase here is `owner=Mubarak` or `owner=scout`); the stall line is demonstrated **in the scratch project's hand-written db** — `sssf.db` here is frozen and readonly, and all 12 rows are `success` |
| **K6** | Home/Overnight | `home/` | first Home open of the process snapshots seen.json and renders the *previous* value; a browser refresh shows the same window, not an empty one; in the scratch project a hand-edited card `Status:` shows as `001 → done` on the next process; empty copy exact |
| **K7** | Gate | `gate/` | renders empty state today; against a fabricated eligible run in a scratch repo, acceptance rows show met/unconfirmed with the fixed phrase verbatim; the only button is the compare link |
| **K8** | Docs | `docs/` | **`README.md` opens by default in this repo** — the order is `docs/index.md` → `README.md` → `MAP.md`, and this repo has no `docs/index.md` but does have `README.md`, so README is the first hit and MAP is never reached; a relative link navigates + reveals; deep link `/p/<id>/docs/docs/day-one.md` works; `Plan from this` present |
| **K9** | Settings + Init actions UI | `settings/`, `init/` | roster shows 5 agents, protected_files once; providers truthful; Initialize buttons appear/disappear with readiness on a scratch folder; factory install streams its real log |
| **K10** | Entry-way scaffold: composer, context strip, slash menu, @-mention, chain rail, entry points (＋ New session, Board ＋, Plan from this), scaffold submit | `session/` (except live Timeline binding) | `/` lists real skills, right-aligned clipped descriptions; `sp` narrows to to-spec; strip shows real branch + resolved harness; submit with bridge absent yields the honest line + copyable command; chain rail renders skipped-strikethrough states |
| **K11** | **v1.1** — pty bridge: port pty/profiles/which server-side, session store (ndjson), SSE stream, adapters (claude, codex; pi per Open Decision 2), input/answer/stop/raw | `server/app/sessions/*` | a `POST /api/app/sessions` + curl of the SSE stream shows normalized events from a real `claude -p` run; kill server → events.ndjson survives; missing binary → the exact `profiles.ts` line as the only event |
| **K12** | **v1.1** — live Sessions UI: Timeline binding, ask cards, steer/queue, Terminal raw view, morning-brief entry | `session/Timeline.tsx` + bindings | `/to-spec` runs end-to-end in-app; an AskUserQuestion renders as the slash-row card and answering resumes; navigation away and back loses nothing — **including the Terminal view's backscroll**, which is audit F2's actual failure and must be clicked through (Session → Board → Session) before this chunk is done |

**07:00 acceptance walk (v1 done means):** open :4700 → Home shows Overnight honestly (likely
`Nothing ran since your last visit.`, and it says the same thing after a refresh) → Board shows the
honest empty (this repo's `queue/` holds only `TEMPLATE.md`) → Runs shows `12 self-checks hidden`
and nothing else, and opening one reads correctly from this db: real title absent, no branch, no
beat rail, its 20–27 events folded → Gate empty, Docs opens `README.md`, Settings truthful → `＋ New
session` → `/` lists real skills → submit yields the copyable command. **Then the honest sentence,
said out loud in the morning rather than implied:** if K11/K12 did not land, the six entry ways are
a launcher and the record's headline goal is not met yet (§1.5). Nothing anywhere is invented, and
nothing anywhere is claimed to work that does not.

---

## 5. Open decisions for the morning

Carried from the walks, deduplicated. Where the night build needed an answer, the spec **builds on
the recommendation** and the morning ruling can reverse it at stated cost. One walk decision is
**closed rather than carried**: W1-7 ("what the Docs sidebar row renders beyond a markdown tree")
was answered by Walk 3's own Docs surface and is built as §2.7 — it is listed here only so the
count reconciles and nobody looks for a missing ruling.

1. **The GET-only rule restated** (W2-1, W3-1). REC — adopted, built on: `/api/*` stays GET-only;
   `/api/app/*` is the bounded write plane (manifest, two init jobs, session processes) behind
   origin+token. Reversing means no Sessions and terminal-only init.
2. **pi's structured-output mode** (W1-1) + **per-harness steer support** (W1-2). Unverified on
   this machine; blocks harness parity for one of three. REC: verify in the morning; until then
   pi ships terminal-only in Sessions and the UI says so via the `can_steer`/capability flags —
   never silent degradation.
3. **Enter = Queue vs Steer** (W1-3). REC — built on: Enter=Queue (non-destructive),
   ⌘/Ctrl+Enter=Steer. Muscle-memory call; one-line change.
4. **Greenfield via typed path** (W1-4, W3-8). REC — built on: typed absolute path with live
   validation, any existing directory accepted (loopback, single operator); folder *creation* and
   the native picker arrive with the desktop wrap. No parent-directory confinement in v1.
5. **Import from an external tracker** (W1-5). REC: out of scope — `@`-mention + `Plan from this`
   cover documents; GitHub/Linear import is a different entry way with a different backend.
6. **Sessions across server restarts** (W1-6). REC — built on: processes die with the server;
   `events.ndjson` survives and the Session renders as ended (`server restarted`). Reattach is v2.
   Accept for tomorrow.
7. **App state home** (W1-8, W3-2). REC — built on: `~/.sdl-factory/` (machine-scoped; a repo
   home would re-create the conflation A5 kills). VPS-visible Sessions are a later question;
   `sssf.db` is barred by the freeze.
8. **The Brief: conversation vs computed digest** (W2-2, scenario W2-D2). REC: the Brief is a Session with
   `/morning-brief` pre-invoked — lands with the bridge (K12); no TS reimplementation of
   `~/.claude/skills/morning-brief/scripts/collect_runs.py` (drift risk against a contract the
   skill owns). Tonight, Overnight (§2.2) covers the structured need.
9. **"Moved overnight" app-owned memory** (W2-3). REC — built on: approved; `seen.json` snapshot.
   Without it the claim reduces to "001 is done".
10. **Gate merge-in-app** (W2-4, W3-10 adjacent). REC: not in v1/v2-tonight — compare link only.
    If ever built: `git merge --ff-only` in the main checkout + the card file moved to `done/` in
    the same action (that move *is* the merge event per `dispatch.py`), else the Board lies.
11. **Harness parity's meaning for Runs** (W2-5). REC: confirm it means "renderer
    harness-agnostic by construction" (the server-side worklog fold) — not "show Claude/Codex
    runs today", which would need the out-of-scope `~/.claude` crawl.
12. **Acceptance-matching conservatism** (W2-6). REC — built on: mechanical matching, everything
    else `unconfirmed` with the fixed phrase. On a real card this will likely mark 2 of 4
    unconfirmed — that is the honest floor. An LLM judgment pass is a separate, explicit feature.
13. **Unparsed on the Board** (W2-7). REC — built on: conditional column, rendered only when
    non-empty (rule 11 satisfied, dead column avoided).
14. **`All projects` scope** (W3-3). REC: v2-later, and Runs-only if ever — an aggregate Gate
    risks a merge decision against the wrong project.
15. **Installer smoke rows / F1** (W3-4). REC — built on: app-side exact-string filter with the
    visible `N self-checks hidden` line. No installer unfreeze; accept the heuristic.
16. **Full machine check's token cost** (W3-5). REC — built on: free `uv/just/pi` probes by
    default; the paid `--verify-only` behind one button whose label names the cost. Unfreezing
    the installer for `--no-round-trip` is the only alternative — not recommended now.
17. **`_docwork/feature_inventory.yaml` on the Board** (W3-6). REC: defer; Board reads `queue/`
    only in v1. Revisit when a documentation-factory run exists in a workload project.
18. **Usage from `sssf.db`** (W3-7). REC: defer to v1.2 — a tokens-by-day view is real data with
    zero new sources (`GET /api/app/p/:id/usage?days=30`), but no scenario tomorrow needs it.
19. **Resource monitor / wizard** (W3-9). REC: neither. The 8am question is answered by Overnight
    + (later) host reachability. The cheap honest version (disk free + uptime) parks with the
    server lens.
20. **Docs/card write-back** (W3-10). REC — built on: never. Checkboxes render disabled; the card
    is the agent contract (`queue/TEMPLATE.md` says so). T3 writing files on tick is the one T3
    behavior we deliberately refuse.
21. **What gets cut when the night runs short — and therefore what "usable by tomorrow" means**
    (raised by the verification pass against the record, not by a walk). The record's headline is
    the six entry ways *working via the UI*; V1 as scoped ships them as a launcher, and the
    headline lands only with K11+K12. REC — built on (§1.5): the observe surfaces are the cut, in
    the order Gate → Docs → Home → Board, and the bridge is never cut. **This is the one open
    decision that changes what the operator sees at 07:00, so it is the first one to rule on.**
    Reversing it (observe-first, bridge tomorrow night) is entirely legitimate — it buys a complete
    Gate and Docs at 07:00 and postpones the headline by a day — but it must be *chosen*, not
    arrived at by builders running out of time in row order.
22. **Write the three walks to disk** (raised by the verification pass). Every scenario citation in
    this spec (`W1-A2`, `W2-B3`, `W3-C1`, …) points at documents that exist only in one night's
    session transcripts. The spec stands alone without them, but the *reasoning* behind ~60 rules
    does not survive the week. REC: dump the three walk outputs to `docs/design/walks/` verbatim
    tomorrow — a copy, not a rewrite — and this spec's citations become openable. Cost: minutes.
