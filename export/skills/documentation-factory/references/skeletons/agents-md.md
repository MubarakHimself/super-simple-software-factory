---
id: DOC-AGENTS
title: Agent Entry Point
type: agents
status: draft
sources: [<SRC/EXT/DEC ids or file paths this doc was built from>]
generated: YYYY-MM-DD
verified: YYYY-MM-DD
stale_after: 90d
---

# AGENTS.md — Read This First

<Three sentences: what this system is, what it does, and what state it is in (design/build/production).>

## Reading order

1. `docs/constitution.md` — the laws. Violating any of them is a bug by definition.
2. `docs/architecture/overview.md` — the shape of the system.
3. The spec of whichever component you are touching: `docs/components/`.
4. `docs/glossary.md` when any term is unclear — one concept, one name.

## Hard rules (distilled — full text in the constitution)

- <Rule 1, one line, link to constitution law number.>
- <Rule 2 ...>
- Never implement anything that contradicts a `status: dead` decision — check `docs/gap-report.md` and `docs/decisions/` before proposing "new" ideas.

## Before changing anything

1. Run `python <skill>/scripts/blast_radius.py COMP-<NAME> --root .` — read every doc it lists.
2. Values come from `docs/registry/variables.yaml` — never hardcode a number that exists there.
3. Interfaces are defined in `docs/contracts/` — never invent a field.
4. Every change gets an ADR (`docs/decisions/`) and a changelog entry. Follow the change-mode protocol in the documentation-factory skill if available.

## Architecture preflight — before you build anything new

Run this before writing code for a new component, service, module, table, or endpoint. Answer in the plan or the ADR, in writing:

1. **Read the inventory.** `docs/architecture/dependencies.yaml` (every component and its edges) plus the specs of the candidates in `docs/components/`. Cite the IDs you read — "I did not find one" is not a proof that none exists.
2. **Prove reuse-or-new.** For each existing component that could plausibly carry this work, state why it cannot: authority boundary in its spec, contract mismatch in `docs/contracts/`, or a ratified decision that forbids it. If one *can* carry it, the answer is **reuse** — extend it and stop here.
3. **If new is required,** state what it owns that nothing else does, what it may never do (its authority boundary), and which existing component's authority shrinks because of it.
4. **Check the graveyard.** If a `status: dead` decision already covers this idea, its reason ends the discussion — see `docs/decisions/` and `docs/gap-report.md`.
5. **Record the verdict** — `reuse COMP-<NAME>` or `new COMP-<NAME>`, with the reason — in the ADR. An unrecorded verdict means the preflight did not happen.

## Where answers live

| Question | Doc |
|---|---|
| Why is X designed this way? | `docs/decisions/` (ADRs), `docs/knowledge/` |
| What is the exact value of X? | `docs/registry/variables.yaml` |
| What happens when X fails? | that component's spec, Failure modes section |
| What is still undecided? | `docs/gap-report.md` |
