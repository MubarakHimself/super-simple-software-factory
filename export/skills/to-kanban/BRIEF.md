# The agent brief

The brief is the body of a queue card, and the card is everything the building agent gets - no
conversation, no docs directory, no issue thread. It is the contract, and it is read cold, possibly
days later, by an agent working in a fresh worktree cut from a branch that has moved since.

The shape below is `AGENT-BRIEF.md`'s, unchanged - the same seven fields the Board renders and the
morning brief walks as checkboxes. Keep it exactly.

## Principles

### Durability over precision

The card may sit in `ready-for-agent` for days. The code will change meanwhile. Write so the brief
still lands after a rename.

- **Do** describe interfaces, types, and behavioral contracts.
- **Do** name specific types, function signatures, or config shapes to look for or modify.
- **Don't** reference file paths - they go stale.
- **Don't** reference line numbers.
- **Don't** assume the current implementation structure survives.

### Behavioral, not procedural

Describe **what** the system should do, not **how** to build it. The agent explores the code fresh
and makes its own implementation decisions.

- **Good:** "The `SkillConfig` type should accept an optional `schedule` field of type `CronExpression`"
- **Bad:** "Open src/types/skill.ts and add a schedule field on line 42"

### Complete acceptance criteria

The agent needs to know when it is done, and the factory's reviewer checks the diff against exactly
this list. Every criterion independently verifiable, observable from outside the code.

- **Good:** "`GET /health` returns 200 with `{status, uptime_seconds}` and no auth header"
- **Bad:** "Health checks should work correctly"

### Explicit scope boundaries

State what is out of scope. It is what stops an agent gold-plating into the next card's territory -
and in a batch, the next card usually exists already.

## Template

```markdown
**Category:** bug / enhancement
**Summary:** one-line description of what needs to happen

**Current behavior:**
What happens today. For a feature built on nothing, this is the absence, stated plainly.

**Desired behavior:**
What should happen once the work is done. Specific about edge cases and error conditions.

**Key interfaces:**
- `TypeName` - what needs to change and why
- `functionName()` return type - what it returns now vs what it should return
- Config shape - any new configuration options needed

**Verification lens:** how "done" is shown to be true, when the docs declare one (see below)

**Acceptance criteria:**
- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2
- [ ] Specific, testable criterion 3

**Out of scope:**
- Thing that should not be changed or addressed in this card
- Adjacent feature that looks related but is separate
```

`**Verification lens:**` is optional and belongs in the brief only when the knowledge base declares
one - a sentence in the feature's `scope` or `notes` naming the evidence that settles it (a recorded
run, a screenshot, a named test suite, an eval metric). Carry that sentence through, and phrase the
evidence as one acceptance criterion as well, so the reviewer and the operator's checkbox walk both
see it. No declaration in the docs, no line on the card.

## When the deliverable is a trained model

A feature whose output is a trained model ships a **training script and a runbook**, never a training
run. The card's acceptance is that the script runs end to end on a small slice - a smoke-train - and
that the runbook is present. The card says plainly, in its own words, that the operator runs full
training himself on his own machine; the factory never starts one.

Every downstream card that needs the model states its precondition in acceptance - "given a model
artifact at the path the runbook names" - so a card that cannot yet be true is visible as such
instead of failing halfway.

```markdown
**Acceptance criteria:**
- [ ] `train.py --slice 200 --epochs 1` completes end to end and writes a checkpoint
- [ ] The runbook states the full-run command, expected wall time, hardware, and where the
      artifact lands
- [ ] The runbook states the eval metric and the number that decides promotion

**Out of scope:**
- Running full training - the operator runs that himself, on his own machine
```

## A good brief

```markdown
**Category:** enhancement
**Summary:** Serve a health endpoint the engine can poll without authentication

**Current behavior:**
The service has no unauthenticated endpoint. A caller that wants to know whether the process is
up has to authenticate and request a real resource, so a monitor needs credentials to answer a
question that is not about credentials.

**Desired behavior:**
An unauthenticated `GET /health` returns 200 with a JSON body carrying the service's status and
its uptime in seconds. It never touches the database, so it stays truthful about the process even
while storage is degraded, and it answers in under 50ms.

**Key interfaces:**
- The HTTP router - one new route, registered before the auth middleware rather than exempted
  inside it
- The response body shape `{status: "ok", uptime_seconds: number}` - `status` is a fixed string
  today, so a caller can start matching on it

**Acceptance criteria:**
- [ ] `GET /health` returns 200 and that JSON body with no auth header present
- [ ] The handler makes no database call, verified by a test with storage unavailable
- [ ] An unknown method on `/health` returns 405, not 200
- [ ] The route is covered by a test at the same seam the other route tests use

**Out of scope:**
- Readiness or dependency checks - this reports the process, not the system
- Metrics, tracing, or any other endpoint
```

## A bad brief

```markdown
**Summary:** Fix the health thing

**What to do:**
The health check is broken. Look at the main file and fix it. The function around line 150 has
the issue.

**Files to change:**
- src/server/handler.ts (line 150)
```

No category, a vague claim in place of current-and-desired behavior, file paths and line numbers
that go stale, no acceptance criteria, no scope boundary. An agent handed this in a fresh worktree
has to invent the specification, and the reviewer has nothing to check the diff against.
