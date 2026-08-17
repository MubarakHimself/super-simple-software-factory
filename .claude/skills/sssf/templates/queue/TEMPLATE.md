# Title of the change

Status: ready-for-agent
Adw: simple-sdlc
Adw-Id:
Created: 2026-08-12
Context:
Needs:

## Agent Brief

**Category:** enhancement
**Summary:** one line
**Current behavior:** what happens today
**Desired behavior:** what should happen instead
**Key interfaces:** files, functions, endpoints this touches
**Acceptance criteria:**
- [ ] first observable, testable condition
- [ ] second observable, testable condition
**Out of scope:** what this ticket deliberately does not do

<!--
Copy this file to queue/NNN-slug.md to start a new item (NNN zero-padded,
slug kebab-case). The UI only parses the Key: value block directly under the
H1 above - Status, Adw, Adw-Id, Created, Context, Needs. Status is one of:
ready-for-agent | running | blocked | done. Leave Adw-Id empty; a run sets it
when it claims this item. Needs is optional: a comma-separated list of other
queue card basenames this item is blocked on (e.g. "001-auth-model.md,
002-schema.md"); leave it empty (or omit the line) when there are no
dependencies. A named card satisfies Needs once the factory has PARKED it in
queue/done/, and not merely when it reaches Status: done. Status: done means
the agent finished and pushed its own branch; the factory then rebases that
branch onto the integration branch, re-runs the quality checks against the
rebased code and merges it, by itself, and only then moves the card to
queue/done/. That parking is the event Needs waits for, because it is the
moment the dependency's code is actually on the line the next run will be cut
from. main is the human's own branch - one squash merge per finished chunk,
clicked by you - and has nothing to do with Needs. The engine will not
dispatch a card whose Needs are not yet all satisfied. Everything under
"## Agent Brief" is the AGENT-BRIEF.md contract the triage skill writes:
durable, behavioral, with complete acceptance criteria and an explicit
out-of-scope line - written for an agent with no other context. The UI renders
it read-only and never writes back to this file.
-->
