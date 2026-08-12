# Video 4 — "I barely review the code anymore after I added these skills"

| | |
|---|---|
| **URL** | https://www.youtube.com/watch?v=7ktaOZqeCmI |
| **Speaker** | Ben Holmes (`bholmesdev`) — ex-Astro core, now building `hubble.md` |
| **Duration** | 11:31 |
| **Subject** | **Agent Skills as the unit of agent configuration** — how to move behaviour out of `AGENTS.md` and into description-gated `SKILL.md` files that the model dispatches on its own |
| **Harness shown** | Codex CLI (`codex --yolo`), model `gpt-5.6-sol medium` (visible in status bar `[04:48]`) |
| **Demo repo** | `bholmesdev/hubble.md` — Electron desktop notes app, pnpm monorepo (`apps/desktop`, `packages/ui`, `packages/editor`, `packages/sync-backend`), Vite + Biome + tsc + cargo |
| **Skills repo** | `github.com/bholmesdev/skills` — install via `npx skills add bholmesdev/skills` |
| **Evidence base** | Full caption transcript + 44 targeted frames read at 1024px (every `SKILL.md`, the `AGENTS.md`, the tldraw diagram, and the skill-audit output are legible) |

> Timestamps in `[mm:ss]` are from the caption track and are re-checkable.

---

## 0. Read this first — what the video is and is not

**It is not about design systems, shadcn, registries, or design tokens.** None of those words appear. If it was linked expecting a UI-generation tutorial, that expectation should be reset now.

**It is about the skill as a primitive**: what goes in one, what the description field is for, how skills compose, and how the newest models auto-dispatch them without being told to. It is a mental-model video with about six minutes of file-reading.

It nevertheless lands on the UI thread in four specific places, and those are the highest-value parts of it for us:

1. **`taste-review`** `[04:39]` — a skill that makes **Codex shell out to `claude -p`** whenever it hits a design/UI/naming judgment call. This is a working mechanism for "use the model that is good at UI for the UI decision", rather than an opinion about which model is good at UI.
2. **`vercel-react-best-practices`** `[03:48]` — a vendored standards skill whose rules are **ID'd, prefixed and priority-tiered**. This is a format worth stealing for our coding standards.
3. **`test-desktop-app`** `[08:14]` — the agent verifies its own UI over the Chrome DevTools Protocol, screenshots included, with no human and no computer-use.
4. **The skill audit** `[10:52]` names our component-reuse problem exactly: *"Agents repeatedly discovered duplicate editors or broader reusable abstractions only after implementation."*

---

## 1. The core mental model: "a program that gets written just in time"

This is the thesis, stated at `[02:27]`:

> "I like to think of this sort of like **a program that gets written just in time**, where all of your skills could be thought of like **functions that the agent has available to call**."

The tldraw diagram he builds `[02:35]`–`[03:22]` is the whole video in one picture:

```
SKILLS                          ← the available function library
  reviewTasteDecisions()
  simplify()
  refineReactCode()
  addCodeComments()
  testDesktopApp()

Prompt                          ← what you actually type
┌──────────────────────────┐
│  Do the thing            │
└──────────────────────────┘

Execution program               ← what the MODEL assembles, unprompted
┌──────────────────────────┐
│  reviewTasteDecisions()  │
│  …                       │
└──────────────────────────┘
```

The generational claim `[02:45]`:

> "Before, when I was using earlier versions of the models, I had to put all of these function calls directly in my prompt, otherwise the agent wouldn't really know to include it. In other words, **I was writing a mini computer program every time I prompted these agents instead of just saying what I wanted.** But I've noticed with the latest batch of models that you don't need to write these computer programs anymore."

And `[02:11]`:

> "With the latest batch of models from both Claude and Codex, especially Codex with GPT-5.6, these models are **trained to discover skills in your project and apply them at the correct times** without you having to manually `/specify` every little thing."

**The load-bearing consequence:** if the model assembles the program, then the `description:` frontmatter field is the dispatch table. `[05:02]`:

> "This is where **the description is a really important part**, because looking at our just-in-time computer program, the agent's not going to know to pull things into this program unless it makes sense for the task. And the description is how the agent decides whether it is important. So in this description I include **both what the skill does and also when to use the skill.**"

---

## 2. The opening demo — one sentence, five skills `[00:23]`–`[01:39]`

He types one line into an existing Codex session:

> `[00:36]` **"Looks good. Let's add these options to the overflow menu in the file editor"**

