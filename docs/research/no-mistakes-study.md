# no-mistakes — the deep study the operator asked for

Ordered by the operator before anything is wired (MAP.md, Open questions: *"decided shape: trimmed to
disposable worktree + merge-check into current `main` + open the PR (its own review/test/docs/lint
off). But the operator wants a proper deep study before anything is wired. Do the study first."*)

**Subject:** `github.com/kunchenguid/no-mistakes` — Go, MIT, 7,606 stars, last push 2026-08-12T16:51:54Z,
default branch `main`, head `c4bc34b` (*chore(main): release 1.50.0*). Read at that commit.

**Verdict up front:** the decided shape — *worktree + merge-check + PR, its own review off* — **is not
configurable**. It is refused by the tool's own code, not by a missing flag. The one signal the
operator correctly identified as non-duplicate (merge-time integration into `main` as it is *now*) is
real, the factory genuinely does not have it, and it is worth **about 100 lines** as a `kind="code"`
phase — **measured before it is built** (two log lines first; see §e), because rule 1 binds the
replacement as tightly as it binds the tool. Recommendation: **rebuild-ourselves**, per MAP
standing rule 1.

Sources: the repo's own docs tree (`docs/src/content/docs/**`), its Go source
(`internal/pipeline/**`, `internal/config/config.go`), its own dogfood config (`.no-mistakes.yaml`),
and the factory as it stands on `main` at commit `d9c6697` plus its uncommitted working tree.
Marketing prose was not used where source was available; where the two agree, both are cited.

---

## a. What it actually does, verified stage by stage

A **local git proxy**. `no-mistakes init` creates a bare repo, installs managed pre-receive and
post-receive hooks, adds a `no-mistakes` git remote, and starts a **daemon**. You `git push
no-mistakes` instead of `origin`. The hook notifies the daemon and exits; the daemon creates a
**detached worktree** at `~/.no-mistakes/worktrees/<repoID>/<runID>/` and runs the pipeline there,
then removes it (`concepts/daemon.md:83-88`). Your working directory is untouched. That part is
exactly as advertised.

The pipeline is **nine** steps, not seven:

```
intent → rebase → review → test → document → lint → push → pr → ci
```

| # | Step | What it actually runs | Default auto-fix limit |
|---|---|---|---|
| 1 | Intent | Uses `--intent` when supplied; otherwise **infers author intent from local Claude Code / Codex / OpenCode / Rovo Dev / Pi / Copilot transcripts** on the machine | n/a |
| 2 | Rebase | Fetches `origin/<default>` **and** the pushed-branch target into the worktree, rebases onto them; on conflict records files, aborts, reports findings | `3` |
| 3 | Review | Agent code review of the diff, structured findings with severity + `action` (`no-op` / `auto-fix` / `ask-user`) + `risk_level` | `0` — **parks for approval** |
| 4 | Test | `commands.test` if set, then an agent that runs *"the smallest relevant"* checks. **Explicitly not a full suite** | `3` |
| 5 | Document | Agent updates docs, reports unresolved gaps; **any** unresolved finding, including `info`, needs approval | initial pass |
| 6 | Lint | `commands.lint` if set; if empty, folded into the document step's combined agent housekeeping pass | `3` |
| 7 | Push | Formats, commits agent changes, force-with-lease to the target | n/a |
| 8 | PR | Creates/updates the PR via `gh` / `glab` / `az` / Bitbucket API; agent-drafted conventional-commit title and body | n/a |
| 9 | CI | Polls provider checks + mergeability, fetches failed job logs, **agent auto-fixes and re-pushes** | `3` |

(`concepts/pipeline.md:8-46`, `reference/pipeline-steps.md:9-273`.)

**Configurability — the part the ticket said was "mechanical and discoverable from the tool's own
docs".** It was discoverable, and the answer is no. From the tool's own page, verbatim:

> ## What you can't configure
> - The step order.
> - **Skipping specific steps permanently — per-run skips are allowed, but the pipeline itself always
>   has all nine.**
> - Adding new steps.
>
> This is intentional. The pipeline is opinionated so that "passed the gate" means the same thing
> across repos. (`concepts/pipeline.md:88-94`)

Verified against source: `internal/config/config.go` has **no `skip` key** in either the global or
the repo schema — all 82 `yaml:` tags in the file were checked across `GlobalConfig` (`:70-104`),
`globalConfigRaw` (`:105-125`), `RepoConfig` (`:126-180`) and the resolved `Config` (`:389-427`);
the string `skip` appears exactly once in the whole file, in a comment about the review step
(`:572`). The only skips are per-invocation: `--skip`, `git push -o no-mistakes.skip=<steps>`,
`axi run --skip`, or the TUI. They are handed to `Executor.SetSkippedSteps`
(`internal/pipeline/executor.go:69-73`) and mark the step `skipped` in the DB without running it
(`executor.go:184-189`).

One honest counter to "not configurable", because the claim has to survive its strongest form: the
gate advertises Git push-option support (`reference/cli.md:43`), so a client-side
`git config remote.no-mistakes.pushOption no-mistakes.skip=<steps>` would attach the same skip list
to *every* push and make a per-run skip persistent in practice. It changes nothing here — the shape
the operator decided on is refused one layer lower, in Go, by the finding below.

**And here is the finding that kills the decided shape.** Push refuses to run unless the *review step
completed*:

```go
// internal/pipeline/steps/push.go:146-153
func assertReviewApprovedPushHead(sctx *pipeline.StepContext, proposedHead string) error {
	run, err := sctx.DB.GetRun(sctx.Run.ID)
	...
	if run == nil || run.ReviewApprovedHeadSHA == nil || strings.TrimSpace(*run.ReviewApprovedHeadSHA) == "" {
		return fmt.Errorf("refusing to push: run has no durably recorded review-approved head")
	}
```

`ReviewApprovedHeadSHA` is set **only** by a successfully executed full review round — the field's
own comment says so (`internal/pipeline/pipeline.go:84-87`: *"set only by a successfully executed
full review round … never while that outcome is parked or after a failed round"*), it is captured
from the review outcome at `executor.go:749-751`, and it reaches the DB only on
`status == StepStatusCompleted` (`executor.go:980-985`). A skipped review never writes it. The docs
say the same thing in one sentence: *"Pre-skipping or later skipping Review
leaves no approval binding, so Push fails closed unless Push is also skipped."*
(`reference/pipeline-steps.md:180`).

So the reachable configurations are:

- **`--skip intent,test,document,lint`** — keeps rebase + **review** + push + pr + ci. The agent
  reviewer stays. That is a second model reviewer stacked on the factory's (MAP rule 2, and the dead
  list's `codex review` entry, killed for exactly this: *"Would be the 8th check and 2nd model
  reviewer. It's an overkill."*).
- **`--skip review,push,pr`** — you get the worktree and the rebase check and nothing else. No PR.
- There is no third option. Worktree + merge-check + PR **without** its review does not exist.

Two further mechanical answers the ticket asked for:

- **GitHub auth headless:** it shells out to `gh` (and `glab`/`az`). The PR and CI steps **skip
  silently** if the CLI is missing or unauthenticated (`reference/pipeline-steps.md:191-193`). So the
  server needs an authenticated `gh` — which the MAP already plans for (build phase 2 installs the
  Claude Code and Codex CLIs as the credential surface). No new blocker.
- **Lane accounting (T12/T20):** invisible. Its agent invocations, tokens, and cost live in its own
  `state.sqlite` and surface only through `no-mistakes stats --agents` / `--run <id>`; the docs state
  *"This detailed performance evidence stays local in `state.sqlite`"* (`reference/cli.md:388-398`).
  Nothing writes to `adws/adw_data/sssf.db`. Every token it spends is spend the factory's tracer and
  lane balancer cannot see. T26 asked for this and the answer is a clean no.
- **Escalation-down (T28):** partial. `axi run --yes` converts both `auto-fix` *and* `ask-user`
  findings into standing consent — the pipeline fixes them once, then approves its own fix review
  (`reference/cli.md:110-111`). That is not "escalation off"; that is **a second agent silently
  editing the code the factory's builder already wrote and the factory's reviewer already approved.**

Things nobody wrote down that matter for adoption:

- It installs an agent skill into **`~/.claude/skills/no-mistakes/SKILL.md` and
  `~/.agents/skills/no-mistakes/SKILL.md`** at `init` (`reference/cli.md:39-42`) — user level, both
  trees, every repo on the machine. The doc is explicit about which tree serves which harness:
  *"`~/.claude/skills` for Claude Code, `~/.agents/skills` for Codex, OpenCode, Rovo Dev, and Pi"*
  (`:40`), so **pi's own skill directory is one of the two it writes**. This writes into shared
  ambient state the factory's rule 12 (`--no-skills` plus explicit `--skill`) exists to avoid
  depending on.
- **Telemetry is on by default** — command, run, approval, fix and wizard events to a default
  self-hosted Umami instance; off with `NO_MISTAKES_TELEMETRY=0` (`reference/environment.md:184-223`).
- A repo with **no CI** is a trap: without a `no_ci: true` declaration on the default branch, *"a
  zero-length check result then stays not-ready for as long as the forge reports no checks — elapsed
  time, grace periods, workflow-file presence or absence, prior check history, and branch names are
  not evidence"* (`reference/repo-config.md:164`, whole field at `:153-169`). **The factory repo has
  no `.github/workflows` at all** — every run would sit in CI-watch until `ci_timeout`, then park at
  an approval gate. (no-mistakes itself has five workflow files and leans on them: its dogfood
  config delegates broad regression to `go test -race ./...` in `.github/workflows/ci.yml`,
  `.no-mistakes.yaml:4-6`.)
- It has a real answer to a problem the factory has: `disable_project_settings: true`, built *"for
  agent-orchestration repositories whose `AGENTS.md`, `CLAUDE.md`, or harness-specific project
  settings would give a validation agent an operator identity"* (`reference/repo-config.md:131-151`).
  Fails closed if the resolved agent has no verified suppression knob. That is a genuinely
  well-thought-out piece of engineering and worth stealing as an idea.

None of this is sloppy software. It is careful, adversarially-tested, fail-closed Go. It is also a
**daemon, a service registration, a second SQLite state store, a second skill directory, a second
definition of done, and its own agent invocations** — which is the whole of MAP rule 1 in one
sentence.

---

## b. Overlap matrix — its stages vs what the factory already has

| no-mistakes stage | Factory mechanism that already covers it | Verdict |
|---|---|---|
| **Intent** (infer from transcripts) | The prompt *is* the intent and it is passed to every phase (`adw_simple_sdlc.py:84-94`); the planner turns it into `specs/plan.md`, committed before code exists (`:97-99`) | **Duplicate** — and solving a problem the factory does not have. It infers what the factory is *told*. |
| **Rebase** (onto fresh `origin/<default>`) | *Nothing.* `git_helper.merge_base()` reads local `main` as a diff base only (`git_helper.py:144-151`) | **UNIQUE** — see §d |
| **Review** (agent) | `reviewer` agent, `thinking: high`, `writes: []` (`adws/adw_sssf_config/sssf.config.yaml:116-131`), gated by `gates.verdict_consistent` (`gates.py:71-95`), bounded revision loop (`adw_simple_sdlc.py:126-139`) | **Duplicate** — violates rule 2 (never stacked). Rule 3, precisely: its agent *is* selectable, globally or per-repo, with an ordered fallback list (`concepts/pipeline.md:78`), but only **statically** — the daemon resolves one agent (or the first live fallback) for the whole run, so it cannot be pinned to the opposite family from whichever workhorse wrote *this* run's code, which is what cross-family review requires |
| **Test** | `quality.test` → `uv run --group dev pytest -q adws/tests`, real, wired, in a bounded fix loop (`quality.py:211-222`, `adw_simple_sdlc.py:107-122`) | **Duplicate, and weaker** — its Test step is explicitly *targeted*, "never a repository-wide regression suite" (`.no-mistakes.yaml:2-7`) |
| **Document** | `documenter` agent over a pinned-baseline `ChangeSet` (`adw_simple_sdlc.py:160-181`), plus `adw_document.py` | **Duplicate** |
| **Lint** | `quality.lint` (ruff), `quality.typecheck` (mypy), `quality.ai_defects` (skylos `--ai-defects --diff <merge-base>`, fail-closed three-state) — `quality.py:225-280`, all four collected by `run_quality` (`:361-389`) | **Duplicate, and weaker** — the factory's lint layer is deterministic; its lint step is an agent when `commands.lint` is empty |
| **Push** | *Nothing.* No ADW runs `git push` (grepped `adws/**/*.py`: zero hits for `git push`, `gh pr`, `worktree`) | Not covered — but not wanted either: the operator's merge button is the PR link, clicked by him |
| **PR** | `githubCompareUrl(remoteUrl, branch)` → `compare_url` on every gate item (`apps/ui/server/gate.ts:184-198`), with `push_command` as the non-GitHub fallback | **Partial duplicate** — the merge surface is built; one click short of automatic, and that click is Gate 2, which MAP rule 10 says is a human moment on purpose |
| **CI** (watch + auto-fix) | *Nothing.* And **there is no CI to watch** — no `.github/workflows` in this repo | Not covered; also not currently applicable |

**Score: 5 of 9 stages duplicate an existing factory mechanism outright** (intent, review, test,
document, lint), a 6th (PR) duplicates a surface that is already built, 2 are unique-but-unwanted
(push, ci), and **exactly 1 is unique and wanted** (rebase / merge-time integration).

The T26 framing said it duplicates four things. It is five, and two of the five (test, lint) are
places where the factory's version is *deterministic and the tool's is an agent* — a straight
downgrade against MAP rule 2.

---

## c. The operator's objections, quoted

**First contact** (`session-transcript.txt:2733-2734`):

> `this is not mistakes[[https://github.com/kunchenguid/no-mistakes]] does it fit in???`

Three question marks. The question was never "adopt this"; it was "does it fit".

**The boundary demand** (`:3021-3036`; the sentence starts mid-line 3021, after *"I face a lot of
issues with Git"*):

> `now the other thing I was talking about in no mistakes we need to find clear lines whereby because
> I think no mistakes is a bit a mixture of code and agents unless I'm wrong is it I'll see anyway but
> for no mistakes we need to find a clear line between no mistakes sky loss and the code that comes
> with the factory we are building on yeah so you need to find a clear line please we don't have to
> step on each other but I think no mistakes actually oh you are saying it solves open things we
> actually had open things okay but how are we going to wear what it offers for disposable work trees
> into our own factory is it viable even because I thought no mistakes has worktrees for its own runs
> and I thought it it's mostly a review get by the way the engineer who made it made it as a review
> gate I hope you know all that yeah and you are you see you are also saying that the same four
> things the factory just did so it is kind of stepping on the factory's feet I don't know if you're
> noticing this so we are adopting both when this take more time and will this be more costly because
> if you're adopting both and if no mistakes actuall`

He was right on every count. *"A bit a mixture of code and agents"* — yes: six of nine steps invoke an
agent. *"Mostly a review gate"* — yes, and the source proves it structurally: push is bound to the
review approval and cannot run without it. *"Stepping on the factory's feet"* — five stages.
*"More costly"* — its agent spend is invisible to the factory's lane accounting.

**The logic objection** (`:3405-3426`, beginning mid-line 3405) — the load-bearing one:

> `now no mistakes autofixing if it can't auto fix then how does it okay man again something okay the
> logic of all this really I know we are importing a lot of products here but some things don't add up
> to me I mean let's say hypothetically something has gone all through all these different skills that
> in my ideology they are very very thorough ... we go from planning planning doesn't see a problem it
> in fact all the other agents didn't see a problem or the other sessions didn't see a problem we go to
> planning we go to actual coding review doesn't see a problem the deterministic guidelines don't see a
> problem Skylos doesn't see a problem I mean test review doesn't see a problem seriously and you are
> telling me when we reach no mistakes it finds a problem doesn't it mean that no mistakes might be the
> only problem because it really beats my understanding okay for me in the logic it doesn't add up why
> would it find a problem and then at that level do you do you know how many agents it would have
> undermined to just state that it found a problem then it's an insane amount you are we are looking at
> around four to five agents okay which most of them might be even higher than it in understanding I
> don't know if you are getting my argument here so I don't know we might need to configure it because
> it's open source`

Immediately preceding it (`:3403-3405`): `I really don't want to engineer this I want to keep it
stupid simple I want to add quality please`.

**The trim decision** (`:3635-3654`, the assistant's reply that became the recorded decision):

> `Your argument is sound: five agents and every deterministic gate passed, then a later tool overrules
> them all? The tool is probably wrong.`
>
> `Correct for everything it re-checks. Wrong for the one thing only it can see.`
>
> `The factory tests your branch in isolation. By the time it merges, main has moved — other runs
> landed. "Does this branch still work merged into current main?" was never asked by anyone upstream,
> because when the factory tested, main was a different repo.`
>
> `That's the only non-duplicate signal it can produce. So configure it down to exactly that: merge into
> current main, run the suite, open the PR. Turn off its review, docs and lint — the factory already did
> those, better, with better models.`
>
> `And the corollary matches your escalation rule: if it ever finds something else, that's a defect
> report against the factory's gates, not a reason to trust it more.`

**T26 resolved as shape 2** (`:6616-6630`, then the ticket edit at `:6632-6686`):

> `Yo, hang on, what do you mean we haven't sliced no mistakes? Why do you need anything from me from
> there? Because I'm confused. do you need do you genuinely need anything from me for speccing out or
> slicing no mistakes? Because this session I think we agreed on what I need. Do you need anything?`

Answer given: `No — I need nothing from you. That was my error, not a real gap.` The ticket was then
marked **RESOLVED — shape 2** with five mechanical follow-ups, the first being *"Which pipeline stages
can be disabled, and whether the tool still functions with nearly all of them off. **If it cannot be
reduced this far, fall back to shape 3 — take the ideas, build the thin version.**"*
(`wayfinder-record/tickets/T26-no-mistakes.md:34`, and `HANDOFF.md:32, 52`).

**That conditional has now fired.** The operator pre-authorised the fallback; this study is the
evidence that triggers it, not a new decision.

One phrase to keep, because it is the whole design in five words — `we don't have to step on each
other`. The factory owns review/test/docs/lint. Whatever owns merge-time integration must own *only*
that.

---

## d. The one question nobody upstream answers — and no, the factory does not have it

**The question:** does this branch still work when merged into `main` **as `main` is right now**?

**What runs today, precisely. Nothing answers it.**

- `quality.test` runs `uv run --group dev pytest -q adws/tests` with `cwd=run.repo_root`
  (`quality.py:216-222`, `:140`) — on the **run's own branch working tree**. `main` is not in the
  picture.
- `quality.ai_defects` computes `git merge-base main HEAD` and passes it as `--diff <base>`
  (`quality.py:267-273`). It *reads* `main` to scope a diff. It never merges it. And it reads the
  **local** `main` ref — nothing in `adws/` ever runs `git fetch`, so on a factory where the operator
  merges PRs on GitHub, that base can be stale too.
- `changes.capture` diffs against the run's **pinned baseline**, deliberately: *"The documenter
  measures against the commit this run STARTED from, not against `main`"* (`adw_simple_sdlc.py:39-41`,
  `:71`).
- The Gate UI asks `repo.isAncestor(branch, "main")` and **skips** the item if the answer is not
  `false` (`apps/ui/server/gate.ts:159-160`). That asks *"has it already been merged?"* — never
  *"would it merge?"*.
- `compare_url` is a GitHub compare link (`gate.ts:184`). The mergeability signal the operator
  actually gets today is **GitHub's own red "can't automatically merge" banner** on that page, at the
  moment he opens it. Conflicts only. No suite.
- `gates.tests_pass(command)` exists as a gate factory (`gates.py:98-109`) and has **zero call sites**
  in the entire repo. It is written and unwired.
- There is **no CI**: no `.github/workflows` directory. Nothing runs the suite after a merge either.

**So: nothing in the factory merges into current `main`, and nothing runs the suite against a merged
tree. Confirmed, not assumed.** The gap the operator identified is real and it is still open.

Two honest qualifications, because the study is worth nothing if it flatters the plan:

1. **no-mistakes does not do "merge into current main + suite" either.** Its Rebase step *rebases*
   onto `origin/<default>` and reports **conflicts** (`reference/pipeline-steps.md:44-58`). Its Test
   step is contractually *targeted*, "never a repository-wide regression suite", and its own dogfood
   config leaves `commands.test` **empty** on purpose (`.no-mistakes.yaml:2-7`). Broad regression is
   explicitly delegated to remote CI — which this repo does not have. You *can* put a full suite in
   `commands.test` (the constraint is documented, not enforced: *"no-mistakes does not guess whether an
   arbitrary shell string is too broad"*, `reference/repo-config.md:180-183`) — but at that point you
   are using a nine-step daemon as a shell runner for one command.
2. **The frequency of the signal is currently zero-evidence.** The premise is *"main has moved — other
   runs landed"*. Today: one operator, serial runs, `git branch -a` shows **only `main`** — not one
   `adw/*` branch has ever survived to the Gate. Concurrent runs are build phase 4. The signal is
   sound in principle and unmeasured in practice.

---

## e. Recommendation

### adopt-trimmed — **not available**

Not "risky", not "expensive": refused by `push.go:146-153`. Worktree + merge-check + PR with its own
review off cannot be assembled. The two reachable shapes are *keep its agent reviewer* (adds the 8th
check and 2nd model reviewer, killed by name in the dead list) or *lose the PR* (which is the only
half the operator wanted). T26's own fallback clause covers this case.

### rebuild-ourselves — **yes, and in this order: measure first, then ~100 lines, one `kind="code"` phase.**

Rule 1 applies to the replacement as hard as it applies to the tool, and §d qualification 2 is the
reason: today `main` provably does not move mid-run (one operator, serial runs, no `adw/*` branch has
ever reached the Gate). So the sequence is **(i) the two `ph.log()` calls of §f.2 — record
`git rev-parse origin/main` at branch-cut and again at Gate time — on the next branch-cutting runs;
(ii) build the phase below when that log shows movement, or when build phase 4 makes concurrency
real, whichever comes first.** Step (i) is ~2 lines and answers whether step (ii) is a check or
theatre. Nothing in this section is an argument for adopting the tool at any point in that sequence;
the tool's own half of this signal is a rebase-conflict report, which is weaker than either step.

When step (ii) fires, the factory already has every part except the merge itself: worktrees are a `git` subcommand, the
suite is written down in `quality.py`, the PR link is built, the branch discipline is enforced, and
the trace/Gate surfaces render any phase. Sketch, in this codebase's own idiom:

| Where | What | ~Lines |
|---|---|---|
| `adws/adw_modules/git_helper.py` | `fetch_trunk()` (the missing `git fetch origin main`), `merge_check_worktree()` (`git worktree add --detach`), `merge_into()` (`git merge --no-commit --no-ff`, capture conflicted paths), `remove_worktree()` | ~40 |
| `adws/adw_modules/data_types.py` | `cwd` field on `QualityCheckSpec` (`_run` currently hardcodes `cwd=run.repo_root`, `quality.py:140`) | ~3 |
| `adws/adw_modules/quality.py` | `merge_check(run, trunk="main")` — fetch, worktree at `origin/main`, merge the branch, run the existing test argv with `cwd=<worktree>`, classify: clean+green `pass`, conflicts or red `fail`, no remote `incomplete` (fail-closed, exactly like `ai_defects`) | ~30 |
| each ADW that commits | one phase block after `commit_build` | ~8 each |
| `apps/ui/server/gate.ts` | mirror the existing `qualityPhase` lookup (`:168-182`) so the card shows it | ~10 |

**~100 lines, no daemon, no second state store, no second definition of done, no invisible token
spend, no skill written into `~/.claude/skills/`, and the result is a `tool_call` event in
`sssf.db` like every other quality block.** It reuses `_run`'s artifact/trace/classify machinery
whole. And it is *strictly stronger* than what no-mistakes would give: an actual merge plus the actual
full suite, where the tool gives a rebase plus a targeted check.

One cost the sketch hides, found while verifying it: every quality block shells `uv run --group dev`
(`quality.py:48`), and `uv` resolves the project from its **cwd**. Pointed at a detached worktree it
will treat that worktree as a new project root and materialise a fresh `.venv` there — a full sync
per run, not a free `cwd=` swap. Pin `UV_PROJECT_ENVIRONMENT` (or pass `--project <repo_root>`) at
the merge-check's spawn site, or the ~30-line block buys a multi-minute install on every run. That is
one extra line, but it has to be a deliberate one.

Free ideas to steal while not adopting the tool:

- **Fail-closed on "cannot verify"** — `no_ci: true` as *positive* evidence rather than treating an
  empty result as green. The factory already has this instinct (`_classify_ai_defects`); the
  merge-check must inherit it: no remote, no fetch, unresolvable trunk ⇒ `incomplete`, never `pass`.
- **`disable_project_settings`** — the insight that an orchestration repo's `AGENTS.md`/`CLAUDE.md`
  will hand a validation agent an operator identity it must not adopt. Relevant the day the factory
  reviews its own kind of repo.
- The PR-body **attestation comment** (`<!-- no-mistakes-pipeline-attestation:v1 {...} -->`,
  `reference/pipeline-steps.md:215-233`) — a machine-readable step snapshot pinned to a `head_sha`,
  data-only, asserting no policy. That is a good shape for the Gate 2 brief.

### skip-v1 for the tool itself — **yes, and file it, don't re-litigate it**

Per MAP rule 1: *"A discovered capability is not a reason to add a node."* Reconsider only if the
factory ever grows real CI **and** genuinely concurrent runs **and** a measured conflict rate — and
even then, reconsider the *CI-watch* stage specifically, which is the only part of it the ~100 lines
above do not replace.

---

## f. What evidence from real runs would change this answer

Concrete, cheap, and all obtainable from the factory's own trace once branch-cutting runs start
landing:

1. **The merge-check ever fires** — this is the test of §e step (ii), and it only runs after step
   (i) below has justified building it. If, over ~20 real runs, `merge_check` never
   once comes back `fail` while `test` came back `pass`, then even the unique signal is theatre and
   the phase should be deleted — the same standard being applied to no-mistakes here. **If it fires
   even twice, the ~100 lines have paid for themselves and the tool is still unnecessary.**
2. **Concurrency arrives and `main` actually moves mid-run** — §e step (i), and the thing to do
   first. Measure it directly: log
   `git rev-parse origin/main` at branch-cut and again at Gate time. If those SHAs are equal on every
   run, the premise of the whole ticket is currently false for this factory, and the phase can idle at
   near-zero cost. This is the single cheapest experiment available and it needs no new code beyond
   two `ph.log()` calls.
3. **The factory grows CI.** If `.github/workflows` ever exists and PRs start failing checks *after*
   the local gate went green, the CI-watch stage becomes the only genuinely uncovered thing
   no-mistakes does — and *that* is the piece worth re-costing, on its own, not the nine-step pipeline
   around it.
4. **A shipped defect that a merged-tree suite would have caught and the branch-tree suite did not.**
   One real instance is worth more than this entire document.
5. **Contra-evidence that would vindicate adoption:** upstream making steps permanently configurable
   (`skip:` in `.no-mistakes.yaml`, or a push binding that survives a skipped review). Both are
   cheap to re-check — one `grep` of `internal/config/config.go` for a `skip` key and one read of
   `push.go:146`. Until then, the decided shape is not on the menu.

**What would *not* change the answer:** more stars, a new release, a better README, or the tool
finding a defect in a factory run. Per the operator's own corollary, that last one is a defect report
against the factory's gates — not a reason to trust the tool more.

---

## Verification corrections

Adversarial re-verification, 2026-08-12, against three independent sources: the parked session
transcript (`sdl-factory-parked-20260812/session-transcript.txt`), a fresh fetch of
`kunchenguid/no-mistakes` at head `c4bc34b` (release 1.50.0 — GitHub API metadata, raw source, raw
docs, and its git tree listing), and the live factory tree. Everything not listed below was checked
and held.

**Held on re-check (the load-bearing claims):**

- `push.go:146-153` `assertReviewApprovedPushHead` — quoted **verbatim and correct**, including the
  exact refusal string. Its two further guards (malformed / unreachable approved head, and the
  ancestor check at `:162-166`) only tighten the finding. `reference/pipeline-steps.md:180` confirms
  it in prose, and `:167` states the same rule from the push step's own behaviour list.
- Nine steps, not the README's seven (`concepts/pipeline.md:9,34-46`); the "What you can't
  configure" block quoted verbatim (`:88-94`); no `skip` key in `config.go`.
- Every operator quote in §c is verbatim at the cited lines, including the three-question-mark first
  contact (`:2733-2734`), the trim decision (`:3635-3654`), and T26's fallback clause — which is
  confirmed twice: in the live ticket file (`T26-no-mistakes.md:34`) and in the transcript's own
  record of that edit (`:6662-6665`). `HANDOFF.md:32` and `:52` are exact.
- Factory side: `tests_pass` has **zero call sites** (only its definition, a README mention, and the
  skill cookbook); zero hits for `git push` / `gh pr` / `worktree` / `git fetch` anywhere in
  `adws/**/*.py`; `gate.ts:159-160` asks only `isAncestor`; `git branch -a` shows `main` and remotes
  only; no `.github/` in the factory at all. Every `quality.py`, `gates.py`, `git_helper.py`,
  `adw_simple_sdlc.py`, `gate.ts` and `sssf.config.yaml` line citation resolves to the claimed code.

**Corrected:**

1. **Wrong factory commit.** The study said it read "the factory as it stands at commit `74dffc2`".
   `74dffc2` is the tip of the **parked** tag `park/opus5-2026-08-12` — the first attempt, which
   MAP.md marks archaeology-only — and is *not* an ancestor of `HEAD` (`gate.ts` does not even exist
   there; the five cited files differ by ~1,000 lines). Every factory citation was re-resolved
   against the live tree and **all of them match it**, so only the label was wrong: corrected to
   `d9c6697` plus the uncommitted working tree.
2. **`config.go` structure names and line range were invented.** There is no `GlobalRaw` or
   `RepoRaw`, and `Config` is not in lines 71-319. Replaced with the real types and spans —
   `GlobalConfig` (`:70-104`), `globalConfigRaw` (`:105-125`), `RepoConfig` (`:126-180`), `Config`
   (`:389-427`) — and with the stronger form of the same check: all 82 `yaml:` tags in the file,
   with `skip` occurring exactly once in the whole file, in a comment (`:572`). **The claim itself
   survives intact.**
3. **The "not configurable" claim was missing its strongest counter.** Per-run skips *can* be made
   persistent client-side with `git config remote.no-mistakes.pushOption` (the gate advertises push
   options, `reference/cli.md:43`). Added, with why it changes nothing: the refusal is in Go, one
   layer below any push option.
4. **"This repo has no `.github/workflows` at all" was ambiguous and, read in context, false.** It
   sat in a paragraph about no-mistakes' `no_ci` trap; **no-mistakes has five workflow files** and
   its dogfood config explicitly delegates regression to `go test -race ./...` in
   `.github/workflows/ci.yml`. The repo with no workflows is the *factory*. Disambiguated.
5. **A fabricated quotation.** `no_ci` was supported with a quoted phrase — *"is never treated as
   green"* — that appears nowhere in the docs. Replaced with the real sentence at
   `reference/repo-config.md:164`, which says the same thing more strongly.
6. **The rule-3 objection was overstated.** The study said its reviewer is "whichever agent the
   daemon resolved". The agent *is* configurable globally or per-repo with an ordered fallback list
   (`concepts/pipeline.md:78`). The accurate objection — that resolution is **static**, so it cannot
   be pinned to the opposite family from whichever workhorse wrote this run's code — is the one now
   stated.
7. **Skill-install landmine sharpened.** The docs are explicit that `~/.agents/skills` is pi's tree
   (`reference/cli.md:40`), so the write lands in pi's own skill directory, not merely near it.
8. **`ReviewApprovedHeadSHA` provenance made complete.** `pipeline.go:84-87` is the declaration (and
   carries the comment that states the rule); `executor.go:749-751` captures it; the DB write is
   gated on `status == StepStatusCompleted` at `executor.go:980-985`. All three now cited.
9. **A hidden cost in the ~100-line sketch.** Every quality block shells `uv run --group dev`
   (`quality.py:48`) and `uv` resolves the project from its cwd, so running the suite in a detached
   worktree materialises a fresh `.venv` and syncs it per run — not a free `cwd=` swap.
   `UV_PROJECT_ENVIRONMENT` / `--project` must be pinned at the spawn site. Added to §e.
10. **The recommendation was unsequenced, which strained rule 1.** §d qualification 2 establishes
    that the premise (`main` moves mid-run) has **zero** supporting evidence today, and §f.2 names a
    two-line measurement as the cheapest experiment available — yet §e told the reader to ship ~100
    lines now, and §f.1 opened with "Ship the ~100 lines". Corrected to an explicit order: measure
    with two `ph.log()` calls first, build the phase when the log shows movement or when build phase
    4 makes concurrency real. **The verdict is unchanged** — adopt-trimmed stays unavailable,
    rebuild-ourselves stays the answer, and nothing in the sequence makes the tool more attractive at
    any step.
11. **Citation drift, corrected in place:** transcript boundary demand `:3022-3036` → `:3021-3036`;
    logic objection `:3404-3426` → `:3405-3426` (both quotes start mid-line); `gate.ts:169-182` →
    `:168-182`; star count 7,605 → 7,606, with the read pinned to a commit SHA rather than a
    timestamp.

**On the "unique value" claim — independently re-tested, and it holds.** Merge-time integration
against *current* `main` is covered nowhere in the factory: not in `adws/` (no fetch, no merge, no
worktree, in either the live tree or the `templates/adws` mirror), not in the UI (`gitro.ts:97` is
`merge-base --is-ancestor`, and the reader is read-only by construction), not in the justfile, and
not in CI (there is none). The nearest thing the operator has today is GitHub's own conflict banner
on the `compare_url` page — conflicts only, no suite — exactly as §d says. The study's two
qualifications are the honest ones and are both confirmed: no-mistakes delivers a *rebase-conflict*
report plus a contractually targeted test (`.no-mistakes.yaml:2-7`, `reference/pipeline-steps.md:103`),
not "merge + full suite"; and the premise that `main` moves mid-run is, today, unmeasured.
