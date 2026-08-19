# Workspace & Contract Schemas

Exact schemas for every machine-validated artifact. Scripts enforce these; humans and agents write to them. All YAML, UTF-8. Dates are ISO (`2026-07-07`). IDs are uppercase with zero-padded numbers.

## `_docwork/manifest.yaml`

```yaml
project: "Project Name"
mode: transcripts        # transcripts | codebase | enhance
created: 2026-07-07
lenses: [core, ops]      # from lens-catalog.md; core always present
scope:
  in: ["billing engine", "reporting"]
  out: ["mobile app", "admin UI"]
sources:
  - id: SRC-01
    path: exports/session-1.jsonl
    kind: transcript      # transcript | code | doc | design | rider | data
    role: primary         # primary | baseline
    status: chunked       # pending | chunked | harvested
  - id: SRC-02
    path: _docwork/riders/scope-rulings.md
    kind: rider           # project specifics live here, never in the skill
    role: primary
    status: pending
  - id: SRC-03
    path: design/handoff-export/
    kind: design          # a design packet; `path` is the packet root, file or folder
    role: primary
    status: pending
```

Rider sources are conventionally kept in `_docwork/riders/`. They are authoritative: their contents enter the ledger at Stage 3 with `authority: rider`, pre-ratified and without an extraction citation.

`kind: design` marks a design packet — an Open-Design-style export, a `design.md` plus screenshots, or any handoff bundle. Its `path` may be a folder; Stage 1 inventories the packet's own files under it. See `stages/01-intake.md`.

## `_docwork/stage_state.yaml`

```yaml
current_stage: 3          # 1-8, or done
provisional: false
completed:
  - {stage: 1, date: 2026-07-07, gate: pass}
harvest_progress:
  SRC-01: SRC-01-C0117    # last chunk processed, per source
ratification:             # written at stage 4
  status: signed          # signed | provisional
  by: operator
  date: 2026-07-08
  notes: ""
```

## `_docwork/chunks/` (produced by chunk_transcript.py)

One file per chunk: `SRC-01-C0001.txt` plus `SRC-01-index.yaml`:

```yaml
source: SRC-01
chunks:
  - {id: SRC-01-C0001, file: SRC-01-C0001.txt, start_line: 1, end_line: 120}
```

## `_docwork/extractions.yaml`

```yaml
extractions:
  - id: EXT-0001
    type: decision        # decision | correction | death | constraint | value | open | context
    summary: "Sweep is checked at daily rollover only."
    quote: "never sweep mid-day ... use end-of-day equity"
    cite: SRC-01-C0083
    topics: [treasury, sweep]
    authority: source     # source | rider
```

## `_docwork/ledger.yaml`

```yaml
ledger:
  - id: DEC-0001
    title: "Sweep timing"
    statement: "The sweep is evaluated at daily rollover only; an intraday cap hit completes the trading day first."
    status: ratified      # ratified | provisional | superseded | dead | conflict | open | out-of-scope
    rationale: "Mid-day sweeps corrupt daily accounting and interrupt open positions."
    sources: [EXT-0001, EXT-0044]
    component: COMP-TREASURY
    tags: [law]           # optional; 'law' marks constitution candidates
    supersedes: []        # DEC ids
    superseded_by: null   # DEC id, required iff status: superseded
    reason: null          # required iff status: dead — verbatim-derived kill reason
    conflict: null        # required iff status: conflict — list both readings
    recommendation: null  # expected iff status: conflict — the reading the agent recommends, and why
```

Validation rules: unique ids; every entry ≥1 source unless `authority: rider` extraction backs it; superseded ⇒ `superseded_by` resolves; supersedes-links resolve, no cycles; dead ⇒ `reason` non-empty; conflict ⇒ `conflict` non-empty.

`recommendation` carries the same meaning here as in `gaps.yaml` below: a non-binding pick the human can ratify with one word, never a resolution. A conflict entry whose `status` was changed by an agent instead of by the human is a defect regardless of what the recommendation said.

## `_docwork/gaps.yaml`

```yaml
gaps:
  - id: GAP-0001
    question: "What is the notification latency budget?"
    needed_by: [COMP-NOTIFY]
    blocking: false
    recommendation: "500ms p95 — the console already polls at 1s, so anything tighter buys nothing."
    status: open          # open | answered | deferred | out-of-scope
    answer: null          # + answered_by, date when resolved
```

`recommendation` is the agent's reasoned best guess, written so the human can ratify it with one word. It is **not** an answer: `answer` is the human's ruling and is the only field anything downstream may cite. A recommendation is expected on every gap presented at Stage 4 and on every `status: conflict` ledger entry; leave it out only where the agent genuinely has no basis to prefer a reading, and say so in the packet rather than inventing one.

## `_docwork/feature_inventory.yaml`

Built at Stage 4 from the ratified ledger and signed with it: the machine-readable answer to *"this documentation contains features X, Y, Z, scoped and ordered."* Downstream, one feature is one spec pass — the artifact exists so a spec loop can take the next unit of work without asking a human what to work on.

```yaml
generated: 2026-07-08       # ISO date the inventory was built
ratified: 2026-07-08        # ISO date the human signed it; null while provisional
features:
  - id: FEAT-0001
    name: "Daily sweep"
    scope: >
      One paragraph: what is in, what is out, and what "done" means for this feature.
      A spec pass must be able to act on it without re-reading the whole ledger.
    decisions: [DEC-0001, DEC-0012]   # >=1; resolve in ledger.yaml; never a dead entry
    components: [COMP-TREASURY]       # optional; resolve in dependencies.yaml once stage 5 has run
    blocked_by:                       # FEAT ids that must ship first; acyclic
      - id: FEAT-0004                 # a bare `[FEAT-0004]` list still parses
        reason: "consumes the settlement contract FEAT-0004 lands"
    size: one-pass                    # one-pass | multi-pass
    status: planned                   # planned | in-progress | shipped
    notes: ""
```

