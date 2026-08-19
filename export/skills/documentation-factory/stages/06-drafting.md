# Stage 6 — Drafting

Goal: write the docs. Read `references/style-rules.md` and `references/doc-taxonomy.md` first; start structure-critical docs (constitution, component specs, ADRs, scenarios, AGENTS.md) from their skeletons in `references/skeletons/`; simpler types follow doc-taxonomy.md conventions plus the mandatory frontmatter. Drafters have one hard boundary: **never invent**. Everything normative cites a ledger ID; everything numeric references the registry; everything unknown is a visible `GAP(GAP-00NN)` marker in place.

Fill the provenance frontmatter as you draft, not afterwards: `sources` (the chunk/extraction/ledger IDs or file paths this doc came from), `generated` (today), `verified` (today), `stale_after` (the doc's staleness budget — see `references/style-rules.md`). A drafter knows its own provenance; nobody else ever will.

## Order of drafting

Depth follows build order — document first what will be built first, so documentation effort lands where implementation risk is. Within that:

1. `docs/constitution.md` — system laws and invariants (from constraint/law entries). Short, numbered, absolute. This is the doc every agent reads first after AGENTS.md.
2. `docs/architecture/overview.md` — C4 system-context + container diagrams plus the layer view (see `references/diagram-conventions.md` and `references/layer-conventions.md`), narrative of the runtime shape, pointers into component specs.
3. `docs/architecture/stack.md` — what the system is built out of and what runs against it: stack per layer, build tooling, custom in-house libraries, data stores, the CI/CD declaration in three tiers (per run / integration line / pre-release), and the training shape if the project trains a model. Start from `references/skeletons/stack.md`. **Every project gets this doc** — it is not lens-gated, because every project has a stack and a pipeline, and a lens nobody selected is how they go missing. Sections the sources never covered carry `GAP(GAP-00NN)` markers, not guesses; those gaps went to the operator at Stage 4 with a recommendation attached, so by drafting time most of them have answers.
4. `docs/components/<name>.md` — one spec per component in `dependencies.yaml`, uniform skeleton: purpose, authority boundary (what it may and may not do), interfaces (link contracts), behavior, configuration (registry references), failure modes, component diagram if internal structure warrants it.
5. `docs/decisions/ADR-NNNN-<slug>.md` — one ADR per *significant* ledger decision: context, options considered, ruling, consequences. Superseded chains become ADR history ("superseded by ADR-0031"). Dead ideas with instructive reasons get ADRs too — the "why not" record is what saves future agents from re-exploring dead ends.
6. Lens docs — whatever the manifest's `lenses:` list requires (see `references/lens-catalog.md`): ops runbook, ML lifecycle, UI design doc and design record, observability spec, etc.
7. `docs/knowledge/` — case-law/rationale essays where the reasoning journey itself has value (major design arcs, instructive failures). Knowledge docs may narrate; reference docs may not.

## Reference vs knowledge docs

Reference docs (constitution, specs, registry, contracts) state *what is* — terse, normative, no narrative, no hedging. Knowledge docs (ADRs, case law) explain *why* — narrative allowed, still citation-bound. Never mix modes in one file; agents planning a change read reference docs, agents questioning a design read knowledge docs.

## Enhancement discipline

Drafters will see genuine improvements the sources never discussed (a missing failure mode, an obvious index, a better name). Do not silently add them. Write the addition inline, wrapped:

```
<!-- ENHANCEMENT ENH-0007: added timeout failure mode; sources never covered adapter timeouts -->
```

and register it in `_docwork/enhancements.yaml` (`id`, `doc`, `description`, `rationale`, `status: pending`). The human ratifies the batch at Stage 8. This keeps the senior-team instinct *and* the no-invention guarantee.

Concrete example: the sources define a store component but never mention what happens if its file is corrupted on read. You know a senior team would specify recovery behavior. Write the failure-mode row, wrap it in the ENHANCEMENT comment, add the `enhancements.yaml` entry with rationale "standard durability failure class; sources silent". If instead you *don't know* what the right behavior is, that's a GAP, not an ENHANCEMENT — enhancements are additions you can fully specify; gaps are questions. (Stage 7 red-team findings follow the same rule: fixable-from-knowledge → ENH; needs-a-decision → GAP.)

## Parallelizing

Component specs shard cleanly across subagents (one component each, given: the skeleton, style rules, that component's ledger slice, registry, and contracts). The constitution, overview, and glossary should be single-authored for voice consistency.

## Gate

```bash
python <skill>/scripts/check_citations.py --root <project-root>
python <skill>/scripts/lint_docs.py --root <project-root>
```

Citations: every DEC/GAP/ENH reference resolves; claim-bearing docs cite ≥1 ledger entry; no doc contradicts a dead entry. Lint (non-strict): frontmatter completeness, provenance field formats, style anti-patterns, a Mermaid block in the architecture overview, and a diagram or a `no-diagram` marker on every component spec. Non-strict deliberately tolerates provisional stamps, pending ENHANCEMENT markers, non-blocking GAP markers, and prints staleness as `WARN` — those are legitimate mid-pipeline states; only Stage 8's `--strict` gate refuses to ship them. Fix, re-run, advance.
