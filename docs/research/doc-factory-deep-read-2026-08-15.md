# documentation-factory — deep read, 2026-08-15

**What this is.** A full, line-cited map of `C:/Users/Mubarak/.claude/skills/documentation-factory/` as it
exists today — every stage file, every reference file, every script's CLI, the feature-inventory
schema, and the `--next`/`--order`/`--waves`/`--handoff` mechanics. Read in full, nothing skimmed:
`SKILL.md`, all 9 files in `stages/`, all 5 files in `references/` plus the 5 skeletons, all 10
scripts in `scripts/` (including `validate_inventory.py` end to end). No edits were made to the
skill; this is a findings document only, for a later enhancement pass to work from knowledge instead
of assumption.

**Companion quarry.** `buildermethods/design-os` (GitHub, fetched read-only via `gh api` — its README
and `docs/{requirements,product-planning,design-section,export,codebase-implementation}.md`) — the
operator's second target, to check what it structures that doc-factory does not: the backend↔UI
layer line, and how it defers stack decisions. `nexu-io/open-design`'s repo description was checked
for one line of confirmation only (Open Design packets = real HTML/CSS + a design handoff file +
manifest); it was not deep-read, since the task's ingestion targets were already specified.

**Context.** `MAP.md`'s two-box model (`MAP.md:16-84`) places doc-factory as the laptop-side first
stage of "the supply line goes in-house" (`MAP.md:76-84`): doc-factory → `/to-kanban` → the server
factory. `MAP.md:369-373` (still on file, written before this read) claims documentation-factory "was
never edited" and lists five enhancements as "agreed but unbuilt." **That claim is stale** — see §2.4.

---

## 1. The skill's true shape

### 1.1 The front door

`SKILL.md:18-36`. Invoked bare, the skill asks exactly one question — "What are you trying to do?" —
with five answers (a)–(e) mapped to modes and entry stages in a table at `SKILL.md:40-46`:

| Answer | Mode | Enters at | First move |
|---|---|---|---|
| (a) design-only, no code | `transcripts` | Stage 1 | `init_workspace.py init --mode transcripts` |
| (b) code exists, thin docs | `codebase` | Stage 1 | `init_workspace.py init --mode codebase` |
| (c) docs exist, no/drifted code | `enhance` | Stage 1, then batch | `init_workspace.py init --mode enhance` |
| (d) small feature, KB exists | `change` | Stage 9 | `blast_radius.py COMP-<NAME>` |
| (e) big feature, KB exists | `change` after upstream planning | planning → Stage 9 | — |

Two things are collected once, before Stage 1 (`SKILL.md:33-37`): rider files (`_docwork/riders/`)
and the project root. If the operator's answer matches none of the five, the rule is "ask **one**
clarifying question — never guess a mode silently, and never start the pipeline to find out"
(`SKILL.md:29`).

**The batch path** (front-door answer (c), `SKILL.md:48-59`) is the mechanism for large drifted
corpora: Stage 1 once (every existing doc chunked as a source), Stages 2–3 once into **one** ledger,
Stage 4 once (one ratification signs both the ledger and the feature inventory), then Stages 5–8 run
**N times, one feature per pass**, `validate_inventory.py --next` naming which one. A pass that
discovers a new decision "stops and adds it through the change-mode protocol — passes never re-open
the ledger on their own" (`SKILL.md:55`).

### 1.2 Operating modes

`SKILL.md:87-98`: `transcripts` (chat exports), `codebase` (repo + git log), `enhance` (existing
docs, any quality), `change` (KB exists, skip straight to `stages/09-change-mode.md`). "Mode changes
only intake (Stage 1) and the gap-report baseline — everything downstream is identical"
(`SKILL.md:89`).

### 1.3 The pipeline — 9 stages

`SKILL.md:104-114`:

| # | Stage | Reads | Output | Exit gate |
|---|---|---|---|---|
| 1 | Intake | `stages/01-intake.md` | `_docwork/manifest.yaml`, `_docwork/chunks/` | `init_workspace.py check` |
| 2 | Harvest | `stages/02-harvest.md` | `_docwork/extractions.yaml` | `coverage_report.py` (review, always exits 0) |
| 3 | Ledger | `stages/03-ledger.md` | `_docwork/ledger.yaml`, `_docwork/gaps.yaml` | `validate_ledger.py` |
| 4 | Ratify | `stages/04-ratify.md` | human signature, `_docwork/feature_inventory.yaml` | `validate_inventory.py` + signature in `stage_state.yaml` |
| 5 | Contracts | `stages/05-contracts.md` | `docs/registry/`, `docs/architecture/dependencies.yaml`, schemas | `validate_registry.py` |
| 6 | Drafting | `stages/06-drafting.md` | `docs/` tree | `check_citations.py` + `lint_docs.py` |
| 7 | Review | `stages/07-review.md` | review reports, fixed docs | `lint_docs.py` clean |
| 8 | Assembly | `stages/08-assembly.md` | index, AGENTS.md, gap report, scenarios, changelog | `lint_docs.py --strict` |
| 9 | Change mode | `stages/09-change-mode.md` | updated docs + ADR + changelog | `lint_docs.py --strict` |

Per-stage detail, everything read and reads/emits:

- **Stage 1 (Intake)** — `stages/01-intake.md:1-36`. Nothing is interpreted here; sources are
  inventoried mechanically into `manifest.yaml` with `id`/`path`/`kind`/`status`
  (`01-intake.md:13-19`). `kind` vocabulary is exactly `transcript | code | doc | rider | data`
  (also enforced by `init_workspace.py:49`, see §1.8). Riders are chunked and ledgered like any
  source but pre-ratified. Large sources are chunked via `chunk_transcript.py` into stable IDs
  (`SRC-01-C0042`), *even short ones* — "citation stability matters more than convenience"
  (`01-intake.md:24`). Lenses are selected here from `references/lens-catalog.md`
  (`01-intake.md:26`) and scope is recorded in-or-out (`01-intake.md:28`); out-of-scope topics are
  still harvested ("cheap insurance") but excluded from drafting.

