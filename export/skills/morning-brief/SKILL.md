---
name: morning-brief
description: Gate 2 for an SSSF-style software factory - a plain-words, non-technical brief on what the factory's coding-agent runs did since you last checked (which run, which branch, what actually changed, what the quality checks and gates concluded, what it cost), followed by a conversation confirming each run matches what was agreed, ending with that run's compare/PR link as the only merge button. Never merges, never pushes, never runs a git or gh command that writes - the click stays the operator's. Use when the operator says "morning brief", "what happened overnight", "what did the factory do", "brief me before I merge", or otherwise wants an overnight run, session, or worktree explained in plain language before deciding whether to ship it.
---

# Morning Brief

The factory runs unattended; the operator is not technical enough to read a trace, a diff, or a
JSON envelope and get anything out of it. This skill is the one conversation where that gap
gets closed before any run reaches `main` - it reads what the factory actually recorded, says it
back in plain words, and stops. It never merges anything itself; it ends every run with a link and
hands the click to the operator.

## Why plain words

Write every paragraph in this conversation the way `/wait-what` would: short sentences, one idea
each, ASD-STE100-simple ("Simplified Technical English" - the register aircraft manuals use so a
non-native reader never has to guess a meaning). No jargon words like "envelope", "phase", "gate",
"diff", or "adw_id" reach the operator unexplained - translate them into what actually happened
("the plan-writing step", "the branch it worked on", "what changed", "this run's id"). If a
follow-up needs a technical word, define it in the same sentence, once.

## Inputs

- **The target repo.** Wherever SSSF is stamped in and running - default to the current directory,
  but ask if it's ambiguous (the operator works across more than one factory-driven project).
