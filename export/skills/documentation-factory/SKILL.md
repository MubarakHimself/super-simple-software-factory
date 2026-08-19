---
name: documentation-factory
description: Turn brainstorming transcripts, chat exports, or under-documented codebases into a senior-engineering-grade, agent-consumable knowledge base — decision ledger, constitution, C4 Mermaid architecture docs, component specs, ADRs, machine-readable variables registry, golden scenarios, glossary, gap report, and an AGENTS.md entry point. Use whenever the user wants to document a project, convert chat/design transcripts into documentation, re-document or clean up existing docs, build a knowledge base for coding agents (OpenCode, Codex, Claude Code, OMO), run a documentation gap analysis, or update docs after a feature change (change mode). Also trigger for "document this transcript", "write docs like a senior team", "create a knowledge base", "update the docs for this change", or any request to make a project understandable to new developers or agents.
---

# Documentation Factory

Produce documentation the way a senior software engineering team would — but written for a team of *agents*. The output is a knowledge base: any agent (or developer) can load one file and act on it safely, plan a change and know its blast radius, and never resurrect an idea the project deliberately killed.

## Why this skill is shaped the way it is

Three failure modes kill most AI-generated documentation, and every rule below exists to prevent one of them:

1. **Invention.** An agent summarizing a long transcript will confidently fill gaps with plausible fiction. Countermeasure: the **GAP rule** — writers never invent. Every claim in every doc traces to a Decision Ledger entry; anything unknown becomes an explicit `GAP` entry, never prose.
2. **Amnesia.** Long projects outlive any single context window. Countermeasure: **all pipeline state lives on disk** in a `_docwork/` workspace. The transcript is the input, the ledger is the memory, the docs are the output; the agent is disposable. Any agent, any session, any model resumes by reading the state files.
3. **Zombie decisions.** Ideas that were considered and deliberately rejected get re-proposed by future agents who never saw the rejection. Countermeasure: **the dead list is first-class** — killed ideas are documented *as killed, with the reason*, and a lint gate blocks docs that contradict them.

## The front door — start here

Invoked with no mode, no stage, and no arguments? The operator must never have to hold four modes and nine stages in his head. Ask exactly one question, then route:

> **What are you trying to do?**
> (a) new project — the design exists as conversation or plan, no code yet
> (b) code exists, documentation is thin or absent
> (c) documentation exists but the code does not, or the docs have drifted so far they must be re-documented, re-scoped and re-shaped before anything is specced
> (d) a small feature or fix on a system that already has a knowledge base
> (e) a big feature on a system that already has a knowledge base

Match the answer to the entry-path table, say the chosen route back in one line (*"codebase mode, entering at Stage 1, lenses to pick with you"*), then start. If the answer matches nothing, ask **one** clarifying question — never guess a mode silently, and never start the pipeline to find out.