- **Stage 2 (Harvest)** — `stages/02-harvest.md:1-36`. Extraction, not interpretation: seven types
  — `decision | correction | death | constraint | value | open | context`
  (`02-harvest.md:13-19`). Corrections "outrank surrounding text and are the highest-value
  extractions in any transcript" (`02-harvest.md:14`). Chunks are processed in source order because
  synthesizing mid-read lets a later reversal corrupt an earlier synthesis (`02-harvest.md:7`).
  `coverage_report.py` (§1.8) is a **review gate, not a hard gate** — it always exits 0
  (`coverage_report.py:155-156`); silence in a chunk can be legitimately annotated rather than
  forced into junk extractions (`02-harvest.md:36`).

- **Stage 3 (Ledger)** — `stages/03-ledger.md:1-27`. Seven merge rules
  (`03-ledger.md:5-13`): group by topic; reversals become supersession chains (never delete
  history); corrections outrank; deaths get `status: dead` with a verbatim `reason`; rider entries
  enter pre-ratified; **unresolved conflicts become `status: conflict` entries carrying both
  readings — "Do not pick a winner yourself"** (`03-ledger.md:12`); unknowns become
  `gaps.yaml` entries. `validate_ledger.py` (§1.8) is the gate.

- **Stage 4 (Ratify)** — `stages/04-ratify.md:1-76`. Builds the ratification packet
  (`_docwork/ratification-packet.md`) in a fixed, busiest-first order: conflicts, blocking gaps,
  deaths, high-impact/law-tagged decisions, the feature inventory table, then the full ledger
  (`04-ratify.md:7-16`). **The feature inventory is built and presented in the same packet**, so the
  human ratifies the slicing at the same moment as the decisions (`04-ratify.md:18-20`) — this is
  the exact mechanism behind §1.9 below. Provisional mode (`04-ratify.md:63-67`): the inventory is
  built the same way with `ratified: null`, the wait is skipped, and every downstream artifact is
  stamped `status: provisional` until Stage 8 flips it — `lint_docs.py --strict` refuses to declare
  the project done while any stamp remains (`04-ratify.md:67`).

- **Stage 5 (Contracts)** — `stages/05-contracts.md:1-30`. Four artifacts before any prose:
  variables/formulas registry (`docs/registry/variables.yaml`), dependency manifest
  (`docs/architecture/dependencies.yaml`), interface/event contracts (`docs/contracts/`), and a
  glossary seed. "Prose disagrees silently; contracts disagree loudly" (`05-contracts.md:3`). When
  this stage runs as one batch pass, filling in `components:` on the feature inventory triggers a
  **new class of check** — "contracts before consumers" — that only becomes live once
  `dependencies.yaml` exists (`05-contracts.md:21`; mechanized in `validate_inventory.py`, §1.9).

- **Stage 6 (Drafting)** — `stages/06-drafting.md:1-45`. One hard boundary: never invent
  (`06-drafting.md:3`). Draft order follows build order: constitution → architecture overview →
  component specs → ADRs → lens docs → knowledge docs (`06-drafting.md:9-16`). The **enhancement
  mechanism**: a drafter that sees a genuine improvement the sources never discussed writes it
  inline wrapped in `<!-- ENHANCEMENT ENH-0007: ... -->` and registers it in
  `_docwork/enhancements.yaml` with `status: pending` for Stage 8 ratification
  (`06-drafting.md:22-32`) — "This keeps the senior-team instinct *and* the no-invention guarantee."
  If the drafter can fully specify the addition it's an ENHANCEMENT; if it can't, it's a GAP
  (`06-drafting.md:32`). Component specs "shard cleanly across subagents"; constitution/overview/
  glossary stay single-authored for voice (`06-drafting.md:34-36`).

- **Stage 7 (Review)** — `stages/07-review.md:1-40`. Two role-bounded passes, never the drafter:
  a **consistency reviewer** (may read `docs/`, ledger, gaps, registry, contracts — may NOT read raw
  sources; checks citation content drift, cross-doc disagreement, dead-list enforcement)
  (`07-review.md:5-16`), and an **adversarial red team** (a competent engineer who has never seen
  the project, may read only `docs/`, tries to plan a real change and fails loudly where docs run
  out) (`07-review.md:18-29`). Every forced assumption becomes either a doc fix or a new GAP.