Codex then, with no further instruction, does the following (all visible in the session log):

| Time | What appears in the log | Why |
|---|---|---|
| `[00:36]` | `Explored → Read SKILL.md (vercel-react-best-practices skill)` | It's a React project |
| `[00:45]` | `Explored → Read SKILL.md (taste-review skill)` — and in its own words: *"I'm using the project's taste-review skill for the menu wording/grouping"* | The task involves copy + menu placement |
| `[00:57]` | `Edited apps/desktop/electron/main.ts (+2 -0)` adding a plain-English *why* comment, then `Ran pnpm build:desktop` → biome/tsc/vite/cargo | The review-readiness pass |
| `[01:05]` | `Explored → Read SKILL.md (test-desktop-app skill)`, then `Ran curl -s http://127.0.0.1:9222/json/list`, then `Called chrome-devtools.take_snapshot` | Verify it actually runs |
| `[01:33]` | Working menu with "Open in Codex" / "Open in Claude" entries, clicked live | Done |

His summary `[01:07]`:

> "Not only am I getting code that works, I'm also getting code that **matches the style that I prefer**, matches the React guidelines, and I'm also certain it actually runs end to end since it's able to click around what it built."

---

## 3. The `AGENTS.md` is a router, not a rulebook `[01:48]`–`[02:07]`

He claims it is "basically empty". What is actually on screen is **22 lines**, and the shape matters more than the length — every section is a *pointer*, not a rule:

```markdown
Check work: `pnpm build:desktop` (builds packages, runs biome check, tsc, vite build, cargo check). F…

When asked why you made a decision, answer why. Don't take it as a challenge to your approach, or pre…

## Agent skills

### Issue tracker
GitHub Issues on `bholmesdev/hubble.md` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels
Defaults: `needs-triage`, `ready-to-implement`, `needs-discussion`, `wontfix`. See `docs/agents/triage…

### Domain docs
Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Review readiness
Use `.agents/skills/review-readiness` before handing code to a human reviewer.
```

Three things to notice:

- **No skill invocation trickery.** `[01:39]`: *"Did we do some trickery in our Agent MD to tell it to call all of these skills every time I ask it to do something? **The answer is no.**"*
- **Domain knowledge is a single named context file plus ADRs** (`CONTEXT.md` + `docs/adr/`), reached via a pointer, not inlined.
- **The only imperative left is the phase boundary**: "use `review-readiness` before handing code to a human reviewer."

This is very close to what our `documentation-factory` knowledge base is for, and it is a much thinner root file than most.

---

## 4. File layout `[04:30]`, `[09:14]`

Skills live at **`.agents/skills/<name>/SKILL.md`** — one directory per skill, confirmed by the audit output at `[11:04]` referencing `.agents/skills/comments/SKILL.md` and `.agents/skills/taste-review/SKILL.md`.

The full roster visible in the sidebar:

```
.agents/skills/
├── changelog/
├── comments/                    SKILL.md
├── create-pr/
├── done/
├── grill-with-docs/
├── handoff/
├── implementation/
├── release/
├── request-pr-review/
├── review-pr/
├── review-readiness/            SKILL.md   ← composite wrapper
├── simplify/                    SKILL.md
├── taste-review/                SKILL.md
├── test-desktop-app/            SKILL.md
├── to-issues/
├── triage/
└── vercel-react-best-practices/ SKILL.md + rules/
AGENTS.md
README.md
```

That roster is itself informative: `handoff`, `implementation`, `triage`, `to-issues`, `create-pr`, `review-pr`, `request-pr-review`, `release`, `changelog`, `done` are **phase names**, not capabilities. He has independently arrived at something close to our named-phase decomposition, but expressed as skills the model picks rather than as a Python driver.

### Installing external skills `[03:48]`–`[04:20]`

```bash
npx skills add <org>/<repo>
npx skills add vercel/<repo>        # what he uses for React best practices
npx skills add garrytan/gstack      # typed on screen [04:05]
npx skills add bholmesdev/skills    # his own [09:34]
```

> `[03:54]` "It's honestly **not really a marketplace**. It's more just if there is a skill available as a GitHub repo, this CLI helps you pull it down… once it's installed or cloned into your skills folder, **you're free to modify it however you want.**"

So: vendoring, not a dependency. There is no version pinning or update path shown.

---

## 5. The five skills, in full

### 5.1 `vercel-react-best-practices` — how to encode standards `[03:48]`, `[04:30]`

Frontmatter carries `license: MIT` and `metadata: {author: vercel, version: "1.0.0"}` — the only skill shown with provenance metadata.

```markdown
# Vercel React Best Practices
Comprehensive performance optimization guide for React and Next.js applications, maintained by Vercel.

