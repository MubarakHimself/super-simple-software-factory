# T3 Code — UI/UX teardown

Source video: **"Exploring T3 Code: Open Source Agent Control Surface + Mobile App"**
Channel: **Tonbi's AI Garage** · Duration **17:15** · Published 2026-08-10 · <https://www.youtube.com/watch?v=gIddBu2yQHs>

The presenter is a third-party reviewer, not the author. T3 Code is by Theo / ping.gg (`github.com/pingdotgg/t3code`), MIT, v0.0.31 at time of recording — the README says "We are very very early in this project. Expect bugs." [16:20]

Notes below are from frame-by-frame reading at 1024px, so on-screen labels are quoted verbatim.

---

## What T3 Code actually is

From its own README [04:04]:

> T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app (iOS, Android), web app and Electron-based desktop app.
> Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, T3 Code can control them.

It is **not** a model client and **not** an editor. It is a *supervisory shell over agent CLIs already installed on your machine*. It shells out to `codex`, `claude`, `cursor-agent`, `grok`, `opencode`, manages git worktrees for them, and renders their event streams.

Stack: TypeScript monorepo, Vite (`vite.config.ts`, `tsconfig.base.json` visible in the repo tree [16:20]); Electron desktop; separate web app; native iOS/Android. Distribution: `winget install T3Tools.T3Code`, `brew install --cask t3-code`, `yay -S t3code-bin` [03:30, 16:05].

Architecture that matters for a headless factory: the concept of an **environment** (a machine that runs agents) separate from **clients** (desktop/web/mobile that attach to it). Settings → Connections [13:30] shows:

| Setting | Description text |
|---|---|
| Network access | "Limited to this machine." |
| Tailscale HTTPS | "Start Tailscale to set up HTTPS access through MagicDNS." |
| WSL backend | "Run a second backend inside a WSL distro alongside the Windows one." |
| T3 Connect | "Make this environment available to your other devices through T3 Connect." |
| Publish agent activity | "Send activity from this environment to your mobile clients for push notifications and Live Activities. **Works without a T3 Connect tunnel.**" |
| Remote environments | `+ Add environment` |

That last row is the exact shape of the user's problem: a headless box publishes activity; thin clients observe.

The reviewer's framing [12:33]: *"they're trying to do like a VS Code for agents."*

---

## Layout anatomy

