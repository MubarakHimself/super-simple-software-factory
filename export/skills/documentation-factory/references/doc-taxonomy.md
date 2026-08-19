# Document Taxonomy

The output tree, what each doc type is for, and the reference/knowledge split. Every doc has exactly one type; the type determines its skeleton, its frontmatter, and how strictly lint treats it.

## The tree

```
docs/
├── index.md                    # map of everything (Stage 8)
├── AGENTS.md                   # agent entry point (Stage 8)
├── constitution.md             # system laws (Stage 6, first)
├── glossary.md                 # one concept, one name (seeded Stage 5)
├── changelog.md                # every change-mode event (Stage 8+)
├── gap-report.md               # open/deferred/out-of-scope + baseline comparison
├── architecture/
│   ├── overview.md             # C4 context + container + layer view, runtime narrative
│   ├── stack.md                # stack per layer, tooling, custom libraries, stores, CI/CD tiers
│   └── dependencies.yaml       # machine-readable component graph (kind + layer per component)
├── registry/
│   ├── variables.yaml          # every value/threshold/symbol (machine-readable)
│   └── formulas.yaml           # formulas with variables, if formula-heavy
├── contracts/                  # typed interface/event schemas per boundary
├── components/                 # one uniform spec per component
├── decisions/                  # ADR-NNNN-slug.md
├── scenarios/                  # golden scenarios, Given/When/Then
├── knowledge/                  # case law: design arcs, instructive failures
└── lenses/                     # docs required by active lenses (ops/, mlops/, ui/, ...)
```

## Reference docs vs knowledge docs

**Reference** (constitution, component specs, registry, contracts, architecture, glossary): state *what is*. Terse, normative, present tense, no narrative, no hedging, no history. An agent executing a task reads only these. If a reference doc needs to explain "why", it links an ADR instead.

**Knowledge** (ADRs, case law, gap report): explain *why and how we got here*. Narrative allowed; still citation-bound to the ledger. An agent (or developer) questioning a design, or tempted by a dead idea, reads these.

The split exists because the two audiences have opposite needs: execution wants minimum tokens of maximum authority; deliberation wants the reasoning trail. Mixing them makes docs long for executors and shallow for deliberators.

## Doc-type notes

- **Constitution**: numbered laws only. If it has more than ~30 laws, it's absorbing things that belong in component specs. A law is something whose violation anywhere in the system is a bug by definition.
- **Component spec**: uniform skeleton, no exceptions — uniformity is what lets an agent that has read one spec navigate all of them. Authority boundary section is mandatory: what this component may do, and *may never* do.
- **ADR**: immutable once written; reversals create a new ADR that supersedes. Number sequentially forever.
- **Golden scenario**: concrete over abstract; real numbers from the registry. If a scenario's numbers change, the scenario cites the registry so it changes with them.
- **Registry**: the only place values live. Prose references `registry:seed_capital` style; lint hunts for suspicious literals in reference docs.
- **Stack** (`architecture/stack.md`, type `architecture`, skeleton in `references/skeletons/stack.md`): reference, never lens-gated. Two things make it load-bearing rather than decorative — its per-layer rows are what stop a component spec from inventing a framework, and its CI/CD tiers are the declaration a build actually executes, so a check that is not in the table does not run. Numeric thresholds in it reference the registry like anywhere else.
- **AGENTS.md**: the only doc allowed to duplicate content (the distilled hard rules) — deliberate redundancy at the single entry point, because it's the one file guaranteed to be loaded.