## When to Apply
Reference these guidelines when:
- Writing new React components or Next.js pages
- Implementing data fetching (client or server-side)
- Reviewing code for performance issues
- Refactoring existing React/Next.js code
- Optimizing bundle size or load times

## Rule Categories by Priority
| Priority | Category | Impact | Prefix |
```

**The rule format is the takeaway.** Every rule is a stable kebab-case ID with a prefix denoting its category, followed by one imperative line:

```
- `rerender-defer-reads`               - Don't subscribe to state only used in callbacks
- `rerender-memo`                      - Extract expensive work into memoized components
- `rerender-dependencies`              - Use primitive dependencies in effects
- `rerender-derived-state`             - Subscribe to derived booleans, not raw values
- `rerender-derived-state-no-effect`   - Derive state during render, not effects
- `rerender-functional-setstate`       - Use functional setState for stable callbacks
- `rerender-lazy-state-init`           - Pass function to useState for expensive values
- `rerender-split-combined-hooks`      - Split hooks with independent dependencies
- `rerender-move-effect-to-event`      - Put interaction logic in event handlers
- `rerender-transitions`               - Use startTransition for non-urgent updates
- `rerender-no-inline-components`      - Don't define components inside components

### 6. Rendering Performance (MEDIUM)
- `rendering-animate-svg-wrapper`      - Animate div wrapper, not SVG element
- `rendering-content-visibility`       - Use content-visibility for long lists
- `rendering-hoist-jsx`                - Extract static JSX outside components
- `rendering-hydration-no-flicker`     - Use inline script for client-only data
- `rendering-activity`                 - Use Activity component for show/hide
- `rendering-conditional-render`       - Use ternary, not && for conditionals
- `rendering-usetransition-loading`    - Prefer useTransition for loading state
```

Plus a `rules/` subdirectory for the long form — the `SKILL.md` is the index, detail is progressive-disclosure.

Observed effect `[04:27]`: *"it's very smart about adding `useLayoutEffect` in the right places and **not abusing `useEffect`** as much whenever this is in context."*

### 5.2 `taste-review` — cross-model delegation for design calls `[04:39]`–`[06:18]`

The rationale `[04:41]`:

> "You may have seen a lot of videos around the internet including my own about how **Claude tends to be better at design decisions** — where if it needs to reason about copywriting or how things should be placed in the UI, it tends to do a better job. So I decided, why not just have **Codex tap Claude Code on the shoulder** whenever it's trying to make a design decision."

Full file:

```markdown
---
name: taste-review
description: Ask Claude Code to make a taste-driven call on something ambiguous — UI polish,
  prose phrasing, naming, formatting. Use when you'd otherwise guess at these decisions.
---

You hit something fuzzy and need a judgment call. Shell out to the `claude` CLI to get one back,
then apply it.

Run from the repo root so `claude` can read files by relative path:

Run outside the sandbox when required, requesting reusable approval for the
`claude -p` prefix. On macOS, use the optional long-lived subscription OAuth
token from Keychain when present. Otherwise, fall back to that machine's normal
Claude authentication.

```bash
prompt="$(cat <<'EOF'
<your question, stated plainly>

Files to consider: <paths, if any>

Weigh a few options, give your recommendation, and share others as alternatives considered.
Length is up to you — a design call may warrant several paragraphs;
a naming call may not. Match the depth to the decision.
EOF
)"

if [[ "$(uname)" == "Darwin" ]] &&
  oauth_token="$(
    security find-generic-password \
      -a "$USER" \
      -s "Claude Code skill OAuth" \
      -w 2>/dev/null
  )"; then
  CLAUDE_CODE_OAUTH_TOKEN="$oauth_token" claude -p "$prompt"
else
  claude -p "$prompt"
fi
```
```

Notes on the prompt template, which is the good part:

- **"Weigh a few options, give your recommendation, and share others as alternatives considered."** — forces the sub-agent to surface the decision space, not just an answer. That is an auditable artifact.
- **"Match the depth to the decision."** — explicit budget control on the sub-agent's output length, keyed to decision weight.
- He is candid that the description needs work `[05:25]`: *"this honestly could be refined a little bit."*

### 5.3 `comments` — the whole skill is one sentence `[06:20]`–`[06:41]`

```markdown
---
name: comments
description: Use when writing or reviewing code comments.
---

