---
id: ARCH-STACK
title: Stack and Pipeline
type: architecture
status: draft
depends_on: []
decisions: [DEC-NNNN]
sources: [<SRC/EXT/DEC ids or file paths this doc was generated from>]
generated: YYYY-MM-DD
verified: YYYY-MM-DD
stale_after: 90d
---

# Stack and Pipeline

<One paragraph: what this system is built out of and what runs against it before anything ships. Every row below cites the decision that chose it; an uncited row is an assumption, and an unknown one is a GAP marker, never a guess.>

## Stack by layer

One row per layer the project actually has — the same layers `docs/architecture/dependencies.yaml` declares. Omit a layer the project does not have; never invent one.

| Layer | Language | Framework / runtime | Chosen because | Cites |
|---|---|---|---|---|
| ui | <lang> | <framework + version line> | <the reason from the ledger> | DEC-NNNN |
| middleware | | | | |
| backend | | | | |
| data | | | | |

## Build and package tooling

| Concern | Tool | Notes | Cites |
|---|---|---|---|
| Package manager | | | DEC-NNNN |
| Build / bundle | | | |
| Test runner | | | |
| Formatter / linter | | | |

## Custom libraries

In-house code every layer depends on — the shared packages a new component is expected to reuse rather than re-derive. This table is what architecture preflight (see `docs/AGENTS.md`) is proved against for libraries, exactly as `dependencies.yaml` is for components.

| Library | Layer | What it carries | Owned by component | Cites |
|---|---|---|---|---|
| <name> | backend | <the one job> | COMP-NNN | DEC-NNNN |

<If the project has none, say "None — every dependency is third-party" rather than leaving the table empty.>

## Data stores

| Store | Engine | Schema lives in | Migration policy | Cites |
|---|---|---|---|---|
| <name> | <postgres / sqlite / files> | <docs/lenses/data/data-layer.md or a contract id> | <how a schema change ships> | DEC-NNNN |

<A project with a store activates the `data` lens; the schemas themselves live there, and this table points at them.>

## Pipeline — what runs, and when

The checks declared here are the checks the build actually runs. Three tiers, and every check sits in exactly one:

| Tier | When it runs | Checks | Failure means | Cites |
|---|---|---|---|---|
| Per run | Every agent run / every commit on a work branch | <fast checks: format, lint, unit tests> | The run does not hand back | DEC-NNNN |
| Integration line | On merge into the integration branch | <build, integration tests, contract tests> | The merge is refused | |
| Pre-release | Before a release leaves the integration line | <end-to-end, migration dry-run, security scan> | The release does not ship | |

Each check names the command that runs it, so a reader can run it by hand:

| Check | Command | Tier |
|---|---|---|
| <name> | `<exact command>` | per-run |

## Model training

<Only if the project trains or fine-tunes a model; otherwise write "None — this project trains no model" and delete the rest of this section.>

| Question | Answer | Cites |
|---|---|---|
| Fresh model or fine-tune? | <which, and of what base> | DEC-NNNN |
| Where does training run? | <the operator's own machine, by hand, from the shipped script — or the named service> | |
| What ships? | <the training script path + the runbook that walks it> | |
| Promotion threshold | `registry:<name>` | |
| What happens below the threshold? | <the current model stays; where the failed candidate goes, and who is told> | |

Training details — data sources, the retraining ritual, eval gates, rollback — live in the `mlops` lens (`docs/lenses/mlops/model-lifecycle.md`); this section is the summary a reader lands on first.

## Related

Decisions: <ADR links>. Layers and seams: `docs/architecture/overview.md` (layer view). Components: `docs/architecture/dependencies.yaml`.
