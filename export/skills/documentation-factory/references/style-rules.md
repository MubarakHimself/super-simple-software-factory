# Style Rules — Writing for Agents

The audience is a team of agents plus occasional developers. An agent may load exactly one file and act on it. These rules are prompt engineering and context engineering applied to documentation: every rule either raises the signal an agent gets per token, or removes a way for it to go wrong.

## Frontmatter (mandatory on every .md doc)

```yaml
---
id: COMP-EXAMPLE            # stable, greppable, unique
title: Example Component
type: component-spec        # one of the taxonomy types
status: draft | reviewed | ratified | provisional
component: COMP-EXAMPLE     # owning component, if applicable
depends_on: [COMP-OTHER]    # component IDs this doc's subject depends on
decisions: [DEC-0012, DEC-0031]   # primary ledger entries
sources: [SRC-01-C0083, EXT-0044] # provenance: what this doc was generated from
generated: 2026-07-07             # date this doc was produced
verified: 2026-07-07              # date it was last checked against reality
stale_after: 90d                  # staleness budget: 30d | 90d | 6m | 1y | ISO date
---
```

Lint enforces presence; the dependency manifest and blast-radius tooling consume `depends_on`; change mode consumes `verified`.

## Provenance & staleness (the OKF fields)

`sources`, `generated`, `verified`, `stale_after` and `status` exist so a machine — not a reader's memory — can say whether a doc is still trustworthy:

- **`sources`** — every upstream input this doc was generated from: chunk IDs (`SRC-01-C0083`), extraction IDs (`EXT-0044`), ledger IDs (`DEC-0012`), or file paths in `codebase`/`enhance` modes. A doc with an empty `sources` list is invention until proven otherwise; this is the GAP rule made checkable at the file level.
- **`generated`** — ISO date the doc was produced. It is not edited afterwards. A rewrite from source is a new generation and resets it.
- **`verified`** — ISO date the content was last checked against reality (its sources, the code, or the operator). Change mode sets it on every doc it confirms, whether or not the doc changed.
- **`stale_after`** — the staleness budget, measured from `verified`: a duration (`30d`, `90d`, `6m`, `1y`) or an explicit ISO date. Choose by how fast the subject moves — contracts and registries short, constitutions long.
- **`status`** — the doc's standing: `draft | reviewed | ratified | provisional`. A `ratified` doc past its `stale_after` is *ratified and stale*: the two fields answer different questions.

`verified` + `stale_after` is what turns staleness into a gate instead of a feeling. `lint_docs.py` warns on every expired doc and fails on one under `--strict`, so a knowledge base cannot be declared done while part of it is quietly out of date.

`verified` is the canonical name. `last_verified` is the deprecated alias carried by knowledge bases built before these fields — lint still accepts it, and renaming it on next touch satisfies rule 4 below (one name per concept).

## The rules

1. **Self-containment.** Every section makes sense with zero surrounding context. Never "as discussed above", "the aforementioned", "see previous section" — repeat the noun or link the ID.
2. **Stable IDs everywhere.** Decisions `DEC-0042`, components `COMP-NAME`, gaps `GAP-0007`, enhancements `ENH-0003`, ADRs `ADR-0015`, scenarios `SCN-0002`. IDs are how agents grep their way to truth; prose descriptions are how they guess.
3. **Values by reference.** Numbers, thresholds, symbols live in the registry. In prose write: "the seed capital (`registry:seed_capital`)". Restated literals rot; references can't.
4. **One name per concept.** The glossary is the arbiter. If two sources used two names, pick one at Stage 5, add a "see" entry for the other, and never use it again.
5. **Normative language is unambiguous.** "must" = law; "should" = default with documented exceptions; "may" = permitted. Never "probably", "typically", "in most cases" in reference docs — if variability exists, state its exact conditions.
6. **Enums are exhaustive.** When a doc mentions a state or mode, list every possible value once (or link the contract that does). An agent that doesn't know the full state space will invent transitions.
7. **Authority boundaries are explicit.** Every component spec states what the component may never do. Agents respect fences they can see.
8. **Failure modes are content, not afterthought.** What happens when the dependency is down, the input is malformed, the state is stale. Senior teams document the unhappy path; that's most of what distinguishes their docs.
9. **GAP markers, never soft padding.** Unknown means `GAP(GAP-00NN): <question>` inline — visible, greppable, lintable. Padding sentences around an unknown is invention with extra steps.
10. **Examples are real.** Worked examples use registry values and real field names from contracts, so they stay true as the system evolves.
11. **Diagrams are text.** Mermaid in fenced code blocks only (see diagram-conventions.md). Never binary images for structure — agents can't read them and diffs can't show them.
12. **Short paragraphs, front-loaded.** First sentence of every section carries its point. Token budgets are real; make the first 50 tokens of a section worth loading.

## Anti-patterns (lint hunts these)

- Relative references: "above", "previously", "as mentioned", "the following section".
- Hedges in reference docs: "probably", "roughly", "more or less", "typically", "might".
- Unmarked TODOs: `TODO`/`TBD`/`FIXME` without a GAP id.
- History in reference docs: "we used to", "originally", "after much discussion" (belongs in ADRs/knowledge docs).
- Naked literals in reference prose where a registry entry exists.
- First-person narrative in reference docs ("we decided" → the ADR decided; the spec just *is*).