Write plain-English comments that explain why non-obvious code exists.
Skip comments that merely restate what the code does.
```

Motivation `[06:22]`: *"Codex tends to not leave a lot of comments unless there are comments in the surrounding code. It also writes in a more mechanical format rather than plain English."* Summarised `[06:39]`: **"explain the why, not the what."**

Seven lines total. This is the proof that skills need not be long.

### 5.4 `simplify` — his longest-standing skill `[06:42]`–`[07:52]`

```markdown
---
name: simplify
description: Use this skill automatically when you feel your code ready for human review.
  This means the code works and achieves its stated goal[, and you deem it necessary human testing]…
---

Review changes in the current branch, or in the state the user specifies.
Apply these criteria **without changing behavior**:

1. **Names**: Shorten verbose names while keeping them clear. Prefer human-readable
   concepts (`baseline`) over compound phrases…
2. **Combine related concepts**: If two types, functions, or constants overlap
   significantly, merge them. The fewer distinct concepts…
3. **Derivability**: If a value can be computed from other values already in scope,
   don't pass or store it separately. Removing…
4. **Scope**: Only touch code in the staged diff. Run existing tests after every change.
```

Three design decisions in there worth lifting verbatim:

- **"without changing behavior"** — a refactor skill declaring itself semantics-preserving.
- **"Only touch code in the staged diff"** — an explicit blast-radius bound.
- **"Run existing tests after every change"** — self-verification inside the skill, not delegated to a later phase.

On criterion 2 `[07:27]`: *"It's very common for agents to have two functions to do the same thing."*
On criterion 3 `[07:36]`: *"Always use derived values… you want to sort of denormalize all of your databases. The same goes for code."*

Still verbose-model-driven `[06:50]`: *"5.6 loves writing a lot of code when getting to a solution."*

### 5.5 `review-readiness` — the composite / wrapper pattern `[07:54]`–`[08:13]`

```markdown
---
name: review-readiness
description: Use when code is working and ready for a final human-review pass.
---

Run a final review pass in this order:

1. Apply the `simplify` skill to reduce unnecessary complexity without changing behavior.
2. Apply the `comments` skill to add and/or refine comments in written code.
3. Run the relevant existing checks after any change.
```

He names the pattern explicitly `[08:00]`:

> "This is the same way you would do a **function wrapper** for multiple things you want to do. I've created a wrapper right here saying to use simplify, comments, and then whatever else I might want to add to this, anytime it's ready to hand back to me."

This is the single most directly transferable structural idea in the video: **a skill whose entire body is an ordered call list of other skills.** It is a phase, written as markdown.

### 5.6 `test-desktop-app` — the one he says every repo must have `[08:14]`–`[09:20]`

> `[08:15]` "This is the kind of skill that **I think every repository, at a minimum, should have.** Because if the agent doesn't know how to open the app it built and test that it runs appropriately, you're going to constantly copy-paste error messages back from the client console into your prompt box. **That is so 2024.** You should give the agents the keys to the kingdom to actually open the app, click around, and come back to you once it's working."

```markdown
---
name: test-desktop-app
description: Use when testing the Hubble Electron desktop app, especially when inspecting,
  clicking, screenshotting, or verifying a real note edit in the running app.
---

# Test Desktop App

1. Run `HUBBLE_DESKTOP_ENABLE_CDP=1 pnpm dev:desktop`.
2. Read the terminal output for:
   - `Playground: <path>`
   - `DevTools listening on ws://127.0.0.1:9222/...`
3. Use the auto-opened editable playground at `apps/desktop/.dev-electron/playground`
   instead of file pickers or checked-in fixtures.
4. Prefer the Chrome DevTools Protocol endpoint for interaction-heavy verification. It can
   inspect DOM state, evaluate JavaScript, click controls, inspect iframe contents, and
   capture screenshots from…
5. For CDP setup, fetch `http://127.0.0.1:9222/json/list`, connect to the page
   `webSocketDebuggerUrl`, and drive the renderer with DevTools Protocol commands.
6. When you're done, stop the dev server and confirm no `Hubble Dev` process remains.

Gotchas:

- Build `packages/ui` and `packages/editor` first; the desktop app imports their dist output.
- Screenshots are DPR 2: CSS px times 2.
- Right clicks need real `Input.dispatchMouseEvent` events; synthetic `contextmenu`
  events don't open base-ui context menus.
