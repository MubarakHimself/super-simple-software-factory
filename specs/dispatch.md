# specs/dispatch.md - the Board-to-factory seam

`adws/dispatch.py` is the one file that turns a `queue/*.md` card into a running ADW. It exists
because MAP rule 8 ("every lint/test/status-write/provision step is an orchestrator-invoked process
with an observable exit code") requires something between "operator queued this" and "an ADW is
running it" - the Board (UI, read-only, `specs/ui.md` 5.3) never launches anything itself.

Recorded here because the verifier flagged the gap: this file existed as working code with no
spec-of-record. What follows matches `adws/dispatch.py` and `adws/tests/test_dispatch.py` as they
stand today - no aspiration, no planned features.

## 1. What it is

A command, not a daemon (MAP rule 1, KISS): one dispatch, one subprocess, two write-backs (claim,
then terminal). Deliberately NOT an `adw_*.py` script - it opens no session of its own, so routing a
bad card never litters a `sessions` row with it (same reasoning as `adws/worktrees.py`,
`specs/worktrees.md` 8.1). The ADW it launches opens its own session and cuts its own branch and
worktree (`specs/worktrees.md` 4), exactly as it would run directly from the justfile.

```
uv run adws/dispatch.py queue/001-add-health-endpoint.md
uv run adws/dispatch.py --next
uv run adws/dispatch.py queue/001-add-health-endpoint.md --adw-id a1b2c3d4
uv run adws/dispatch.py --next --config adws/adw_sssf_config/sssf.config.yaml
```

`just work <file>` and `just work-next` are the justfile wrappers (`--queue-dir` overrides the
queue directory; default is `<repo root>/queue`).

## 2. The card contract

Parses one `queue/*.md` file: an H1 title, then the contiguous `Key: value` block directly under
it (`queue/TEMPLATE.md`'s shape), then a blank line, then the body. Parsing mirrors
`apps/ui/server/queue.ts`'s `parseHeaderBlock` exactly - `dispatch.QUEUE_STATUSES` is checked
against both `queue/TEMPLATE.md`'s comment and `queue.ts`'s `VALID_STATUSES` by
`test_queue_status_vocabulary_matches_template_and_queue_ts`, so the two parsers cannot silently
drift apart.

Fields read: `Status` (`ready-for-agent | running | blocked | done`), `Adw`, `Adw-Id`; `Created`
and `Context` are passed through, never interpreted. `Adw` must name one of the 8 writing ADWs
(`specs/worktrees.md` 4.1: `build`, `build-review`, `build-test`, `document`, `plan-build`,
`plan-build-test`, `plan-build-test-quality`, `simple-sdlc`). The 4 read-only ADWs (`adw_prompt`,
`adw_scout`, `adw_plan`, `adw_quality`) are refused - a card that expects a merge has no business
routing to one that cuts no branch.

## 3. Claim / idempotence

- `Status: running` with no `--adw-id` -> refused (exit 2), card untouched. Two dispatches of the
  same card must never both start an ADW.
- `--adw-id` matching the card's own `Adw-Id:` -> proceeds (a deliberate rejoin).
- `--adw-id` that does not match the card's `Adw-Id:` -> refused.
- Any other status with an `Adw-Id:` already on the card (a `blocked` retry) -> reuses that id
  automatically, so a retry rejoins the SAME worktree/branch rather than orphaning the failed
  attempt's.
- A never-claimed card mints a fresh id: `secrets.token_hex(4)`, 8 hex chars.

Write-backs (`write_status`) touch only the `Status:`/`Adw-Id:` lines - title, body, and every other
byte survive round-trip untouched. At most two writes per run: claim (-> `running`), then exactly
one terminal write (-> `done` on exit 0, `blocked` otherwise - including a launch failure, e.g. `uv`
not found, which still resolves to `blocked` rather than leaving the card stuck on `running`).

## 4. The prompt handed to the ADW

Every writing ADW takes one positional CLI argument that does two jobs once inside it: it is the
request text (engineer, planner, builder, reviewer, documenter all read it verbatim), and it is
what `Run.enter_worktree` slugifies into the branch name (`specs/worktrees.md` 3.2,
`git_helper.slugify` - first four alphanumeric words, lowercased, dash-joined). `request_prompt()`
builds that one string as `<H1 title>\n\n<body>`: the title leads, so slugify's first-four-words
rule reads a legible per-card title ("add-a-health-endpoint") instead of the "## Agent Brief"
boilerplate every card starts with identically ("agent-brief-category-enhancement" on every single
card, regardless of what it asks for). The full body follows untouched - the ADW's actual task does
not shrink to the title, only the slug source changes.

## 5. `--next`

The lowest-numbered `queue/*.md` file (filenames are zero-padded, so lexicographic order is numeric
order) whose `Status` is `ready-for-agent`. Non-recursive - `queue/done/` is a directory, never a
candidate, and never descended into. Malformed cards are skipped silently (they are the Board's
"Unparsed" bucket, not `--next`'s business).

## 6. What it deliberately does not do

- Never moves a card into `queue/done/`. That is the MERGE event; Gate owns it (`specs/ui.md` 5.4),
  reading `sessions.status` and git directly, never this file's `Status:` line.
- Never cuts a branch or worktree itself - the ADW does that, per `specs/worktrees.md` 4.
- Never runs more than one subprocess per invocation, and never in the background - `just work`
  streams the child's stdout live, the same way `just simple-sdlc` does when run directly.

## 7. Exit codes

`0` - the ADW ran and exited 0 (card written `done`). Non-zero - the ADW's own exit code (card
written `blocked`), or `2` for a dispatcher-level refusal (bad `Adw:`, an in-progress card with no
matching `--adw-id`, a missing header line, no such file) - a `2` touches the card not at all.

## 8. Tests

`adws/tests/test_dispatch.py` - hermetic, no network, no pi, no model calls; the one subprocess
boundary (`dispatch._stream`) is monkeypatched to a fake that never actually launches anything.
Covers: header parse/write-back round trip, the vocabulary cross-check (2), unknown-`Adw:`
rejection, claim/idempotence (3), the title-led prompt and its slug (4), end-to-end success/failure
paths (7), and `--next` selection (5).
