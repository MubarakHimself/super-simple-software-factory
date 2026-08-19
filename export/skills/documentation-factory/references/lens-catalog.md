# Lens Catalog

A lens is a documentation viewpoint a project may or may not need. Lenses are selected at Stage 1 (recorded in `manifest.yaml: lenses:`) and each active lens adds required docs to Stage 6 and required review questions to Stage 7. This is how the skill stays generic while still producing, say, an MLOps story for an ML project and none for a static site.

Selection heuristic: activate a lens if the project *operates* in that dimension, not merely mentions it. Selection is not a judgement call made in silence: Stage 1 asks the operator a fixed set of questions (`stages/01-intake.md` step 4), each carrying a recommended answer, and records the "no"s as answers too. A lens activated late means a topic that was never harvested.

Stack, build tooling, custom libraries and the CI/CD declaration are deliberately **not** lenses — they live in `docs/architecture/stack.md`, which every project gets, because every project has them and a lens nobody selected is exactly how they go missing.

## core (always active)

Constitution, architecture, components, contracts, registry, ADRs, glossary, scenarios, gap report, AGENTS.md. Everything in the taxonomy.

## ops (DevOps / deployment)

For anything that runs somewhere. Adds `lenses/ops/`:
- `runbook.md` — start/stop/restart/deploy procedures, environments, secrets handling (locations, never values), scheduled jobs.
- `incident-playbook.md` — failure classes → first responses; escalation; what "down" means per component.
Review question: "the system crashed at 3am — do the docs get an agent from alert to diagnosis?"

## observability (logging / monitoring / alerting)

For systems that must be watched. Adds `lenses/observability/`:
- `logging-spec.md` — what each component logs, levels, structured fields, retention; log locations.
- `metrics-and-alerts.md` — metrics emitted, dashboards, alert thresholds (registry references), severity tiers and who/what is notified per tier.
Review question: "a number looks wrong on a dashboard — can an agent trace it back to the emitting code path via the docs?"

## mlops (ML lifecycle)

For projects with trained/fine-tuned models. Adds `lenses/mlops/`:
- `model-lifecycle.md` — per model: data sources, training/retraining ritual, evaluation gates, shadow rollout, promotion criteria, rollback. Four questions are answered by name, not left to the shape of whatever the sources happened to cover — each asked at Stage 1 or Stage 4 with a recommendation attached, each recorded even when the answer is "no":
  1. **Fresh or fine-tune?** Does this project train a model from scratch, or fine-tune a named base? Name the base.
  2. **Whose machine?** The default shape is that the factory **ships a training script and a runbook** and the operator runs them himself on his own hardware — a documented, repeatable, hand-run ritual, not an automated pipeline. Say so explicitly, or name the service that runs it instead.
  3. **What is the eval threshold?** A number, in the registry, that a candidate model must beat before it may be promoted. A promotion criterion without a number is folklore.
  4. **What happens below the threshold?** The current model stays; say where the failed candidate goes and who is told.
- `data-pipeline.md` — datasets, storage, versioning, synthetic data, lineage.
Review question: "a model degrades — do the docs say how to retrain, validate, and promote without folklore?"

## ui (UI / design)

For anything with a human interface. Adds `lenses/ui/`:
- `design-system.md` — a canonical DESIGN.md-style file: tokens (color, type, spacing), components, interaction conventions. Single authoritative file agents parse before generating UI.
- `screens/` — per-screen or per-section specs: purpose, data consumed (contract references), states (empty/loading/error), sample data.
- `design-record.md` — **only when a design packet was ingested** (`kind: design`, see `stages/01-intake.md`): what the packet contained, which packet file each doc above traces to, which screenshots evidence which state, and what the packet left undecided. This is the design record the spec and ticket chain downstream cites; the packet itself is an input and is never cited directly, because it is not versioned with the knowledge base.
Pattern note: this lens deliberately mirrors what Design OS and Impeccable-style tooling expect — a machine-readable design authority file plus per-section specs — so design-capable agents can consume it directly, and so a packet from that world lands here in its own shape.
Layer note: everything in this lens is the `ui` layer. Where a screen implies an endpoint or a store, that seam is a contract and the thing on the far side is a separate component — `references/layer-conventions.md` rule 3.

## performance

For systems with latency/throughput obligations. Adds `lenses/performance/`:
- `budgets.md` — end-to-end and per-hop budgets (registry references), measurement method, current baselines, and what happens when a budget is exceeded.
Review question: "the docs claim a latency budget — could an agent write the benchmark from them?"

## bugs (bug handling / triage)

For maintained systems. Adds `lenses/bugs/`:
- `triage.md` — severity classification, reproduction requirements, regression-test rule (every fixed bug leaves a test), linkage rule (bug → ADR if the fix changes documented behavior — that routes through change mode, not around it).

## testing

For any system that will be built or maintained by coding agents (which write notoriously weak tests unless the docs force better). Adds `lenses/testing/`:
- `test-strategy.md` — the test pyramid for this project: what gets unit tests, integration tests, end-to-end tests, and property/invariant tests; per component, WHAT must be proven (behaviors, boundaries, failure modes from the component specs) rather than which functions exist. Coverage is stated as "these documented behaviors have tests," never as a percentage.
- `fixtures-and-scenarios.md` — how the golden scenario bank doubles as test fixtures: each scenario's inputs/expected outputs mapped to executable test cases; where fixture data lives; determinism rules (seeded randomness, frozen clocks, no network in unit tests).
Rules this lens enforces on drafting: every component spec's "failure modes" section must be test-addressable (an agent can write a failing test from it); every contract gets at least one contract test (schema round-trip + boundary values); every Never-List-style invariant gets a property test naming the invariant. Anti-patterns to lint for in test docs: "test the happy path," coverage-percentage targets without named behaviors, mock-everything guidance.
Review question: "could an agent write the test suite from the docs alone — and would that suite actually fail if the documented behavior broke?"

## security

For systems handling money, secrets, or third-party access. Adds `lenses/security/`:
- `security-model.md` — trust boundaries (who may call what), secret inventory (locations/rotation, never values), authz rules per interface, threat notes per boundary.

## data (data layer)

For systems where storage is a first-class concern — asked about by name at Stage 1, so a project with a database never reaches Stage 8 without a schema doc. Adds `lenses/data/`:
- `data-layer.md` — stores, schemas (or links to contracts), retention, backup/restore, migration policy, access patterns and their owners. Every table/collection gets its columns with types and nullability, exactly as a contract does; `docs/architecture/stack.md` names the stores and points here for their shape.