- **Stage 8 (Assembly)** — `stages/08-assembly.md:1-27`. Produces `docs/index.md`,
  `docs/AGENTS.md` (agent entry point — see §1.10), the golden scenario bank
  (`docs/scenarios/*.md`, Given/When/Then), the gap report (open / deferred / out-of-scope, plus a
  baseline-comparison section if a baseline source existed — "insurance against silent loss during
  re-documentation," `08-assembly.md:13`), `docs/changelog.md`, and the enhancement ratification
  (Stage 4's second human touch, `08-assembly.md:17`). The final gate,
  `lint_docs.py --root <root> --strict`, additionally fails on any `provisional` status, any
  unratified ENHANCEMENT, any unresolved blocking GAP marker, missing index/AGENTS.md/gap-report,
  any doc missing provenance fields, and any doc already past its `stale_after` budget
  (`08-assembly.md:27`).

- **Stage 9 (Change mode)** — `stages/09-change-mode.md:1-43`. The maintainability protocol for
  a KB that already exists: scope the change → `blast_radius.py COMP-<NAME>` → **architecture
  preflight** (§1.5) → ledger first (new DEC / supersessions / deaths) → write the ADR → update the
  contracts layer (registry, `dependencies.yaml`, **and the feature inventory in the same edit** —
  "An inventory that still describes the pre-change plan sends the next pass at work that no longer
  exists," `09-change-mode.md:27`) → update every doc in the blast radius → changelog entry →
  mini-review (Stage 7 pass 1, scoped). Gate: `check_citations.py` + `lint_docs.py --strict`.

### 1.4 The two human gates

`SKILL.md:118-125`. Exactly two, by design, for a solo operator orchestrating agents: **Stage 4**
(sign the ledger + feature inventory before prose exists — "the only place re-scoping is still
free") and **Stage 8** (ratify the ENHANCEMENT batch). Default is strict (stop at Stage 4);
`--provisional` or "run through" continues but stamps everything provisional until signed.

### 1.5 Architecture preflight — prove reuse-or-new

`SKILL.md:127-136`. Before building anything against a doc-factory-produced KB, an agent must name
the existing components it considered and state why each cannot carry the work — "'I did not find
one' is not a proof; the inventory is a file, and it is either cited or it was not read"
(`SKILL.md:129`). Defined once, executed in two places the skill itself writes:
`references/skeletons/agents-md.md:36-44` (every produced KB ships it in its own entry point) and
`stages/09-change-mode.md:15-21` (step 3 of the change protocol). The verdict — `reuse COMP-X` /
`new COMP-Y`, with reason — is recorded in the ADR; "An unrecorded verdict means the preflight did
not happen" (`SKILL.md:136`, repeated verbatim at `09-change-mode.md:21` and
`agents-md.md:44`).

### 1.6 Rider files

`SKILL.md:78-85`. The **only** channel for project specifics: scope rulings, dead lists, laws,
glossary seeds, coding standards, naming conventions, non-negotiables — live in `_docwork/riders/`,
entered in `manifest.yaml` as `kind: rider`. They enter the ledger pre-ratified
(`authority: rider`), need no extraction citation, and win over a contradicting source (the
contradiction itself gets ledgered, not silently resolved). "Never edit this skill to hold a
project's facts... A rule stored in a rider travels with the project it belongs to"
(`SKILL.md:85`).

### 1.7 Reference files — role of each

- `references/doc-taxonomy.md` — the output tree (`docs/index.md`, `AGENTS.md`, `constitution.md`,
  `glossary.md`, `changelog.md`, `gap-report.md`, `architecture/`, `registry/`, `contracts/`,
  `components/`, `decisions/`, `scenarios/`, `knowledge/`, `lenses/` — `doc-taxonomy.md:7-26`) and
  the reference-vs-knowledge split (`doc-taxonomy.md:29-35`): reference docs state *what is*
  (terse, no narrative — constitution, specs, registry, contracts); knowledge docs explain *why*
  (ADRs, case law, narrative allowed but still citation-bound).
- `references/ledger-schema.md` — exact YAML schemas for every machine-validated artifact (§1.9
  covers the feature inventory in full; the rest are cited inline in §1.1–1.6 above).
- `references/lens-catalog.md` — 10 lenses total: `core` (always active — constitution, architecture,
  components, contracts, registry, ADRs, glossary, scenarios, gap report, AGENTS.md,
  `lens-catalog.md:7-9`), `ops`, `observability`, `mlops`, `ui`, `performance`, `bugs`, `testing`,
  `security`, `data` (`lens-catalog.md:11-66`, detailed in §2.1). Selected at Stage 1; each active
  lens adds required docs to Stage 6 and required review questions to Stage 7
  (`lens-catalog.md:3`).
- `references/style-rules.md` — the mandatory frontmatter block (`style-rules.md:7-21`), the "OKF
  fields" (`sources`/`generated`/`verified`/`stale_after`/`status`, `style-rules.md:25-37` — see
  §2.3), 12 numbered writing rules (`style-rules.md:41-52`), and the anti-patterns lint hunts for
  (`style-rules.md:54-61`).
- `references/diagram-conventions.md` — C4-as-Mermaid standard. `overview.md` needs Level 1
  (system context) + Level 2 (container); component specs need Level 3 *only* when internal
  structure warrants it (else a `<!-- no-diagram: reason -->` marker); state diagrams are mandatory
  wherever a spec describes a state machine, and "the diagram and the enum in the contract must
  match exactly" (`diagram-conventions.md:10`).
- `references/skeletons/` — copy-paste templates for the five structure-critical types: `adr.md`,
  `agents-md.md`, `component-spec.md`, `constitution.md`, `scenario.md`. Simpler types (index,
  glossary, changelog, gap-report) have no skeleton — they follow `doc-taxonomy.md` conventions plus
  mandatory frontmatter (`SKILL.md:153`).

### 1.8 Scripts — full CLI surface

All stdlib-plus-PyYAML, run from the project root, exit 0 pass / non-zero fail (`SKILL.md:157`).

- **`init_workspace.py`** — `init --project <name> --mode {transcripts|codebase|enhance} --root .
  [--provisional]` creates `_docwork/manifest.yaml` + `_docwork/stage_state.yaml`, refusing to
  overwrite if either exists (`init_workspace.py:180-182`). `check --root .` validates manifest
  schema (required fields `project/mode/created/lenses/scope/sources`; `lenses` must include
  `core`; each source's `kind` ∈ `{transcript, code, doc, rider, data}`, `role` ∈
  `{primary, baseline}`, `status` ∈ `{pending, chunked, harvested}`, and — for
  `transcript/code/doc` kinds — that the path exists), plus that every non-pending transcript
  source has a chunk index (`init_workspace.py:39-167`).
- **`chunk_transcript.py`** — `<source-file> --source-id SRC-01 --out _docwork/chunks
  [--max-lines 120] [--root .]`. Splits `.txt`/`.md` by line count with break-point search near
  blank lines (`find_break_point`, `chunk_transcript.py:54-67`); `.jsonl` is parsed per-line, best-
  effort text extracted from `text`/`content`/`message`/`role` fields with a depth-limited
  recursive fallback (`chunk_transcript.py:16-51`). Idempotent — overwrites prior output for the
  same source ID. Writes `SRC-01-C0001.txt` … plus `SRC-01-index.yaml`.
- **`coverage_report.py`** — `--root .`. Reads `extractions.yaml` + chunk indexes, computes
  per-source and total coverage %, writes `_docwork/coverage-report.md`, honors a
  `_docwork/coverage-exceptions.yaml` allow-list for legitimately-empty chunks
  (`coverage_report.py:48-56`). **Always exits 0** — it is a review gate, not a hard gate
  (`coverage_report.py:155-156`).
- **`validate_ledger.py`** — `--root .`. Validates `extractions.yaml` (ID format `EXT-NNNN`,
  `type` ∈ the 7-value vocabulary, `authority` ∈ `{source, rider}`), `gaps.yaml` (`GAP-NNNN`,
  `status` ∈ `{open, answered, deferred, out-of-scope}`), and `ledger.yaml` (`DEC-NNNN`, `status` ∈
  the 7-value vocabulary, `dead` requires non-empty `reason`, `conflict` requires non-empty
  `conflict`, `superseded` requires `superseded_by`, every entry needs ≥1 resolving source or
  `authority: rider`, supersession chains checked for cycles via DFS
  (`validate_ledger.py:188-208`) and dangling references).
- **`validate_registry.py`** — `--root . [--strict]`. Validates `docs/registry/variables.yaml`
  (unique `name`, unique non-null `symbol`, `decision` resolves in ledger, `value`/`formula`
  mutually exclusive, `value: null` requires `gap`) and `docs/architecture/dependencies.yaml`
  (`COMP-[A-Z0-9-]+` ID format, unique IDs, no self-edges, `depends_on` resolves, `spec` path
  existence — warning normally, error under `--strict`). **Note**: it never checks that a
  component's `kind` value is one of the six the schema documents (`service | library | store | ui
  | external | process`, `ledger-schema.md:169`) — `validate_dependencies()`
  (`validate_registry.py:106-172`) has no such check.
- **`check_citations.py`** — `--root .`. Walks `docs/**/*.md`, regex-extracts every
  `DEC-####`/`GAP-####`/`ENH-####`/`EXT-####`/`SCN-####`/`ADR-####`/`COMP-[A-Z0-9-]+` reference
  (`check_citations.py:52-60`), errors on any that doesn't resolve (COMP is warn-only), errors when
  a `component-spec`/`constitution`/`contract`-typed doc cites zero DEC ids, and warns when a
  `status: dead` decision is cited without "dead/killed/rejected/superseded" nearby
  (`check_citations.py:69-96`).
- **`lint_docs.py`** — `--root . [--strict]`. Frontmatter presence/vocabulary
  (`lint_docs.py:59-90`); provenance (`verified` or deprecated `last_verified`, ISO dates,
  `sources` as a list, `stale_after` as duration-or-date; staleness = `verified + stale_after`,
  WARN normally / ERROR under `--strict`, `lint_docs.py:107-183`); style anti-patterns scoped to
  reference-typed docs only (`lint_docs.py:186-215`); TODO/TBD/FIXME without a GAP id
  (`lint_docs.py:218-230`); component-spec must have a mermaid block or a `no-diagram` comment
  (`lint_docs.py:233-252`); strict-only checks — `provisional` status forbidden, no ENHANCEMENT
  markers left, required docs (`index.md`/`AGENTS.md`/`gap-report.md`) present, no pending
  enhancements, no inline reference to a `blocking: true` gap
  (`lint_docs.py:255-340`).
- **`blast_radius.py`** — `<COMP-NAME> --root .`. Builds the reverse dependency graph from
  `dependencies.yaml`, BFS's transitive dependents (`blast_radius.py:71-89`), prints an ASCII tree,
  then scans `docs/**/*.md` frontmatter for `depends_on` entries touching the component or anything
  in its blast radius, plus the component's own spec (`blast_radius.py:148-191`).
- **`selftest.py`** — no CLI args; runs all 29 fixture tests against a hardcoded
  `/tmp/docfactory-selftest` (`selftest.py:19`), invoking every other script with a bare `python3`
  interpreter (e.g. `selftest.py:493`). This is the only script in the skill hardcoded to a
  POSIX temp path and the `python3` binary name rather than accepting `--root`/using `python` —
  worth flagging for the operator's Windows/PowerShell environment (see §4, item 8).

### 1.9 The feature inventory — schema and mechanics, exact

Schema: `references/ledger-schema.md:101-131`. Top-level: `generated` (ISO date built),
`ratified` (ISO date signed, `null` while provisional), `features: [...]`. Each feature:

```yaml
- id: FEAT-0001
  name: "Daily sweep"
  scope: >
    One paragraph — in, out, and what "done" means. A spec pass acts on this
    instead of re-reading the whole ledger.
  decisions: [DEC-0001, DEC-0012]   # >=1, must resolve in ledger.yaml, never dead
  components: [COMP-TREASURY]       # optional until dependencies.yaml exists
  blocked_by:
    - id: FEAT-0004
      reason: "consumes the settlement contract FEAT-0004 lands"
  size: one-pass                    # one-pass | multi-pass
  status: planned                   # planned | in-progress | shipped
  notes: ""
```

Built at Stage 4 by clustering ratified ledger entries into shippable units, scoping each in a
paragraph, drawing blocking edges from the architecture — "contracts before consumers... the
operator is never the one to point out that the UI came before its endpoint"
(`stages/04-ratify.md:26-28`) — sizing (`one-pass`/`multi-pass`, split multi-pass features now if
possible), and leaving `status: planned` for everything unbuilt (`04-ratify.md:22-34`).

`validate_inventory.py` (562 lines, read in full) enforces: unique `FEAT-NNNN` ids; `name`/`scope`/
`size` present (scope <40 chars *warns* — "that is a title, not a scope,"
`validate_inventory.py:22,269-273`); `size` ∈ `{one-pass, multi-pass}`, `status` ∈
`{planned, in-progress, shipped}`; ≥1 `decisions` entry, each resolving in the ledger, **erroring**
if it traces a `dead` decision (a resurrection) and **warning** if it traces a `superseded` one
(`validate_inventory.py:283-312`); `components` resolving against `dependencies.yaml` once that
file exists; `blocked_by` accepting either a bare string or `{id, reason}`
(`normalize_blockers`, `validate_inventory.py:105-122`), erroring on self-edges, and — normally
warning / erroring under `--strict` — on any blocking edge with no `reason`
(`validate_inventory.py:346-353`, "the spec pass carries the reason, not the id"). A DFS
(`find_cycle`, `validate_inventory.py:74-102`) catches blocking cycles. **Contracts-before-consumers**
(`contract_order_findings`, `validate_inventory.py:138-170`) is silent until `components` are filled
*and* `dependencies.yaml` exists (Stage 5+); once both exist, a feature touching a component that
`depends_on` another feature's component must list that feature as a blocker, or the finding fires
(warn normally, error under `--strict`). **Coverage**: every ratified, component-scoped, non-law
decision must belong to some feature, or the inventory is warned (errored under `--strict`) as
incomplete (`buildable_decisions`, `validate_inventory.py:59-71`, `373-384`).

Ordering is derived, never hand-written (`ledger-schema.md:126`): Kahn's-algorithm topological sort,
blockers first, ties broken by id (`topological_order`, `validate_inventory.py:200-225`). Waves are
computed as `1 + max(blocker depths)` (`compute_waves`, `validate_inventory.py:173-179`); same-wave
features sharing a component are flagged to serialize (`wave_conflicts`,
`validate_inventory.py:182-197`).

Four CLI switches, the entire downstream handoff mechanism (`validate_inventory.py:450-459`,
demonstrated live in `stages/04-ratify.md:42-47` and `SKILL.md:66-68`):

- `--next` — prints the single feature id whose blockers are all `shipped` (or `NONE`)
  (`next_feature`, `validate_inventory.py:430-439`). This is the batch consumer's entire
  interaction: "read one line and start" (`validate_inventory.py:454-455`).
- `--order` — prints the full topological sequence with each feature's wave, size, status, name.
- `--waves` — groups the order into waves ("start now" / "after wave N-1 ships"), plus any
  same-wave component conflicts.
- `--handoff FEAT-NNNN` — prints one feature's scope, its blockers with their reasons ("must
  already exist — say so in the spec"), what it delivers for (its dependents, with their reasons),
  its wave-mates still unshipped ("may run alongside"), its `components`, and its `decisions`
  (`print_handoff`, `validate_inventory.py:389-427`).

The handoff's stated purpose (`SKILL.md:70-76`): every spec written downstream states, in its own
prose, three facts pulled from this — what must already exist, what this feature delivers that
others wait on, what may run alongside it — "the operator reads a correctly ordered board without
ever re-stating the order himself."

### 1.10 AGENTS.md skeleton — what a produced KB ships as its entry point

`references/skeletons/agents-md.md:1-54`. Frontmatter typed `agents`, `stale_after: 90d` (shortest
budget of any skeleton — this file is meant to be re-checked often). Contents: three-sentence system
summary; reading order (constitution → overview → the component being touched → glossary);
distilled hard rules (with an explicit instruction to check `gap-report.md` and `decisions/` before
proposing "new" ideas, since a `status: dead` entry might already cover it); "before changing
anything" (run `blast_radius.py`, never hardcode a registry value, never invent a contract field,
every change gets an ADR + changelog entry); the full architecture-preflight text reproduced
verbatim (§1.5); a "where answers live" lookup table. `doc-taxonomy.md:44` notes AGENTS.md is "the
only doc allowed to duplicate content... because it's the one file guaranteed to be loaded."

---

## 2. What it already handles — verifying the operator's claim

The operator's claim was that the skill "already handles more than any one session has seen." Point
by point, against the files:

### 2.1 Scenario coverage, architecture docs, API contracts, C4 diagrams, variables registry, golden
scenarios, gap reports — all present and load-bearing, not aspirational

- **Golden scenarios**: `docs/scenarios/*.md`, Given/When/Then, skeleton at
  `references/skeletons/scenario.md`, built at Stage 8 (`stages/08-assembly.md:11`) "from ledger
  entries with concrete worked examples... Prefer scenarios with real numbers over abstract ones."
  A dedicated "Worked numbers" section doubles as a test fixture (`scenario.md:31-33`).
- **Architecture docs**: `docs/architecture/overview.md` (C4 Level 1 + Level 2, mandatory,
  lint-checked per `diagram-conventions.md:5-10`) and `docs/architecture/dependencies.yaml` (the
  machine-readable component graph powering blast-radius and C4).
- **API/interface contracts**: Stage 5 artifact 3 (`stages/05-contracts.md:13`) — typed schemas per
  boundary in `docs/contracts/`, field names/types/enums/units/nullability spelled out, unknown
  fields marked `# GAP-00NN` rather than invented.
- **C4 diagrams**: `references/diagram-conventions.md` is a dedicated 54-line reference — Level
  1/2/3 Mermaid patterns, state diagrams mandatory for state-machine specs (with the rule that "the
  diagram and the enum in the contract must match exactly," line 10), sequence diagrams for ordered
  multi-party interactions.
- **Variables registry**: `docs/registry/variables.yaml`, schema at `ledger-schema.md:144-160`,
  validated by `validate_registry.py`. "The only place values live... lint hunts for suspicious
  literals in reference docs" (`doc-taxonomy.md:43`).
- **Gap reports**: `docs/gap-report.md`, three bins (open / deferred / out-of-scope), plus a
  baseline-comparison section when a baseline source exists — every baseline topic classified as
  redesigned / killed / never-discussed (`stages/08-assembly.md:13`), explicitly framed as
  "insurance against silent loss during re-documentation."

### 2.2 Modes — all four implemented, not just named

`transcripts`/`codebase`/`enhance`/`change` each have a distinct Stage 1 intake instruction
(`stages/01-intake.md:16-17`) and `init_workspace.py` enforces the three-value enum for the first
three (`change` skips intake entirely per `SKILL.md:98`).

### 2.3 The OKF provenance frontmatter — fully built, not a stub

`references/style-rules.md:25-37` labels the block explicitly "the OKF fields": `sources`,
`generated`, `verified`, `stale_after`, `status`. `lint_docs.py:107-183` (`check_provenance`)
enforces ISO-date parsing, duration parsing (`30d|12w|6m|1y` or explicit date,
`DURATION_DAYS = {d:1, w:7, m:30, y:365}`, `lint_docs.py:20`), computes expiry as
`verified + stale_after`, warns normally and **errors under `--strict`** past expiry, and — under
`--strict` — requires `sources`/`generated`/`stale_after` present with `sources` non-empty. The
`verified`/`last_verified` alias handling (`style-rules.md:37`, `lint_docs.py:121-127`) shows this
was built with an eye to migrating pre-OKF knowledge bases forward, not just greenfield ones.

### 2.4 The five "agreed but unbuilt" items — status check against `MAP.md:369-373`

`MAP.md` still states "documentation-factory was never edited" and lists five enhancements as
agreed-but-unbuilt: a front door, architecture-preflight, OKF provenance frontmatter, the feature
inventory, and unspecified "lens/skeleton additions." **All five now exist in the skill as read:**

| Item | Status | Where |
|---|---|---|
| Front door | **Built** | `SKILL.md:18-36` (§1.1 above) |
| Architecture preflight | **Built** | `SKILL.md:127-136`, `stages/09-change-mode.md:15-21`, `references/skeletons/agents-md.md:36-44` (§1.5) |
| OKF provenance frontmatter | **Built** | `references/style-rules.md:25-37`, `references/ledger-schema.md:176-200`, enforced in `lint_docs.py` (§2.3) |
| Feature inventory | **Built** | `stages/04-ratify.md`, `references/ledger-schema.md:101-131`, `scripts/validate_inventory.py` (562 lines) (§1.9) |
| Lens/skeleton additions | **Substantially built** | 10 lenses in `references/lens-catalog.md` (§1.7), 5 skeletons in `references/skeletons/` — MAP.md never specified which *additional* lenses/skeletons were agreed beyond what exists, so this line item can't be checked against a named target, only against volume, which is already broad |

MAP.md's own text elsewhere is internally inconsistent with its "never edited" line: the open-
questions section separately records "**RESOLVED — 2026-08-13**, ... documentation-factory now
emits the feature inventory at Stage 4" (`MAP.md:374-379`). This deep read confirms the resolution
is real and complete — the "never edited" sentence at `MAP.md:369` is the stale half of the file,
not the resolution note. **Practical implication for the enhancement pass**: do not re-build any of
these five; the gap list in §3 is genuinely what's left, not a re-statement of what MAP.md says is
missing.

### 2.5 Change mode / front-door interplay

Change mode (`stages/09-change-mode.md`) is reached directly from the front door's answers (d)/(e)
(`SKILL.md:45-46`) without re-running Stages 1–8 — "The knowledge base is **read, not rebuilt**."
This is a real behavioral claim, not just a table entry: the change-mode protocol's own steps
(§1.3, Stage 9) never touch `_docwork/manifest.yaml`, `extractions.yaml`, or re-run Stage 1–3
scripts; it only reads `docs/` and `_docwork/ledger.yaml`/`feature_inventory.yaml`, mutating the
latter two in place.

---

## 3. Honest gaps vs the agreed enhancement list

Per `MAP.md:76-84`, the agreed enhancement pass for doc-factory is: senior-architect framing;
ingesting transcripts + artifacts + design packets (Open Design/BMAD `design.md` + screenshots);
SDLC end-to-end capture (stack, DB/schemas, custom libraries, API contracts, CI/CD); HITL grilling
with recommendations when ambiguous; orchestrator + subagents. Checked one at a time against the
file contents above:

### 3.1 Senior-architect framing — partially present, narrower than it sounds

The top-level framing already exists: "Produce documentation the way a senior software engineering
team would" (`SKILL.md:6`), and the ENHANCEMENT mechanism (`stages/06-drafting.md:22-32`) already
lets a drafter propose things "a senior team would specify" that sources never discussed — wrapped,
tracked, and ratified at Stage 8, never silently added. What's **not** present: nothing in the
pipeline asks an agent to originate or recommend *architecture or stack* the way a senior architect
would at kickoff — the skill's stance throughout is scribe-and-verify (extract what the sources say,
never invent), not propose-and-defend. The ENHANCEMENT mechanism is scoped in its own text to "doc
content" (a failure-mode row, a missing index) — nothing in `06-drafting.md` or `SKILL.md` names
architecture/stack choices as a class of enhancement a drafter may propose.

### 3.2 Ingesting transcripts + artifacts + Open Design packets — real gap

`init_workspace.py:49` defines `kind` as exactly `transcript | code | doc | rider | data` — there is
no `design`/`artifact` kind. No stage (`01-intake.md` included) mentions screenshots, `.tsx`
component files, `tokens.css`, or a design-handoff manifest as a source shape needing special
handling. `chunk_transcript.py` only handles `.txt`/`.md`/`.jsonl` — nothing in the skill chunks or
otherwise ingests a binary screenshot or a CSS file; a design packet would today have to be
force-fit into `kind: data` or `kind: code` with no stage guidance on what to extract from it.
`lens-catalog.md`'s `ui` lens (line 37) explicitly says it "mirrors what Design OS and
Impeccable-style tooling **expect**" — i.e. it shapes doc-factory's *output* to be consumable by
design-capable agents, but it is not an *ingestion* path for a pre-built design export. This matches
`MAP.md:326`'s dead-list note ("agent-os / design-os — Ideas absorbed... design → its UI/design
lens; tools not installed") — the absorption so far is output-shaping, not input-ingestion.

### 3.3 SDLC end-to-end capture — partially present, unevenly

- **API contracts**: built (Stage 5, `docs/contracts/`, §2.1).
- **DB/schemas**: partially built — the `data` lens (`lens-catalog.md:63-66`) covers "stores,
  schemas... retention, backup/restore, migration policy," but only when the lens is selected; it
  is not part of `core`, so a project that never explicitly picks the `data` lens gets no schema
  doc at all, even if it has a database.
- **Stack (languages/frameworks/build tooling)**: no capture mechanism anywhere. No lens, no
  doc-taxonomy entry, no registry field names "the stack" as a first-class artifact. It could today
  only surface incidentally inside a component spec's prose.
- **Custom libraries**: same — no dedicated inventory; would have to be inferred from component
  specs one at a time, with no place that lists them together.
- **CI/CD declarations**: the `ops` lens (`lens-catalog.md:11-16`) covers `runbook.md`
  (start/stop/restart/deploy procedures) and `incident-playbook.md`, but neither is a CI/CD
  *pipeline* declaration (what gates a merge, what a pipeline stage checks, where it's defined) —
  closer to operational runbooks than to a build/release pipeline spec.
- **ML-training questions** (fresh model vs. fine-tune, does the script run on the operator's own
  infrastructure, numeric eval/promotion threshold): the `mlops` lens
  (`lens-catalog.md:25-30`) has `model-lifecycle.md` covering "data sources, training/retraining
  ritual, evaluation gates, shadow rollout, promotion criteria, rollback" — broad enough to *hold*
  these answers, but none of the three specific operator-named questions is named in the lens text,
  so an agent following the lens as written could fill `model-lifecycle.md` without ever asking
  them.

### 3.4 HITL grilling-with-recommendations when ambiguous — not present as a distinct mechanism

The current pattern is present-and-wait, not grill-and-recommend. Stage 4's ratification packet
presents conflicts, blocking gaps, and deaths for a human ruling (`stages/04-ratify.md:9-11`,
"These *require* a human ruling") but nothing drafts a recommended resolution alongside them — the
`gaps.yaml` schema (`ledger-schema.md:89-99`) has `question`/`needed_by`/`blocking`/`status`/
`answer` fields and no `recommendation` field. Stage 3's conflict rule is explicit that the agent
"Do not pick a winner yourself" (`03-ledger.md:12`) — correct for *silent* resolution, but the skill
never separately offers "state a recommendation, non-binding, for the human to accept or override,"
which is a different and weaker claim than "pick a winner." A `grilling` skill is installed
alongside doc-factory in this same Claude Code environment (per the available-skills listing) but
nothing in `SKILL.md` or any stage file references or hands off to it.

### 3.5 Layer lines (the design-os quarry) — real, specific gap, confirmed against design-os's own docs

design-os enforces a hard UI/backend split as a *process rule*, not just an output convention: while
shaping a section, "Focus on experience and interface requirements—no backend or database details"
(design-os `docs/design-section.md`); its own requirements doc states flatly "Design OS only
handles the frontend design layer" and that the backend "can be anything—Rails, Laravel, Next.js API
routes, Python, Go, whatever" (design-os `docs/requirements.md`). The seam between the two layers is
a named, exported artifact: every component is "props-based — accepts data and callbacks via props,
never import data directly" (design-os `docs/export.md`), and the export package physically
separates `design-system/` (tokens), `data-shapes/` (TypeScript contracts), `shell/` +
`sections/*/components/` (UI) from everything the backend must supply — "the backend, data layer,
routing, state management" is explicitly called out as the implementer's job, never design-os's
(design-os `docs/codebase-implementation.md`). Stack/backend decisions are deliberately deferred to
a named "Clarifying Questions" step the *implementation* agent runs, not resolved inside design-os
itself.

Doc-factory has adjacent pieces but no equivalent named layer taxonomy: `dependencies.yaml`
component `kind` is `service | library | store | ui | external | process`
(`ledger-schema.md:169`) — `ui` and `store` exist as kinds, so a UI-vs-storage distinction is
representable, but there is no `middleware`/`api` kind, no `layer:` field anywhere in the schema,
and `validate_registry.py` doesn't even check `kind` against its own enum (§1.8, noted gap). No
diagram convention exists for a layer/swimlane view (`diagram-conventions.md` only prescribes C4
levels 1–3, state, and sequence diagrams — none of which is "what's UI vs. middleware vs. backend
vs. database at a glance"). Stage 5's interface contracts are generic typed schemas, not a
"props+callbacks" shaped sub-type mirroring how design-os actually hands off a UI/backend seam.

### 3.6 Orchestrator + subagents scaling — mostly present, one explicit gap

`SKILL.md:142-144` ("Multi-agent orchestration") already covers the general case: the `_docwork/`
workspace as shared blackboard, one stage or one component's drafting dispatched per subagent,
reviewers required to be a fresh agent (never the drafter), and graceful single-agent degradation.
`stages/06-drafting.md:34-36` shards component specs across subagents explicitly. What's **not**
spelled out: the batch path's N passes (`SKILL.md:48-59`, §1.1) never states that independent
features in the same wave (`validate_inventory.py --waves`, §1.9) may be dispatched to parallel
subagents rather than run strictly one-at-a-time — the mechanism to compute which passes are safe to
parallelize already exists (`--waves`), but nothing in the batch-path prose points a reader at it
for dispatch purposes.

---

## 4. Enhancement-pass recommendations, sized

Each anchored to what exists today (§1–§3), not re-derived.

1. **New source kind for design packets — small script edit + small stage-doc addition.**
   Extend `init_workspace.py`'s `valid_kinds` (`init_workspace.py:49`) with `design` (or
   `artifact`), and add a short subsection to `stages/01-intake.md` (after the existing bullet list
   at `01-intake.md:13-19`) naming what a design-os/Open-Design-style export folder looks like as a
   source set (`components/*.tsx`, `tokens.css`, `types.ts`, `sample-data.json`, screenshots,
   a manifest) and how to inventory it — screenshots cited by filename rather than chunked, code/
   type files chunked like any `kind: code` source. No new script needed; `chunk_transcript.py`
   already handles text; binary assets just get a manifest entry with no chunk index.

2. **New reference: layer conventions — new reference file + two small schema edits.**
   Add `references/layer-conventions.md`: the backend/UI/middleware/database taxonomy, a Mermaid
   "layer view" pattern (a 4-lane swimlane) to sit alongside `diagram-conventions.md`'s C4 levels,
   and a "UI contract" shape for `docs/contracts/` mirroring design-os's props+callbacks seam
   (data-in, callbacks-out, no direct import). Pair it with: (a) adding `middleware` to the `kind`
   enum documented at `ledger-schema.md:169` and mirrored in `dependencies.yaml`'s allowed values,
   and (b) closing the existing enforcement gap noted in §1.8/§3.5 — `validate_registry.py`'s
   `validate_dependencies()` (`validate_registry.py:106-172`) doesn't check `kind` against the enum
   at all today; fixing that is a ~5-line addition regardless of whether `middleware` is added.

3. **SDLC stack/CI-CD capture — new core doc (not lens-gated) + skeleton.**
   Add `docs/architecture/stack.md` (languages, frameworks, build tooling, custom libraries) as a
   `core`-tier doc in `doc-taxonomy.md`'s tree (`doc-taxonomy.md:7-26`), since every project has a
   stack whereas `ops`/`mlops`/`data` are opt-in lenses — gating it behind lens selection risks
   silently skipping it. One new skeleton (`references/skeletons/stack.md`), one new drafting step
   in `stages/06-drafting.md`'s order-of-drafting list (`06-drafting.md:9-16`). CI/CD declarations
   can extend the existing `ops` lens's `runbook.md` (`lens-catalog.md:11-16`) with a named
   "pipeline" subsection rather than a new lens.

4. **mlops lens — explicit ML-training checklist — small edit.**
   Add three named questions to the `mlops` lens's `model-lifecycle.md` description
   (`lens-catalog.md:25-30`): fresh model vs. fine-tune of an existing one; does training/eval run
   on the operator's own infrastructure or a third-party service; the numeric promotion/eval
   threshold, registry-referenced. ~5–8 line edit to one lens entry.

5. **HITL grilling-with-recommendations — schema field + two stage-doc edits, medium.**
   Add an optional `recommendation` field to the `gaps.yaml` schema
   (`ledger-schema.md:89-99`) — a non-binding, reasoned best guess distinct from `answer` (the
   human's actual ruling). Update `stages/03-ledger.md` rule 6 (`03-ledger.md:12`) and
   `stages/04-ratify.md`'s packet-building instructions (`04-ratify.md:7-16`) to draft a
   recommendation alongside every conflict/blocking-gap presented, explicitly distinct from picking
   a winner. Optionally hand off to the already-installed `grilling` skill for the live
   conversation posture at Stage 4, referenced by name rather than re-implemented. No gate script
   change required unless the operator wants `recommendation` presence enforced, which would be a
   small addition to `validate_ledger.py`'s gap validation (`validate_ledger.py:74-109`).

6. **Batch-path parallel dispatch — small edit.**
   Add one or two lines to `SKILL.md`'s batch-path description (`SKILL.md:48-59`) pointing at
   `validate_inventory.py --waves` as the parallel-dispatch boundary for the N passes, consistent
   with the existing "Multi-agent orchestration" section (`SKILL.md:142-144`). The mechanism to
   compute safe parallelism already exists (§1.9); this is a documentation cross-reference, not new
   code.

7. **Senior-architect / stack-recommendation authority — small edit, scope widening.**
   Rather than a new mechanism, widen the existing ENHANCEMENT mechanism's stated scope
   (`stages/06-drafting.md:22-32`) to explicitly include architecture/stack recommendations as a
   valid ENHANCEMENT class (still wrapped, tracked in `enhancements.yaml`, ratified at Stage 8 —
   never silently adopted). Cross-reference this from the front-door text
   (`SKILL.md:18-36`) so the operator sees at invocation time that the skill can propose, not just
   transcribe.

8. **Two script-hygiene findings surfaced by this read, informational (small fixes, not
   enhancement-list items).** (a) `validate_registry.py` never validates a component's `kind`
   against the schema's own enum (§1.8, §3.5) — a latent gap independent of the design-os work. (b)
   `selftest.py` hardcodes `/tmp/docfactory-selftest` (`selftest.py:19`) and shells out to
   `python3` throughout, unlike every other script in the skill which is documented and invoked via
   bare `python` and an explicit `--root` (`SKILL.md:155-165`) — worth a look before relying on
   `selftest.py` on the operator's Windows/PowerShell laptop, consistent with the platform-landmine
   pattern already tracked in `MAP.md:252-289`.

---

## Sources

- `C:/Users/Mubarak/.claude/skills/documentation-factory/SKILL.md`
- `C:/Users/Mubarak/.claude/skills/documentation-factory/stages/01-intake.md` through `09-change-mode.md`
- `C:/Users/Mubarak/.claude/skills/documentation-factory/references/{doc-taxonomy,ledger-schema,lens-catalog,style-rules,diagram-conventions}.md`
- `C:/Users/Mubarak/.claude/skills/documentation-factory/references/skeletons/{adr,agents-md,component-spec,constitution,scenario}.md`
- `C:/Users/Mubarak/.claude/skills/documentation-factory/scripts/{init_workspace,chunk_transcript,coverage_report,validate_ledger,validate_inventory,validate_registry,check_citations,lint_docs,blast_radius,selftest}.py`
- `C:/Users/Mubarak/Documents/sdl-factory/MAP.md` (two-box model, dead list, open questions)
- `buildermethods/design-os` on GitHub — README, `docs/{requirements,product-planning,design-section,export,codebase-implementation}.md` (fetched via `gh api`, read-only)
- `nexu-io/open-design` on GitHub — repo description only, for the "Open Design packet" definition already supplied by the task
