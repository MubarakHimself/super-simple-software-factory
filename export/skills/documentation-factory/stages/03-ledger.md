# Stage 3 — Decision Ledger

Goal: merge raw extractions into `_docwork/ledger.yaml` — the single source of truth every doc will cite. The ledger is the project's memory; docs are just its presentation layer.

## Merge rules

1. **Group extractions by topic.** Multiple extractions about the same decision merge into one ledger entry citing all of them.
2. **Resolve reversals with supersession chains.** If a decision changed over time, keep every version: the old entry gets `status: superseded` and `superseded_by: DEC-00NN`; the new one lists `supersedes: [DEC-00MM]`. Never delete history — an agent seeing only the final state cannot answer "why not the obvious alternative?", and that question is exactly what ADRs and future maintainers need.
3. **Corrections outrank everything.** A `correction` extraction beats any number of earlier statements. If a correction contradicts your merged entry, the correction wins.
4. **Deaths become dead-list entries:** `status: dead`, with `reason` filled from the verbatim quote. A dead entry with no reason is a gate failure — "we killed it but forgot why" is how zombies return.
5. **Rider-file entries** enter as `status: ratified` directly (`authority: rider`).
6. **Unresolvable conflicts** (two contradictory statements, no correction, no later reversal) become entries with `status: conflict` listing both readings — these are the main payload of the Stage 4 ratification packet. Do not pick a winner yourself: the `status` stays `conflict` until the human rules. Do write a `recommendation` — one sentence naming the reading you would take and the reason. Recommending is not resolving, and the two are kept apart by the field they live in.
7. **Unknowns become gaps.** Anything a doc will need but no source provides → `_docwork/gaps.yaml` entry (`GAP-0001`, question, which doc/component needs it, `blocking: true|false`) — and a `recommendation`, the answer you would give if it were yours to give, so the human can ratify it with one word instead of composing one. Where you have no basis to prefer an answer, leave the field out and say why in the packet; a fabricated recommendation is worse than an honest question.

## Entry anatomy

See `references/ledger-schema.md`. Key fields: `id: DEC-0001`, `title`, `statement` (normative, present tense, self-contained), `status` (ratified | provisional | superseded | dead | conflict | open | out-of-scope), `rationale`, `sources: [EXT-...]`, `component`, `tags`.

Write `statement` as law, not history: "The sweep runs at daily rollover only", not "we discussed and decided the sweep should probably run at rollover".

## Gate

```bash
python <skill>/scripts/validate_ledger.py --root <project-root>
```

Checks: schema, unique IDs, supersession chain integrity (no dangling references, no cycles), every entry cites ≥1 extraction (except rider-authority), every dead entry has a reason. Fix and re-run until clean, then advance `stage_state.yaml`.