- Popup open in the DOM but missing from a screenshot? Check stacking with
  `document.elementFromPoint`.
- xterm refits through a debounced ResizeObserver and can lag layout changes by a few
  seconds; re-measure before calling it a bug.
```

Deliberately unglamorous `[08:59]`: *"I'm **not using computer use or anything fancy**. This will work with whatever harness you have, like if you're using **pi** or Claude Code or whatever else. This is letting it write Node scripts inside the Electron app to screenshot and verify that everything's working."*

Note he names `pi` — the same agent we drive. Also note **`base-ui`**, not Radix — consistent with our own `migrate-radix-to-base` skill.

Structure worth copying: **numbered happy path, then a `Gotchas:` list.** Step 1 sets an env var (`HUBBLE_DESKTOP_ENABLE_CDP=1`) that unlocks a debug surface the app does not normally expose — the skill's first act is to put the app into an agent-inspectable mode. Step 6 is teardown/leak-check.

---

## 6. How skills get better over time — two mechanisms

### 6.1 Gotchas accrete as diffs, written by the agent that got burned `[10:11]`

> "And **yes, I asked the agent to write the initial version of this skill**, and in future versions, if it ever hit a wall, I asked it to update with gotchas. For example, when **Fable** tried to run this skill, it took these notes on its own, because Fable loves being Fable. It knows some issues with like the pixel size when taking a screenshot, so that it didn't mess it up twice. And **those were applied as diffs onto the skill.**"

So the `Gotchas:` block is an append-only failure log, authored by the model, scoped to one skill. `Screenshots are DPR 2: CSS px times 2` is literally a bug a model hit once and wrote down.

Note the tension with his own advice in §8 — see the reconciliation there.

### 6.2 The skill audit — an agent mines your own history for missing skills `[10:34]`–`[11:20]`

> "To get started, you could actually have an agent **trace through your conversations to find opportunities to improve.** I just had Codex do this, because I just thought to do it. It makes a lot of sense."

The output format it produced is the interesting artifact — numbered proposals, each with **Trigger / Required behavior / Evidence**, where Evidence cites how many past conversations exhibited the pattern:

**`### 2. worktree-hygiene`** `[10:44]`
> *Trigger for any coding task involving branches, worktrees, commits, merges, or pushes.*
> Required behavior: Run `git status`, current branch, and `git worktree list` before editing · Detect unrelated/concurrent changes and declare owned files · Honor "make a worktree first" before any mutation · Never restore, stash, move, or delete changes without establishing ownership · Stage explicit paths; inspect `git diff --cached` · Split commits by independently reversible behavior · Recheck worktree cleanliness and intended commit contents before push.
> Evidence: *"Atomic commits" was repeated across at least six conversations · An agent moved files while another agent was preparing commits · User-authored skill changes were overwritten by an auto-syncing command.*

**`### 3. architecture-preflight`** `[10:52]`
> *Trigger for persistence, telemetry, backend, routing, editor, or application-lifecycle changes.*
> Required behavior: Read `CONTEXT.md`, relevant ADRs, deployment configuration, and existing integration boundaries · Trace actual state transitions—not just initialization defaults · List infrastructure assumptions and prove each from code/config · Inventory existing interaction invariants that must survive · Resolve contradictions between a handoff and the current repository before delegating implementation.
> Evidence: *Telemetry implementation added a Convex table despite no user-facing Convex deployment; it had to be removed for direct Plausible events · Sidebar placement advice assumed the sidebar defaulted closed; the workspace-opening flow actually opens it · **Agents repeatedly discovered duplicate editors or broader reusable abstractions only after implementation.***

**`### 5.` (sandboxed sub-agent reliability)** `[11:04]`
> Required behavior: Know whether credentials require an unsandboxed context · Capture stdout, stderr, exit status, transcript/result files, and process state · **Empty stdout does not prove empty model output** · Use a timeout and a defined retry limit; kill all child processes when stopped · Avoid interactive Git/editor subprocesses · Never create tokens, edit Keychain, or alter billing/auth configuration unless explicitly authorized · Detect commands that sync or regenerate files before running them over local edits.
> Evidence: *Claude was repeatedly reported logged out only inside the sandbox · An agent claimed Claude returned no output while the user could visibly see it · Claude review processes stalled repeatedly · Fixing auth escalated into creating a long-lived token and researching billing · Running Claude auto-synced over a manual skill edit.*
> **"This should replace the shell details currently embedded in `.agents/skills/taste-review/SKILL.md`."**

