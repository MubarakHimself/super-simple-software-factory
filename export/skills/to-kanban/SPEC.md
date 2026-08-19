# The house spec

One spec per feature, written to `specs/<slug>.md` in the target repo. It is the durable half of the
handoff: the card is what an agent builds from, the spec is what a human reads six weeks later to
find out why the card asked for that.

It is written **from the inventory row and the `--handoff` output**, in the order `--order` gave.
Everything the spec says about ordering is copied from that handoff, never worked out again from
reading the docs.

## Template

```markdown
# <Feature name, the inventory's own name>

Feature: FEAT-0003
Blocked-by: FEAT-0001, FEAT-0002
Status: planned

## Problem

What is wrong or missing today, from the point of view of whoever feels it. One or two paragraphs,
no solution in them.

## Solution

What exists once this ships, from the same point of view. The feature's `scope` paragraph from the
inventory is the seed; this is that paragraph made concrete, including what "done" means.

## Ordering

The three facts, in prose, from the `--handoff` output:

- **What must already exist** - each blocker with the reason the handoff gave, naming the thing:
  "consumes the settlement contract FEAT-0004 lands".
- **What this delivers that others wait on** - the dependents, so it is clear why the contract this
  feature lands has to be stable rather than convenient.
- **What may run alongside** - its wave-mates, so parallel work reads as parallel.

Nothing blocking it and nothing waiting on it is a complete answer: "Nothing blocks this and nothing
waits on it."

## Implementation decisions

The decisions already made, and where they came from - the ledger ids behind the feature
(`DEC-0012`), the component specs and contracts it touches, the schema or interface shapes it is
bound by. No file paths, no code snippets; they go stale before the card is picked up.

An open decision belongs in "Questions", not here as a guess.

## Acceptance

What has to be observably true for this feature to be finished, as a list. The card's acceptance
criteria are drawn from this list, so anything vague here becomes a vague checkbox on the Board.

- [ ] Observable, testable condition
- [ ] Observable, testable condition

## Out of scope

What this deliberately does not do, especially the parts a neighbouring feature owns. Name the
neighbour by its FEAT id where there is one.

## Questions

Anything the docs left ambiguous that the operator ruled on during this run, with his answer. Empty
is the normal case - an unanswered question here means the spec was written over a guess.
```

## Rules

- `Feature:` and `Blocked-by:` are copied verbatim from the inventory. They are the trace back to the
  ledger, and the card carries the same `Feature:` line, so a card, a spec and a ledger decision can
  always be lined up.
- `Blocked-by:` holds FEAT ids, not card names. The card's `Needs:` holds card basenames; the script
  converts one to the other. A spec that names card numbers goes stale the moment the queue does.
- One feature, one spec, one card. When a feature is too big for one card, that is a question for the
  operator before anything is written, not a split invented here.
- Write what the docs support. Anything the knowledge base does not answer is a question for the
  operator, never a plausible sentence.
