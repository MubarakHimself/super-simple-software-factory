# Stage 4 — Ratification Gate

Goal: get the human's signature on the ledger *before any prose exists*. Catching a misremembered fact here costs one line-edit; catching it after drafting costs a rewrite of every doc that cited it.

## Build the ratification packet

Write `_docwork/ratification-packet.md` containing, in this order (busiest-first — the human may only skim):

1. **Conflicts** — every `status: conflict` entry with both readings, its citations, and its `recommendation`. These *require* a human ruling.
2. **Blocking gaps** — every `gaps.yaml` entry with `blocking: true`, each with its `recommendation`.
3. **Empty capture points** — the SDLC facts every project has that these sources never supplied: the stack per layer, the build tooling, the custom libraries, the CI/CD tiers, the stores and their schemas, and (if the project trains a model) the training shape and its eval threshold. The checklist is the Stage 1 question table plus the sections of `references/skeletons/stack.md`; an empty section there is an item here. One line each, with the recommendation.
4. **Deaths** — the full dead list with reasons (one line each). Zombie prevention is only as good as this list's accuracy.
5. **High-impact decisions** — entries tagged as laws/invariants/constraints, one line each.
6. **The feature inventory** — the table from `_docwork/feature_inventory.yaml` (id, name, size, blockers with their reasons, wave), in shipping order. See below.
7. **The full ledger** — compact table (id, title, status) for completeness.

Keep items skimmable: one line per item plus citation. The human should be able to ratify a large ledger in minutes, drilling into detail only where something looks wrong.

## Ask with a recommendation attached

Every item in sections 1–3 is a question, and every question is asked the same way: **state the recommendation, then ask.** The shape is one line of recommendation, one line of reason, and a ratification the operator can give in one word.

> **GAP-0007 — Which store backs the ledger?**
> Recommended: SQLite. Single writer, no service to operate, and DEC-0011 already rules out a network hop on the settlement path.
> Ratify, or name the store you want.

Three rules keep this bounded:

- **Ask where the record is ambiguous or a capture point is empty — nowhere else.** A question whose answer is already in the ledger is a question that wastes the one gate this pipeline has. This is not a questionnaire the operator fills in every run.
- **Recommend, never resolve.** The recommendation lives in the `recommendation` field; the ruling lives in `answer` (gaps) or in the human's own words (conflicts). Nothing downstream cites a recommendation.
- **Push back once, then stop.** If an answer contradicts a ledger entry or a rider, say so plainly, name the entry, and ask again — once. Then record whatever the operator says; he outranks the record, and the contradiction gets ledgered rather than argued.

The `grilling` skill carries this posture in full. When it is installed and the packet is large or the conflicts are load-bearing, hand it the packet and let it run the conversation; the rules above are what it is being asked to do, not a re-implementation of it.

## Build the feature inventory

The ledger says what was decided; the inventory says **what that adds up to building, scoped and ordered**. Write `_docwork/feature_inventory.yaml` (schema in `references/ledger-schema.md`) before presenting the packet, so the human ratifies the *slicing* at the same moment as the decisions — the one place where re-scoping is still free.

Method, one feature at a time:

