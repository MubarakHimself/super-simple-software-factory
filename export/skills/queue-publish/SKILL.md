---
name: queue-publish
description: Write a triaged agent brief into a repo's queue/ as a new queue/NNN-slug.md file so it appears on the Kanban Board on its next poll, no restart needed. Use when the operator says "publish to the queue", "put this on the board", "queue this brief", or a planning/triage chain has just produced a brief that needs to land where the Board reads from.
---

# Queue Publish

The Board polls `queue/*.md` and only ever reads it — nothing in that app writes a queue
file. This skill is the missing writer: the last step of a planning chain, run by
whatever harness finished it (Claude Code, Codex, pi — the steps below assume nothing
harness-specific), that turns a triaged brief into a file the Board picks up live.

Stays generic on purpose: it never hardcodes a queue contract's field names or status
values. Every run re-reads the target repo's own `queue/TEMPLATE.md` — that file is the
contract, this skill is just the hand that follows it.

## Inputs

- A triaged agent brief in the `/triage` output format: `**Category:**`,
  `**Summary:**`, `**Current behavior:**`, `**Desired behavior:**`, `**Key
  interfaces:**`, `**Acceptance criteria:**` (checkboxes), `**Out of scope:**`.
- A title for the item.
- Optionally, blocking edges: other queue items this one can't start before
  (named in the brief or the upstream feature inventory as "needs X first",
  "blocked on X", "depends on X"). Carry these through as a `Needs:` header
  if the target's `TEMPLATE.md` documents one — see step 5.
- The target repo. If it isn't obvious from context, ask rather than guess — publishing
  to the wrong repo's queue is a silent miss, not a loud error.

## Steps

1. **Locate the target's queue.** Find `queue/` at the target repo's root. It must
   contain a `TEMPLATE.md` — that's the contract this run publishes against. No
   `queue/`, no `TEMPLATE.md`: stop and say so rather than inventing a shape.

2. **Read that `TEMPLATE.md` fresh.** Don't reuse a shape remembered from a previous run
   or another repo. Pull two things from it:
   - The header block: the contiguous run of `Key: value` lines directly under the H1
     title (blank line, then keys, ending at the next blank line). Every key that
     appears there is a required key in the file you're about to write, in the same
     order — even keys the template itself leaves blank (e.g. an ID a later run fills
     in).
   - Any enumerated values documented for a key (commonly `Status`, often spelled out
     in a trailing HTML comment, e.g. "one of: a | b | c"). Use exactly that vocabulary;
     don't invent or reuse values from a different project's contract.

3. **Compute the next number.** List `queue/*.md` (excluding `TEMPLATE.md`) plus
   `queue/done/*.md` if that directory exists — done items are parked, not deleted, and
   their numbers stay retired. Take the leading integer off each filename, find the max,
   add one, zero-pad to the width already in use (3 digits, `NNN`, if the queue is
   empty).

4. **Slugify the title.** Lowercase; collapse anything that isn't `a-z0-9` into a single
   hyphen; trim leading/trailing hyphens.

5. **Compose the file.** `# <Title>` as the H1, one blank line, the header block with
   the template's exact keys filled in (`Status` defaults to whatever the template
   marks as the ready state unless the brief says otherwise; leave a key blank if the
   template's own example leaves it blank — that's usually a later run's job to fill),
   one blank line, then the brief verbatim under `## Agent Brief`, acceptance-criteria
   checkboxes intact. If the template documents a `Needs:` key and the brief or
   feature inventory names blocking edges, fill it with the comma-separated
   basenames of the queue files those items landed as (e.g.
   `Needs: 001-auth-model.md, 002-schema.md`) — otherwise leave it blank, same as
   any other key the brief doesn't speak to.

6. **Write `queue/NNN-slug.md`.** Never overwrite an existing path — if one exists at
   that number, step 3 was computed wrong; recompute rather than clobber. Never write
   into `done/`, never touch `TEMPLATE.md`.

7. **Run the validator and read its exit code:**
   ```
   python <this-skill-dir>/scripts/validate_brief.py queue/NNN-slug.md
   ```
   Exit 0 means the Board can parse what you wrote. Exit 1 prints each violation to fix
   — read them, fix the file, run it again. A nonzero exit is never something to narrate
   past; the file isn't published until this is 0.

8. **Confirm.** Report the exact path written (`queue/NNN-slug.md`), plainly, so the
   operator can point the Board at it.

## What this skill does not do

It never edits an existing queue item, never writes `Status:` back on completion (that's
a separate, code-owned write path once a run claims an item), and never touches anything
outside `queue/`.