- **Since when to brief.** Ask, or infer from context ("since yesterday", "the last 10 runs"). If
  neither is offered, check for a saved cutoff first (see [Remembering where you left
  off](#remembering-where-you-left-off)); with nothing to go on, default to the 5 most recent
  completed runs and say plainly that's what you're showing.

## The flow

### 1. Collect

Run the collector once, read-only, against that repo:

```
python <this-skill-dir>/scripts/collect_runs.py --repo <repo> --since <ISO8601> --pretty
```

(swap `--since <ISO8601>` for `--last <N>` when there's no cutoff to resume from). Read its exit
code before doing anything else:

| Exit | Meaning | What to say |
|---|---|---|
| 0 | Digest printed. `run_count` may be 0 - that's a complete, valid brief. | If 0: "the factory did nothing since <cutoff> - nothing to brief." Otherwise proceed to step 2. |
| 2 | Bad arguments (should not happen if you built the command from step 1). | Fix the command and retry once; don't guess at output. |
| 3 | No `sssf.db` at the resolved path. | Say plainly: this repo hasn't run the factory yet, or the repo path is wrong. Ask which repo they meant. |
| 4 | The db exists but couldn't be read (locked, corrupt). | Report the script's own error text verbatim. Stop - do not narrate runs you couldn't actually read. |

### 2. Narrate one run at a time, oldest first

The collector returns newest-first; reverse the list so the operator hears the night unfold in the
order it happened. For **each** run, do these in order:

**a. The plain-English paragraph.** One paragraph, no jargon, built only from what the digest
actually contains:

- *What it worked on* - lead with `title` when it's set (a short human name, e.g. "Add a login
  flow" - say it like a ticket title, not a technical term); fall back to the full `request` (the
  prompt/ticket in the requester's own words) only when `title` is null.
- *Where* - `branch` if the run cut one ("it worked on a branch called `adw/...`"); if `branch` is
  null, say so plainly ("this run never created a branch - there's no code change to look at").
  `worktree` is the filesystem path that branch's own working copy lived in while the run was
  in flight - useful mainly when several runs overlapped ("branch `adw/...`, in its own worktree at
  `...`"); null on the same runs `branch` is null on, and also on any run recorded before this
  factory started stamping it (say "the factory didn't record which worktree ran this one" rather
  than guessing).
- *What changed* - describe it from `phases` (which steps ran: planning, building, testing,
  reviewing, documenting - by their plain purpose, not their internal `name`/`kind`) and from each
  phase's entry in `notes_for_next_agent` (`summary`, `changed_files`, `document_path`,
  `commit_message` when present). **Never paste or summarize a raw diff** - if the operator wants
  to see the actual lines that changed, point them at the repo's own Gate/diff view (if one is
  running) or `git diff` themselves; this conversation stays in plain language.
- *What the checks concluded* - `quality` and `gates`, translated: "the tests passed, the style
  checker found problems, and the AI-defect scanner couldn't run at all on this machine, so that
  one's unknown, not passed" (an `incomplete` check is never reported as a pass or a fail - say
  it wasn't answered). A gate's `checks`/`violations` become "it looked for X and found it" /
  "it looked for X and didn't find it", never the raw JSON.
- *What it cost* - `tokens.total_tokens` and `tokens.total_cost` as a plain sentence ("about
  15,000 tokens, no dollar cost - this ran on a flat-rate lane" when cost is 0).
- *What card it worked from, if any* - when `card` is not null, name it by title in the paragraph
  ("this matches the card on the board called '<card.title>'") so the operator can tell which
  ticket the run was answering. When `card` is null, say nothing about a card at all - this run
  was never dispatched from one (a direct run, or a repo not using the queue), and the rest of the
  paragraph is unaffected.

**b. The checklist walk - only when this run has a card.** When `card` is not null, walk its
`criteria` list one item at a time, in plain words, before asking the operator anything. Each item
gets its own short beat, built the same way every time: *"the card asked for `<criteria[i].text>`
- here is where the run's record shows that happened: `<the evidence>`."* The evidence comes from
the same places (a) draws from and nowhere else - `phases`, `notes_for_next_agent` (`summary`,
`changed_files`, `commit_message`), and `gates` (`checks`/`violations`) - said in plain words, not
pasted as JSON. **When the digest holds nothing that speaks to a criterion, say exactly that and
stop there** - the fixed phrase is *"cannot confirm from the record - check the compare page for
this one"* - word for word, so the operator learns to recognize it as this skill's own honest "I
don't know," never a soft dodge or an invented match. Mark each item done or not-yet the same way:
from the run's own record, never from the card's own `done` checkbox alone (a card can say
`- [x]` and the run's record can still hold no evidence for it - report the gap, don't trust the
checkbox). This walk is `/code-review`'s spec-conformance axis - *does the run's work match what
was asked for* - carried into plain words for a non-technical reader; it never substitutes for or
softens the factory's own quality checks (tests, style, the AI-defect scanner) from (a) - those are
reported exactly as they are regardless of what this walk finds. **When `card` is null, skip this
step entirely** - the flow is exactly what it was before this walk existed: the paragraph, then
straight to the open question below.

**c. The open question.** Ask: *"Does this match what we agreed?"* Then actually wait for the
answer before moving on. Answer follow-ups using only what's in that run's digest entry (including
its `card`, when present) - offer to show the full JSON or the gate's raw checks if asked, but
don't dump it unprompted. **If the digest has no record of something the operator asks about, say
so honestly** ("this run left no note about that") - never invent an answer to fill the gap.

**d. The merge button.** Close the run's segment with exactly one of these, decided only now
(after the conversation, and only by checking git - never by guessing):

- **Shipped already:** if `branch` is set and it's already an ancestor of `main`
  (`git merge-base --is-ancestor <branch> main`), say so - nothing left to do.
- **Ready to ship:** if `status` is `success`, `branch` is set, and it's *not* yet merged - compute
  the compare/PR link (below) and give it as the one next step: *"here's the link - click it when
  you're ready."* Do not click it. Do not run `git push`, `git merge`, `gh pr create`, `gh pr
  merge`, or any other write to the repo's git state, ever, for any reason, even if the operator
  says "just merge it for me." Tell them the click is theirs.
- **Nothing to ship:** if `status` is `fail`, or `branch` is null, say plainly there's nothing to
  merge and why, in one sentence ("this run failed during the quality checks and never reached the
  build step" / "this run only reported findings - it never wrote code").

### 3. Computing the compare/PR link

Only for the "ready to ship" case, and only with real git commands - never construct a URL from
guesswork:

1. If this repo has its own Gate/UI view of runs already running, prefer pointing the operator
   there directly - it renders the same link next to the actual diff.
2. Otherwise, from the target repo: `git remote get-url origin`. No remote, or the command fails ->
   there's no compare link; give the operator the branch name and the exact command instead:
   `git push -u origin <branch>`.
3. Match the remote URL against GitHub's two forms: `git@github.com:<owner>/<repo>(.git)` or
   `https://github.com/<owner>/<repo>(.git)`. No match (a non-GitHub remote, e.g. GitLab/Bitbucket)
   -> same fallback as above (branch name + push command); don't invent a compare URL for a host
   this logic doesn't know.
4. On a match: `https://github.com/<owner>/<repo>/compare/main...<branch>?expand=1` (URL-encode the
   branch name). That is the link - present it plainly, e.g. *"When you're ready:
   `https://github.com/.../compare/main...adw/...`"*.

### 4. Never

- Never `git push`, `git merge`, `git commit`, `gh pr create`, `gh pr merge`, or any other write to
  the target repo's git state, at any point in this skill, for any run, no matter what the operator
  asks. The compare/PR link is the entire extent of this skill's involvement in shipping.
- Never invent a branch, a worktree, a diff summary, a note, a check result, a card, or a
  criterion's match to evidence the run didn't actually record. A gap in the digest is reported as
  a gap - for the checklist walk specifically, that gap is always the fixed phrase "cannot confirm
  from the record - check the compare page for this one," never a guess dressed up as a match.
- Never lead with raw JSON or a raw diff. Translate first; offer the raw form only if asked.

## Remembering where you left off

Optional, best-effort convenience - never required for the flow above to work. After finishing a
brief, you may record its cutoff so the next invocation can resume from it automatically: write
`{"repo": "<resolved repo path>", "last_brief_ended_at": "<the newest ended_at you just
briefed>"}` to `<this-skill-dir>/state/<a short, filesystem-safe slug of the repo path>.json`. On
the next invocation, if the operator hasn't given a cutoff, check for that file first before
falling back to `--last 5`. This state lives entirely inside the skill's own directory - it is
never written into the target repo.

## Reference: what the digest actually contains

Every field the collector can hand you. Most come straight from what `adws/adw_modules/tracer.py`
records; `card` is the one exception, read live off the queue's own files instead - nothing here is
inferred or computed beyond what's noted:

| Field | Where it comes from | Notes |
|---|---|---|
| `adw_id`, `adw_name`, `status`, `engineer` | `sessions` table | `adw_name` can be several ADWs joined with " + " (a continued run). |
| `request` | `sessions.request` | The prompt/ticket text, clipped to 300 chars. |
| `started_at` / `ended_at` / `duration_seconds` | `sessions` | Computed from the two timestamps. |
| `branch` | a `log` event named `branch`, its `branch` key | Null on any run that never cut one (scout/prompt-only, or a run that failed before reaching that phase). |
| `worktree` | the same `branch` event, its `path` key | The branch's own working-copy path while the run was in flight. Null wherever `branch` is null, and also on telemetry recorded before this factory stamped it at all. |
| `title` | the same `branch` event's `title` key, else the branch slug humanized ("add-a-clamp-helper" -> "Add a clamp helper") | The run's short human name (MAP.md's worktree-naming ticket - "an id tells me nothing"). Null wherever `branch` is null; never invented past that fallback. |
| `tokens.total_tokens` / `tokens.total_cost` | `sessions` | Summed across every phase and retry. |
| `phases` | `phases` table | Each step's name, kind, status, attempt/retry count, and (clipped) error. |
| `quality` | the `quality` phase, plus its `quality:<check>` `tool_call` events | Per-check `status` is `pass` / `fail` / **`incomplete`** - three states, never collapsed to a bool. `incomplete` means the tool never ran (missing toolchain, timeout) - it is not evidence the code is broken, and it is not a pass either. |
| `gates` | `gate_results` table | What each gate looked for (`checks`) and what it concluded (`passed`, `violations`). |
| `notes_for_next_agent` | the final valid `envelopes` row per phase | Quoted, not paraphrased - this is what the agent itself said carries forward. |
| `card` | `<repo>/queue/*.md` or `<repo>/queue/done/*.md`, whichever file's `Adw-Id:` line matches this run's `adw_id` | `{path, title, status, criteria}` - `path` relative to the repo, `title`/`status` the card's own H1 and `Status:` line, `criteria` the "Acceptance criteria" checkbox list as `[{text, done}]` in file order. Null on any run no card names - direct/non-dispatched runs, or a repo not using the queue at all. This is what step 2b walks. |

A run with nothing recorded in one of these is not a bug in the collector - it means that step
never happened for that run. Report it that way.
