# turbodiff — the video-proof PR tool, and what its recording mechanism actually is

**What this is:** a code-grounded study of `github.com/Ngineer101/turbodiff`, ordered because the
operator saw the headline trick — *an agent builds a feature, records a video of the feature running,
and ships the PR with review comments already addressed* (Nico Botha, @nwbotha, X, 2026-08-12) — and
said *"this can come in clutch for end-to-end app testing and UI work."* The study establishes the
mechanism and files it. **There is no adoption recommendation here**, per MAP standing rule 1: *"A
discovered capability is not a reason to add a node: if a boundary already has a check, the discovery
is filed, not deployed"* (`MAP.md:33-35`).

**Subject:** `Ngineer101/turbodiff`, cloned and read 2026-08-13 at head `1d128d2`
(*Add oauth flow support for mcp servers (#58)*). TypeScript. Licensed **FSL-1.1-ALv2**
(`LICENSE.md:1-5`, `README.md:209-210`) — source-available with a commercial non-compete, not
OSI-open; self-hosting is explicitly permitted.

**Study date:** 2026-08-13.

**Sources:** the repo's own source tree (`src/**`, `migrations/**`, `Dockerfile`, `wrangler.jsonc`),
its docs (`README.md`, `AGENTS.md`, `docs/software-factory-design.md`), and the factory as it stands
on `main` at `1f0e2c9`. Line numbers are given where load-bearing. The X post is cited only where a
claim originates there and nowhere in the code — which turns out to matter (§5).

---

## 1. What turbodiff is — one page

A **GitHub App** built on the **Flue** agent framework, hosted entirely on Cloudflare (Workers,
Durable Objects, D1, Queues, R2, Containers, Workflows). Two products share one codebase
(`README.md:5-19`):

1. **A software factory** — free-form requirement → plan → clarifying questions → approve → generate
   → PR → verify → review → auto-fix → merge.
2. **Standalone PR review** — which has been **retired**. `AGENTS.md:12`: *"Human-opened PRs are never
   reviewed (the standalone auto-review product was retired; reviews gate factory output only)."* The
   webhook handler enforces it: it looks up `getFeatureByRepoPr(repo.id, p.number)` and, with no
   `features` row, returns `{ ok: true, skipped: 'not a factory PR' }` (`src/routes/webhooks.ts:203-206`).
   The README still advertises the opposite — *"The review stage also works standalone: install the app
   and every new pull request gets an automatic review"* (`README.md:17-19`), repeated at
   `README.md:194-196`. That contradiction is unresolved in the repo; the code is the authority.

The coding agent is **Anthropic's own `@anthropic-ai/claude-code`**, installed globally into the
sandbox image (`Dockerfile:8`) and invoked identically at every stage:

```
claude -p --dangerously-skip-permissions --output-format text < <task-file>
```

verbatim at `src/lib/generation-workflow.ts:260`, `src/lib/verifier.ts:239`, `src/lib/fixer.ts:271`,
`src/lib/planner.ts:146`. So turbodiff is not a competing agent — it is **a harness around the same
CLI the factory already runs**, with a Cloudflare container as the execution boundary and GitHub as
the interaction surface. The only in-process LLM agent is the reviewer
(`cloudflare/anthropic/claude-sonnet-5` through the Workers AI binding into a named AI Gateway —
`AGENTS.md:50-51`, `src/lib/personas.ts:6`). Two execution models coexist: **CLI-in-container** for
plan/generate/verify/fix, **in-Worker LLM agent** for review.

---

## 2. The run loop

**Intake → plan.** `POST /internal/plans {repo,title,requirements}` inserts a `plans` row and enqueues
`plan_analyze` (`src/app.ts:233-251`). The planner boots a Cloudflare Sandbox, does a read-only
`--depth 50` clone of up to three repos, runs a cheap **Haiku** classification pass to tier the
request `trivial`/`standard` (`planner.ts:172-202`), then the main pass, which writes `analysis.md`
plus `questions.json` (multiple-choice clarifying questions) (`planner.ts:243-286`). Answers →
`plan_refine` → `plan.md` + `acceptance.json`, machine-checkable acceptance criteria capped at 4 or 8
items by tier (`planner.ts:287-342`). Approval turns the plan into one `features` row per repo and
enqueues `generate` (`planner.ts:511-548`).

**Generate.** Clone → agent run against a spec prompt with explicit rules (no scope creep, no
drive-by refactors, do not `git commit`/`push` — the harness does) → commit (author attributed to the
instructing human, coauthor trailer) → optional per-repo `check_command` gate → push → open the PR,
using the instructing user's own OAuth token where available and the App/bot token otherwise
(`generation-workflow.ts:379-415`). Opening the PR enqueues verification when the feature has
acceptance criteria (`generation-workflow.ts:422`).

**Where it runs.** `@cloudflare/sandbox`, image pinned to `docker.io/cloudflare/sandbox:0.12.4`
(`Dockerfile:3`), container class `standard-1`, max 5 concurrent instances — *"fix runs clone repos,
run the agent CLI, and execute test suites — they need the memory/CPU headroom"*
(`wrangler.jsonc:52-60`). Generation and verification **share one warm container per repo**
(`gen--<owner>--<repo>`, `sleepAfter: '45m'`) with a shared git cache at `/workspace/repo-cache` and
shared package caches, so a verify that follows a generation lands hot (`verifier.ts:30-36, 200-206`).
`--dangerously-skip-permissions` is used everywhere, with the stated rationale that *the container is
the isolation boundary* (`fixer.ts:268`). The git credential that reaches the container is
deliberately narrow — a token scoped to exactly one repo and exactly the needed permission
(`contents: read` for verify, `read|write` for fix), minted per run and never cached, *"so a
compromised or prompt-injected agent run cannot touch other repos in the installation or use any
other App permission"* (`github-app.ts:69-84`).

**Why Workflows.** Generation, verification, and fix each run as a Cloudflare Workflow
(`src/cloudflare.ts:21-26`) explicitly to escape the 15-minute queue-consumer wall clock — *"a killed
isolate resumes the instance at the failed step instead of stranding the feature"*
(`generation-workflow.ts:21-38`). The queue consumer only creates workflow instances; the multi-minute
agent run happens inside a memoized step with bounded retries.

**Runner auth** is pluggable (`fixer.ts:75-109`): `claude_subscription` mode uses a
`CLAUDE_CODE_OAUTH_TOKEN` minted once via `claude setup-token` against the operator's own Claude
Pro/Max subscription; `gateway` mode uses `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` pointed at
Cloudflare's AI Gateway (BYOK, metered). Subscription mode wins when both are configured
(`fixer.ts:102`). A `codex_subscription` mode is **design-doc only** — no implementing code exists
(`docs/software-factory-design.md:75`).

---

## 3. The video-recording mechanism, in full

This is the operator's stated interest, so it is traced end to end. The whole thing lives in the
**verification** step (`src/lib/verifier.ts`); there is no separate recording service.

**Trigger and gate.** Verification is enqueued when a factory PR opens, and re-enqueued after each fix
push. It is skipped outright when the feature has no acceptance criteria (`verifier.ts:163-167`).
Recording specifically requires the per-repo `demo_videos` toggle, which **defaults ON**
(`migrations/0021_demo_videos.sql`: `ADD COLUMN demo_videos INTEGER NOT NULL DEFAULT 1`, with the
comment *"the verify agent works out how to launch the app by itself, so there is no config burden —
this column exists to opt OUT for repos where recordings add time without value (API-only,
libraries)"*). It is a switch on `/settings` (`src/client/pages/settings.tsx:265-269`).

**Nothing in the harness drives the browser. The prompt does.** There is no Playwright script, no
recorded selectors, no test file, and nothing is written into the target repo. `verifyPrompt()`
(`verifier.ts:54-153`) builds a task file and the agent writes its own capture scripts. Verbatim from
that prompt:

> `A headless Chrome binary is installed (its path is in the env var PUPPETEER_EXECUTABLE_PATH) and
> puppeteer-core is globally available via NODE_PATH. For criteria with user-visible behavior, write a
> small node script that opens the relevant page/state and captures PNG screenshots into <shots>/
> (create it). Write capture scripts as CommonJS (.cjs files using require('puppeteer-core')) — ESM
> import cannot resolve the global install. Launch with args ['--no-sandbox',
> '--disable-dev-shm-usage'].` (`verifier.ts:104-112`)

> `## Demo recording
> Also record ONE short screen recording (10–30 seconds) demonstrating the feature's happy path end to
> end. This is what humans watch, so drive it like a demo: pause about a second between meaningful
> steps and let each state change be visible before moving on. In a .cjs script, use puppeteer's
> screencast API:
>
>     const recorder = await page.screencast({ path: '<out>/demo.webm' });
>     // ... drive the flow deliberately ...
>     await recorder.stop();
>
> Write a one-line caption for the recording to <out>/demo-caption.txt. If the app cannot run, skip the
> recording.` (`verifier.ts:117-128`)

So the mechanism is: **Chrome DevTools Protocol screencast, driven by an agent-authored throwaway
`.cjs` Puppeteer script, inside the same container that is running the app.** Not a test framework.

**The browser and the transcode.** `Dockerfile:15-21` installs Google Chrome from the official `.deb`
(the comment notes apt's chromium on Ubuntu 22.04 is a snap stub), plus **ffmpeg**, plus a global
`puppeteer-core`, and exports `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable` and
`NODE_PATH=/usr/local/lib/node_modules`. After the agent exits, `uploadDemo()` (`verifier.ts:405-430`)
stats `demo.webm`, returns nothing if it is missing or zero-length, **refuses anything over 40 MB**,
and transcodes:

```
ffmpeg -y -v error -i demo.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 26 demo.mp4
```

with the reason stated in the code: *"Chrome's screencast emits VP9 WebM, which iOS Safari cannot play
(renders a black box) — transcode to H.264 MP4 in the sandbox so the demo plays everywhere"*
(`verifier.ts:402-404`).

**How the app under test gets running** — the part that decides whether any of this works on a given
repo. Three prompt branches, selected by `repo.run_command` / `demo_videos` / the cached `launchable`
verdict (`verifier.ts:58-101`):

- `run_command` configured → the agent is told the command and port, launches it with
  `nohup ... > /tmp/app.log 2>&1 &`, waits for the port, and checks runtime criteria with curl or
  small node scripts.
- Nothing configured, demos on, `launchable !== 0` → **self-discovery**: *"Determine how to run this
  app from the repository itself: package.json scripts (dev/start/preview), the README, framework
  config, lockfiles."* Timeboxed to a few minutes, with an explicit give-up list: *"If the app needs
  Docker, containers, cloud bindings (e.g. Cloudflare Workers/D1/R2), a database, or other external
  services to run, treat it as NOT launchable here — do not fight it; verify statically instead"*
  (`verifier.ts:82-85`). The agent must record its verdict either way to `run-command.json`
  (`verifier.ts:87-91`), which the harness parses and caches into the `repositories` row — command +
  port on success, `launchable = false` on failure — so later runs skip discovery entirely
  (`verifier.ts:275-287`).
- Cached `launchable = 0` → *"This repository is known not to be launchable in this sandbox"*; verify
  statically, mark the rest `skip` (`verifier.ts:99-101`).

Two honest properties of that design, and they are the good parts: infrastructure failure is **never**
a `fail` (*"do NOT mark them 'fail' for infrastructure reasons"*, `verifier.ts:71-73`, repeated at
`:95-97`), and a criterion the agent silently drops from `results.json` becomes `skip`, not `pass` —
*"A criterion the agent silently dropped is unverified, not passed"* (`verifier.ts:350`).

**Where the video ends up.** `demo.mp4` is PUT to R2 under `verify/<featureId>/demo.mp4`
(`verifier.ts:425-426`); screenshots land under `verify/<featureId>/<name>.png` the same way
(`verifier.ts:388`). The key is HMAC-signed (`signArtifactKey`, `src/lib/crypto.ts:101`) and served by
a capability-URL route — *"the signature over the key (issued when the artifact was uploaded) is the
only credential — no signature, no object, and keys cannot be enumerated"*, with `..` rejected
(`src/app.ts:71-87`). The verification row stores `{"video": key, "caption": …}` as JSON
(`migrations/0015_demo_recording.sql`). The PR comment carries a 🎬 line linking the cockpit plus a raw
video link (`verifier.ts:455`), a ✅/❌/⚪ table with one row per criterion (`:459`), screenshots
embedded inline under **Evidence** (`:472`), and the agent's `summary.md` appended as **How it works**
(`:477`). The video itself is *not* inlined — GitHub does not render arbitrary `<video>` in Markdown.
The cockpit page plays it as a plain `<video controls autoPlay muted loop playsInline>` from the
signed URL (`src/client/pages/feature.tsx:584-599`, signed at render time in `src/routes/api.ts:811-817`).

**Budget.** The verification agent's timeout is 20 minutes, deliberately: *"Verification runs inside a
Workflow step (no wall clock), so the agent can afford launch discovery + screenshots + a recording"*
(`verifier.ts:38-40`).

---

## 4. The PR / review-comment loop — how comments arrive "already addressed"

**Review dispatch** happens only for factory PRs (§1) and is sized by risk (`src/lib/risk.ts`):
`trivial` (≤10 reviewable diff lines) runs the default reviewer alone; `lite` (≤100) adds security;
`full` (≥50 files, or >100 lines, or any auth/crypto/secret/CI-workflow path) runs every enabled
persona (`review`, `security`, `a11y`, `o11y`, plus user-created agents). Sensitive paths escalate
regardless of size (`risk.ts:20-23`).

**The reviewer** (`src/agents/pr-reviewer.ts`) is one durable Flue agent instantiated per
`<agent-slug>--<owner>--<repo>--<pr>`, so a re-review continues the same conversation and reconciles
against prior findings — fixed findings dropped, unfixed re-emitted briefly, author-resolved threads
respected via a `fetch_review_threads` GraphQL call (`pr-reviewer.ts:112-118`). It has three read
tools and one write tool, `post_review`, which posts a real GitHub review with inline comments
anchored to diff lines.

**The loop that produces the headline.** `post_review` maps findings to a review event only when the
repo has `blocking_reviews` on: a `P1` → `REQUEST_CHANGES`, clean or P2-only → `APPROVE`, otherwise
plain `COMMENT` (`src/tools/github.ts:354-363`). GitHub refuses author-self-review, so on the
factory's own PRs the verdict is downgraded to a `COMMENT` carrying `**Verdict: REQUEST_CHANGES**` in
the body — which bypasses the `pull_request_review` webhook, so `post_review` **enqueues the fix
itself** in that case (`github.ts:394-401, 422-432`). Otherwise a genuine `CHANGES_REQUESTED` from the
app's own bot login triggers `handlePullRequestReview` → `{kind:'fix'}` (`webhooks.ts:275-309`).

**The fix agent** (`fixer.ts:runFix`) clones the PR head with a write-scoped single-repo token, builds
a work order — explicit findings from a verification failure or a cockpit comment, or scraped from
turbodiff's own latest blocking review and its inline comments (`latestBlockingFindings`,
`fixer.ts:130-168`) — runs the CLI with the rule *fix only what the findings describe*, optionally
runs the repo's `check_command` as a test gate (a failing test blocks the push), commits, pushes. The
push re-triggers review through the normal `synchronize` webhook and re-enqueues verification, closing
the loop. The cap is **three attempts** (`FIX_MAX_ATTEMPTS = 3`, `fixer.ts:71`); exhaustion posts a
human-handoff comment rather than looping silently (`fixer.ts:454-476`). **Fork PRs are excluded** —
`fetchPrHead` throws when the head repo differs from the base (`fixer.ts:121-124`), so the auto-fix
claim holds only for same-repo branches.

**Verification feeds the same queue.** Failed criteria are reformatted as `**P1** — Acceptance
criterion not met: …` with the agent's evidence and pushed to the fix queue (`verifier.ts:313`), so
spec non-conformance and review findings converge on one mechanism. The cockpit has a third entrance:
line-anchored comments in turbodiff's own diff viewer are **batched** into a single fix dispatch
(`src/client/pages/feature.tsx`, `submitBatch`), rather than one fix per comment.

**Auto-merge** (`src/lib/auto-merge.ts:17-76`) fires only when `auto_merge=1` **and**
`blocking_reviews=1`, requires the latest verification `status='passed'`, requires at least one of
turbodiff's own bot reviews to exist with none carrying a blocking verdict (including the
self-review-downgrade marker), and declines toward a human on any ambiguity. **Both toggles default
off** (`migrations/0008_blocking_reviews.sql`, `migrations/0014_auto_merge.sql` — the latter's comment
reads *"Trust is earned, not configured"*), so out of the box the pipeline stops at "PR ready for a
human to click merge." The fully autonomous path in the X post requires two explicit per-repo opt-ins.

**Prompt-injection posture**, worth recording because it is the same problem the factory has: every
agent prompt embeds a shared `UNTRUSTED_CONTENT_RULES` block (`src/lib/prompt-security.ts`, used at
`verifier.ts:148` among others), and the reviewer prompt states outright that PR title, description,
diff, file contents and thread comments are data, not instructions (`pr-reviewer.ts:138`).

---

## 5. Deployment and cost — and the rule it runs into

**What it needs to exist:** one Cloudflare account with D1, R2 (`turbodiff-artifacts`), Queues
(`turbodiff-factory` — a single queue discriminated by a `kind` field, because *"the local dev plugin
hangs at boot with two consumers on one worker"*), three Workflows, a Containers binding exported as a
Durable Object, the `PrReviewer` Durable Object, a Workers AI binding routed to a **named AI Gateway
that must serve Anthropic models** (`README.md:98`), and Version Metadata (`wrangler.jsonc`). Plus your
own GitHub App, with the PKCS#1 → PKCS#8 private-key conversion the README calls out because WebCrypto
cannot import PKCS#1 (`README.md:127-140`). Deploy is `pnpm vp run deploy` (`README.md:185`) and needs
a Docker daemon, because the sandbox image is built and pushed; every push to `main` deploys via
`.github/workflows/deploy.yml`, which needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
(`README.md:179`).

**The ~$5/month figure is the turbodiff author's claim in the X thread. It appears nowhere in the
repo** — no cost model, no pricing doc, nothing. Reading the component list against Cloudflare's
public pricing shape: $5/month is the **Workers Paid base fee**, and it is the floor, not the bill.
Cloudflare **Containers are billed separately by vCPU / memory / duration**, and every generate,
verify and fix run instantiates a `standard-1` container for minutes at a time — with verification
alone budgeted up to 20 minutes of agent time (`verifier.ts:40`). Model tokens sit outside that again,
on either a metered AI-Gateway key or a Claude subscription. The honest statement is: **fixed platform
fee ≈ $5, plus usage-driven container spend, plus model spend.** This is inference from Cloudflare's
published billing shape, not something the repo asserts or contradicts.

**Against MAP standing rule 7** — *"No paid services. Flat-rate subscriptions only; zero marginal
token spend is a hard constraint. No per-token APIs, no GCP billing, no Context7."* (`MAP.md:50-51`) —
turbodiff-as-deployed is out of bounds on one count that is not negotiable and one that is:

- **Container compute is per-second usage billing.** Not flat-rate. This is the binding one.
- **Model spend** is *not* necessarily disqualifying: `claude_subscription` mode exists precisely to
  run the CLI on a flat-rate Claude subscription (`fixer.ts:75-109`), which is the same posture the
  factory already takes. Only `gateway` mode is per-token.

The mechanism in §3, by contrast, has no Cloudflare dependency at all: Chrome, `puppeteer-core`,
`page.screencast()`, ffmpeg, and a prompt. That distinction — **the platform is paid, the trick is
not** — is the reason this is a study rather than a purchase decision.

---

## 6. Fit notes — filed, not deployed

Two questions were asked. Both are answered as *what would and would not transfer*, not as proposals.

### (a) End-to-end testing of the factory's Electron app (`apps/ui`)

**The part that would transfer, and it is more than expected.** `apps/ui` is not a native-widget app.
The Electron main process starts a Bun server on `127.0.0.1:4700` and the window simply `loadURL`s it
(`apps/ui/electron/main.ts:52, 753`). Everything the operator looks at — Board, Trace, Gate, diff,
files — is a web page served over local HTTP. A headless Chrome could point at
`http://127.0.0.1:4700/`, drive it, screenshot it, and screencast it **without Electron being involved
at all**. The screencast recipe is ~6 lines and depends on nothing Cloudflare owns.

**What would not transfer, and why:**

1. **Everything behind the preload bridge.** `apps/ui/electron/preload.cts:142` does
   `contextBridge.exposeInMainWorld("factory", factory)`, and five renderer components depend on it:
   `PtyPane.tsx`, `ServerPane.tsx`, `SetupScreen.tsx`, `Shell.tsx`, `TerminalSurface.tsx`. Loaded in a
   plain browser, `window.factory` is undefined — the terminals, the server lens, and the first-run
   setup screen are exactly the surfaces a bare-Chrome harness cannot see, and they are the newest
   ones (commit `1f0e2c9`, *"terminals, first-run setup, server lens"*). A recording made this way
   would be **evidence about the SPA, not about the app**.
2. **Everything that is Electron.** Window chrome, menus, the installer, multi-window flows
   (`main.ts:508` loads a second window against a configured local port), and Windows-specific
   behaviour. turbodiff has **no** notion of a desktop app: its launch prompt assumes a web server on
   a port, and grepping the repo for `electron`/`desktop` finds only CSS-breakpoint and landing-page
   noise.
3. **The platform.** Its container is Ubuntu; the factory's app is developed and shipped on Windows
   (`set windows-shell` in the justfile). A Linux screencast of the SPA says nothing about the Windows
   build.
4. **Fixture data.** `apps/ui/server/index.ts` is GET-only over *a real repo's* `sssf.db`, `queue/*.md`
   and read-only git, and exits if it cannot resolve a DB path (`server/index.ts:29-40`). Any headless
   run needs a seeded database first — and MAP rule 6 forbids mock data. That prerequisite is unsolved
   and sits upstream of any recording.
5. **turbodiff's own launch heuristic would decline this repo anyway.** Its give-up list names apps
   needing Docker, databases or external services (`verifier.ts:82-85`); the harness would cache
   `launchable = false` and verify statically from then on.

Net: **the recording technique is portable to `apps/ui`'s web layer; the product is not** — and the
web layer is the half that is already easiest to reason about. The gap between "the SPA renders" and
"the Electron app works" is where the interesting bugs live.

### (b) UI-work verification inside factory runs on workload projects

The stronger fit of the two, for a structural reason: turbodiff's verifier is downstream of
**machine-checkable acceptance criteria produced at plan time** (`acceptance.json`,
`planner.ts:287-342`) and it re-checks them against a *running* app rather than against the diff —
*"Do not infer from the diff what you can observe directly"* (`verifier.ts:135`). The factory's own
gate line is the same question narrowed to one agent reviewer (MAP rule 2: *does this do what the
ticket asked*), and today it is answered by reading code, not by running it. For a workload project
that is an ordinary web app — one that starts with `npm run dev` on a port — the whole chain (launch,
screenshot per criterion, one 10–30s screencast, evidence table) is prompt plus Chrome plus ffmpeg.

**What would not transfer:**

1. **The evidence surface.** turbodiff's artefacts live on a GitHub PR comment and a hosted cockpit
   behind signed R2 URLs. The factory's Gate 2 is a **local** morning brief plus a compare/PR link
   (`apps/ui/server/gate.ts`), with no object store and no public base URL. A 10–30s H.264 file has to
   land somewhere the brief can show it; nothing in the factory holds binary artefacts today.
2. **The verdict semantics need re-deriving, not copying.** The good parts of §3 are the *refusals*:
   infrastructure failure is never `fail`, a dropped criterion is `skip` not `pass`, discovery is
   timeboxed and its negative verdict is cached. Those are the same fail-closed instincts as Skylos's
   three-state pass/fail/**incomplete**. Ported carelessly — a green table because the agent could not
   launch the app — this becomes exactly the "green means nothing" failure the fail-closed rule exists
   to prevent.
3. **It is a second agent run on top of the run that already happened.** Verification is a full
   `claude -p` invocation with a 20-minute ceiling. Under rule 1 that is a node; under rule 7 its lane
   cost must be visible to the balancer; under rule 8 it would have to be an orchestrator-invoked
   process with an observable exit code writing to `sssf.db` like every other quality block — never an
   opaque sub-agent.
4. **Prompt-driven improvisation is not a test suite.** Nothing is committed to the target repo: each
   `.cjs` capture script is written fresh inside the sandbox and discarded. Two verification runs on
   the same PR can exercise the feature differently. That is fine for a demo and wrong for a
   regression gate — and the factory's existing quality layer is deterministic, which rule 2 treats as
   the stronger position.
5. **Windows again.** `page.screencast()` works there, but `nohup`, `/tmp/app.log` and an
   apt-installed Chrome do not; the launch half of the prompt would need rewriting, and the sandbox
   isolation that justifies `--dangerously-skip-permissions` would not exist.

Filed, per rule 1. The cheapest check on whether the recording is worth anything is independent of
adopting anything: **on one workload run against a plain web app, does a 20-second screencast change
the operator's Gate 2 decision even once?** If it does not, no amount of mechanism detail matters.

---

## 7. Honest gaps

- **The $5/month figure is unsubstantiated in-repo** and, read against Cloudflare's billing shape, is
  a floor rather than a bill (§5). No cost-modelling code or doc exists to check it against; the claim
  is the author's, on X.
- **README vs code on standalone review.** `README.md:17-19` and `:194-196` promise review of every
  PR; `webhooks.ts:203-206` and `AGENTS.md:12` say factory PRs only. One of the two is stale and the
  repo does not say which is intended.
- **No evidence of recording reliability.** Everything about the screencast is *instructions to an
  agent*. There is no test, no fixture, no golden video, no retry: if the agent writes a bad `.cjs`,
  `uploadDemo` finds a missing or zero-byte `demo.webm` and returns `undefined` (`verifier.ts:407-409`)
  — the report simply has no video and nothing flags its absence. How often that happens is not
  observable from the repo, and **this study did not run turbodiff** (doing so needs a Cloudflare
  account with Containers, i.e. the thing rule 7 forbids). Every claim here about the recording is a
  claim about the code path, not about a video that was watched.
- **The demo is a happy path by construction** — *"ONE short screen recording (10–30 seconds)
  demonstrating the feature's happy path"* (`verifier.ts:118-119`). It proves the flow the agent chose
  to show; it is a demo, not a regression test.
- **The recording is not independently triggerable.** There is no "record a video" endpoint or button:
  the only path is a full verification run, which itself requires acceptance criteria to exist
  (`verifier.ts:163-167`). The X post's framing — *ask the agent to record a video* — is really *the
  verifier ran and, by its own judgement, was able to record one*.
- **`codex_subscription` runner mode is a stub** — documented at `software-factory-design.md:75` with
  a ToS caveat; `resolveRunnerAuth` understands only `claude_subscription` and `gateway`
  (`fixer.ts:75-109`).
- **Duplicate migration numbering** — two `0024_*` and two `0025_*` files. Functional under Wrangler's
  filename-sorted tracking, unverified beyond that, and a smell.
- **`docs/software-factory-design.md` is a dated draft** ("2026-08-05") mixing `_Status: done_`
  sections with aspirational ones. The four pipeline phases were checked against implementing code and
  are real, but the doc's roadmap framing should not be read as current.
- **Flue itself is opaque.** `@flue/runtime` has no vendored source here; `dispatch()`, Durable Object
  placement and `useMcpConnection` were read only through call sites and the one load-bearing pnpm
  patch (`patches/@flue__runtime.patch`, flipping the Workers-AI provider's `cacheRetention` from
  `"none"` to `"short"`).
- **Not read in depth:** the SPA beyond the feature and settings pages, `src/lib/metering.ts`, and the
  connections/MCP integration path. None are load-bearing for §3.
