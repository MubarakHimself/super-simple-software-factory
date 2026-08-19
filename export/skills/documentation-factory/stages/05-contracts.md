# Stage 5 — Contracts Before Prose

Goal: pin down everything machine-checkable *before* anyone writes paragraphs. Prose disagrees silently; contracts disagree loudly. Producing these first means every doc drafted at Stage 6 references shared, validated definitions instead of restating (and drifting from) them.

## Artifacts

1. **Variables & Formulas Registry** — `docs/registry/variables.yaml` (+ `formulas.yaml` if the project is formula-heavy). Every named value, threshold, symbol, and formula from `value`-type ledger entries. Schema in `references/ledger-schema.md`. This is the *single source of truth for values*: docs and (later) code config both read from here. A value that appears only inside prose is a future inconsistency.
   - Each entry: `name`, `symbol` (optional), `value` or `formula`, `units`, `type`, `component`, `decision` (DEC id), `configurable: true|false`, `notes`.
   - Unknown values: enter the variable with `value: null` and a `gap: GAP-00NN` reference. The registry documents the *shape* of the system even where numbers are pending.

2. **Dependency manifest** — `docs/architecture/dependencies.yaml`. Every component (`id: COMP-<NAME>`), its kind, **its layer**, what it depends on, and its declared interfaces. This graph powers blast-radius analysis in change mode and is the backbone of the C4 diagrams. Derive components from ledger entries' `component` fields; if the component set is unclear, that's a conflict for the operator, not a guess.
   - **Every component declares its layer** (`ui | middleware | backend | data | external`) — read `references/layer-conventions.md` before filling this in; the gate errors on a missing or off-vocabulary value. A ledger entry that describes an interface *and* the query behind it becomes **two** components split on the seam, with a contract between them, never one component that does both.

3. **Interface/event contracts** — for each boundary where components exchange data, a typed schema (YAML or JSON Schema) in `docs/contracts/`. Field names, types, enums with all values spelled out, units, nullability. If the ledger doesn't specify a field, add it as `# GAP-00NN` — never invent field semantics.
   - **Every contract names its seam** — `layer_from` and `layer_to`, the layers it joins. Contracts on a `ui` seam take the props-in / callbacks-out shape defined in `references/layer-conventions.md`: data in, intents out as named callbacks, every state's shape, one block of real sample data.

4. **Glossary seed** — `docs/glossary.md` started now from ledger terminology, so drafters at Stage 6 converge on one name per concept. One concept, one name, forever; synonyms get "see X" entries.

## Method

Work component by component. For each: pull its ledger entries, extract values → registry, boundaries → contracts, dependencies → manifest. When a contract forces a question the ledger can't answer, it's a new gap — do not resolve design questions at the documentation layer.

When this stage runs as one pass of a batch (the docs-only batch path), the pass's slice is one feature from `_docwork/feature_inventory.yaml` — `validate_inventory.py --next` names it, and the feature's `components` list is the slice boundary. Once the manifest exists, fill in each feature's `components` and re-run `validate_inventory.py`: from here on the inventory's component ids are checked against `dependencies.yaml`, and so are its blocking edges — a feature touching a component that `depends_on` another feature's component must be `blocked_by` that feature (contracts before consumers). The manifest is the first moment that check can run, so treat its findings as ordering the Stage 4 pass missed and fix them in the inventory.

## Gate

```bash
python <skill>/scripts/validate_registry.py --root <project-root>
```

Checks registry schema, duplicate names/symbols, dangling DEC/GAP references, and that `dependencies.yaml` parses with unique component IDs, resolvable edges that run downward through the layers, and a `kind` and `layer` on every component drawn from their vocabularies. Then advance `stage_state.yaml`.