1. **Group the ledger.** Cluster ratified entries into units of shippable work — usually one component's behaviour, sometimes one cross-component capability. Every feature carries the DEC ids it traces to; a feature that traces to nothing is a wish, not a feature.
2. **Scope it in a paragraph.** What is in, what is out, what "done" means. This paragraph is what a downstream spec pass reads *instead of* the whole ledger, so vagueness here is paid for later at full price.
3. **Draw the blocking edges from the architecture — contracts before consumers.** Read the edges off the dependency direction the ledger already decided; ordering is derivation here, never taste, and the operator is never the one to point out that the UI came before its endpoint. For each feature, list the components it touches (`docs/architecture/dependencies.yaml` when it exists — change mode, or a batch pass after Stage 5 — otherwise the ledger's `component` fields plus the architecture decisions):

   - Whoever **lands** a contract, schema, store, or auth boundary blocks whoever **consumes** it. Provider first, every time.
   - Each edge carries the reason, naming the thing that must exist: `blocked_by: [{id: FEAT-0004, reason: "consumes the settlement contract FEAT-0004 lands"}]`. The id orders the graph; the reason is what the spec pass downstream repeats, and an edge without one is an edge no consumer can act on.
   - A preference is not an edge. If the second feature could be built against a stub of the first, they are independent — and saying so is what lets them run side by side.

   Then read the ordering back with `validate_inventory.py --waves` and check it against the architecture: features in one wave have no edge between them and start together, and wave-mates sharing a component are flagged to serialize. Every surprise in that output is either a missing edge or a wrong one.
4. **Size it.** `one-pass` if a single spec-and-build pass can carry it; `multi-pass` if it must be split — and if a `multi-pass` feature can be split *now*, split it now.
5. **Leave `status: planned`** for everything unbuilt. Downstream consumers move features to `in-progress` / `shipped`; this stage never guesses that state.

Unknowns are gaps, exactly as everywhere else: a feature that cannot be scoped without an answer gets its question in `gaps.yaml` with `blocking: true`, and lands in the packet's blocking-gaps section.

## What the inventory is for

Downstream, one feature is one pass. A batch consumer (the docs-only batch path here, a spec loop outside this skill) asks for the next unit of work and gets exactly one, plus the ordering context that unit has to carry:

```bash
python <skill>/scripts/validate_inventory.py --root <project-root> --next               # -> FEAT-0002, or NONE
python <skill>/scripts/validate_inventory.py --root <project-root> --order              # the full sequence, with waves
python <skill>/scripts/validate_inventory.py --root <project-root> --waves              # what may run side by side
python <skill>/scripts/validate_inventory.py --root <project-root> --handoff FEAT-0002  # one feature's blockers, reasons, wave-mates
```

That is the entire mechanism by which passes arrive pre-chunked *and pre-ordered*, and no human is re-prompted between them. Quality was paid for here, once, at ratification.

## Collect the ruling

Present the packet. The human may: ratify as-is, rule on conflicts, correct entries, kill entries, answer gaps, and re-scope, re-order, split or merge features. Apply every ruling to `ledger.yaml`/`gaps.yaml`/`feature_inventory.yaml` (ledger rulings create new supersession entries — never silently edit a signed statement; the inventory is a projection of the ledger and is rewritten to match), set the inventory's `ratified` date, then record in `stage_state.yaml`:

```yaml
ratification:
  status: signed          # or provisional
  by: <name>
  date: <iso-date>
  notes: <free text>
```

## Provisional mode

In provisional mode the inventory is built exactly the same way, with `ratified: null` — it is a draft slicing that the human signs at Stage 8 along with everything else.

Provisional mode is entered either at init (`init_workspace.py init --provisional`, which sets `provisional: true` in `stage_state.yaml`) or by the operator saying "run through unattended" at any point before this stage — in which case set `provisional: true` in `stage_state.yaml` yourself. In provisional mode, skip the wait: still build the packet (the human reads it later), set `ratification.status: provisional`, and continue. Every artifact produced downstream must carry `status: provisional` in its frontmatter until the human signs, at which point Stage 8 flips them. `lint_docs.py --strict` enforces that nothing ships while provisional. This trades early feedback for throughput — the safety net is that provisional docs are visibly marked and machine-refused at the final gate.

## Gate

```bash
python <skill>/scripts/validate_inventory.py --root <project-root>
```

Checks unique FEAT ids, that every feature traces to at least one live ledger decision (a dead one is an error — that is a resurrected idea), that the blocking edges resolve, are acyclic, and each carries its reason, and — once components are known — that every consumer is blocked by its provider. Plus: `stage_state.yaml` contains a `ratification` block with status `signed` or `provisional`, and conflicts are zero (signed mode) or explicitly deferred with the human's later ruling still pending (provisional mode).