**`### 6. Strengthen comments and review-readiness`** `[11:10]`
> *The current `.agents/skills/comments/SKILL.md` is only one sentence.* Add a mandatory new-helper audit: Prefer domain language; avoid overloaded abbreviations such as `ref` · Public or non-obvious utilities get short plain-English doc comments · Comments explain the rule or reason, not mechanics · **Assess whether reusable helpers belong in `lib`** · **Scan all newly introduced helpers before handoff.**
> Evidence: *plain-English comments, clearer utility names, and better module placement were requested across at least six conversations.*

**`### 7. Strengthen create-pr`** — *"The current `.agents/skills/create-pr/SKILL.md` is too thin."*

His verdict `[10:44]`: *"while there is some fluff in here, for sure, there are some interesting ideas that I might pull out."* Not accepted wholesale — treated as a proposal queue.

---

## 7. When to write a skill `[09:45]`

> "The simplest way to get started is **if you find yourself prompting the agent multiple times to do something**, that means you can probably wrap it up in a skill. The same way that you wouldn't want the same code copied five times throughout a code base, you probably want to **abstract the kinds of prompts that you're writing all the time.**"

His own worked example `[10:02]`: *"I got so tired of copying client console logs back into the prompt box, that I figured out a way for the agent to test the desktop app."*

---

## 8. Explicit warnings — what he says NOT to do

| # | Warning | Timestamp |
|---|---|---|
| 1 | **Don't have an agent write the skill body.** *"I tend to handwrite my skills whenever possible just so we're not pulling in too many things into context, and we know that **every line is purposeful**. Otherwise, if you have an agent write this block, it's going to have a lot of fluff, and **you're not going to know what to add or remove**. The same way that you wouldn't copy something off of Stack Overflow — you also wouldn't want to just copy a skill directly from Claude's output."* | `[05:41]`–`[06:04]` |
| 2 | **Don't put skill-invocation trickery in `AGENTS.md`.** Don't write "always call X" clauses. The description field does the routing. | `[01:39]` |
| 3 | **Don't keep writing the mini-program in your prompt.** Manually chaining `/skill` calls in the prompt is a habit from older models. | `[02:45]` |
| 4 | **Don't be the human clipboard.** Copy-pasting console errors back into the prompt box is *"so 2024."* | `[08:26]` |
| 5 | **Don't just download his skills.** *"I really encourage you to write all of these skills yourself, since **your tastes are probably going to be a bit different**, and you're probably going to find corner cases that I did not, depending on the model that you're using, and depending on the project that you're building."* | `[09:31]` |
| 6 | Implicit: he twice flags his own skills as under-refined (`[05:25]` on the taste-review description, `[07:18]` on simplify, `[11:11]` on comments). The audit agrees. **Treat any skill as a draft.** | — |

**Reconciling #1 with §6.1.** He says handwrite, then admits *"yes, I asked the agent to write the initial version of this skill"* for `test-desktop-app` `[10:11]`. The consistent reading is a split by skill type:

- **Judgment / taste / standards skills** (`taste-review`, `simplify`, `comments`) — handwritten, short, every line load-bearing. These encode *his* preferences; an agent cannot know them.
- **Procedural / mechanical skills** (`test-desktop-app`) — agent-drafted, then pruned, then agent-appended with gotchas on failure. These encode *the environment's* facts, which the agent discovers better than he does.

That split is a usable rule for us.

---

## 9. Models and tools, and why

| Thing | His claim | Timestamp |
|---|---|---|
| **Codex / GPT-5.6** (`gpt-5.6-sol medium`) | Primary driver. *"I've especially found good luck in Codex with the latest GPT models with having these skills just get called at the right times."* Weaknesses he compensates for with skills: rarely writes doc comments, writes mechanically rather than in plain English, *"loves writing a lot of code."* | `[03:39]`, `[00:57]`, `[06:22]`, `[06:50]` |
| **Claude Code** | Called *into* Codex for design. *"Claude tends to be better at design decisions — copywriting, how things should be placed in the UI."* | `[04:41]` |
| **"latest Opus or Fable models"** | Skills are portable. *"Skills are just markdown, so if you try these out with the latest Opus or Fable models, they'll work there as well."* | `[03:32]` |
| **Fable** | Self-documents gotchas unprompted. *"Fable loves being Fable."* | `[10:19]` |
| **`pi`** | Named as a harness the CDP approach works with. | `[09:03]` |
| **`npx skills add <org>/<repo>`** | Vendoring CLI for GitHub-hosted skills. | `[04:02]` |
| **Chrome DevTools Protocol** | Chosen over computer-use deliberately — harness-agnostic, scriptable, cheap. | `[08:59]` |
| **Base UI** | In use (the `base-ui context menus` gotcha). | `[09:14]` |
| **Matt Pocock's skills** | One installed; he says he might remove its `AGENTS.md` clause. | `[01:53]` |

