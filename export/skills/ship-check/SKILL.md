---
name: ship-check
description: The operator's deep-dive before a finished chunk ships from integration to main - runs adws/ship_report.py for the assembled shipping summary, then on request walks each card's acceptance criteria against its merged diff and committed docs, and only on the operator's explicit word performs the one squash merge into main (confirming the message and the push, refusing a dirty tree, never --force). Use when the operator pastes the UI's copy-prompt (card names and adw-ids for a chunk that's ready to ship), says "ship check", "ready to ship", "let's ship this", "walk me through this chunk", or otherwise wants the pre-merge review before touching main, in a checkout of an SDL-Factory-style repo.
---

# Ship Check

This is Gate 2 for the two-box model (MAP.md): the engine already rebased, re-verified and
fast-forward-merged every finished run into `integration` by itself, and parked its card in
`queue/done/`. Nothing here re-does that work or re-judges it - code assembled the report, this
skill presents it and, when asked, digs. The one thing this skill may write is the single squash
commit that moves a finished chunk from `integration` onto `main`, and only on the operator's
explicit word in this session.

**This supersedes `/morning-brief` in the daily flow.** Read `/morning-brief`'s SKILL.md first -
its honesty rules, its checkbox-walk pattern, and its plain-words register all carry over here
unchanged. What's different is depth, not vocabulary: morning-brief never leaves its own pre-built
digest; this skill actually runs git and reads files - the real branch, the real diff, the real
docs - then says what it found back in the same plain words morning-brief would use. Translate
before saying it back: no unexplained jargon, no raw diff or raw JSON dumped on the operator.

The operator dictates loosely ("what's ready", "walk me through the clamp helper one"). Read for
intent rather than waiting for exact phrasing.

## Inputs

- **The checkout.** Default to the current directory; ask if it's ambiguous (more than one
  SDL-Factory-style repo in play). It should be the operator's normal checkout, not one of the
  engine's own `../*-worktrees/` trees cut for a single run - if `cwd` looks like one of those,
  say so and confirm before going further, especially before step 3.
- **The trigger.** Either the UI's copy-prompt (card titles and adw-ids for a chunk that's ready)
  or a bare invocation with nothing attached. Either way, step 1 supplies the authoritative list -
  nothing needs to be parsed out of the prompt by hand.

## The flow

### 1. Assemble the report

Two commands, from the repo root:

```
git fetch origin
uv run adws/ship_report.py --integration origin/integration
```