Three-column desktop shell inside a **frameless Electron window with a custom titlebar** (min/restore/close drawn at the far right of the app's own top bar — the app owns the whole chrome).

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ▣ T3 Code   │ 📁 token-burn / Review Project Art Choices  │ ▷Server run⌄ ⧉Open⌄ ⑂Commit⌄ ▤ ▥ ─ □ ✕ │  ← 28px top bar
├─────────────┼───────────────────────────────────────────┬──────────────────────────────┤
│ 🔍 Search   │                                           │ ⊡ Terminal 1 │ 🗎 Files │ ⊟ Diff │ + │
│      Ctrl+K │  ── work log stream (scrolls) ──          ├──────────────────────────────┤
│             │                                           │                              │
│ Projects ⇅ ⊞│  Worked for 1m 51s  ›     ← collapsed turn │  ⟳ Search files              │
│ ▾ 📁 token- │  ────────────────────────  hairline rule   │  ▾ .wayfinder/               │
│      burn   │                                           │    › handoffs                │
│             │  Re-pinning to the current npm releases,  │    › maps                    │
│ ●Working    │  then scaffolding the rest of the shell.  │    › tickets                 │
│  Review Pr… │    >_ Changed files  D:\token-burn\.git…  ⌄✓│    M↓ TRACKER.md             │
│      2m ago │    ⌄ +12 previous tool calls              │  ▾ research/                 │
│             │                                           │    © AGENTS.md               │
│ ●Completed  │  Installing dependencies and verifying    │    M↓ IDEA.md                │
│  Greeting   │  the shell builds and tests.              │                              │
│      1m ago │    >_ Tool  npm run typecheck; npm run …  ⌄✓│         — or —               │
│             │    ⌄ +2 previous tool calls               │  Latest turn ⌄     +1 -0 ▤▥⇄¶ │
│  Review To… │                                           │  ▾ ⊕ research           +1   │
│     12m ago │  ••• Working for 2m 22s   ← live elapsed   │  1 │ Subproject commit 320b… │
│             │                                           │                              │
│             │ ┌───────────────────────────────────────┐ │                              │
│             │ │ Ask anything, @tag files/folders,     │ │                              │
│             │ │ $use skills, or / for commands        │ │  ← composer floats OVER the  │
│             │ │                                       │ │    stream, translucent bg    │
│             │ │ ✳Grok 4.5⌄ │ High·1M⌄ │ ⚙Auto⌄ │ Build │ ◯ ⏹│                              │
│             │ ├───────────────────────────────────────┤ │                              │
│             │ │ 📁 Local checkout ⌄        ⑂ master ⌄ │ │  ← workspace + base branch   │
│ ⚙ Settings  │ └───────────────────────────────────────┘ │                              │
└─────────────┴───────────────────────────────────────────┴──────────────────────────────┘
   ~215px fixed        flexible, drag-resizable (⋮ handle)      ~450px, toggleable
```

### Pane by pane

**Top bar (persistent, ~28px).** Left: sidebar-collapse icon + `T3 Code` wordmark. Center-left: breadcrumb `📁 token-burn / Review Project Art Choices` — project in dim gray, thread title in bold white. Right: **contextual action buttons that change with repo state** — `Initialize Git` → `Commit` → `Commit & push` → `Publish repository` as the repo progresses [05:40, 09:10, 09:26]. Saved user Actions get their own split button (`▷ Server run ⌄`) [10:30]. Then panel toggles (bottom panel, right panel) and window controls. When the center pane narrows, these buttons **collapse to icon-only split buttons** [11:06] — a real responsive toolbar, not a scrollbar.

**Left sidebar (persistent, ~215px).** Fixed anatomy:
- `🔍 Search` row with a right-aligned `Ctrl+K` keycap chip
- `Projects` section header with sort (⇅) and new-project (⊞) icon buttons
- Project as an expandable folder node (`▾ 📁 token-burn`)
- **Thread rows nested under it** — this is the run list. Each row: `[status chip] Title…  [relative time]`. Active row gets a lighter rounded pill background and bold white text; inactive rows are dim gray with dim timestamps.
- On hover, the timestamp is **replaced in place by an archive icon** [09:42] — nice density trick, zero extra width.
- `⚙ Settings` pinned at the bottom above a hairline divider.

**Center pane — the work log.** Not a chat. See "Run rendering" below.

**Right pane — Surfaces.** Toggled by the top-bar icon. Own tab strip with a `+` button whose menu offers exactly four surface types [11:18]: **Browser · Terminal · Files · Diff**. Tabs are labeled with icon + name (`Terminal 1`, `Files`, `Diff`), active tab is a lighter rounded pill. Multiple instances allowed (`Terminal 1`). Far right of the strip: expand-to-full and panel toggles.

**Settings** is a **full-window takeover**, not a modal: its own left nav (General · Appearance · Keybindings · Providers · Source Control · Connections · Beta · Archive), a centered ~550px content column, and a `← Back` at the bottom-left [04:18].

---

## The status / run board

There is **no Kanban**. The run board is the sidebar thread list, and on mobile it is a flat card list.

### Desktop thread row [00:10, 06:30, 08:18]

```
● Working    Review Projec…              2m ago
● Completed  Greeting                    1m ago
             Review Token Burn Dir…     12m ago
```

Exactly two explicit states are shown, both as a **colored dot + word chip** rendered *before* the title:
- `● Working` — cyan/azure dot and cyan text (~`#3B9EFF`)
- `● Completed` — green dot and green text (~`#22C55E`)
- Idle/old threads show **no chip at all** — just the title, dim, with a timestamp.

Relative time is always right-aligned, always short (`just now`, `2m ago`, `12m ago`). Two threads can show `Working` simultaneously and do [10:54] — concurrency is legible at a glance with zero extra chrome.

### Mobile card [00:40]

```
📁 tonbistudio/token-burn                        Working
Codex
master                                                ⚙
─────────────────────────────────────────────────────────
📁 tonbistudio/token-burn                            11m
Review Token Burn Directory
                                                     ✳
```

Three-line card on pure black, separated by hairline rules (no card borders, no elevation):
1. repo path, dim, small — **right slot is either relative time or the `Working` status word** (they occupy the same slot; status wins when running)
2. thread title, bold white, ~15px
3. worktree/branch in dim monospace — right slot holds the **provider glyph** (OpenAI mark, Claude asterisk) so you can see *which agent* at a glance

Bottom of the mobile screen: a floating pill toolbar — filter button · `🔍 Search` pill · new-thread button. Everything floats; there is no nav bar or tab bar.

### The other status idiom: dot + bold noun + "State · detail"

Used consistently in three unrelated places, and it is the single most transferable pattern in the app.

Providers [04:30]:
```
● 🟢 Codex   v0.146.1                                        [toggle ON]
     Authenticated as ●●●●●@●●●● · ChatGPT Pro 5x Subscription
● 🟡 Cursor  [Early Access]                                  [toggle OFF]
     Disabled — Cursor is disabled in T3 Code settings.
● 🟢 Grok    v8.2.121  [Early Access]                        [toggle ON]
     Available — Installed and ready, but authentication could not be verified.
● 🟢 OpenCode v1.18.14                                       [toggle ON]
     Authenticated · opencode – 4 upstream providers connected through OpenCode.
```
Header right: `Checked 1m ago` + refresh icon. Above it: `Health check interval  [− 300 +] seconds` — "Set this to 0 seconds to rely on manual refreshes."

Mobile relay [13:35]:
```
● Coppice                                                    [toggle]
  Available · Relay online
```

Same triple every time: **status dot · bold identifier (+ version in dim monospace) · one plain-English sentence**. Never a bare enum, never a raw error code. Amber pill badges (`Early Access`, `Coming Soon`, `Not authenticated`, `Setup Required`) carry the exceptions.

Secrets are **auto-blurred in the UI** [04:51] — the reviewer explicitly praises this ("it's nice that they automatically blur this, I'm not doing that").

---

## Run rendering: how a RUNNING agent looks vs a FINISHED one

This is the heart of the app and the part most worth copying.

### Running [06:18, 07:42, 09:42]

The stream alternates **narrative** and **evidence**:

```
Re-pinning to the current npm releases, then scaffolding the rest of the shell.
   >_ Changed files   D:\token-burn\.gitignore                            ⌄  ✓
   ⌄ +12 previous tool calls

Installing dependencies and verifying the shell builds and tests.
   >_ Tool   npm run typecheck; npm run test:unit; npm run build          ⌄  ✓
   ⌄ +2 previous tool calls

Fixing TypeScript 7 config incompatibilities and Vite path resolution.
   >_ Changed files   D:\token-burn\package.json                          ⌄  ✓
   ⌄ +7 previous tool calls

••• Working for 2m 22s
```

Rules I can extract:
1. **Plain-prose section headers.** One sentence, white, full weight, no bullet, no icon. This is the agent's own summary of the phase it's in. It carries all the semantic load.
2. **Tool calls are one-line, indented, and typed.** `>_` glyph, then a bold type label — `Tool call` / `Tool` / `Changed files` / `Ran command` — then the payload in dim gray monospace (`Read {"file_path":"D:\\token-burn\\AGENTS.md"}`, `git -c safe.directory=D:/token-burn worktree add -b research D:/token-burn/research master`). Right edge: a chevron to expand and a **✓ status glyph**.
3. **Runs of tool calls collapse into a counted stub**: `⌄ +12 previous tool calls`. Only the *most recent* call under each narrative line stays expanded. This is how the log stays readable at hundreds of events — you never scroll past 200 `Read` calls, you scroll past `+12`.
4. **The live indicator is `••• Working for 2m 22s`** — animated ellipsis plus a ticking elapsed counter, dim gray, always the last row. No spinner, no progress bar, no percentage. There is nothing anywhere in the app that claims to know how far along a run is.
5. **The send button becomes a red circle with a white square (stop)** while running [06:18]. On mobile it is magenta/pink [14:20]. The primary action button *is* the run-state indicator.
6. Token-by-token streaming is **off by default** — Settings → General has `Assistant output — Show token-by-token output while a response is in progress` unchecked [04:18]. They deliberately chose summarized work-log over character streaming.

### Finished [11:06, 09:54]

The whole turn collapses to a single dim row above a hairline rule:

```
Worked for 1m 51s  ›
─────────────────────────────────────────────
```

Click the chevron to re-expand the tool calls. The elapsed counter freezes into the summary. **Running state and finished state are the same component with a different verb tense** (`Working for 4s` → `Worked for 29s`), which is why it never feels like a mode switch.

Then the agent's result renders as markdown: h2/h3 headings, bullets, numbered lists, borderless tables (column headers in dim gray, generous row spacing, *no grid lines*), and inline code chips (dark pill, subtle border, monospace — some with a file-type icon inside, e.g. `TS main.ts`).

### Diff summary card [00:10, 09:54, 16:30]

Collapsed:
```
┌────────────────────────────────────────────────────────────┐
│ › 1 changed file  +1 -0   Show files          [⧉ Open diff] │
└────────────────────────────────────────────────────────────┘
```
Expanded:
```
┌────────────────────────────────────────────────────────────┐
│ ⌄ 1 changed file  +1 -1   Hide files       [×] [⧉ Open diff]│
│   root  1 file                                              │
│   📄 research                                       +1  -1  │
│   Show all 1 files                                          │
└────────────────────────────────────────────────────────────┘
```
Files grouped by directory, per-file `+N` green / `-N` red on the right, an explicit `Show all N files` escape hatch so it never floods. `Open diff` promotes it into the right-hand Diff surface.

### Diff surface [11:44, 11:48]

Toolbar: **`Latest turn ⌄` dropdown** (also `Turn 1`, `Turn 2`, …) — diffs are scoped **per agent turn**, which the reviewer calls out as the standout feature [11:35]: *"the nice thing is that you could see the difference by turn… you could see each turn what the diffs are."* Right side: aggregate `+1 -0` counts and four icon toggles (unified/split, wrap, whitespace ¶).

File header: chevron + a green ⊕ badge for added / presumably ⊖ for deleted + filename + right-aligned `+1`. Body: line-number gutter, a colored left rail on the changed line, subtle green/red line tint, monospace. Empty state: `No net changes in this selection.`

### Sub-agents / parallel work [11:57]

The weakest area. When Claude fans out, T3 renders a bare **two-column live table**:

```
hd-pixel-fundamentals        Reading a post on gridded vs non-gridded pixel art techniques
character-art-animation      Searching for guidance on smear frames for fast actions
environments-tilesets        Reading the Level Design Book's environment-art chapter…
palette-color                Processing search results
```

Left column: sub-agent name, bold white. Right column: current activity, one line, dim gray, updating live. That's it — **no per-agent elapsed time, no status dot, no completion count, no ordering, no tree**. Everything else about the fan-out lives in prose ("The research workflow is running in the background — 7 parallel researchers covering: 1. Hi-bit fundamentals — … 2. Character art & animation — …").

The reviewer's verdict [16:23]: *"you can do kind of multi-agent orchestration [in Herder], which I do think T3 is working on, but is not part of it yet."*

---

## Design language

**Theme.** Dark only, and *very* dark. No light mode shown; Settings has an "Appearance" section that is never opened.

| Role | Approx value | Where |
|---|---|---|
| App background / center pane | `#0A0A0B` – `#0D0D0F` | near-black, not pure |
| Sidebar & top bar | `#0F0F11` | ~1 step lighter than the canvas |
| Elevated surfaces (modals, popovers, cards) | `#17171A` – `#1C1C1F` | + a 1px `#2A2A2E` hairline border |
| Mobile background | `#000000` | true black, OLED |
| Hairline dividers / borders | `#232326` | 1px, everywhere, never heavier |
| Primary text | `#EDEDEF` | headings, labels, agent narrative |
| Secondary text | `#A0A0A8` | body prose |
| Tertiary / metadata | `#6E6E76` | timestamps, tool args, descriptions |
| Accent — primary / send / focus | `#2563EB` – `#3B82F6` | send button, toggles ON, focus rings, active step |
| Accent — running | `#3B9EFF` cyan | `Working` chip + dot |
| Success | `#22C55E` | `Completed` chip, `+N` additions, ✓ glyphs, health dots |
| Danger / stop | `#EF4444` | stop button, `-N` deletions, error banner |
| Warning / gated | `#D9A441` amber | `Early Access`, `Setup Required`, `Not authenticated`, `Coming Soon` badges |
| Mobile user bubble | `#0A84FF` | iOS system blue — the *only* saturated fill on mobile |

Note there is **no `Failed` / `Error` state color for a run** — only the red error banner, which is a transient message, not a run status.

**Typography.** A single geometric/neo-grotesque UI sans throughout (reads like Inter/Geist), plus a monospace for anything machine-generated. Scale is tight:
- Hero empty state ~28px semibold (`What should we build in token-burn?`, with the project name underlined)
- Settings section h1 ~18px semibold
- Markdown h2 ~17px semibold, h3 ~15px semibold
- Body / agent narrative ~14px regular
- Metadata, tool args, descriptions ~12px
- Chips, keycaps, badges ~11px, some in small caps (`Work Log`, `Sources`, `STEP 1`)

Bold is used *semantically*, not decoratively: bold = the thing you'd scan for (thread title, tool type, provider name, the noun in a status line). Everything explanatory is dim regular.

**Density.** Deliberately **low** for a dev tool. Sidebar rows ~28px. Tool-call rows ~28px. Settings rows have ~24px of vertical air between them. Markdown tables have no rules and ~28px row height. The center content column caps at roughly 640px even in a 1000px pane. This is closer to Linear/Vercel than to VS Code, and it's the main reason the reviewer keeps calling it "clean" — the app buys legibility with whitespace rather than with borders and boxes. Compensating for the low density: the collapse-and-count pattern (`+12 previous tool calls`), which is what makes low density survivable in a log.

**Iconography.** Thin 1.5px stroke line icons, 14–16px, monochrome and dim — *except* provider/brand marks, which keep full color and act as the app's only real color accents. `>_` prompt glyph marks tool rows. File-type icons in the tree are colored (green `M↓` for markdown). Status is conveyed by a **filled dot**, never by an icon.

**Shape.** Radii: 6px chips/buttons, 8–10px cards and popovers, 12px modals, full-round pills for the mobile chrome and the composer footer. Shadows are almost absent; elevation is expressed by background lightness + a hairline border.

---

## Interaction model

**Navigation is a sidebar tree, not tabs.** Project → threads. The only "tabs" in the app are the right-panel surface tabs. There is no global tab bar, no back/forward, no URL-shaped routing exposed.

**Keyboard.** `Ctrl+K` is advertised right in the sidebar as a persistent affordance. Every command-palette-style overlay ends in a **keycap legend footer** [05:06]:

```
  ↑ ↓  Navigate    Enter  Select    Backspace  Back    Esc  Close
```

Keycaps are small dark rounded chips; the verb after each is dim. List items in the model picker carry their *own* shortcuts as right-aligned chips (`Ctrl+1` … `Ctrl+5`) [07:18]. Settings has a dedicated `Keybindings` section, and user-defined Actions can each bind a shortcut [10:18].

**Modal patterns.**
- *Command palette* — centered ~360px, backdrop dimmed hard to near-black, back-arrow + search field, small-caps section headers (`Sources`), rows of icon + bold title + dim subtitle, amber `Setup Required` on the right, keycap legend footer.
- *Wizard modal* — `Publish repository` [12:06] uses a horizontal three-chip stepper: `STEP 1 / Provider` `STEP 2 / Repository` `STEP 3 / Summary`. Done = filled blue check circle; current = blue ring + brighter card + blue border; future = dim. Radio-cards for choices (selected card gets a blue border and lighter fill), prefixed inputs (`github.com/` in a darker inset segment), a `› Advanced` disclosure, ghost `Cancel` / blue `Publish`.
- *Form modal* — `Add Action` [10:18]: title + one dim description line, labeled fields each with a helper line under the input, a trailing toggle row, ghost/primary button pair. Focused input gets a 2px blue ring.

**Composer as control panel.** Below the input sit inline pills that are the run's entire configuration, all dropdowns:
`✳ Claude Fable 5 ⌄` (model) · `High · 1M ⌄` (reasoning effort · context) · `⚙ Auto ⌄` (permission) · `Build` (mode).
The permission dropdown [06:11] lists four modes, each with icon + bold label + one-line description:
- **Supervised** — "Ask before commands and file changes."
- **Auto-accept edits** — "Auto-approve edits, ask before other actions."
- **Auto** — "An AI reviewer approves routine actions; risky ones still ask."
- **Full access** — "Allow commands and edits without prompts."

Model picker [07:18] is a two-pane popover: a vertical provider icon rail on the left (with a blue left-edge indicator on the active provider and a ★ favorites pseudo-provider) + a searchable list on the right with per-row shortcut chips and star toggles.

**Workspace declared at launch.** A second strip *below* the composer: `📁 Local checkout ⌄` / `Current checkout` / `New worktree` on the left and `⑂ master ⌄` / `From master ⌄` on the right [06:54, 07:30]. Every thread declares its isolation and base branch before it runs. This is the mechanism behind parallel agents [08:14] — same project, different worktrees.

**Actions** [10:09] — "project-scoped commands you can run from the top bar or keybindings." Fields: Name (+ icon), Keybinding, Command (`bun test`), Preview URL ("Open this URL in the in-app preview when this action runs"), and a toggle **"Run automatically on worktree creation"** — i.e. actions double as lifecycle hooks. Saved actions become first-class top-bar split buttons.

**Slash and sigil syntax** in the composer: `@tag files/folders`, `$use skills`, `/for commands`. Typing `/` opens an autocomplete popover of skills discovered from Claude Code — the reviewer's own `hyperframes` skills carry over automatically [11:48].

**Feedback.**
- *Toast* — top-right dark card, green check + bold line + dim line + `×`: "Provider updates finished / New sessions will use the updated providers." [03:54]
- *Inline transient pill* (mobile) — a small floating `☀ Pushing…` pill under the header [14:50]
- *Error banner* — full-width inset card at the top of the center pane, maroon translucent fill, red border, red `!` circle, dismiss `×`. Content is **raw and leaky**: "Orchestration command invariant failed (thread.create): Thread 'caa5ad28-129c-4643-b91f-473e40f6be53' already exists and cannot be created twice." [08:51] The reviewer's reaction is literally *"Okay, getting an error here. I'm not sure."* — a good example of the anti-pattern.
- *Scroll affordance* — a floating `⌄ Scroll to end` pill hovering above the composer when you've scrolled up in a long log [08:54]. Essential for a live-tailing log; steal it.

**Auto-titling.** Thread titles start as the raw prompt ("Please review this directory") then get rewritten by the agent to a clean title ("Review Token Burn Directory"), updating in the breadcrumb and sidebar simultaneously [07:06 → 07:18].

**Composer floats over content** with a semi-transparent background — the log visibly scrolls *underneath* it. Distinctive, and it costs nothing.

---

## What the reviewer praises and criticizes

**Praises**
- "The UI is really clean… there's a lot of nice little elements. Tool call here." [06:42]
- "It's very code-focused, and the UI is very clean. I haven't had a ton of issues… everything runs fairly smoothly. There's no weird lagginess. It just feels like a clean, polished UI." [12:42]
- Per-turn diffs: "the nice thing is that you could see the difference by turn… you could see each turn what the diffs are." [11:35]
- Git integration depth — commit, publish repo, choose provider, all without leaving the app: "This is very git-focused, right?" [09:11]
- Actions: "it's nice, pretty convenient… instead of having to go run those commands every time." [10:33]
- Auto-blurring credentials on screen [04:51]
- Mobile: "for a mobile app, this is very smooth… really well done." [14:38] "especially with the mobile, they're taking a lot of effort towards the UI, which a lot of these dev tools sometimes that is lacking." [16:00]

**Criticizes**
- Bugs: the `thread.create` invariant error [08:51]; "Few bugs we hit along the way." [15:53]; "It's still very early, as they can say." [15:48]
- **No real multi-agent orchestration**: "you can do kind of multi-agent orchestration [in Herder], which I do think T3 is working on, but is not part of it yet." [16:23]
- Less control than his current tool: "Herder, you just have a lot more control." [16:16]
- Net: he keeps the mobile app, not the desktop app — "I do think right now the mobile app is something I would probably use." [16:37]

---

## What to steal / what to skip for a headless factory dashboard

### Steal — high confidence

1. **The collapse-and-count log.** Prose narrative line as the section header, one expanded tool call under it, and everything else folded into `⌄ +12 previous tool calls`. This is the single best idea in the app and it maps perfectly onto ADW phases: each named phase becomes a narrative header, its tool calls collapse into a count, and you can expand any of them. It is what lets a 400-event SQLite stream render as a screenful. Your existing "per-phase tool-call detail" already has the data; this is purely a rendering decision.

2. **`Working for 2m 22s` → `Worked for 1m 51s ›`.** One component, two tenses, same row position. A ticking elapsed counter with an animated `•••`, freezing into a collapsed summary chevron on completion. Deliberately **no progress bar and no percentage** — T3 never pretends to know completion, and neither can you. For a headless factory this is the honest running indicator, and it's cheap: you already have phase start/end timestamps in SQLite.

3. **The status triple: `● dot · bold identifier (dim version) · "State — one plain sentence"`.** Used identically for providers, source-control backends, and relay hosts. Port it directly to: ADW runs, phases, worker machines, and agent CLI health. Pair it with the amber pill badges (`Setup Required`, `Not authenticated`) for exceptional states, and with a `Checked 1m ago` + refresh affordance in the section header. Crucially: **never render a bare enum**. `FAILED` becomes `● Failed — test phase exited 1 after 4m 12s`.

4. **Per-turn diff scoping.** `Latest turn ⌄` in the diff toolbar is exactly `Latest phase ⌄` for you. Being able to say "show me only what the *implement* phase changed, not the whole branch" is the highest-value thing a factory observability view can offer, and it's the feature the reviewer singled out. Pair with the compact diff summary card (`⌄ 3 changed files +47 -12  Show files` / files grouped by directory / per-file `+N -N` / `Show all N files`).

5. **The status list as the primary navigation, with two-simultaneous-`Working` legibility.** A flat list where each row is `[● state chip] [title] [relative time]`, active-run chips in cyan, done in green, idle unchipped, hover swaps the timestamp for row actions. It costs 215px, scales to dozens of runs, and shows parallelism without a Kanban. On a wide screen, promote it to the mobile card layout (`repo · title · branch`, with the agent glyph in the branch row's right slot) so you can see *which model* is on each run at a glance.

**Runners-up worth taking:** the floating `⌄ Scroll to end` pill (mandatory for a live-tailing log); the keycap legend footer on every overlay; the horizontal `STEP 1 / STEP 2 / STEP 3` stepper as an ADW phase-progression widget; borderless markdown tables; and the whole low-density / hairline-border / dot-not-icon aesthetic, which is 80% of why this reads as "clean."

### Skip — will not transfer

1. **The composer and everything hanging off it.** The input box, the model/effort/permission/mode pills, the workspace + branch strip, slash-command autocomplete, `@`/`$` sigils, the stop button. That's roughly a third of T3's surface area and *all* of it is for driving an interactive agent. The user explicitly does not want a chat view, and a read-only dashboard has nothing to send. Deleting it also frees the bottom ~140px of the center pane for more log. The only thing to salvage: the *display* semantics of those pills (model, effort, permission mode) become a **static run-metadata header** on each ADW run — same pill shapes, no dropdowns.

2. **Git as an interactive workflow.** `Commit`, `Commit & push`, `Publish repository`, the provider wizard, `Initialize Git`, the four Surfaces (Browser / Terminal / Files / Diff), and Actions-with-keybindings. In a headless factory the ADW script owns git, and it commits without asking. What survives is the *read* half: the diff surface and the diff summary card. The Terminal and Browser surfaces are meaningless when you're observing a server — and a live Files tree is a nice-to-have you'd have to build a file-serving endpoint for. Skip both.

3. **T3's sub-agent rendering.** The bare two-column `name | current activity` table is genuinely the weakest thing in the app — no elapsed time, no status dot, no completion count, no ordering, no relationship to the parent. The reviewer names parallel orchestration as the missing feature. Since the user will run *several ADWs at once* and each fans out further, this is precisely where T3 has nothing to teach and where the factory dashboard must invent: a real trace waterfall with per-agent lanes, durations, and states. Take T3's *row styling*, take nothing of its *structure* — the existing Vue waterfall is already ahead of it here.

**Also not transferable, lower stakes:** dark-only with no light mode is a defensible choice but a solo engineer staring at a server dashboard in daylight may disagree; T3's raw leaky error strings (`Orchestration command invariant failed (thread.create)…`) are an anti-pattern to explicitly avoid, especially in a system whose whole job is telling you why a run broke; and the mobile app's iOS-blue chat bubbles are the one place T3's own design language slips, so don't copy the mobile *bubbles* even if you copy the mobile *cards*.

One structural idea worth lifting wholesale: T3's **environment vs client** split (`Publish agent activity — Send activity from this environment to your mobile clients… Works without a T3 Connect tunnel`) is the correct architecture for a headless factory. The server publishes an event stream; the dashboard is one of possibly several thin read-only consumers. That is already close to the SQLite-event-stream design; it just argues for making the read path a proper published feed rather than something only the Vue app knows how to open.