---

## 10. What transfers to a headless, no-human-in-the-loop factory

### Transfers cleanly

1. **The composite/wrapper skill.** `review-readiness` = ordered call list of `simplify` → `comments` → checks. This is a phase expressed as markdown. Our review/document phases can be authored this way and still be driven by a deterministic Python caller. No human needed.
2. **The ID'd, prefixed, priority-tiered rule format** from `vercel-react-best-practices`. Rules with stable IDs (`rerender-derived-state`) can be **cited by the reviewer in its envelope** and **asserted by a gate**. "Violated `rendering-conditional-render` at `Foo.tsx:41`" is machine-checkable in a way that "follow React best practices" never is. This is the single best answer in the video to *"how do I stop the agent inventing its own patterns."*
3. **`AGENTS.md` as a thin router to `CONTEXT.md` + `docs/adr/` + `docs/agents/*.md`.** Twenty-two lines of pointers. Our `documentation-factory` output is exactly the thing those pointers should point at.
4. **Scope + behavior-preservation clauses.** *"Only touch code in the staged diff"*, *"Apply these criteria without changing behavior"*, *"Run existing tests after every change."* These are blast-radius bounds a headless system needs even more than an interactive one, and they are gate-checkable (diff-scope assertion).
5. **A verify skill that puts the app in an agent-inspectable mode and drives it over a protocol.** `HUBBLE_DESKTOP_ENABLE_CDP=1` + CDP + screenshot + teardown/leak-check. No computer-use, no human eyeballs. Directly buildable for our verify phase, and it closes the loop on **UI** specifically — the agent sees what it built.
6. **`Gotchas:` as an append-only, model-authored failure log per skill.** Our SQLite trace already records failures; the missing piece is a writer that turns a repeated failure into a gotcha line. Give agents append-only permission on that section and no permission on the body.
7. **The skill audit as a maintenance ADW.** Ben ran it ad hoc against chat history. We have a *better* input — a structured SQLite trace with phase, gate result and envelope. An `adw_skill_audit.py` that emits Trigger / Required behavior / **Evidence (n runs)** proposals into a review queue is a near-drop-in.
8. **`architecture-preflight` as a pre-build gate.** Its evidence line — *"agents repeatedly discovered duplicate editors or broader reusable abstractions only after implementation"* — **is** the component-reuse problem. The fix shape is: before building, read `CONTEXT.md` + ADRs + an inventory of existing components, and prove reuse-or-not *in the plan envelope*, not after the diff exists.
9. **`npx skills add org/repo`** for vendoring external standards (Vercel React rules) into the factory repo.

### Does not transfer as-is