`git fetch origin` moves no branch and touches no file - it updates the remote-tracking refs only.
It comes first because the hub is the truth: the server pushes card parks and status write-backs
all day, so a laptop's own `integration` branch is routinely behind, and `--integration
origin/integration` is what points the report at the same ref step 3 squashes. Report a failed
fetch in plain words and carry on against what's local, saying the view may be behind the hub.
On a checkout with no `origin` at all, run `uv run adws/ship_report.py` with no flag.

`ship_report.py` is owned by a different lane (its contract: `uv run adws/ship_report.py
[--pr|--changelog] [--integration REF] [--range BASE..TIP] [--out FILE]`) - reference it, don't
second-guess its output or reimplement any of its logic here. If a flag's exact syntax matters and
isn't obvious, run `uv run adws/ship_report.py --help` rather than guessing.

- **Exit 0, something printed:** show it as it is. This step is presentation, not narration - the
  report is code-assembled ("code assembles, nobody judges" - MAP.md), so don't re-summarize it in
  different words, don't add a claim it didn't make, and don't render a verdict. If what comes back
  is structured rather than prose (raw JSON, a table dump), translate it into plain sentences before
  relaying it - the same rule morning-brief follows for its own digest; offer the raw form only if
  asked. If the copy-prompt named cards or adw-ids that don't line up with what came back, say that
  mismatch out loud rather than quietly trusting one side over the other.
- **Exit 0, nothing to ship:** say so plainly - nothing on `integration` ahead of `main` right now.
  There is nothing to interrogate and nothing to squash; stop here, honestly, rather than inventing
  a chunk to talk about.
- **Nonzero exit, or `adws/ship_report.py` doesn't exist in this checkout:** report the exit code
  and stderr verbatim, or say plainly it hasn't landed here yet (it's built in a parallel lane, and
  may not be in this checkout at this commit). Stop. Do not fall back to hand-building a summary
  from raw trace data - that is morning-brief's job, and this skill exists specifically not to redo
  it.

### 2. Interrogate, on demand

Only when the operator pushes past the summary - asks about a specific card, doubts a claim, wants
to see something work. Step 1 alone is a complete, valid session if the operator just says it looks
right.

For each card the operator wants dug into:

- **Find it.** Match by `Adw-Id:` against `queue/done/*.md` first - a finished, integrated card
  should be parked there. Cards parked on `integration` are not in `main`'s tree, so from a
  checkout standing anywhere else read the card out of git rather than off disk:
  `git show origin/integration:queue/done/<name>`. If it's still in `queue/` (`Status: done` and
  not yet parked, or earlier than that), say so: the engine's integrate step hasn't picked it up
  yet, so it isn't ready for this review. Don't guess at a card that can't be found; ask.
- **Read its acceptance criteria** - the `- [ ]` list under "Acceptance criteria" in the card file
  (`queue/TEMPLATE.md` is the contract).
- **Read the merged diff for its branch.** The branch ref `adw/<adw-id>_<slug>` still exists and was
  never rewritten - engine.md's integrate step rebases a *detached copy* for the merge, never the
  branch itself - so its own commits sit directly on top of wherever `integration` was when the
  worktree was cut. Measure against `origin/integration`, the hub's copy, which only ever advances
  by fast-forward: `git merge-base origin/integration adw/<adw-id>_<slug>` is the branch's true
  fork point, no reflog archaeology needed, and `git diff <that>..adw/<adw-id>_<slug>` (or `git log`
  the same range) is exactly what the run committed. A server's *local* `integration` is a
  different story - engine.py's pull runs `git pull --rebase` when the hub and the server have both
  moved, which gives this box's own commits new shas and can strand a young branch's fork point.
  Whenever the diff comes back empty, or wider than one card's work, cross-check against the
  commits named in the run's own trace (`notes_for_next_agent.commit_message`, the same field
  morning-brief's digest reads) rather than guessing which commits are the run's own.
- **Check its docs.** Two places to look, not one: a `document` phase inside the run's own trace
  (`notes_for_next_agent.document_path`, same source morning-brief reads), and - if this project has
  it wired up - the separate post-merge documentation-factory session MAP.md describes, which runs
  after the merge, on the laptop. `git log` on `integration` around the card's park commit shows
  anything in `docs/` the run's own branch doesn't already account for.
- **Walk the criteria against that record**, one at a time, morning-brief's pattern: *"the card
  asked for `<criterion text>` - here's where the record shows that: `<the evidence>`."* Evidence
  comes only from what was just read - the card, the diff, the trace, the docs - never from taking
  a commit message or an agent's own note at face value without checking it against the diff itself.
  **When none of that confirms a criterion, say exactly that - "cannot confirm from the record" -
  never invent a match, never round a partial answer up to done.** This skill can go one step
  morning-brief can't: since the operator is right here in a real checkout, offer to actually read
  the code and check, when asked - that's the escalation past the diff, not the default for every
  criterion (an interrogation that auto-audits every line of every card isn't "on demand" any more).
  Whatever depth it reaches, say the finding back in plain words - what a passing/failing/missing
  check means in effect, not the raw diff hunk or file listing.

### 3. The squash - only on the operator's explicit word, in this session

Never inferred from the interrogation going well, from silence, from the copy-prompt having been
pasted, or from a standing instruction in an earlier session. The operator has to actually say it
("squash it", "ship it", "merge to main") in the conversation this skill is running in.

**Preconditions, checked before anything moves:**

1. `git status --porcelain` in this checkout - anything at all (staged, unstaged, untracked)
   refuses the whole step. Say what's dirty and stop. Never stash it, never clean it, never push
   through.
2. `git branch --show-current` - record it as `<start-branch>`, where step 6 returns to. A detached
   HEAD refuses the same way the dirty tree does.
3. `git fetch origin` - report a failure honestly and stop; squashing a stale `integration` is worse
   than waiting sixty seconds.

**Then, with the operator's go-ahead before the sequence starts:**

1. `git checkout main`
2. `git merge --squash origin/integration` - stages the combined diff, commits nothing yet. A
   conflict here stops the flow: report git's own words, leave the index exactly as git left it, and
   name the operator's choices (resolve by hand, or `git merge --abort` to back out). Never resolve
   it yourself, never force anything.
3. The commit message, written straight to a file - never pasted into a shell argument:

   ```
   uv run adws/ship_report.py --integration origin/integration --pr --out .git/SQUASH_BODY.md
   ```

   Every line of that report is backtick-quoted markdown (`` `001-alpha.md` ``, `` `adw/aaa1_work` ``),
   and no shell carries it through an argument intact - PowerShell reads a backtick as its escape
   character (`` `0 `` becomes a NUL byte git rejects), bash runs the text between backticks as a
   command. `--out` hands git a file instead, and `.git/` keeps it out of the working tree.
   **Read the file back to the operator and get an explicit yes, or their edit, before committing.**
   This text becomes the permanent record of what shipped; it doesn't go in silently. An edit is an
   edit to that file.
4. `git commit -F .git/SQUASH_BODY.md --cleanup=whitespace` - `--cleanup=whitespace` keeps the
   `#` headings, which git's other cleanup modes strip as comments. Then `git log -1 --format=%B`
   and confirm what git recorded is what the operator approved; a mismatch stops the sequence.
5. **A separate, explicit confirmation here** - this is the one truly irreversible step, the point
   past which `main` has actually moved on the shared remote: `git push origin main`.
6. `git checkout <start-branch>` - back to where the session started.

Any step failing stops the sequence and reports git's exact words. No `--force`, no `-f`, no
force-push, anywhere, for any reason, even if asked.

**If the operator never asks for step 3:** mention once, at most, that the option exists (e.g. at
the end of a clean step 1 with nothing outstanding from step 2) - never repeat the offer unprompted
after that.

## Never

- Never treat a pasted copy-prompt, or a "looks good", as consent to squash - only an explicit,
  in-session word for it is.
- Never invent evidence for a criterion, a diff, a doc, or a commit the record doesn't actually
  show. A gap is reported as a gap - the fixed phrase is "cannot confirm from the record."
- Never fall back to hand-narrating from raw trace data when `ship_report.py` fails or is missing -
  say so and stop; that path belongs to morning-brief, not here.
- Never `git commit`, `git merge`, or `git push` without the confirmations step 3 lays out, and
  never outside step 3 at all.
- Never `--force`, under any name, for any reason.
- Never lead with raw JSON, a raw diff, or unexplained jargon - translate first, same as
  morning-brief; offer the raw form only if asked.
