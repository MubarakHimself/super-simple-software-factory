# Stage 8 — Assembly & Final Gate

Goal: turn a set of validated docs into a navigable, shippable knowledge base, and close the loop with the human.

## Artifacts

1. **`docs/index.md`** — the map: every doc, one-line purpose, grouped by taxonomy. An agent lands here when it doesn't know where to look.

2. **`docs/AGENTS.md`** — the entry point coding agents (OMO, OpenCode, Codex, Claude Code) auto-load. Skeleton in `references/skeletons/`. Contents: what this system is (three sentences); the reading order (constitution → overview → the component you're touching); the hard rules an agent must never violate (distilled from the constitution, with links); how to use the registry and dependency manifest before any change; the **architecture preflight** (before building anything new, read the component inventory and prove reuse-or-new, verdict recorded in the ADR); the change-mode protocol ("before modifying component X, run blast_radius, read the listed docs, write an ADR"). This file is why the knowledge base plugs into agent frameworks with zero adaptation.

3. **Golden scenario bank** — `docs/scenarios/*.md`, Given/When/Then format (skeleton provided), from ledger entries with concrete worked examples. Each scenario serves three masters: human explanation, agent planning fixture, and future test fixture. Prefer scenarios with real numbers over abstract ones.

4. **Gap report** — `docs/gap-report.md`, all `gaps.yaml` entries in three bins: *open* (needs a decision), *deferred* (decided to postpone, with ledger cite), *out-of-scope*. If a baseline source exists (old docs/vault), add the comparison section: every baseline topic classified as redesigned (cite new DEC) / deliberately killed (cite dead entry) / never discussed (becomes an open gap). This section is the insurance against silent loss during re-documentation.

5. **`docs/changelog.md`** — initialized with the creation entry (date, ledger version, doc count, mode).

6. **Enhancement ratification** — present `_docwork/enhancements.yaml` to the human as a skimmable packet (like Stage 4). Ratified → remove inline markers, integrate; rejected → remove content, keep tombstone in the ledger (`status: dead`, reason: "operator rejected ENH-NNNN"). If the run was provisional, this is also where the human signs the Stage 4 packet and provisional stamps get flipped to ratified.

## Gate — final

```bash
python <skill>/scripts/lint_docs.py --root <project-root> --strict
python <skill>/scripts/check_citations.py --root <project-root>
python <skill>/scripts/coverage_report.py --root <project-root>
```

Strict lint additionally fails on: any `provisional` status, any unratified ENHANCEMENT marker, any unresolved inline GAP marker for a `blocking: true` gap, a missing `index.md`, `AGENTS.md`, `gap-report.md`, `architecture/overview.md` or `architecture/stack.md`, any doc missing its provenance fields (`sources`, `generated`, `verified`, `stale_after`), and any doc already past its `stale_after` budget. When clean: set `stage_state.yaml: current_stage: done`, record the date, and tell the operator the knowledge base is ready — including a one-paragraph summary of open gaps, since those are the project's real to-do list.