1. **The central premise is non-deterministic dispatch.** The entire video rests on *the model choosing* which skills to load from `description:` matching. Our factory's value is that phases are pinned by Python. His own experience confirms the risk `[10:57]`: *"asking it to look through the system architecture… **Because I have noticed sometimes it misses this in context.**"* A skill that fires 90% of the time is fine for a solo human who will notice; it is a silent-defect generator at 3am with no reviewer. **Pin mandatory skills per phase; let description-dispatch handle only optional enrichment.**
2. **`taste-review`'s auth and sandbox story is macOS-desktop-shaped and demonstrably flaky.** `security find-generic-password` is mac-only — dead on a Linux VPS. And the audit at `[11:04]` is a list of exactly how it fails in a sandbox: *"Claude was repeatedly reported logged out only inside the sandbox"*, *"an agent claimed Claude returned no output while the user could visibly see it"*, *"Claude review processes stalled repeatedly."* The **pattern** (delegate design calls to a better-at-UI model) transfers; **this implementation** must be rebuilt as a proper sub-agent call with timeout, retry limit, child-process kill, and exit-status capture. The audit's own item 5 is the spec for that rebuild — use it.
3. **"When you feel your code is ready for human review."** Both `simplify` and `review-readiness` are triggered on a human-handoff boundary that our factory does not have. Our equivalent boundary is the `no-mistakes` merge gate / PR-open. The trigger text must be rewritten or the skills will never fire (or fire at random).
4. **`--yolo`, live clicking, "I might ship this."** The demo's acceptance test is a human looking at a menu. Ours must be an assertion.
5. **"Requesting reusable approval for the `claude -p` prefix"** — an interactive permission grant. Must be pre-granted in config headless.
6. **Vendored skills have no version pinning.** *"You're free to modify it however you want"* means a fork with no upstream update path. Acceptable for a solo human; needs a recorded provenance/version note for a factory (the Vercel skill's `metadata: {author, version}` block is the pattern to keep and enforce).

---

## 11. Decisions this raises

1. **Dispatch model.** Do we pin skills per phase in the ADW (deterministic), or lean on `description:` auto-discovery (Ben's model), or both — mandatory pinned + optional discovered? Recommend both, with the pinned set gate-enforced.
2. **Rule IDs.** Do we adopt prefixed, kebab-case, priority-tiered rule IDs for our coding standards so the reviewer can cite them and Skylos can assert them? If yes, this changes the shape of the standards docs the `documentation-factory` produces.
3. **Cross-model taste delegation.** Do we add a `taste-review` equivalent that hands UI/copy/naming calls to Opus 4.8 / GLM 5.2 / Gemini from inside the build phase? If yes: what is the Linux-VPS auth path (no Keychain), what is the timeout/retry policy, and does the recommendation + alternatives-considered get persisted into the envelope as a decision record?
4. **Thin the root file.** Do we cut `AGENTS.md` to a pointer index over `CONTEXT.md` + `docs/adr/` + `docs/agents/*.md`, matching his 22-line shape?
5. **Gotchas channel.** Do we add an append-only `Gotchas:` section to every factory skill, writable by agents on failure and never rewritable? Who reviews accumulated gotchas, and when do they get promoted into the skill body?
6. **Skill-audit ADW.** Do we build `adw_skill_audit.py` over the SQLite trace, emitting Trigger / Required behavior / Evidence(n) proposals? Note our evidence is stronger than his (structured runs vs. chat scrollback). Output goes to a human queue or auto-opens a PR via `no-mistakes`?
7. **`architecture-preflight` phase.** Do we insert a pre-build step that reads `CONTEXT.md` + ADRs + a component inventory and must *prove* reuse-or-new in the plan envelope? This is the concrete fix for "agent invents a second version of a component we already have" — and it belongs before the build, not in review.
8. **Composite skills vs. ADW phases.** `review-readiness` is a phase written in markdown. Where does the boundary sit — which sequencing lives in Python (retries, gates, envelopes) and which lives in a wrapper skill (ordered sub-skill calls)? Getting this wrong duplicates the orchestrator.
9. **Vendoring policy.** Do we `npx skills add vercel/...` for React rules? If so, do we record author/version metadata and accept that it is a fork with no update path?
10. **Skill authorship split.** Do we adopt his implied rule — judgment/standards skills handwritten and short; procedural/environment skills agent-drafted then pruned and gotcha-appended? This determines what the factory is allowed to write about itself.
11. **Verify-phase UI loop.** Do we build the CDP-equivalent for our stack so the agent screenshots and asserts its own UI? Without it, no amount of design-system discipline is checkable headlessly.

---

## 12. Honest assessment of fit

This is a **solo-human-in-the-loop** video. Ben's whole win is that he can stop *reviewing* because the skills front-load the review — but he is still the acceptance test, and he says so (`"ready to hand it back to me"`, `"I might ship this"`). Nothing here is a headless system.

What it gives us is **format**, not architecture: the shape of a good skill (short, description-gated, scoped, behavior-preserving, gotcha-accreting), the shape of good standards (ID'd rules), the shape of a good root file (a router), and the shape of a good self-improvement loop (evidence-counted proposals from history).

The two ideas most worth acting on are the ones he did not present as headline material: **`architecture-preflight`** (because it names our component-reuse failure and puts the fix before the build) and the **skill audit over run history** (because our trace DB makes it strictly better than his version).

On the original UI question: the video's answer is not "use model X for UI." It is **"route the decision type to the model that is good at it, at the moment the decision is made, and make the sub-agent show its alternatives."** That is a mechanism we can build. The rest of the UI stack — design systems, tokens, shadcn, registries — is simply not in this video.
