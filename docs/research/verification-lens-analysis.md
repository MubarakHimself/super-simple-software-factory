# The verification lens — which adaptations does turbodiff-style verify genuinely need?

**What this is:** the dug-deep adaptation analysis the operator ordered before anything is wired
(`.scratch/app-v2/issues/12-verification-lens.md`, chartered with the app-v2 map at
`.scratch/app-v2/map.md:121`; MAP's own open-question entry is `MAP.md:263-282`). It answers four
questions concretely — the per-task lens, where the declaration originates upstream, where a verify
phase lands in the real ADW anatomy, and the minimal change set on each side.

**No adoption is performed here.** Per MAP standing rule 1 (*"a discovered capability is not a
reason to add a node"*, `MAP.md:35-37`), the turbodiff capability is filed
(`docs/research/turbodiff-study.md`), and this document is decision-shaped input for a grilling
session — not a build order. Section 6 is the part the operator has to answer.

**Study date:** 2026-08-13. Factory read on `main` at `1f0e2c9`.

**Method.** Two code-grounded reader passes (factory side: `adws/**`, `installer/steps.py`,
`pyproject.toml`; upstream side: the Pocock chain + documentation-factory + queue-publish +
morning-brief skills and the three parsers of the card contract), then independent re-verification of
every load-bearing citation against the live tree, then — this revision — **an adversarial pass that
found fifteen defects in the draft, every one of which was re-checked against the code and upheld.**
Two were sharpened in the process (§7 records which). Where a claim was corrected, the correction is
stated in place rather than quietly substituted: §2 row 1, §2 row 2, §4.4(c)'s cost, §4.6's Gate-2
wire, §4.5's rule-7 citation, and §3's missing altitude were all wrong in the draft.

**Sources.** `docs/research/turbodiff-study.md`; `MAP.md`; the live code — `adws/adw_modules/`
(`runner.py`, `agents.py`, `gates.py`, `quality.py`, `data_types.py`, `tracer.py`, `permissions.py`,
`session.py`, `agent_pi.py`), `adws/adw_*.py`, `adws/dispatch.py`, `apps/ui/server/gate.ts`,
`apps/ui/server/queue.ts`, `queue/TEMPLATE.md`, `installer/steps.py`; and the skills —
`~/.claude/skills/{triage,documentation-factory,queue-publish,to-spec,to-tickets,morning-brief}/`,
including `triage/AGENT-BRIEF.md`, `morning-brief/scripts/collect_runs.py` and
`documentation-factory/references/ledger-schema.md`. Tone and shape follow
`docs/research/no-mistakes-study.md`.

**The one-line frame.** turbodiff's verifier is a *second full agent run* that improvises a capture
script against a running app (`turbodiff-study.md:120-143`). The factory's equivalent question —
*does the shipped thing actually run and do what the card asked* — is currently answered by reading
code, never by running it (`turbodiff-study.md:343-344`). The gap is real. The mechanism is portable
(Chrome + `puppeteer-core` + `page.screencast()` + ffmpeg, no Cloudflare dependency,
`turbodiff-study.md:290-292`). What is **not** portable is the assumption that filming is the answer
— which is what §2 exists to refuse.

---

## 1. What the operator actually asked for, and the two constraints it carries

Verbatim lens (`MAP.md:266-279`): *"an automated verify step in the pipeline — backend feature
shipped where UI already exists → prove the feature end-to-end; UI shipped → prove it works and looks
as it should… fully automated, because the factory works the Kanban autonomously."* Plus the
correction the same night: ***"NO blanket web-first rule — the factory is meant to be adaptable,
through and through,"*** and the origination doctrine: *"the ticket/card should declare the
verification lens and the factory executes it."*

Two constraints ride on that and both are load-bearing:

1. **Fail-closed.** *"turbodiff's silent-no-video on failed capture is the anti-pattern"*
   (`MAP.md:271-272`). turbodiff's own study confirms the mechanism: if the agent writes a bad
   `.cjs`, `uploadDemo` stats a missing or zero-byte `demo.webm`, returns `undefined`, and **nothing
   flags the absence** (`turbodiff-study.md:389-391`). A green report with no video is
   indistinguishable from a green report with one.
2. **Per-task, declared upstream.** Not a repo-wide toggle. turbodiff's `demo_videos` column is a
   per-*repo* switch defaulting ON (`turbodiff-study.md:111-115`); the operator's lens is per-*card*,
   decided by the humans and skills that wrote the card.

---

## 2. The per-task matrix

### The premise this table rests on, stated before the table

**There is no workload-repo binding in this factory. Every ADW runs against the checkout it is
installed in.** `session.ensure` sets `main_root = git_helper.repo_root()` (`session.py:79`) and
`dispatch.py:310` does the same; there is no `--repo`, no manifest, no workload-repo parameter
anywhere in `adws/`. MAP still lists multi-project as open — *"one factory, many projects — answer is
probably a manifest file, not a system"* (`MAP.md:349-351`). The shape that **does** exist is
per-repo installation: the installer puts a factory into a codebase, so "a workload project" means
"another repo with its own install," not a repo this install can reach. Compounding it, rule 13's
`protected_files` (`data_types.py:376-378`) makes the one repo this install *does* reach the one
whose machinery it may not touch.

Consequences, stated up front rather than discovered three rows down:

- Every row below that says "the repo" means **the repo the run is installed in**. Rows whose answer
  hinges on a *workload* app (rows 2 and 3) are conditional on a binding that has never been built.
  → **Q0**, which outranks Q1.
- The commands are not generic either. `test` is `pytest -q adws/tests`, `lint` is `ruff check .`,
  `typecheck` is `mypy adws`, all under `uv run --project <repo_root> --group dev`
  (`quality.py:235-259`, `_dev` at `:57-58`). Nothing in `QualityCheckSpec` is parameterised by
  project type. For a non-Python workload these argv are meaningless. → **Q3**.

### One verification declaration that already exists and costs zero

Before proposing any new field: **the `Adw:` header value is already a per-card lens selection.**
`queue/TEMPLATE.md` ships `Adw: simple-sdlc`, and `adw_simple_sdlc.py:116` calls
`quality.run_tests(run)` — the **test block alone**. Same for `adw_build_test.py:60` and
`adw_plan_build_test.py:60`. Only `adw_plan_build_test_quality.py:62` and `adw_quality.py:31` call
`run_quality` (lint + typecheck + `ai_defects` + test, `quality.py:380-385`). So a card that wants
the full deterministic stack says `Adw: plan-build-test-quality` today, and that is a per-card
verification declaration with zero new schema, zero parser change, and zero factory code.

### The table

Six work shapes, as the operator named them (`MAP.md:274-276`). **There is no blanket rule and this
table is not one** — it is six independent answers that happen to share machinery. Read each row on
its own.

| Work shape | What verification is meaningful | Filmed e2e? | What Gate 2's checkbox walk would consume |
|---|---|---|---|
| **Backend-only, no UI** | The existing deterministic stack — **named precisely, not waved at**: `test` (`quality.py:230-241`), `lint`, `typecheck`, `ai_defects` (`quality.py:244-299`), all hardcoded to this repo's Python layout. On the **default dispatched path** (`Adw: simple-sdlc`) only `test` runs; the rest need `Adw: plan-build-test-quality`. Optionally one API smoke check — a fixed argv that starts the service, curls a route, asserts a status/shape, tears down, routed through `quality._run`. | **No.** Nothing to see. turbodiff's own opt-out comment names exactly this case (*"API-only, libraries"*, `turbodiff-study.md:112-115`). | On the default path: exactly **one** `quality:test` tool_call event per loop iteration (`collect_runs.py:217-238`, stamped at `quality.py:194-210`). Two caveats: the digest's `quality` block is `null` on every dispatched run until §4.4(c) is fixed, and the event's `output_artifact` — the one payload key carrying the `command.log` path (`quality.py:206`) — is **dropped** by `fetch_quality_checks` (`collect_runs.py:230-237`). |
| **Backend + UI already exists** | Hinges on one fact: **does a deterministic e2e suite already exist in the repo the run targets?** If yes → wrap that argv in a `quality` block routed through `quality._run` — three states, a timeout, an artifact, a trace event. **Not `gates.tests_pass`** (the draft recommended it; that was wrong — see the strike-out note below). If no → this is the only row besides UI work where improvised capture is even a candidate. | **Conditionally.** A screenshot of the pre-existing UI showing the new backend value is genuinely the cheapest proof that "the feature reached the screen." A 20-second screencast usually is not — the change is one value in an existing view. | Best case: a `quality:e2e` row with a three-state verdict. Filmed case: an artifact path — which reaches the operator only after §4.6's +1-line `output_artifact` carry, or in the agent shape (and then see §4.3's gate/enforce ordering hole). **Real blocker first:** proving a backend value reached the screen needs the app to *have data*, and rule 6 forbids faking it (`MAP.md:49`; `turbodiff-study.md:326-329`). |
| **UI work (new or changed)** | *"Works"* and *"looks as it should"* are two questions, not one. **Works** is checkable by predicate: the app launched, the route returned 200, the declared screenshot exists and is non-trivially sized. **Looks as it should** is not checkable by any predicate the factory can write — it is a judgement, and rule 2 says judgements belong to the **one** agent reviewer, never a new stacked one (`MAP.md:38-40`, dead list `MAP.md:246`). | **Yes — this is the row filmed e2e is for**, and only for workload projects that are ordinary web apps started by one command on a port (`turbodiff-study.md:346-347`) — which today is a repo shape the factory cannot target (Q0). For the factory's **own** `apps/ui`, filming reaches the SPA only: everything behind the preload bridge — terminals, Setup screen, server lens — is `window.factory === undefined` in bare Chrome (`turbodiff-study.md:311-317`), and a headless run needs a seeded DB first, which rule 6 forbids faking (`turbodiff-study.md:326-329`). | **This cell assumes the agent shape.** Envelope `artifacts` gated by `artifacts_exist` + `files_non_empty` (`gates.py:38-55`) produce `gate_results` rows the walk can narrate — *"the card asked for X — the verify phase declared `verify/login.mp4` and the gate confirmed it exists, 2.1MB."* In the **code** shape that narration is unreachable today: gates cannot ride a code phase (§4.1) and the artifact path is dropped before the digest. The walk never plays the file either (`morning-brief/SKILL.md:104-106`; and it has nowhere to be served from — §7). |
| **ML** | Metric-based, not visual: an eval script emits `eval_metrics.json`; verification is (a) it parses — `gates.json_parses` (`gates.py:58-69`), and (b) named values clear declared thresholds — a small new gate or a `quality` block whose classifier reads the file. The threshold is a **card-declared number**, which is the strongest form of the upstream-origination doctrine on this whole list. The eval script's argv is the *workload's*, not the factory's → Q3. | **No.** A screencast of a training run is noise. | The metrics file as a declared artifact plus the threshold verdict — checkable text, ideal for the walk: *"the card asked for ≥0.87 F1 — the run recorded 0.891."* Via `json_parses` this is an agent-phase gate (§4.1); via a classifier it is a code phase and needs the `output_artifact` carry. |
| **DB schema** | Migration applies cleanly against a real (never mock — rule 6, `MAP.md:49`) schema, the suite is still green after it, and — optionally, and only if the card asks — the down-migration restores. All three are fixed commands, and all three are the *workload's* commands, not `quality.py`'s hardcoded Python argv → Q3. A `kind="code"` phase, identical in shape to `test_{i}` (`adw_build_test.py:56-61`). | **No.** | Same as backend-only: quality-row evidence with a three-state verdict. "Database unavailable on this host" is the canonical `incomplete` case (§4.3). |
| **Agentic harness (building an ADW/agent workflow)** | Run the new harness against a **fixture** and check its own trace: did the phases it claims exist appear in `sssf.db`, did the envelope parse, did the gates it declared actually run. This is the factory's own machinery inspecting itself, and it is entirely code-checkable — `phases`, `envelopes`, `gate_results` rows are all queryable (`tracer.py:60`, and `collect_runs.py:193-258` is a working example of exactly such a reader). Blocked on the fixture existing. | **No.** Nothing renders. | Trace-derived assertions as a quality row. Note the collision with Q0: rule 13 (`MAP.md:64-65`) `protected_files` refuses the run before verification is even a question — and the factory's own repo is the only repo this install can reach. |

**Strike-out, recorded rather than silently dropped.** The draft recommended `gates.tests_pass("<e2e
command>")` for row 2 as *"a predicate, rule 2 satisfied, nothing new."* That was wrong on three
counts, and it recommended precisely the two-lies bool §4.3 spends its length refusing
(`gates.py:109-122`): it has **two** states, not three, so a missing binary or an absent toolchain
comes back `ok=False`; that violation is fed back into the **same pi session** as a defect for the
agent to fix (`agents.py:200-209`), burning the bounded retry budget on something no agent can
repair; and it passes **no `timeout`** to `subprocess.run`, so an e2e command against a dev server
that never exits hangs the run forever with no 124→`incomplete` path. Route row 2 through
`quality._run` like every other row. If `tests_pass` is ever to carry weight, it needs a timeout and
a third state first (§7).

**Four things this table says that a blanket rule cannot.**

- Filmed e2e is meaningful in **one and a half of six rows** (UI work; conditionally backend+UI).
  The other four and a half are served by machinery that shipped — **in shape, not in argv**: the
  three-state classifier, the `_run` wrapper, the trace event and the loop are all real and reusable,
  but the commands inside them are this repo's Python, and on the default dispatched ADW only the
  test block runs at all. Rule 1 still holds — the boundary already has a check — but the check is
  narrower than the draft claimed.
- The **"works" / "looks right" split inside the UI row is the whole design**. Pushing "works" into
  predicates (launched, route answered, artifact exists and is non-trivial) and leaving only "looks
  right" to the existing reviewer means no second model reviewer is added — the thing the dead list
  killed by name (`MAP.md:246`). An unconstrained agent-authored capture step inherits turbodiff's
  own unmeasured reliability (`turbodiff-study.md:389-391`); a code-phase step can be fail-closed by
  construction (§4.3).
- The **row that needs the most work is the one nobody asked about**: backend+UI-existing, where the
  answer hinges on facts about the repo the run targets — does an e2e suite exist, what is its
  command, and is there seed data — that no factory-side code can know today. → §6 Q3.
- **Two rows are gated on things upstream of verification entirely**: Q0 (no workload-repo binding)
  and seed data under rule 6. Neither is a verification problem; both must be answered before rows 2
  and 3 have a subject.

---

## 3. Upstream origination — where the declaration lives

Five candidate altitudes. Traced by data flow, not preference. Each names the exact file and field.
Altitude 3.5 is new in this revision: the draft missed it, and it is the one that actually produces
the body of a dispatched card.

### Altitude 1 — the feature inventory (earliest human signature)

**File:** `_docwork/feature_inventory.yaml`, per `FEAT-NNNN` entry. **Schema:**
`documentation-factory/references/ledger-schema.md:105-120`. **Built and human-ratified at Stage 4**
(`stages/04-ratify.md`); **validated by** `documentation-factory/scripts/validate_inventory.py`.

Each FEAT already carries `scope` (*"what is in, what is out, and what 'done' means"*,
`ledger-schema.md:111-113`) and a free-text `notes: ""` (`ledger-schema.md:119`).

- **Cheapest form — no schema change at all:** the verification lens is one sentence inside `scope`
  or `notes`. `scope` already answers *"what 'done' means"*, and *"done means a recorded run shows
  the login flow"* is a scope sentence, not new metadata.
- **Machine-checkable form:** one optional key, e.g.
  `verification: {mode: static|test-suite|smoke|screenshots|screencast|eval-metrics, reason: "…"}`,
  added to the schema block and to `validate_inventory.py`'s per-feature checks — mirroring the
  existing `size in VALID_SIZES` vocabulary check. Stage 4's ratification packet already shows the
  operator the feature table; a verification column costs one more column, not a new stage.

This is the altitude MAP's own text names (`MAP.md:277-279`), and it is the only one where the
**human is already signing something**.

### Altitude 2 — the spec

**File:** `to-spec`'s spec template, `to-tickets`-facing. The template has `## Testing Decisions` and
**no** `## Verification Decisions`. Adding one heading, parallel in shape, is the entire change; step
3 of that skill already *"writes the spec using the template."* No process change. Specs not built
through documentation-factory would decide it here for the first time.

### Altitude 3 — the ticket

**Files:** `to-tickets/SKILL.md:69-82` (local-ticket template) and `:84-103` (issue template). Both
carry `**Blocked by:**` and acceptance checkboxes; neither has a verification field. Two options: a
metadata line beside `Blocked by:`, or one phrased acceptance criterion.

**But read Altitude 3.5 before spending anything here.** `to-tickets`' templates are *not* the format
that reaches a dispatched card.

### Altitude 3.5 — `/triage` + `AGENT-BRIEF.md` (the altitude that actually produces the card body)

**Files:** `~/.claude/skills/triage/SKILL.md` and `~/.claude/skills/triage/AGENT-BRIEF.md`. The draft
claimed no `triage*` skill existed and marked this seam unknown. **That claim was false and is
withdrawn** — the skill is present and it is the seam.

The chain is closed, and the code says so in three places:

- `AGENT-BRIEF.md:41-68` is the brief template: `Category / Summary / Current behavior / Desired
  behavior / Key interfaces / Acceptance criteria / Out of scope`.
- `queue/TEMPLATE.md`'s `## Agent Brief` block is that template **field-for-field**, and the
  template's own HTML comment names the source: *"Everything under '## Agent Brief' is the
  AGENT-BRIEF.md contract the triage skill writes."*
- `queue-publish/SKILL.md:19` declares its input as *"a triaged agent brief in the `/triage` output
  format"* and lists the same seven fields.

Two consequences that change §3's answer:

1. **The least-change recommendation lands here, not at Altitude 3.** "Phrase the lens as one
   acceptance criterion" is right — but the criteria list that reaches a dispatched card is
   `AGENT-BRIEF.md`'s, written by `/triage`, copied verbatim by `queue-publish` into
   `queue/NNN-slug.md`, and read by Gate 2's checkbox walk (`morning-brief/SKILL.md:89-98`). Zero
   schema, zero code, and it rides the whole chain untouched.
2. **`/triage` already carries a verification step.** Step 3 of `triage/SKILL.md` is *"Verify the
   claim… For a PR, confirm the diff does what it claims — check it out, run the relevant tests or
   commands,"* and notes *"a confirmed verification makes a much stronger agent brief."* So the
   upstream chain already has a place where someone runs the thing. The question this document is
   really asking is whether that step moves downstream into the factory, or whether the card simply
   states what the factory must run.

**A genuine competitor to the FEAT-schema option:** extend `AGENT-BRIEF.md`'s template with one
`**Verification:**` line beside `**Out of scope:**` — ~1 line of Markdown, zero code, and it rides
through `queue-publish` verbatim into every future card. It is not machine-branchable (nothing parses
the brief body), but neither is any prose option, and it is the only prose option that lands in the
document an agent actually receives as its contract.

### Altitude 4 — the queue-card header

**File:** `queue/TEMPLATE.md:3-7` — the `Key: value` block under the H1 (`Status`, `Adw`, `Adw-Id`,
`Created`, `Context`).

This altitude costs the least *parser* code, verified against three independent implementations that
all read the block generically:

- `apps/ui/server/queue.ts:16-44` — parses the contiguous `Key: value` run under the H1 with no
  hardcoded key list beyond `status`'s enum;
- `adws/dispatch.py:72-73, 95-99` — the same H1 + header-block grammar, deliberately mirrored;
- `queue-publish/scripts/validate_brief.py:79-92` — literally **derives** the required-key list from
  whatever `TEMPLATE.md` declares (`required_keys_and_enum`), and the skill instructs re-reading the
  template fresh each run.

So adding `Verify:` to `TEMPLATE.md` needs **zero parser edits** — it rides through like `Context:`
does today.

**But the free enforcement cuts both ways, and this is a decision, not a detail.**
`validate_brief.py:112-122` treats *every* template header key as **required** and emits a violation
for any card missing it. Adding `Verify:` to the template therefore makes it **mandatory on every
future card**, not optional. That is either exactly what the operator wants (every card states its
lens, no silent defaults — the fail-closed instinct applied to intake) or an unwanted tax on trivial
cards. It cannot be both. → §6 Q2.

Note also that this altitude **already carries one lens field**: `Adw:` selects which quality blocks
run (§2). A `Verify:` key is only needed if the branching cannot be expressed as "which ADW."

### Verdict on "where"

**Originate at Altitude 1** (ratified with everything else at Stage 4 — MAP's own text). **Ride
through Altitudes 2 and 3 as prose.** **Land in the card body at Altitude 3.5** — that is the
document the factory's agents actually read. **Add a header key at Altitude 4 only if the factory
needs to branch its code path on it**, and only after checking whether `Adw:` already expresses the
branch.

**Least-change option, marked and re-pointed:** **Altitude 1 free-text (`scope`/`notes`) + one
phrased acceptance criterion in the `/triage` agent brief (Altitude 3.5).** Zero schema edits, zero
validator edits, zero parser edits, zero skill-code edits anywhere in the chain — and the declaration
lands in the exact block Gate 2's checkbox walk already reads
(`queue/TEMPLATE.md`'s `## Agent Brief`, `morning-brief/SKILL.md:89-98`). Everything heavier buys
machine-branchability, which is only worth paying for once the factory actually branches (§6 Q2).

### What each skill minimally changes

| Skill | Minimum for the least-change option | Minimum for the machine-checkable option |
|---|---|---|
| **documentation-factory** | **Nothing.** `scope`/`notes` already exist; Stage 4 already ratifies them. | One optional `verification:` key in `ledger-schema.md:105-120` + one vocabulary check in `validate_inventory.py`, mirroring the existing `size` check. ~10 lines + one doc block. |
| **to-spec** | Nothing. | One `## Verification Decisions` heading in the spec template. ~3 lines. |
| **to-tickets** | **Nothing structural** — and note its templates are not what reaches a card (§3.5). | One optional `**Verification:**` line in both templates (`SKILL.md:69-82`, `:84-103`). ~2 lines. |
| **triage** (new row) | **Nothing** — the lens is one more acceptance-criteria checkbox, which the template already has (`AGENT-BRIEF.md:60-63`). | One `**Verification:**` line in the brief template (`AGENT-BRIEF.md:41-68`). **~1 line, zero code, rides through queue-publish verbatim** — the cheapest structured option in this table. |
| **queue-publish** | **Nothing.** It copies the brief verbatim under `## Agent Brief` and derives required keys from `TEMPLATE.md` live. | Still nothing — but `queue/TEMPLATE.md` gains a `Verify:` key, and `validate_brief.py` starts **requiring** it for free (see the warning above). ~1 line of template, plus the mirrored `## Agent Brief` line if 3.5 is taken. |
| **dispatch.py** | Nothing. | Nothing, **if** the operator picks a verification-bearing ADW by `Adw:` value (one more entry in `KNOWN_WRITING_ADWS`, `dispatch.py:67-70`, plus one new `adw_*.py`). Only the alternative — dispatch reading `Verify:` and passing it through — touches the router, and its own docstring is *"one dispatch, one subprocess"* (`dispatch.py:23-24`). See also Q9, which proposes the router's first refusal-with-a-reason. |

The `Adw:`-value route keeps dispatch a pure router and puts the branching in the ADW script, which
is where `adw_build_test.py` already branches on outcomes. That is the KISS-aligned half.

---

## 4. Factory landing

### 4.1 What a phase is, precisely

One `with run.phase(PhaseParams(...)) as ph:` block (`runner.py:135-174`). `PhaseParams`
(`data_types.py:23-54`) is name + `kind` (`"engineer"|"agent"|"code"`) + `owner` + a **required,
non-echoing** `description` + `retries`. Entering writes a `phases` row with `status="running"` —
success must be earned (`runner.py:152`) — plus a `phase_start` event; **any** exception flips the
row to `fail`, logs an `error` event, and calls `session_finish(ok=False)` (`runner.py:151-166`).
There is no path to a silently-green phase.

`kind="code"` runs deterministic Python directly — no agent, no envelope, no gates.
`kind="agent"` calls `ph.call(AgentCall(...))` into `agents.execute()` (`agents.py:115-253`):
render → spawn pi → parse the typed envelope (2 same-session JSON-fix attempts) → run every declared
gate, feeding violations back into the **same** pi session bounded by `retries`
(`agents.py:185-210`) → `permissions.enforce()` diffs a pre/post tree snapshot against the agent's
`writes` allowlist and rolls back anything unauthorized (`agents.py:216-223`) → persist, then raise
if `envelope.status != "success"` (`agents.py:251-252`).

**The rule that prices half of this document, stated once: gates ride agent phases; code phases
produce `tool_call` events.** `gates` is a field on `AgentCall` (`data_types.py:322`), the gate loop
lives inside `agents.execute` (`agents.py:185-210`), and `PhaseHandle.call` refuses outright outside
an agent phase — `"ph.call() is only valid inside an agent phase"` (`runner.py:37-38`). So *"just
model verification as a gate and it flows to Gate 2 for free"* is never free: **it costs an agent
phase**, which is a node under rule 1 and a lane under rule 7. A code phase's evidence channel is the
`tool_call` event (§4.4(b)), not `gate_results`. §2's "What Gate 2 would consume" column is derived
against this rule, which is why two of its cells name which shape they assume.

**The load-bearing precedent:** a failing check does **not** fail its phase. `adw_build_test.py:73-74`
and `adw_plan_build_test_quality.py:88` both show it — the test/verify phase *succeeds when it ran and
reported*; the **run's** acceptance is a separate question settled once at the end by
`run.finish(accepted=...)` (`runner.py:177-205`), after a bounded repair loop has had its chances.
That is exactly the slot a verify-by-running step occupies: a phase that can legitimately come back
*"the app did not demonstrate the criterion"* and feed the same loop.

### 4.2 Where the verify phase sits

Two existing loop shapes, both live in the writing ADWs:

- **The `test_i`/`fix_i` (or `verify_i`/`fix_i`) code-phase loop** — `adw_build_test.py:55-71`,
  `adw_plan_build_test_quality.py:57-86`. A `kind="code"` phase runs a fixed command, and a failure
  is wrapped by `quality.as_envelope()` into a `VerifyOutput` and handed to the builder through the
  same door an agent's report uses (`quality.py:318-354`).
- **The `review_i`/`revise_i` agent-phase loop** — `adw_build_review.py`. A `kind="agent"` phase
  where the agent decides what to check and writes its own findings, gated on the paths it declares.

**The code-phase shape is the closer fit** given the operator's lens, for reasons that are not taste:
it can be fail-closed *by construction* (§4.3), it costs zero lane (§4.5), it keeps rendered page
content out of an agent prompt (§4.5's injection bullet), and the agent-authored-script shape —
turbodiff's actual mechanism — inherits turbodiff's own honest gap (*"no test, no fixture, no golden
video, no retry… how often that happens is not observable from the repo"*,
`turbodiff-study.md:389-391`). Rule 2 argues for pushing *did it launch / did the route answer / does
the artifact exist and is it non-trivial* into predicates, and reserving the agent for the one
question no predicate can settle — *does the screenshot show the right thing* — which folds back into
the **existing** reviewer, not a new one.

The cost of the code shape is stated plainly in Q4: it needs a committed capture script in the repo
under test, and no such repo is bound today (Q0).

**Relation to `merge_check`:** distinct question, sibling phase, **not** a layering. `merge_check`
(unbuilt, evidence-gated, `MAP.md:333-343`) asks *"does this branch still work merged into current
main"* — a code-only question about git state. A verify phase asks *"does the shipped feature
actually run"* — a question about the running app. Neither requires the other, and `merge_check`'s
own evidence bar (two `ph.log()` calls recording `origin/main` at branch-cut and at Gate, watching
whether it moves mid-run) has not been met (`MAP.md:340-343`). It is not scaffolding to build on
today.

### 4.3 Fail-closed, mechanically — the three-state pattern

`quality.py`'s `ai_defects`/`_classify_ai_defects` is the house pattern and it is *exactly* what the
operator's correction demands:

- `QualityStatus = Literal["pass", "fail", "incomplete"]` (`data_types.py:149`), with the comment
  spelling out why a bool lies in **both** directions: `passed=True` on a tool that never ran reads
  as a verified pass it never earned; `passed=False` sends the builder to fix a missing toolchain it
  cannot fix (`data_types.py:137-148`).
- `TOOL_UNAVAILABLE_SIGNATURES` (`quality.py:104-110`) is a **narrow, evidence-collected, not
  guessed** substring list, plus exit 124 (timeout) and 127 (missing binary) as unambiguous
  `incomplete` (`quality.py:113-133`).
- `QualityResult.passed` stays **strict**: true only when every check is `"pass"`, so an
  incomplete-only result is `passed=False` exactly like a real failure and nothing downstream can
  read the run as verified (`data_types.py:182-199`, `quality.py:402-408`). But `failures` (the
  builder's repair spec) and `incomplete` (recorded, surfaced, **never** handed to the agent) stay
  separate lists — an unwinnable round never burns the bounded fix loop (`quality.py:393-401`,
  `as_envelope` keyed on `.failures` not `.passed`, `quality.py:326-336`).

**Ported to capture, the mapping is forced, not chosen:**

| Real condition | Verdict | Why |
|---|---|---|
| App launched, criterion's screenshot captured, non-empty | `pass` | The tool ran and reported. |
| App launched, flow ran, the asserted state never appeared | `fail` | The tool ran and found something — routable to the builder. |
| App would not launch / port already bound / headless Chrome absent on this host / capture script errored / timeout | **`incomplete`** | The tool never ran. It has said **nothing** about the code. Recorded, blocks acceptance via strict `passed`, never fabricated into a green row, never sent to the builder as a defect. |

The forbidden fourth state is turbodiff's: **capture failed → report simply has no video and nothing
flags its absence.** In this codebase that state is unreachable *if* the block goes through
`quality._run` — a missing artifact is an exit code, an exit code is a classified status, and a
status is a row in the trace.

**The agent-shape fallback has a hole, found on adversarial re-verification.** The draft said: *"if
the block is an agent phase whose envelope declares `artifacts`, the same refusal is enforced by
`gates.artifacts_exist` + `gates.files_non_empty`."* That is true about the gate and false about what
happens next. Ordering: the gate loop runs at `agents.py:185-210`; `permissions.enforce` runs
**after** it, at `:216`. For an agent with `writes: []` — exactly what §4.5 proposes for a verifier —
a captured file that is **not** gitignored appears in the tree snapshot as untracked, fails
`permitted()`, is **deleted** by `_roll_back` (`permissions.py:151-173`, the untracked branch at
`:165-170`), and the phase then dies on `PermissionBreach` (`permissions.py:245-252`). So the
sequence is: gate certifies `verify/login.mp4` exists at 2.1MB → a green `gate_results` row is
written → the file is destroyed → the run hard-fails → and per Q8 the failed run is filtered off the
Gate board entirely (`gate.ts:151`). The operator sees nothing; the trace keeps a green row for
evidence that no longer exists.

If the path **is** gitignored, the mirror image: `_snapshot_tree` lists untracked files with
`--exclude-standard`, so gitignored paths never appear (`permissions.py:51-68`) — nothing is rolled
back, the file survives, and nothing records it as touched either.

**Forced consequence:** a capture artifact must land under `data_dir`'s session runtime
(`context_handoff/`, always writable regardless of `writes`, `permissions.py:123-131`) or be named
explicitly in the verifier's `writes`. Both are config, not code. The ordering itself is a finding
(§7): a gate can certify an artifact that `enforce` then deletes.

**One honest caveat carried from the reader pass:** the three-state classifier is proven **once**
(`ai_defects`). Porting it means writing a second signature list from *this* toolchain's real failure
text — Chrome's, the dev server's, the OS's — collected from real failures, not assumed to transfer
from Skylos's uv/MSVC strings.

### 4.4 Where the evidence lands — the wire facts (re-verified, and one correction)

This is where the reader passes needed sharpening. Three concrete facts decide whether any of this
reaches Gate 2.

**(a) A `kind="code"` phase cannot produce a gate row today.** `tracer.gate_row(...)` has exactly one
call site: `agents.py:190`, inside the gate loop of `agents.execute()`. So *"model verification as a
gate and it flows to the brief for free"* is true **only in the agent-phase shape**. From a code
phase it costs a small `PhaseHandle` helper (~5 lines) that builds a `GateReport` and calls
`run.tracer.gate_row(...)` directly. Cheap — but not free, and the general rule behind it is stated
in §4.1: gates ride agent phases, and an agent phase is a node and a lane.

**(b) The `quality:<name>` tool_call event is the cheapest existing wire to Gate 2 — cheaper than
either the gate route or a new envelope field, with one payload key missing.**
`collect_runs.fetch_quality_checks` (`collect_runs.py:217-238`) queries `events WHERE
type='tool_call' AND name LIKE 'quality:%'` and carries `status` (pass/fail/incomplete),
`returncode`, `area`, `operation` and `command` straight into the digest. Every call to
`quality._run` stamps exactly that event (`quality.py:194-210`). Two corrections to the draft's
"zero changes" claim:

- **`output_artifact` is dropped.** `quality._run` stamps the artifact path into the payload
  (`quality.py:206`); the digest's per-check dict does not carry it (`collect_runs.py:230-237`). So a
  code-shaped verify puts **no path** in front of the operator. One line fixes it (§4.6).
- **Which blocks even run depends on the ADW.** On the default dispatched path (`Adw: simple-sdlc`,
  `queue/TEMPLATE.md`) the loop calls `quality.run_tests` — one `quality:test` event per iteration
  (`adw_simple_sdlc.py:116`; same at `adw_build_test.py:60`, `adw_plan_build_test.py:60`). Lint,
  typecheck and `ai_defects` only run under `adw_plan_build_test_quality.py:62` or `adw_quality.py:31`.

The envelope route remains worse: any new field (`demo_path`, `screenshot_paths`) is **silently
dropped** by the hardcoded allowlist `for key in ("commit_message", "document_path", "approved",
"changed_files")` (`collect_runs.py:291`), and `artifacts` is not carried at all.

**(c) …except that both Gate readers key on a phase literally named `"quality"`, and no dispatched
run has one.** `build_digest` populates `digest["quality"]` only when a phase named exactly
`"quality"` exists (`collect_runs.py:422, 462`), and `gate.ts:168` does
`phases.find((p) => p.name === "quality")` for the Gate card's quality tile. In the live tree the
only phase with that name is `adw_quality.py:31` — and `"quality"` is **not** in `KNOWN_WRITING_ADWS`
(`dispatch.py:67-70`). Every dispatched writing run names the phase `test_{i}`
(`adw_build_test.py:57`, `adw_plan_build_test.py:57`, `adw_simple_sdlc.py:113`) or `verify_{i}`
(`adw_plan_build_test_quality.py:60`) — all with `owner="quality"`, which neither reader looks at.

**Consequence, stated plainly:** today the quality *checks* are collected but the digest's `quality`
block and the Gate card's quality tile are `null` on every dispatched run. This is a pre-existing
naming mismatch, not something a verify phase introduces — but it lands squarely on the path any
verification evidence must travel. Flagged as a finding, **not** fixed here. → §6 Q5.

**Cost, corrected — the draft's "~2 lines each" was wrong.** Three reasons:

1. `next(...)` and `.find(...)` return the **first** match. Every dispatched writing ADW runs its
   quality phase up to three times (`test_1`/`verify_1` … through the fix loop), so an owner-based
   rename would narrate the **pre-repair** round — `phase_status` and `phase_error` from the failure
   the loop already fixed (`collect_runs.py:422, 462-472`; `gate.ts:168-181`). The fix is the **last**
   `owner == "quality"` phase by `seq`, which `fetch_phases` already selects
   (`collect_runs.py:193-200`). In `adw_simple_sdlc` that correctly picks `retest` — the re-run after
   a revision, which is the run's real final verdict (`adw_simple_sdlc.py:149-154`).
2. `fetch_quality_checks` is **run-scoped**, not phase-scoped (`WHERE adw_id = ?`,
   `collect_runs.py:222-226`), so `pass_count`/`fail_count`/`incomplete_count` sum across every loop
   iteration. Scoping them to the chosen phase's `phase_id` is a query change plus a caller change.
3. `gate.ts:179` hardcodes `checks_json: null`, so the Gate tile would light up carrying **no
   per-check evidence** even after the rename — which is most of the point.

Honest re-cost: **~15-20 lines across `collect_runs.py` and `gate.ts`**, not 4. Still the cheapest
item in this document, and still worth its own card — on that number.

### 4.5 pi + roster + lanes vs turbodiff's single-CLI loop

turbodiff is one CLI (`claude -p --dangerously-skip-permissions`, `turbodiff-study.md:44-48`) inside
one Cloudflare container that *is* the isolation boundary. The factory is pi + a roster + lane
balancing on a host with **no sandbox** — dead-listed for v1 on purpose (`MAP.md:250`). What that
changes:

- **No process isolation.** `agent_pi.run()` does
  `subprocess.Popen(cmd, ..., cwd=request.cwd, env=operator_env())` (`agent_pi.py:322-325`) — pi runs
  directly on the host, and its `bash` tool is bounded only by the roster's `tools:` allowlist. A dev
  server an agent launches is a real process on the operator's machine. Worktrees isolate the
  **filesystem** (`specs/worktrees.md`) and `permissions.py` polices **paths** — neither says
  anything about a **process** or a **port**. A filming step is a strictly larger blast radius than
  any check that exists today.
- **Prompt injection — the surface the draft dropped entirely.** turbodiff embeds a shared
  `UNTRUSTED_CONTENT_RULES` block in every agent prompt and tells its reviewer outright that PR
  title, description, diff, file contents and thread comments are *data, not instructions*
  (`turbodiff-study.md:251-254`) — the study recorded this as *"the same problem the factory has."*
  An agent-shaped verify step launches a workload app, drives a browser, and feeds **rendered page
  content** back into an agent prompt, on a host with no sandbox and a `bash` tool bounded only by a
  roster allowlist. A page under test is attacker-influenced content by construction (it renders
  whatever is in the database, the fixtures, or the diff just written). The **code** shape has no
  such surface: fixed argv, exit code, artifact path — nothing rendered ever becomes an instruction.
  This is a stronger argument for the code shape than anything currently in Q4.
- **No port allocator.** Nothing in the worktree layer assigns a port per run. Two parallel
  worktrees each running the workload's `npm run dev` collide on the same default port — a real
  problem the moment the fan-out planner activates (`MAP.md:117-121`). Unbuilt; nothing to reuse.
- **No registry for agent-launched background processes.** `tracer.process_start/process_end`
  (`tracer.py:174-203`) exists and is wired for the pi child itself (`agents.py:167-170`), so a hung
  agent is findable and killable by `adw_id`. It is **not** wired to anything an agent's own `bash`
  spawns with `nohup … &` — turbodiff's launch idiom (`turbodiff-study.md:165`). Such a server would
  be invisible to the registry and would leak for the life of the host unless the agent kills it.
- **Lane cost is a cards-per-night number, not a visibility problem.** Rule 7 is *"No paid services.
  Flat-rate subscriptions only; zero marginal token spend is a hard constraint"* (`MAP.md:50-51`) —
  the draft cited `MAP.md:94-96`, which is the balancer's lane-pinning text, not the rule. Under a
  flat-rate weekly cap the currency is **agent turns**, and the factory's own planner already has a
  threshold in that currency: the fan-out planner activates at **>10 ready cards, or any lane under
  30% weekly headroom** (`MAP.md:117-121`). turbodiff budgets its verifier 20 minutes of agent time
  (`turbodiff-study.md:197-199`). An agent-shaped verify phase plus its correction rounds roughly
  doubles the agent turns a card costs — which at the same weekly headroom turns **N cards a night
  into about N/2**. A **code**-shaped verify phase costs zero lane. That arithmetic decides Q4 more
  sharply than any argument about elegance.
- **Roster/lanes are otherwise a non-issue.** A `verifier` (or reuse of `reviewer`) is an ordinary
  `AgentConfig` (`data_types.py:332-354`) with `writes: []` — read-only w.r.t. the repo, since
  `context_handoff/` is always-writable regardless of `writes` (`permissions.py:123-131`). Config,
  not machinery — **but see §4.3: with `writes: []`, any capture artifact outside `data_dir` is
  deleted by `enforce` after the gate has already certified it.**
- **Host split, already coded.** `installer/steps.py:586-603` (`detect_target()`) draws the line:
  container markers → `"container"`; Windows → `"laptop"`; Linux with no `DISPLAY`/`WAYLAND_DISPLAY`
  → `"server"`. **Nothing in the installer installs Chrome, Puppeteer or ffmpeg on any target.**
  turbodiff's recipe is apt-installed Chrome + ffmpeg + `nohup` + `/tmp` — Linux-only
  (`turbodiff-study.md:145-147`). MAP is blunt about where this has to live: *"the laptop is a
  planning box; the chains that build software need the Linux server"* (`MAP.md:196`) — and the
  server phase has not landed. The Skylos precedent is the template: a separate optional `uv` group
  (`pyproject.toml`'s `scan` group, `quality.py:61-66`), absent on the laptop, classified
  `incomplete` rather than faked green — and Q8 records what that precedent already costs today.

### 4.6 The cheapest honest v1

Reusing what exists, in this codebase's own idiom. Effort sizes are of the same kind the no-mistakes
study used for `merge_check` (~100 lines). **Every line here must beat Option 0 in §5**, which
changes nothing on either side.

| Where | What | ~Lines |
|---|---|---|
| `adws/adw_modules/data_types.py` | Either reuse `operation="test"` (**0 lines**) or add `"verify"` to `QualityOperation` (`:135`). `QualityArea` already declares `"frontend"`/`"backend"` (`:134`) and **nothing in the live tree uses them** — every block is `area="repo"`. A UI verify block would be their first legitimate consumer. | 0–1 |
| `adws/adw_modules/quality.py` | `verify(run, spec)` — a `_run` call with a launch/capture argv, plus `_classify_verify` with its own `TOOL_UNAVAILABLE_SIGNATURES` collected from real failures. `_run` already gives subprocess capture **with timeout**, `UV_PROJECT_ENVIRONMENT` pinned per-tree (`quality.py:143-149` — the exact worktree-correctness fix a launch command also needs), a `command.log` artifact, the `tool_call` event, and the console note. | ~35 |
| The capture script | **Committed to the repo under test, not improvised per run** — the single sharpest divergence from turbodiff, and what turns a demo into a check. turbodiff writes each `.cjs` fresh in the sandbox and discards it, so two runs exercise the feature differently (`turbodiff-study.md:366-370`). A committed script makes the verify block a fixed argv like every other quality block. **Blocked on Q0: there is no repo under test other than the factory's own.** | repo-side, not factory-side |
| each ADW that gains it | one phase block in the existing bounded loop, following `adw_plan_build_test_quality.py:57-86` verbatim | ~8 each |
| Gate 2 wire | **+1 line** in `fetch_quality_checks` to carry `output_artifact` into the per-check dict (`collect_runs.py:230-237`) — without it the evidence path never reaches the brief in the code shape. | 1 |
| the §4.4(c) reader fix | last `owner == "quality"` phase by `seq`, checks scoped to that phase's `phase_id`, and `checks_json` actually populated — across `collect_runs.py` **and** `gate.ts:179`. Re-costed honestly (§4.4). | ~15–20 |
| artifact landing | capture output under `data_dir`'s session runtime, or named in the verifier's `writes` — otherwise `permissions.enforce` deletes what the gate certified (§4.3). Config, not code. | 0 |

**Not counted, because they are prerequisites of *running a dev server at all*, not of verification:**
a port allocator, a background-process registry, a Chrome/ffmpeg toolchain on a host that has one,
and **seed data the app can render** under rule 6's no-mock-data constraint. Those are the real cost,
they are unbuilt, and they belong to the server phase (§7).

**And the cheapest experiment of all is upstream of every line above** — the same shape §f.2 of the
no-mistakes study used to evidence-gate `merge_check`: **on one real run, does a screenshot or a
20-second screencast change the operator's Gate 2 decision even once?**
(`turbodiff-study.md:375-377`). Two honest notes on running it: it needs no factory change, and it
**cannot be run as a factory run tonight** — there is no run shape that targets a plain web app (Q0).
What *is* available today is the hand version: capture one screenshot manually of whatever app is
being shipped, put it beside a real Gate 2 decision, and see whether it moves. That costs one
operator, one file, and no code.

---

## 5. The minimal change set

Per KISS (rule 1). Four columns because the operator's own framing was *"either we adjust upstream or
we adjust the factory, one of the two, if not both"* — and because the honest floor is neither.

**Option 0 — change nothing on either side (the baseline every other option must beat):**

Declare the lens upstream as one acceptance criterion in the card's `## Agent Brief` (the
`AGENT-BRIEF.md` contract, §3.5), pick `Adw: plan-build-test-quality` when the full deterministic
stack is wanted (§2), and let the **existing** single reviewer (rule 2) check the criterion against
the diff. Zero schema, zero validator, zero parser, zero factory code. **This is what the factory
does today.** What it cannot do: it reads code — it never runs the app. That is precisely the gap
this document opens with, and it is the entire content of Q1. If the answer to Q1 is "no, evidence
would not have changed my decision," Option 0 *is* the answer and §4.6 is not built.

**Upstream — minimum (the least-change option of §3):**

1. One sentence in the FEAT's existing `scope`/`notes` naming the verification lens
   (`ledger-schema.md:111-119`). **Zero schema edits.**
2. One acceptance criterion in the `/triage` agent brief that names the expected evidence form
   (`AGENT-BRIEF.md:60-63`) — the block `queue-publish` copies verbatim into the card and Gate 2's
   walk already reads. **Zero template edits.**

That is the whole upstream minimum. It is also *already legal today* — nothing prevents an operator
writing either sentence this afternoon.

**Upstream — if machine-branching is wanted (only then):**

3. `verification:` optional key on the FEAT schema + one vocabulary check in
   `validate_inventory.py` (~10 lines).
4. One `**Verification:**` line in `AGENT-BRIEF.md`'s template (~1 line, zero code, rides through
   queue-publish verbatim) — the cheapest structured option, though still prose to any parser.
5. `Verify:` key in `queue/TEMPLATE.md` (~1 line) — **which makes it required on every card**
   (`validate_brief.py:112-122`). Decide that deliberately, and check first whether `Adw:` already
   expresses the branch.
6. One `## Verification Decisions` heading in `to-spec`'s template (~3 lines).

**Factory — minimum:**

1. The §4.4(c) reader fix — last `owner == "quality"` phase by `seq`, phase-scoped check counts, and
   `checks_json` populated (`collect_runs.py:422, 462-472`; `gate.ts:168-181`), **~15-20 lines, not
   4**. **Worth doing on its own merits regardless of verification** — it is a live gap on every
   dispatched run today.
2. **+1 line** carrying `output_artifact` through `fetch_quality_checks` (`collect_runs.py:230-237`),
   without which a code-shaped verify shows the operator no evidence path at all.
3. A `quality.verify` block + its own three-state classifier (~35 lines), and one phase block in
   whichever ADW gains it (~8 lines) — **only after Q0 and Q1 are answered.**
4. Nothing else, for the four-and-a-half rows of §2 that filming does not touch.

**Both — the honest answer for the UI row specifically:** upstream declares the lens (which criterion
needs which evidence), the factory executes it deterministically and refuses fail-open. Neither side
alone gets there: a factory-only version has to guess which cards want filming (the blanket rule the
operator rescinded), and an upstream-only version declares an intent nothing enforces. But note that
"both" is the *third* option, not the first: Option 0 and the two-sentence upstream minimum come
first, and neither costs a line of factory code.

### What does NOT change

Verified, not assumed:

- **`runner.py`'s `Run`/`PhaseHandle`/phase context manager** — already generic across all three
  kinds; a verify phase is just another `with run.phase(...)` block.
- **`agents.py`'s execute/gate/retry/permission pipeline** — untouched in the agent shape, bypassed
  by design in the code shape. (Its gate→enforce **ordering** is a finding, §4.3, not a change
  proposed here.)
- **`tracer.py`'s schema and write path** — every row this would produce already has a shape
  (`type` is a free string; `gate_results.checks_json` carries arbitrary evidence, `tracer.py:241-249`
  — which is exactly the column `gate.ts:179` currently hardcodes to `null`).
- **`gates.py`'s five checks** — `artifacts_exist`, `files_non_empty`, `json_parses`,
  `diff_matches_claims`, `verdict_consistent` are reusable unmodified, and the first two are exactly
  the "an evidence file was declared — does it exist and have content" refusal (`gates.py:38-55`).
  **`tests_pass` is the exception and is not reused** — two states, no timeout (§2's strike-out, §7).
- **`QualityStatus`'s three states** (`data_types.py:149`) — already the vocabulary; no new one
  needed.
- **`permissions.py`'s writes/protected_files model** — a `verifier` slots in with `writes: []`; no
  code change, **provided artifacts land under `data_dir` or are named in `writes`** (§4.3).
- **`worktrees.py` / `specs/worktrees.md`** — the app under test runs inside the run's own worktree,
  `cwd=run.repo_root`, like every other command `quality.py` shells out to.
- **`adws/dispatch.py`** — untouched under the `Adw:`-value route; a card routes to whichever writing
  ADW gained the phase, exactly as today. (Q9 proposes the one exception worth arguing.)
- **`apps/ui/server/queue.ts`, `dispatch.py`'s header parser, `validate_brief.py`** — all three
  derive their key contract generically from `queue/TEMPLATE.md`; a new header key is a template
  edit, not a code edit.
- **`morning-brief`'s checkbox-walk logic and its fixed honest-gap phrase**
  (`morning-brief/SKILL.md:89-106`) — it already pulls from `phases`/`notes_for_next_agent`/`gates`
  generically and already refuses to invent a match. It does not need to know "verification" is a new
  *kind* of evidence, only that evidence exists where it already reads. (The two wire fixes above are
  about evidence *arriving*, not about the walk's logic.)
- **`documentation-factory`'s two-gate structure and the `_docwork/` workspace** — a verification-lens
  decision is exactly what Stage 4 ratification exists to catch cheaply. No new stage.
- **`/triage`'s state machine** — the lens is a criterion inside an existing template field; no new
  role, no new state (§3.5).
- **`merge_check`** — a separate, still-evidence-gated question (`MAP.md:333-343`). Not a dependency
  in either direction.
- **Rule 2's single reviewer** — nothing here adds a second model reviewer. "Looks as it should"
  routes to the existing one or nowhere.

---

## 6. Open decisions for the grilling

These are the questions only the operator can answer. Each carries the analysis that produced it, so
the answer can be given in one sentence.

**Q0 — What repo does a verify step even target? (Outranks Q1.)**
Every ADW binds to the checkout it is installed in: `session.ensure` sets
`main_root = git_helper.repo_root()` (`session.py:79`); `dispatch.py:310` does the same. There is no
`--repo`, no manifest, no workload-repo parameter anywhere in `adws/`, and MAP still lists
multi-project as open (*"probably a manifest file, not a system"*, `MAP.md:349-351`). The shape that
exists is per-repo installation, so "the workload project" means "another repo with its own
install." Meanwhile rule 13's `protected_files` (`data_types.py:376-378`) makes the one repo this
install *does* reach the one whose machinery it may not touch. **So: is the first move a verification
lens at all, or the workload-repo binding that §2's rows 2 and 3, §4.6's committed capture script,
and Q1's experiment all presume?** Everything below is conditional on this answer.

**Q1 — Does the evidence change your decision, before any of it is built?**
The cheapest experiment in this document needs zero code: on one real run, does a screenshot (or a
20-second screencast) change your Gate 2 decision **even once**? turbodiff's own study set this bar
(`turbodiff-study.md:375-377`), and the factory has an exact precedent for honouring it —
`merge_check` is evidence-gated behind two `ph.log()` calls rather than built on a sound-sounding
premise (`MAP.md:340-343`, no-mistakes study §e). Everything in §4.6 is downstream of your answer
here, and Option 0 (§5) is the null hypothesis it is measured against. *If the honest answer is "I
don't know yet," the decision is to run the experiment by hand — one manual screenshot beside one
real Gate 2 decision — not to build the phase.*

**Q2 — Optional prose, or a mandatory card field?**
The least-change option (§3, marked) is one sentence in the FEAT's `scope`/`notes` plus one phrased
acceptance criterion in the `/triage` agent brief — zero schema, zero validator, zero parser edits,
and it lands exactly where Gate 2 already walks. The machine-checkable option costs ~15 lines across
`ledger-schema.md`, `validate_inventory.py`, `to-spec`'s template and `queue/TEMPLATE.md`, and buys
one thing: a **deterministic router can branch on it**. But note the asymmetry found in the code:
adding `Verify:` to `queue/TEMPLATE.md` makes it **required on every card**, because
`validate_brief.py:112-122` derives required keys from the template and violates on any missing one.
So the real question is four-way: *(a)* prose only; *(b)* one `**Verification:**` line in
`AGENT-BRIEF.md` (~1 line, rides the whole chain, still prose to a parser); *(c)* optional metadata
upstream, no card key; *(d)* a mandatory `Verify:` on every card forever. **(d) is defensible** — the
fail-closed instinct applied to intake, no card ships without stating how it will be proven — but it
taxes trivial cards and it is a one-way door once cards exist. And check first whether `Adw:` already
expresses the branch you want (§2).

**Q3 — Where do the workload's commands come from? (Not just the e2e one.)**
This is the hinge of §2's rows 2-5, and it is bigger than the draft's "does an e2e suite exist."
Nothing in `QualityCheckSpec` is parameterised by project type: `test` is `pytest -q adws/tests`,
`lint` is `ruff check .`, `typecheck` is `mypy adws`, all under `uv run --project <root> --group dev`
(`quality.py:235-259`). For the ML row's eval script, the DB row's migration, an e2e command, or any
non-Python workload, those argv are meaningless. Three shapes, and they are not equally cheap: the
card declares the command (upstream doctrine, most KISS-aligned, but a human has to look); the ADW
discovers it per run (turbodiff's self-discovery timeboxed with a cached verdict,
`turbodiff-study.md:168-175` — an agent turn per run, a lane cost, and the discovery result has
nowhere to be cached in this factory today); or the workload repo declares it once in a manifest the
factory reads — **which is the same manifest question already open at `MAP.md:349-351` and the same
binding as Q0.** Answer Q0 and Q3 together or not at all.

**Q4 — Code phase or agent phase, for the UI row?**
The code shape can be fail-closed by construction, costs **zero lane**, produces a fixed-argv check
that is the same every run, and — the argument the draft missed — has **no prompt-injection
surface**: fixed argv in, exit code and artifact path out, no rendered page content ever entering an
agent prompt (§4.5). It requires the capture script to be **committed to the repo under test**, which
turbodiff explicitly does not do (`turbodiff-study.md:366-370`) and which Q0 currently blocks. The
agent shape needs no committed script and handles never-seen-before UIs, but: it is a second agent
run on top of the run that already happened (rule 1: a node); under rule 7's flat-rate cap it roughly
**halves cards per night** at the same weekly headroom (`MAP.md:50-51`, `:117-121`); it feeds
attacker-influenceable page content into an agent with a `bash` tool on a host with no sandbox
(`MAP.md:250`); and it inherits turbodiff's unmeasured capture reliability. **My reading of your own
rules points hard at the code shape** — but it moves work into the workload repo, which is a cost you
have to accept explicitly, not one this analysis can accept for you.

**Q5 — The pre-existing wire gap: fix it now, or leave it?**
Found while verifying this analysis, and it is independent of verification entirely: both Gate 2
readers key on a phase **literally named `"quality"`** (`collect_runs.py:422, 462`; `gate.ts:168`),
and no dispatched writing ADW has one — they are named `test_{i}` / `verify_{i}` with
`owner="quality"`. So today the morning brief's `quality` block and the Gate card's quality tile are
`null` on every dispatched run, while the per-check evidence sits in the trace unread. **Honest cost,
corrected from the draft's "~4 lines": ~15-20 lines across two files** — a naive `owner` rename would
report the **first** loop iteration (the pre-repair failure), the check counts are run-scoped rather
than phase-scoped (`collect_runs.py:222-226`), and `gate.ts:179` hardcodes `checks_json: null` so the
tile would carry no evidence anyway. Add the +1 line for `output_artifact` (§4.6) and it is the whole
Gate-2 evidence path in one card. It is still the cheapest item here, and it is still not what you
asked for. *Do you want it as its own small card, on that number?*

**Q6 — Which host, and is the server phase now the blocker?**
Nothing in the installer provisions Chrome, Puppeteer or ffmpeg on any of the three targets
`detect_target()` names (`installer/steps.py:586-603`), and MAP is explicit that *"the laptop is a
planning box"* (`MAP.md:196`). The Skylos precedent says the honest posture is a separate optional
`uv` group, absent on the laptop, classified `incomplete` rather than faked
(`quality.py:61-66, 278-284`). **Which means: on the laptop, every filmed verification would honestly
read `incomplete`, forever, and correctly block acceptance.** If that is unacceptable, the answer is
not to weaken the classifier — it is that this capability is server-phase work and should be
sequenced there. Read this with Q8: that precedent already has a consequence nobody has named.

**Q7 — Are you willing to pay for a port allocator, a process registry, and seed data?**
Filming needs a *running app with data in it*. Under parallel worktrees (shipped, `MAP.md:167-172`),
two runs each starting the workload's dev server collide on one port, and nothing allocates one per
run. An agent-launched `nohup … &` server is invisible to `tracer.process_start/process_end`
(`tracer.py:174-203`, wired only for the pi child at `agents.py:167-170`) and leaks for the life of
the host. And the app must **have data to render**: the turbodiff study's own hardest blocker is that
any headless run of `apps/ui` needs a seeded database first, while rule 6 forbids mock data
(`turbodiff-study.md:326-329`, `MAP.md:49`) — *"that prerequisite is unsolved and sits upstream of any
recording."* None of the three is a *verification* problem; all three are prerequisites of running
any app under this factory, no sandbox exists to contain the blast radius (`MAP.md:250`), and they
are the real cost. **Pay for them for the UI row, or is the UI row's answer "static verification plus
the existing reviewer" until the server phase lands?**

**Q8 — Should an infrastructure-`incomplete` run stay on the Gate board as a named, non-mergeable
item?**
The draft said an `incomplete` verify merely "does not present itself as ready to merge." That
understates it by two orders. The chain: `run.finish(accepted=False)` writes
`session_finish(ok=False)` (`runner.py:203`); `computeGateItems` filters `s.status === "success"`
with the explicit comment that a failed run *"is trace work, not gate work, and is skipped here
entirely"* (`gate.ts:146-151`) — **no card, no compare URL, no push command**. Meanwhile the commit
phase sits inside the `if verified:` branch (`adw_plan_build_test_quality.py:88-94`;
`adw_simple_sdlc.py:159-164`), so **the code is never committed either.** Rule 11 says a run either
merges or leaves a visible, named artifact explaining why not — *silence is the bug* (`MAP.md:59-61`).
Today it is silent. **And this is already live, unremarked:** skylos is `incomplete` on Windows by
design (`quality.py:278-284`), `QualityResult.passed` is strict, so `adw_plan_build_test_quality` on
the laptop never reaches its commit phase and never appears on the Gate board at all. The Skylos
precedent Q6 holds up as the model already carries this consequence. **So the question is not "do you
accept `incomplete`" — you already do. It is: should such a run appear on Gate 2 as a named,
non-mergeable card saying why?** (`gate.ts:151` is where fail-closed becomes invisible — §7.)

**Q9 — Where does a lens/host mismatch get reported: at intake, or mid-run?**
Rule 10 is named in this ticket's charter and the draft never engaged it: *"Mid-run escalation is a
defect report against the intake, not a feature"* (`MAP.md:56-58`). A card that declares a screencast
lens on a host with no Chrome is exactly a mid-run escalation with no route — the run spends its
phases and comes back `incomplete` (Q6), and per Q8 then disappears. Under rule 10 the honest place
to catch it is the **intake**: a pre-flight check at dispatch — *does this host have the toolchain
this card's lens needs?* — that **refuses the card with a reason** rather than burning a run to
discover it. That is a strong KISS argument, and it is cheap in code. The cost is a new
responsibility on a router whose docstring is *"one dispatch, one subprocess"* (`dispatch.py:23-24`),
and it would be dispatch's first refusal-with-a-reason. **Do you want the router to start refusing
cards it cannot host?**

---

## 7. Honest gaps

**First, the one that outranks the rest:**

- **No workload-repo binding exists; every run is the factory on the repo it is installed in.**
  `session.ensure` binds `main_root = git_helper.repo_root()` (`session.py:79`); `dispatch.py:310` is
  the same; there is no `--repo`, no manifest, no workload parameter, and multi-project is still an
  open MAP question (`MAP.md:349-351`). Every "the target repo" claim in this document is conditional
  on a binding that has never been built, and rule 13 makes the one repo this install reaches the one
  whose machinery it may not touch (`data_types.py:376-378`). → Q0.

Then:

- **Fixture / seed data is unsolved and sits upstream of any recording.** Any headless run of a real
  app needs a seeded database first, and rule 6 forbids mock data (`turbodiff-study.md:326-329`,
  `MAP.md:49`). It generalises past `apps/ui`: *"prove the backend feature reached the screen"*
  requires the app to *have* data, which under rule 6 cannot be faked. Named in §2 rows 2 and 3 as
  those rows' real blocker.
- **`gate.ts:151` is where fail-closed becomes invisible.** The success-only session filter means a
  run that failed for infrastructure reasons produces no Gate card, no compare URL and no explanation
  — and its code is never committed (§Q8). This is live today on the laptop via skylos-`incomplete`.
  Rule 11 forbids exactly this silence (`MAP.md:59-61`).
- **`gates.tests_pass` is not fit to carry a verification row.** Two states, not three; no `timeout`
  passed to `subprocess.run`; and its violation is fed back into the same pi session as a defect for
  the agent to repair (`gates.py:109-122`, `agents.py:200-209`). The draft recommended it for §2 row
  2; that recommendation is struck. Before anything new hangs off it, it needs a timeout and a third
  state.
- **The gate→enforce ordering can destroy the evidence a gate just certified.** Gates run at
  `agents.py:185-210`, `permissions.enforce` at `:216`; for an agent with `writes: []` a non-gitignored
  capture file is deleted by `_roll_back` (`permissions.py:151-173`) and the phase dies, leaving a
  green `gate_results` row behind (§4.3). Mitigable by config (land artifacts under `data_dir`), but
  the ordering itself is a finding.
- **The evidence path is not wired end to end even for the checks that exist.** `output_artifact` is
  stamped by `quality._run` (`quality.py:206`) and dropped by `fetch_quality_checks`
  (`collect_runs.py:230-237`); `fetch_envelope_notes` carries a four-key allowlist and never carries
  `artifacts` (`collect_runs.py:291`); both Gate readers key on a phase name no dispatched run has
  (§4.4(c)). Until those are fixed, a code-shaped verify shows the operator a status and no path.
- **Prompt injection is an unaddressed surface in the agent shape.** turbodiff embeds
  `UNTRUSTED_CONTENT_RULES` in every agent prompt and the study recorded it as *"the same problem the
  factory has"* (`turbodiff-study.md:251-254`). Driving a browser and feeding rendered page content
  into a pi agent, on a host with no sandbox (`MAP.md:250`) and a `bash` tool bounded only by a roster
  allowlist, is a new attack surface this factory has no answer for. The code shape has none of it.
- **No artifact-hosting surface, verified directly rather than inferred.** `gate.ts` serves JSON
  computed from `sssf.db` + read-only git; the only file it reads from the session runtime is
  `context_handoff/changes.diff`, server-side, as text (`gate.ts:54-74`). There is no object store,
  no signed URL, no binary route. A captured PNG or MP4 has nowhere to be *shown* — only named and
  path-referenced.
- **No port allocator, no registry for agent-launched app processes, no sandbox.** All three are
  prerequisites for running a dev server under parallel worktrees, independent of verification.
- **No Chrome/Puppeteer/ffmpeg in the installer on any target.** The realistic home is the server
  target, which has not shipped.
- **The three-state classifier is proven exactly once.** Porting it to launch/capture means
  collecting a second signature list from real failure text on this toolchain — not assuming Skylos's
  uv/MSVC strings transfer.
- **No real queue card has ever exercised a new header key.** `queue/` and `done/` hold only
  `TEMPLATE.md`. The "a new header key costs zero parser code" claim is verified against three
  parsers' *source*, not against a card that ran end to end.
- **The FEAT `verification:` field is a proposal, not an existing mechanism.** `ledger-schema.md` and
  `validate_inventory.py` have no verification concept today.
- **No envelope type exists for an agent-driven capture run.** `VerifyOutput`
  (`data_types.py:265-276`) is explicitly *"a deterministic result, shaped as an envelope"* — the
  `quality` code path's adapter, not an agent's free-form capture report. A new type would be needed
  only in the agent shape, which is not decided here.
- **Withdrawn claim.** The draft stated *"no `triage*` skill file was found in `~/.claude/skills`"*
  and marked the upstream seam unknown. **That was false.** `~/.claude/skills/triage/` exists with
  `SKILL.md` and `AGENT-BRIEF.md`; `queue/TEMPLATE.md`'s `## Agent Brief` block is that template
  field-for-field and its own comment says so; `queue-publish/SKILL.md:19` names `/triage` output as
  its input; and `/triage` step 3 already runs a verification of its own. §3.5 replaces the claim, and
  the least-change recommendation was re-pointed there from `to-tickets`.

**Two sharpenings, recorded because the adversarial pass was right in substance and slightly
overstated in mechanism:**

- The gate/enforce hole is **conditional on gitignore status**: `_snapshot_tree` uses
  `--exclude-standard` (`permissions.py:51-68`), so a gitignored artifact is never rolled back — and
  never recorded as touched either. The outcome is also not a green run with no video but a
  **destroyed artifact plus a stale-green gate row inside a run that hard-fails and then vanishes
  from Gate 2** — turbodiff's silence reproduced through Q8's door, not through a fake pass.
- "No workload-repo binding" is precisely *"one install, one repo"*, not *"no `--repo` flag"*: the
  factory installs **into** a codebase, so the open question is the manifest/commands binding of Q3,
  not a CLI argument.

- **Nothing here was run.** Every claim is a claim about code that was read. In particular: no
  screenshot was captured, no app was launched by any factory phase, and — exactly as the turbodiff
  study said of itself (`turbodiff-study.md:393-395`) — no video was watched.