Validation rules: unique `FEAT-NNNN` ids; `name`, `scope`, `size` present (a scope under 40 characters warns — that is a title, not a scope); `size` and `status` in vocabulary; at least one `decisions` entry and every one of them resolving in `ledger.yaml`; tracing a `dead` decision is an error (it would resurrect a killed idea), tracing a `superseded` one warns and names the successor; `components` resolve when `dependencies.yaml` exists; `blocked_by` ids resolve, no self-edges, no cycles; every ratified component-scoped non-law decision belongs to at least one feature (warning by default, error under `--strict`).

Two rules make the ordering survive the trip downstream, both warnings by default and errors under `--strict`:

- **Every edge carries a reason.** The id is for the graph; the reason is what a spec pass copies into its spec, and it is the only form a ticket splitter downstream can act on.
- **Contracts before consumers.** Once `components` are filled and `dependencies.yaml` exists, a feature touching a component that `depends_on` another feature's component must be `blocked_by` that feature. This is the check that catches a UI feature scheduled ahead of the endpoint it reads.

Ordering is derived, never hand-written: blockers first, ties broken by id. `validate_inventory.py --order` prints the sequence with each feature's wave; `--waves` groups it — one wave is the set of features with no blocking edge between them, so wave-mates may run side by side, and wave-mates sharing a component are flagged to serialize; `--next` prints the single id whose blockers are all `shipped` (or `NONE`), which is the whole point — the batch consumer reads one line and starts; `--handoff FEAT-NNNN` prints one feature's scope, blockers with reasons, dependents, and wave-mates, for a spec pass to carry into its spec.

## `_docwork/enhancements.yaml`

```yaml
enhancements:
  - id: ENH-0001
    doc: docs/components/adapter.md
    description: "Added timeout failure mode"
    rationale: "Sources never covered adapter timeouts; standard failure class."
    status: pending       # pending | ratified | rejected
```

## `docs/registry/variables.yaml`

```yaml
variables:
  - name: seed_capital
    symbol: S
    value: 500            # or null with gap: GAP-00NN
    formula: null         # mutually exclusive with value for computed entries
    units: USD
    type: money           # money | ratio | duration | count | enum | string | formula
    component: COMP-TREASURY
    decision: DEC-0012
    configurable: true
    notes: ""
```

Validation: unique `name` (and unique non-null `symbol`); `decision` resolves in ledger; `value: null` requires `gap`; formulas reference only defined names/symbols.

## `docs/architecture/dependencies.yaml`

```yaml
components:
  - id: COMP-TREASURY
    name: Treasury Desk
    kind: service         # service | library | middleware | store | ui | external | process
    layer: backend        # ui | middleware | backend | data | external — required
    depends_on: [COMP-RECORDS]
    interfaces: [CT-01]   # contract ids in docs/contracts/
    spec: docs/components/treasury.md
```

Validation: unique ids; edges resolve; edges run downward (`ui → middleware → backend → data`, `external` exempt); `kind` and `layer` both present and in vocabulary; spec paths exist (warn if missing at stage 5, fail under `--strict`).

`kind` says what a component *is*; `layer` says where it *sits*, and it is the line the work is split along downstream. Both are closed vocabularies and `validate_registry.py` errors on anything outside them. Layer definitions, the direction rule, and the UI contract shape are in `references/layer-conventions.md`.

A knowledge base built before `layer:` existed carries none, so the gate errors on every component at once. That is a backfill, not a finding: fill the layers in once, in the same edit as whatever change brought you here (`stages/09-change-mode.md` step 6), then re-run.

## Doc frontmatter

See `style-rules.md` for the full block and the writing rules. Schema:

```yaml
---
id: COMP-EXAMPLE          # stable, greppable, unique
title: Example Component
type: component-spec      # taxonomy type
status: draft             # draft | reviewed | ratified | provisional
component: COMP-EXAMPLE   # optional; owning component
depends_on: [COMP-OTHER]  # optional; component ids
decisions: [DEC-0012]     # optional; primary ledger entries
sources: [SRC-01-C0083, EXT-0044, DEC-0012]   # provenance; ids or file paths
generated: 2026-07-07     # ISO date the doc was produced
verified: 2026-07-07      # ISO date last checked against reality
stale_after: 90d          # duration (30d|90d|6m|1y) or ISO date, measured from `verified`
---
```

Lint checks (`lint_docs.py`): `id`, `title`, `type`, `status` present; `type` in taxonomy; `status` in vocabulary; a verification date present as `verified` (canonical) or `last_verified` (deprecated alias, still accepted); `generated`/`verified`/`last_verified` are ISO dates; `sources` is a list; `stale_after` is a duration or ISO date; DEC/GAP/ENH references in body resolve.

Duration units are counted in days: `d` = 1, `w` = 7, `m` = 30, `y` = 365.

Staleness: expiry = `verified` + `stale_after` (or the literal date). Past expiry, lint prints `WARN` and `--strict` fails. Under `--strict` the provenance fields `sources`, `generated`, `verified` and `stale_after` are all **required** — a knowledge base is not done while any doc's provenance is unstated.