Whichever route is chosen, say what comes out the far end of it, in one line: besides the docs, the pipeline emits a **feature inventory** — `_docwork/feature_inventory.yaml`, *"this documentation contains features X, Y, Z, scoped and ordered"*, written and signed at [Stage 4](#the-two-human-gates-and-only-two). It exists so the work after documentation arrives pre-chunked *and pre-ordered*: a spec loop takes one feature per pass (`validate_inventory.py --next`) and never comes back to ask what to work on or what has to come first — see [the handoff](#the-handoff-to-a-spec-loop). Routes (d) and (e) *read* an existing inventory instead of building one; the change-mode protocol keeps it current.

Ask for three things at the same time, once, before Stage 1:

- **Rider files** — the project-specific inputs (scope rulings, dead lists, laws, glossary seeds, coding standards). They go in `_docwork/riders/`; see [Rider files](#rider-files--the-only-channel-for-project-specifics).
- **Design packets** — any pre-built description of the interface: an Open Design export (real HTML/CSS pages, a design-handoff file, a project manifest), a design-os-style export, or a plain `design.md` plus screenshots. These enter as sources of `kind: design` and are read *structurally*, never as pictures; `stages/01-intake.md` says how, and the `ui` lens is where they land.
- **The root** — where `_docwork/` and `docs/` will live.

### Entry paths

| Operator's answer | Mode | Enter at | First move | Notes |
|---|---|---|---|---|
| (a) Greenfield — design only, no code | `transcripts` | Stage 1 | `init_workspace.py init --mode transcripts` | Full 1→8. Stage 4 ratification is where a wrong design is caught while it is still free to fix. |
| (b) Brownfield with code | `codebase` | Stage 1 | `init_workspace.py init --mode codebase` | Sources include the repo tree and `git log`; the gap report baselines against whatever docs exist. |
| (c) Brownfield docs-only — docs without code, or drifted past trusting | `enhance` | Stage 1, then batch | `init_workspace.py init --mode enhance` | **The batch path** — ingest once, ratify once, then N small passes. See below. |
| (d) Small feature after ship | `change` | Stage 9 | `blast_radius.py COMP-<NAME>` | The knowledge base is **read, not rebuilt**. Stages 1–8 do not re-run. |
| (e) Big feature after ship | `change`, after an upstream planning pass | planning first, then Stage 9 | upstream planning/wayfinding pass → Stage 9 | A feature big enough to add components or bend a law needs a plan before it needs docs; this skill records the ruling, it does not make it. [Architecture preflight](#architecture-preflight--prove-reuse-or-new) is mandatory before building. |

### The batch path (docs-only brownfield)

Ingest is once; passes are many. This is the shape that keeps a large drifted corpus inside real context windows:

1. **Stage 1, once.** Every existing doc is a source (`kind: doc`), plus riders. Chunk them like transcripts — a drifted doc is a transcript of a past intention, and it needs citable chunk IDs for exactly the same reason.
2. **Stages 2–3, once.** Harvest the whole corpus into **one** ledger. Where two docs disagree, the entry is `status: conflict` carrying both readings — never a silent pick.
3. **Stage 4, once.** One ratification for the whole corpus. Re-scoping and re-shaping happen here, before any prose is written; that is the entire economy of this path. The same signature covers `_docwork/feature_inventory.yaml` — the human ratifies the decisions *and* how they are sliced into features.
4. **Stages 5–8, in N passes.** **N is the feature inventory** — one feature per pass, taken in its order, `validate_inventory.py --next` naming the one to do now. Every pass reuses the single ratified ledger, runs its own gates, and records itself in `stage_state.yaml`. A pass that discovers it needs a *new* decision stops and adds it through the change-mode protocol — passes never re-open the ledger on their own.
5. **Dispatch the passes by wave.** `validate_inventory.py --waves` is the parallel boundary: one wave is the set of features with no blocking edge between them, so a wave's passes may run as parallel subagents (see [Multi-agent orchestration](#multi-agent-orchestration)) and the next wave starts when the previous one has shipped. Two constraints, both printed by `--waves` itself: wave-mates that share a component are flagged to serialize, and a pass still runs its own gates. Single-agent runtimes walk the same waves one pass at a time — `--next` is `--waves` read one line at a time, not a different order.

Because N is a file and not a judgment call, the passes need no operator between them: each one knows its scope (the feature's paragraph), its blockers (`blocked_by`), its wave-mates, and its size (`one-pass` / `multi-pass`) before it starts. The same wave structure is what a `/to-kanban`-style consumer downstream inherits, which is why it is computed here and not re-derived there.

The split exists because the ledger is the expensive artifact and needs the human once, while drafting is cheap, parallel, and safely repeatable.

## The handoff to a spec loop

The chain that consumes this pipeline — a spec skill, then a ticket splitter — never opens `_docwork/`, and the splitter draws its blocking edges from *the spec's own text*. The ordering derived at Stage 4 therefore reaches the tickets through one channel only: the spec pass writing it into the spec. Two commands supply it:

```bash
python <skill>/scripts/validate_inventory.py --root <project-root> --next              # the one feature to spec now
python <skill>/scripts/validate_inventory.py --root <project-root> --handoff FEAT-0002  # its edges, in words
```

Every spec states, in its own prose, three facts from that handoff:

- **What must already exist** — each blocker with its reason ("consumes the settlement contract FEAT-0004 lands"), so the tickets inherit the edge instead of guessing it.
- **What this feature delivers that others wait on** — its contract is load-bearing for a named later feature, which is why it ships whole.
- **What may run alongside it** — its wave-mates, so parallel work arrives marked as parallel rather than as one flat list.

Write those three and the operator reads a correctly ordered board without ever re-stating the order himself; that is the completion criterion for the handoff.

## Rider files — the only channel for project specifics

This skill is generic and stays generic. Everything project-specific arrives as **data**:

- **Where:** `_docwork/riders/`, listed in `manifest.yaml` under `sources:` with `kind: rider`. Stage 1 inventories them like any other source.
- **What counts:** scope rulings, dead lists, laws/constitution seeds, glossary seeds, coding standards, naming conventions, the operator's non-negotiables.
- **Authority:** rider content enters the ledger at Stage 3 pre-ratified (`authority: rider`) and needs no extraction citation. Where a rider contradicts a source, the rider wins — and the contradiction is written down as a ledger entry, not quietly resolved.
- **Never edit this skill to hold a project's facts.** A rule stored in the skill leaks into the next project; a rule stored in a rider travels with the project it belongs to.

## Operating modes

Determine the mode first — the front door does this by asking, not by guessing; this table is the definition it routes into. Mode changes only intake (Stage 1) and the gap-report baseline — everything downstream is identical.

| Mode | Input | Typical trigger |
|---|---|---|
| `transcripts` | Chat exports / brainstorming logs | "Document this design conversation" |
| `codebase` | Existing repo + commit history | "This project is poorly documented" |
| `enhance` | Existing docs (any quality) | "Make these docs senior-team grade" |
| `change` | An existing `docs/` KB built by this skill + a described change | "We're upgrading component X — update the docs" |

For `change` mode, skip the pipeline and read `stages/09-change-mode.md` directly.

## The pipeline

Stages run in order. **A stage is not complete until its gate passes** — gates are scripts, not judgment calls. Never skip a gate; if a gate script fails, fix the artifact, not the gate.

| # | Stage | Read | Output artifact | Exit gate |
|---|---|---|---|---|
| 1 | Intake | `stages/01-intake.md` | `_docwork/manifest.yaml`, `_docwork/chunks/` | `scripts/init_workspace.py check` |
| 2 | Harvest | `stages/02-harvest.md` | `_docwork/extractions.yaml` | `scripts/coverage_report.py` (review output) |
| 3 | Ledger | `stages/03-ledger.md` | `_docwork/ledger.yaml`, `_docwork/gaps.yaml` | `scripts/validate_ledger.py` |
| 4 | Ratify | `stages/04-ratify.md` | Human signature (or PROVISIONAL stamp), `_docwork/feature_inventory.yaml` | `scripts/validate_inventory.py` + signature recorded in `stage_state.yaml` |
| 5 | Contracts | `stages/05-contracts.md` | `docs/registry/`, `docs/architecture/dependencies.yaml`, schemas | `scripts/validate_registry.py` |
| 6 | Drafting | `stages/06-drafting.md` | `docs/` tree (reference + knowledge docs) | `scripts/check_citations.py` + `scripts/lint_docs.py` |
| 7 | Review | `stages/07-review.md` | review reports, fixed docs | `scripts/lint_docs.py` clean after fixes |
| 8 | Assembly | `stages/08-assembly.md` | index, `AGENTS.md`, gap report, scenarios, changelog | `scripts/lint_docs.py --strict` |
| 9 | Change mode | `stages/09-change-mode.md` | updated docs + ADR + changelog entry | `scripts/lint_docs.py --strict` |

Record progress in `_docwork/stage_state.yaml` after every stage. On starting any session, read `stage_state.yaml` first and resume from there.

## The two human gates (and only two)

The pipeline is built for a solo operator orchestrating agents; it must run unattended between exactly two checkpoints:

- **Stage 4 (Ratify):** the human signs the Decision Ledger — and the feature inventory built from it — before any prose exists. This is where misremembered facts get caught cheaply, and the only place re-scoping is still free.
- **Stage 8 (Assembly):** the human ratifies the ENHANCEMENT batch — everything agents added beyond source material.

Default is **strict**: stop and wait at Stage 4. If the operator passes `--provisional` (or says "run through"), continue past Stage 4 but stamp every downstream artifact `status: provisional`; `lint_docs.py --strict` refuses to declare the project done while any stamp remains.

## Architecture preflight — prove reuse-or-new

Before an agent *builds* anything against a knowledge base this skill produced — a new component, service, module, table, or endpoint — it must read the knowledge base and the component inventory and **prove reuse-or-new**: name the existing components it considered, and state why each one cannot carry the work. "I did not find one" is not a proof; the inventory is a file, and it is either cited or it was not read.

The check is defined once and executed in two places, both of which this skill writes:

- `references/skeletons/agents-md.md` — every produced knowledge base ships the preflight in its own entry point, so downstream agents inherit it whether or not this skill is installed.
- `stages/09-change-mode.md` — the preflight step of the change-mode protocol, run while the change is being documented.

Its verdict (`reuse COMP-X` / `new COMP-Y`, with the reason) is recorded in the ADR for the change. An unrecorded verdict means the preflight did not happen.

## Audience: agents first

Every doc is written assuming an agent may load *only that file*. Read `references/style-rules.md` before drafting anything. The non-negotiables: YAML frontmatter on every doc (id, type, status, depends_on, decisions); every section self-contained (no "as discussed above"); stable greppable IDs (`DEC-0042`, `COMP-BMS`, `GAP-0007`); values live in the registry and are *referenced*, never restated; diagrams are Mermaid in fenced ```` ```mermaid ```` blocks (renders on GitHub, GitBook, and locally); jargon resolves in the glossary.

## Multi-agent orchestration

The `_docwork/` workspace is the shared blackboard. When subagents are available, the orchestrator dispatches one stage (or one component's drafting) per subagent, giving it: the relevant `stages/*.md` file, the input artifact paths, and the output path. Reviewer roles (Stage 7) must **not** be the same agent instance that drafted, and reviewers may not read raw sources — role boundaries are defined in the stage file. Single-agent runtimes execute the same stages sequentially, adopting each role's constraints in turn. The pipeline degrades gracefully; the gates keep quality identical either way.

## Reference files — when to read what

- `references/doc-taxonomy.md` — the output document tree, what each doc type is for, reference-vs-knowledge split. Read at Stage 5/6.
- `references/lens-catalog.md` — optional documentation lenses (DevOps, MLOps, UI/design, observability & logging, performance, bug handling/triage, testing, security, data layer). Read at Stage 1 to select lenses in the manifest; each lens adds required docs.
- `references/style-rules.md` — agent-first writing rules and anti-patterns. Read before Stage 6.
- `references/layer-conventions.md` — the UI / middleware / backend / data taxonomy, the rule that every component and contract declares its layer, how mixed inputs get split along the seam, the UI contract shape, the layer view. Read at Stage 5, and again at Stage 6 whenever a spec spans layers.
- `references/diagram-conventions.md` — C4 levels, Mermaid patterns, which docs require which diagram. Read at Stage 5/6.
- `references/ledger-schema.md` — full schemas for manifest, extractions, ledger, gaps, feature inventory, enhancements, stage_state, dependencies, registry. Read at Stages 2–5. Scripts enforce these schemas.
- `references/skeletons/` — copy-paste templates for the structure-critical doc types (constitution, component-spec, adr, scenario, agents-md, stack). Always start those docs from their skeleton; simpler types (index, glossary, changelog, gap-report) follow doc-taxonomy.md conventions plus the mandatory frontmatter.

## Scripts

All scripts are stdlib-plus-PyYAML Python, runnable anywhere (`pip install pyyaml` if missing). Run them from the project root. Every script exits 0 on pass, non-zero on fail, and prints actionable errors. See each script's `--help`.

## Starting a project

```bash
python <skill>/scripts/init_workspace.py init --project "<name>" --mode transcripts --root .
```

Pick the mode through [the front door](#the-front-door--start-here), not by guessing, then follow the stage table. Take the operator's rider files (project-specific scope rulings, laws, dead lists, glossary seeds) as *input at Stage 1*, from `_docwork/riders/` — this skill stays generic; project specifics arrive as data, never as edits to this skill.
