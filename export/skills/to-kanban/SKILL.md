---
name: to-kanban
description: Turn ratified documentation into cards on the Kanban Board - one spec and one agent brief per feature, published in one push.
disable-model-invocation: true
---

# To Kanban

The supply line from ratified docs to the Board. Documentation-factory ends with a signed feature
inventory; the factory starts with `queue/NNN-slug.md` cards. This run is the piece in between: one
spec and one agent brief per feature, written in the order the inventory already derived, published
as cards in a single pass.

It is the whole in-house chain - `to-spec`, `to-tickets`, `/triage` and `queue-publish` stay
installed and are not called from here.

Two files carry the contracts, and both are handed to subagents by path:

- [`SPEC.md`](SPEC.md) - the house spec shape.
- [`BRIEF.md`](BRIEF.md) - the agent-brief contract every card body must match, plus the two cases
  that change what a brief asks for: a declared verification lens, and a deliverable that is a
  trained model.

## The front door

Name the target repo first. If it is not obvious from the conversation, ask - publishing to the
wrong repo's queue is a silent miss, not a loud error. Then ask one question:

> **Batch from an inventory, or a single feature?**

**Batch** requires `_docwork/feature_inventory.yaml` in that repo. When it is absent, say so plainly
- documentation-factory writes that file at Stage 4, so run it first - and offer the single-feature
path for a genuine one-off.

## The batch path

### 1. Read the order, once

`validate_inventory.py` lives beside this skill, in the `documentation-factory` skill's `scripts/`
directory:

```
python <skills>/documentation-factory/scripts/validate_inventory.py --root <repo> --order
python <skills>/documentation-factory/scripts/validate_inventory.py --root <repo> --handoff FEAT-0001
```

`--order` prints the shipping order. That sequence **is** the order cards are written and numbered
in, blockers first, so every blocker lands on a lower number than the thing it blocks. Run
`--handoff` once per feature; its output is the ordering context that feature carries into its spec.

Those two outputs are the entire ordering input for this run. The order was derived once, from the
architecture, at a gate the operator signed - re-reading the docs to work out what comes first is
how a board arrives wrong.

Features the inventory already marks `in-progress` or `shipped` have their cards; this run is the
`planned` ones, in the order `--order` gave them.

A non-zero exit from `--order` is a broken inventory, not a thing to work around: print what it said
and send the operator back to documentation-factory.

### 2. Size the run

- **1-3 features** - inline, one at a time, in order.
- **4 or more** - one subagent per feature, all dispatched together. You become the orchestrator and
  write no spec yourself. Ordering is already carried by each card's `Needs:`, so nothing about the
  dispatch needs to be serial.
- **A dynamic workflow** only when the operator asks for one by name.

Each subagent's packet is exactly: the feature's inventory row, its `--handoff` output verbatim, the
knowledge-base slice its row names (the component specs, contracts and ADRs behind its `components:`
and `decisions:`), the paths to `SPEC.md` and `BRIEF.md`, and its two output paths. It returns three
lines - card title, spec path, brief path - and nothing else.

### 3. Per feature, in order: the spec, then the brief

1. **The spec** goes to `specs/<slug>.md` in the target repo, in the shape `SPEC.md` gives. It
   carries `Feature: FEAT-000X` and `Blocked-by: <FEAT ids>` verbatim from the inventory, and states
   the three handoff facts in its own prose: what must already exist and why, what this feature
   delivers that others wait on, and what may run alongside it.
2. **The brief** goes to `<work>/briefs/FEAT-000X.md`, in the shape `BRIEF.md` gives - durable,
   behavioral, complete acceptance criteria, explicit out-of-scope, written for an agent that will
   see the card and nothing else.

`<work>` is `_docwork/kanban/` when `_docwork/` exists, `.scratch/to-kanban/` otherwise. The
manifest of step 4 lives there too. These are working files; the cards are the record.

### 4. Publish

Two edits first, so the inventory stays true and everything lands in one commit:

- Set `status: in-progress` on every feature this batch publishes. That is what keeps `--next` and
  `--order` honest for the next batch; a feature left at `planned` is a feature the next run
  publishes twice.
- List `_docwork/feature_inventory.yaml`, every spec written, and any doc this journey touched under
  the manifest's `sync:`.

Then run one command:

```
python <this-skill>/scripts/publish_batch.py <work>/batch.yaml --repo <repo>
```

Manifest shape - cards in shipping order, one per feature:

```yaml
cards:
  - feature: FEAT-0001            # kept in the card header for traceability
    title: Add the health endpoint
    brief: briefs/FEAT-0001.md    # relative to this manifest
    needs: []                     # FEAT ids, or basenames of cards already in queue/
    adw: ""                       # optional; blank takes TEMPLATE.md's value
    context: ""                   # optional; passed through to the card's Context:
  - feature: FEAT-0002
    title: Chart the health history
    brief: briefs/FEAT-0002.md
    needs: [FEAT-0001]
sync:                             # committed with the cards - everything written this journey
  - _docwork/feature_inventory.yaml
  - specs/health-endpoint.md
  - specs/health-history-chart.md
  - docs/
```

The script does the rest in one pass: collision-free numbering, `FEAT-0001 -> 001-add-the-health-endpoint.md`
resolution across the whole set at once, the header block copied from the repo's own `TEMPLATE.md`,
then `git add` + commit + push of the cards **and** every path under `sync:`. Publishing is the sync;
one push, no second command.

Read the refusal, not just the exit code. Exit 1 covers two states, and the refusal says which:

- **Refused before the commit** - nothing was published. Every card is planned before any is
  written, and anything already written is removed again if staging fails, so the queue is as it
  was. Fix what the refusal names and run the command again.
- **Refused at or after the commit** - the cards are on disk and committed; the push is what
  failed. The refusal names each card. Finish that step by hand. Running the command again here
  publishes a second copy of every card.

The batch is published when the exit code is 0.

### 5. Report

One line per card: number, basename, and the FEAT id it came from. Then the branch pushed to. The
operator points the Board at it and sees the wave already ordered.

## A single feature

Same brief contract, same script, no inventory:

1. Ask what it is and grill it into shape if it is thin - `/grilling` is installed for exactly this.
2. Ask **what it is blocked on**, in existing card basenames (`001-auth-model.md`), since there is
   no inventory to read edges from. Nothing blocking it is a fine answer and the common one.
3. Write the brief; write a spec too when the feature is big enough that a card alone would lose the
   reasoning.
4. Publish through the same script with a manifest of one card, `feature:` omitted, `needs:` holding
   those basenames.

## When to ask the operator

Ambiguity in the inventory or the docs is a question, never a guess. Ask in one round, numbered, each
question carrying your recommended answer, then wait - the `/grilling` shape. The five that come up:

- A feature's `scope` never says what **done** means, so the acceptance criteria would be invented.
- Two features overlap enough that one card would do both, or one feature is plainly two cards.
- A blocking edge carries no reason, so the spec cannot say what must already exist.
- A feature is sized `multi-pass`. One feature is one card here; recommend either splitting the
  feature in the inventory (a documentation-factory change-mode pass) or shipping it as one card
  with a bigger brief, and say which you would pick.
- The feature touches a component the knowledge base does not document, so the brief's key
  interfaces would be a guess.

## What this run never does

It writes cards, specs and briefs, and pushes them on the working line. It never edits a card that
already exists, never writes `Status:` back, never touches `queue/done/` or `TEMPLATE.md`, and never
commits or pushes `main` - `main` is the operator's, one squash per finished chunk, clicked in the
app.
