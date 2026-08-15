# specs/engine.md - the always-on worker

`adws/engine.py` is the thing that makes the Kanban run by itself. It closes the unattended gap the
upstream project left open (`docs/research/video-2-notes.md:726` records it as an open question
there too): without it, a published card sits on the Board until a human types `just work`.

It is the server half of MAP.md's **two-box model** (ratified 2026-08-14). The laptop plans and
publishes; the server ships; git is the only transport. Since MAP.md's **integration branch** ruling
(2026-08-15) the engine also *finishes* the work: it merges a finished run into the factory's
working line by itself, after deterministic checks, and parks the card - which is what lets a wave
of dependent cards roll overnight without the operator.

What follows matches `adws/engine.py` and `adws/tests/test_engine.py` as they stand - no aspiration,
no planned features.

## 1. What it is

A command that loops, not a framework (MAP rule 1, KISS). One thread. Every git operation in the
factory's main checkout happens inside that loop and nowhere else, sequentially - which is not only
simpler, it is the mechanism that makes sibling run branches fast-forwardable one after another
instead of racing for the same tip (5). The ADWs it starts write **card files** only, and do their
real work in their own branches and worktrees (`specs/worktrees.md`).

```
uv run adws/engine.py                          # the service: loop until stopped
uv run adws/engine.py --once                   # exactly one cycle, then exit
uv run adws/engine.py --interval 30 --cap 4
uv run adws/engine.py --lanes "xai=2,opencode-go=1"
uv run adws/engine.py --queue-dir /path/to/queue
```

`just engine` is the justfile wrapper (`just engine --once` for a single cycle). On the server,
systemd runs the same command as `sdl-engine.service` (10).

It is not overnight-only and has no schedule: it works as long as there is work.

**`--once` is one cycle, not one shipment.** It does **not** wait for the runs it starts - a run
takes minutes and a cycle takes seconds. That is honest rather than lossy because the integrate step
reads the queue off **disk** (5): whatever a child finishes after the process exits is written to its
card as `Status: done`, and the *next* invocation of the engine picks it up from there and merges it.
The last line `--once` prints says exactly that, naming how many runs it left going.

**It requires `worktrees.enabled: true`** in the roster it is given, and refuses to start otherwise,
by name. With the layer off, a run's branch is cut *in the main checkout* (`git_helper.ensure_run_branch`) -
the one checkout this engine checks the working line out in, every cycle. It would yank a live run's
branch out from under it mid-flight, and no worktree would ever hold a finished branch for the
integrate step to rebase. An unreadable roster is not this refusal's business (dispatch refuses those
per card, visibly); only an explicit `enabled: false` stops the service coming up.

## 2. The two branches

```
  laptop (planning)                         server (the engine)
  -----------------                         -------------------
  queue-publish  --push-->   origin/integration   <--push--   card statuses, docs,
  docs, cards                    ^        |                   and every finished run
                                 |        | pull
                                 | push   v
                              [ integration ] <--ff-merge-- adw/<id>_<slug>
                                          |                       ^
     the operator's ONE squash            |                       | cut from integration
     per finished chunk, in the UI        |                       | (ensure_run_worktree)
                                          v
                                      [ main ]   human-owned. The factory never
                                                 checks it out, commits to it,
                                                 or pushes it.
```

- **`integration` is the living line.** Queue cards, their status write-backs, docs and every merged
  run live here. It is what the engine has checked out, pulls, pushes, and merges into. Runs are cut
  from it and fast-forwarded back into it.
- **`main` is human-owned**: one squash commit per finished chunk, merged by the operator in the UI
  ("what comes on `main` is never split work"). No code path in `engine.py` writes to it - the only
  time the name appears at all is as the *base* the working line is cut from the first time (4), and
  as a refusal: `SSSF_INTEGRATION_BRANCH=main` is rejected at startup rather than silently obeyed.
- **`SSSF_INTEGRATION_BRANCH`** names the working line for the rest of the factory too (the worktree
  and dispatch side read the same variable); unset, it is `integration`. Read once at startup - a
  branch that changed under a running service would be a different factory.

## 3. The cycle

Every `--interval` seconds, in this order:

0. **Can git name a committer here?** `git var GIT_COMMITTER_IDENT` in the main checkout. Every
   record this engine keeps is a commit, and a checkout with no identity fails every one of them, so
   a cycle that cannot answer does **nothing at all** and says which two commands fix it (7).
1. **Be on the working line** (4). One `rev-parse` in the normal case; a cycle that cannot get onto
   `integration` does **nothing else at all**, because every commit below belongs on that branch and
   nowhere else.
2. **Reap.** Every child that has exited: read its card's `Status:` (dispatch wrote it, not the
   engine), log one line with the exit code and the elapsed seconds, commit the write-back (6).
   Nothing is queued for integration here - **the card is the record**, and step 5 reads it back off
   disk on this same cycle. A child whose card does not say `done` is named in one line and
   integrated **not at all**.
3. **Adopt, then push.** Any `queue/*.md` card that differs from `HEAD` and has no live child behind
   it is committed as it stands, and everything pending is pushed (6).
4. **Pull.** `git pull --ff-only` in the main checkout. This is how new cards, the laptop's docs, and
   everything else arrive - there is no other channel. When the fast-forward is refused **because
   both boxes moved the working line**, this server's own card commits are replayed on top of the
   hub's history and the cycle continues (7). Any other failure logs one line and **the cycle stops
   there**: dispatching against a stale checkout is worse than doing nothing for 60 seconds. A
   checkout with no `origin` remote is local-only - no pull, no push, everything else unchanged.
5. **Integrate** every card the queue says is finished - `Status: done`, still in `queue/`, read off
   **disk** - one at a time, oldest NNN first (5).
6. **Scan.** `queue/*.md` (non-recursive - `queue/done/` is a directory and never a candidate;
   `TEMPLATE.md` is not a card) for `Status: ready-for-agent` whose `Needs:` are all satisfied,
   **oldest NNN first**. Malformed cards are skipped silently - they are the Board's "Unparsed"
   bucket, the same rule `dispatch.pick_next` follows.
7. **Route, then dispatch.** While live children < `--cap` **and every lane the run draws on has a
   free slot** (5.3), spawn `uv run adws/dispatch.py <card> --config <config>` as a **non-blocking**
   child (cwd =
   repo root; env = `operator_env()` plus `PYTHONIOENCODING=utf-8`, a per-child pin, never an ambient
   interpreter setting). stdout and stderr are inherited, so an ADW's console output lands in the
   same journal as the engine's own lines; the authoritative per-run trace is SQLite, read by the UI.
   When the roster carries a `router.builder_pool`, the builder's model is chosen **first** and
   `<config>` is this run's own derived copy of the roster (5.4). Then wait up to 10s for that
   child's `ready-for-agent -> running` write-back, and commit + push it in the **same** cycle - a
   card the server is already building must never still look free on the laptop's Board.
8. **Sleep**, and go again.

**Steps 2-3 come before the pull deliberately.** They are the engine's recovery: they clear the
local state - an uncommitted write-back, an unpushed commit - that a pull refuses to run over.
Behind the pull they could only ever run on a cycle that did not need them, and the service would
sit wedged on the one thing it could have fixed itself. **The integrate step comes just after the
pull** for the opposite reason ("rebase onto *current* integration" is only true if integration is
current) **and just before the scan**, so a card parked by an integration unblocks its dependents in
the *same* cycle.

**`Needs:` is met at the INTEGRATION, not at `done`** (`dispatch.needs_satisfied`). A named card
satisfies an edge once it is parked in `queue/done/`, and parking is now step 5's last act. `Status:
done` while the card is still in `queue/` means the ADW finished and pushed its own `adw/` branch -
the work is not on the working line yet, and a dependent dispatched there would cut its worktree from
an `integration` without its dependency in it (`worktrees.ensure_run_worktree` bases a fresh run on
trunk). `Needs:` exists to order the code, not merely the dispatch. That state is also never a
resting place: a card at `done` in `queue/` is exactly what the integrate step scans for (5), so it
is either merged and parked, or blocked with a named reason, on the next cycle that can run.

A card already held by a live child is excluded from the scan by name. This matters even though
dispatch writes `running` itself: between spawn and that write-back the card still reads
`ready-for-agent` on disk, and a scan landing in exactly that window would dispatch it twice.

## 4. Getting onto the working line

First thing, every cycle - so it is also the startup self-heal, and a checkout somebody left on
another branch fixes itself:

| State of the checkout | What the engine does |
|---|---|
| already on `integration` | nothing (one `rev-parse`) |
| `integration` exists locally | `git checkout integration` |
| only `origin/integration` exists | `git checkout -b integration --track origin/integration` |
| neither exists | `git checkout -b integration main` (the human-owned line it forks from and never writes to), then `git push -u origin integration` |
| the hub has never seen it | `git push -u origin integration` - which is also what gives `pull --ff-only` something to track |

A failure to get onto the branch is logged **once** (not once a minute) and the cycle returns
immediately. A failure to *publish* is logged once and the cycle continues: the pull will say so in
its own words, and the record is safe locally either way.

## 5. The integrate step - the merge_check phase, as code

**What feeds it is the queue on disk, not a list in memory.** Every cycle, after the adopt and before
the dispatch, `queue/*.md` is scanned for `Status: done` (non-recursive, oldest NNN first, skipping
any card a live child still holds). Each one is a card whose run finished and whose work is not on
the working line yet - *regardless of which process dispatched it*. That is the whole recovery: a
merge queue kept in RAM died with its process, so a card left at `done` in `queue/` by a restarted
engine (systemd's `Restart=always`, a converge re-running `enable --now`) or by an `--once`
invocation that exited while its child was still going was a **permanent dead end** - `report_stranded`
only names `running` cards, the dispatch scan (3) only considers `ready-for-agent`, and nothing on the
Board ever said why. The queue on disk IS the queue.

A card a live child still holds is skipped for one cycle: dispatch writes `done` just before its
process exits, and integrating a run whose worktree is still being written to would race it. The next
cycle reaps that child and picks the card up from disk anyway.

For each such card, in order, in the loop thread:

```
   card's Adw-Id:  ->  adw/<id>_<slug>  +  the worktree that holds it
        |
        |  git -C <worktree> checkout --detach adw/<id>_<slug>     the BRANCH REF never moves
        |  git -C <worktree> rebase integration        conflict -> abort, reattach, card blocked
        v
   quality suite in <worktree>              red / unrunnable -> reattach, card blocked
        |
        v
   git -C <main checkout> merge --ff-only <rebased sha>   ->  git -C <worktree> checkout <branch>
        |
        v
   push integration  ->  git mv queue/X.md queue/done/X.md  ->  commit  ->  push
                                                                    |
                                                     this is what unblocks Needs:
```

1. **Name the run.** The card's `Adw-Id:` gives the branch (`git_helper.find_run_branch`) and the
   worktree that still holds it (`worktrees.worktree_for`). Nothing is pruned here - `just worktrees`
   owns that, and it refuses anything unmerged. A card at `done` that fails one of those guards is
   **blocked with the reason on it**, never left silently in `queue/`: the disk scan above would
   otherwise re-read it every 60 seconds forever, and a dependent naming it would wait forever too.
2. **Rebase a DETACHED COPY, in that worktree.** `git checkout --detach <branch>`, then `git rebase
   integration` - which replays the run's commits onto the working line and leaves them on a detached
   HEAD. **The run's branch ref never moves.** Rebasing the branch itself (what this used to do)
   rewrote history the run had already pushed: `push_branch` then failed forever for any repair run
   (this factory has no `--force`, deliberately), and the hub's compare link kept showing pre-rebase
   code. The main checkout still never moves and never checks out a run branch (`specs/worktrees.md`
   invariant 1), and the engine still refuses to touch a worktree that is on some other branch. A
   conflict is `rebase --abort`ed at once, the worktree is put back on its branch, and the card is
   blocked with the reason.
3. **Re-run the deterministic suite against the rebased tree** - `ruff check .`, `mypy adws`,
   `pytest -q adws/tests`, each through `uv run --project <worktree> --group dev` (the same
   invocation `adw_modules/quality.py` uses, mirrored in `engine.quality_commands` so the tests can
   swap it). **Fail-closed**: a command that cannot run at all - missing binary, a toolchain that
   will not provision, a timeout - reads RED, never "unverified but fine".
4. **`git merge --ff-only <rebased sha>`** into the working line, in the main checkout. A commit is
   as good a merge argument as a branch name, and step 2 is what guarantees the fast-forward.
5. **Reattach, push, park, commit, push.** The worktree goes back onto its own branch - on *every*
   exit from the gate, green or red - because a repair dispatch for a blocked card rejoins that same
   worktree and both `worktrees.ensure_run_worktree` and step 1's own guard refuse a detached tree. A
   checkout that will not go back is named loudly with the one command that fixes it; nothing here
   ever forces it. Then the card moves to `queue/done/` (`git mv`, then a path-scoped commit
   `factory: <card> integrated`). Parking is not bookkeeping: `dispatch.needs_satisfied` is a
   `queue/done/` existence check, so this is the event that lets the next card in a wave start.

**One at a time.** Two sibling branches cut from the same commit both fast-forward - the second
after being replayed on top of the first. That is exactly the case that used to make the second
merge refuse, and it is why the integrate step is a loop over one list and not a fan-out.

**Nothing about the run's branch is ever pushed from here.** Its commits are already at the hub (the
run pushed them itself) and they still match, which is the whole point of rebasing a copy. The
rebased content reaches the hub on the working line instead, which is the only place it needs to be.

**Reconciliation still reads the branch as merged** afterwards, even though it is not an ancestor of
the working line: `worktrees.is_merged_into_trunk` compares **content** (`git merge-tree
--write-tree` against trunk's tree), which is exactly why a rebased copy landing on the line is
enough and `just worktrees` does not hold every integrated run forever as "HOLDS WORK".

**A branch holding nothing new is parked, not merged.** `integration..<branch>` empty means a run
that committed nothing, or a card whose work already reached the line and whose engine died before it
could park it. There is nothing to merge and nothing to check, so the card is parked as it stands,
with one log line - leaving it at `done` in `queue/` would hold every dependent behind it forever.
The engine never manufactures a merge to have something to park; this is the opposite, a park with no
merge because there is nothing left to merge.

(A card whose park itself failed is retried the same way: it is still at `done` on disk, so the next
cycle picks it up, rebases a fresh copy - git drops the commits it already applied - re-runs the
suite, fast-forwards to the same tip and parks it. Slower than it needs to be, and correct.)

### 5.1 Where the checks live (the ladder)

| Where | What | Who |
|---|---|---|
| **Inside the run** | the deterministic quality block, Skylos (`--ai-defects`, fail-closed), the bounded fix loops, and **exactly one** cross-family review agent | the ADW chains (`adws/adw_*.py`) - untouched by this spec |
| **The integration gate** (5) | rebase onto current integration + re-run the suite. **DETERMINISTIC ONLY. Never an agent, ever.** | `engine.integrate` |
| **Gate 2** | the operator's morning brief, then ONE squash merge into `main` | the human, in the UI |

The middle row is the rebuilt `merge_check` idea MAP.md has carried since 2026-08-13, and the
"never an agent" is not a style preference: an agent there is precisely what got
no-mistakes-the-tool killed (MAP.md's dead list - it would have been an 8th check and a 2nd model
reviewer). The run's own chain already judged the change in isolation; the gate asks the one thing
that chain cannot: *does this still work on top of integration as integration is NOW.*

Skylos deliberately does **not** re-run at the gate: it judges the change in isolation, it already
ran inside the run, and it is fail-closed-incomplete wherever its toolchain is missing.

### 5.2 Blocked semantics

A card that cannot be integrated gets, on the card itself and pushed to the hub:

```
Status: blocked
Blocked-reason: rebase conflict with integration (CONFLICT (add/add): Merge conflict in shared.txt)
```

`Blocked-reason:` is written as the last line of the card's header block (the contiguous `Key:
value` run the Board's own parser reads), flattened to one line and truncated; title and body
survive byte for byte, and re-blocking the same card replaces the line rather than stacking. The
reasons the engine writes:

| Reason | When |
|---|---|
| `rebase conflict with integration (<git's own words>)` | the replay stopped on a conflict; aborted before this was written |
| `rebase onto integration refused (<git's own words>)` | git would not even start - a dirty worktree, most often |
| `quality suite red on <branch> rebased onto integration: <command> exited <n>: <tail>` | a check failed |
| `quality suite red ...: <command> could not run at all (<error>)` / `timed out after <n>s` | fail-closed: the tool never ran, which is exactly when a gate must refuse |
| `ff-merge of <branch> into integration refused (<git's own words>)` | should be unreachable after a clean rebase; recorded rather than assumed away |
| `no worktree holds <branch> ...` / `<tree> is on <other>, not <branch> ...` | the run's tree is gone or moved; reconcile with `just worktrees` |
| `no adw/<id>_* branch in this checkout ...` | the card says `done` and nothing names a branch to merge |
| `could not detach <branch> in <tree> ...` | the gate had nothing safe to rebase, so it rebased nothing |
| `no Adw-Id: on the card ...` | nothing names the run's branch |

A blocked card is **not retried on the loop**. A conflict and a red suite are human-shaped problems,
and re-running them every 60 seconds is a louder way of being stuck. Blocking is also what takes the
card *out* of the disk scan that feeds the integrate step (5): the scan reads `done`, and a blocked
card is not that. The card is visible on the Board with its reason - MAP rule 11's "a run either
merges or leaves a visible, named artifact explaining why not".

**A run that exited non-zero is never integrated at all** - one log line, no rebase, no gate. Its
own branch is already at the hub (the run pushed it), so the work is there for a human to look at;
it simply does not go near the working line.

### 5.3 Lane slots

**One provider account = one LANE = one quota pool. A lane's SLOT count = how many parallel runs may
draw on it** (MAP.md, 2026-08-15). The lanes a run draws on are the distinct provider prefixes of
every `provider/model` string in the roster this engine passes to dispatch - `defaults.model` plus
any per-agent `model:`. The yaml is read **directly**, not through `agents.load_config`: this is a
scheduling input, and dispatch is the thing that refuses an invalid roster, per card and visibly.

- **Default: 2 slots for every lane the roster uses** (operator-ratified). `--lanes
  "xai=2,opencode-go=1"` (or `$SSSF_LANES`, same syntax) overrides per lane; an override naming a
  lane the roster does not use is logged and ignored; `<lane>=0` is refused at startup, because a
  lane with no slots holds every card forever.
- **A slot counts a RUN, not a call.** This is a deliberate approximation: a run fans out inner
  pi-subagents that draw on the *same* lane as their parent (MAP.md's roster note), and the engine
  does not count those. The conservative default of 2 exists precisely because of that fan-out - two
  runs on one provider account is already more than two concurrent calls against that quota pool.
  Headroom-aware balancing is a later, separate thing (MAP.md: the T3-style usage-log crawl is
  dead; lane slots + visible holds are the deterministic placeholder).
- **Before spawning**, every lane the roster uses must have a free slot; children each occupy one
  slot of every lane they use, released the moment they are reaped. Otherwise the card is held and
  the reason is logged **once per card, per changed reason**:
  `holding 003-third.md: waiting for lane: ollama-cloud (0 free of 2)`.
- The **cap still applies on top**: `--cap` bounds total parallelism regardless of lanes, and
  `Needs:` orders cards regardless of both.
- A roster that cannot be read at all leaves lane slots **unenforced**, with one line saying so. The
  cap still bounds parallelism, and dispatch will refuse such a card by itself - failing closed here
  would turn one visible refusal into a silent stall.

Slot counts come from three places, each one overriding the one before it:

| Source | What |
|---|---|
| the default | `2` for every lane the roster uses - its own `provider/model` strings, plus every lane its builder pool names (5.4) |
| the roster's own `lanes:` block | `lanes: { xai: { slots: 2 } }` - an optional top-level block the roster UI writes; **replaces** the default for the lanes it names |
| `--lanes` / `$SSSF_LANES` | replaces both. Ops keeps the last word: a systemd `Environment=` line must be able to narrow a lane without editing a file the laptop owns |

An entry naming a lane nothing in the roster uses is logged and ignored, from *either* source. A
malformed `lanes:` entry (not `<lane>: {slots: N}`, or `N < 1`) is named in one line and skipped, and
that lane keeps its default - a service must not die of one bad line in a roster, and the log line is
what keeps a lane from silently running at a count the operator did not write. `--lanes` is stricter
and still refuses its own malformed value **at startup** (it is one invocation's argument, not a file
the factory has to keep running on).

### 5.4 The router: which model a run's builder gets

**Deterministic arithmetic now.** The smart batch planner - a model looking at the whole board and
deciding what should run where - stays behind usage data per MAP.md; what ships here is free-slot
counting and nothing else. No history, no usage-log crawl (that idea is on MAP.md's dead list), no
agent anywhere near the decision.

The roster may carry an optional top-level `router:` block:

```yaml
router:
  builder_pool:                              # ordered, 1-5 entries (the roster UI's own bound)
    - model: "ollama-cloud/kimi-k2.7-code"
    - model: "xai/grok-4.5"
```

**The pool belongs to the BUILDER and to no other agent.** The builder is the concurrency-critical
one - longest-running, and the one that actually runs in parallel across runs (the operator's roster
ruling, 2026-08-15). Planner, scout, documenter and reviewer each run on the one model the roster
gives them; the reviewer's cross-family rule is enforced against the whole pool where the roster is
written, not here.

For each card the engine is about to dispatch:

```
   builder_pool           lane_free(lane) = slots - (live children drawing on it)
   ------------
   xai/grok-4.5        -> xai         2 free of 2   \
   openrouter/glm-5.2  -> openrouter  2 free of 2   / most free wins; a tie takes pool order
        |
        v
   copy the roster, swap the BUILDER's model:  <tmp>/sssf-003-slug-xxxx.yaml   (utf-8)
        |
        v
   uv run adws/dispatch.py queue/003-slug.md --config <that copy>
        |
        v
   the child is reaped  ->  the copy is deleted
```

- **Most free slots wins; ties go to the operator's own pool order** (a strictly-greater comparison,
  so the earlier entry keeps a tie - which is the normal state of an idle factory).
- **A pool entry whose lane is full is simply not picked**, and the next one is considered. **Only
  when every pool lane is full** does the card take the normal hold path, with the counts on it:
  `holding 003-third.md: waiting for lane: no lane in the builder pool has a free slot (xai 0 of 2,
  openrouter 0 of 2)`.
- **The run gets its own DERIVED copy of the roster**, written to a temp path in utf-8 and named
  after the card, and *that* path is what is passed as `--config` to its dispatch. A copy, never an
  edit: the operator's roster is a file the laptop owns and git tracks, and two runs routed to two
  different models in the same cycle would otherwise be writing over each other's roster while
  dispatch is reading it. Nothing else in the file is touched.
- **The slots a routed run occupies are the derived roster's lanes** - read by exactly the same rule
  as any other roster's (`_lanes_of`: the distinct provider prefixes of `defaults.model` plus every
  per-agent `model:`). So a run routed to `xai` occupies the shared default lane *and* `xai`, and not
  `openrouter`. That is what makes the arithmetic above mean anything from one dispatch to the next.
- **The copy is deleted when the child is reaped.** A delete that fails is one line and nothing more
  (it is a temp file, and its run is over). `--once` deliberately leaves the copies of the runs it
  did not wait for: those processes are still reading them.
- **Which model was picked is recorded twice**: one log line -
  `router: 003-third.md builder -> xai/grok-4.5 (xai: 2 free of 2)` - and, with no extra plumbing,
  the run's own record, because the ADW loads the derived roster and reports *that* model in its
  `agent_start` event and its sessions row. Nothing is written into the CARD: `queue/*.md` has
  exactly one writer while a run is live (dispatch), and a second writer racing it over a status
  write-back is precisely the wedge 6 exists to avoid.

**Fail-closed on the entry, never on the loop.** A pool entry that is not `<provider>/<model>` (both
halves non-empty) is named in one line and **skipped**; the rest of the pool still routes. A typo in
one line must not stop a service that has four other perfectly good models to build on. A pool on a
roster with no agent named `builder` is named once and ignored entirely. If the derived copy cannot
be written at all, that card is **not dispatched this cycle** and says so - the engine dispatches on
the roster it meant to or not at all, because silently falling back to the roster's own builder model
would run the card on a lane the router had just decided was full.

**No pool, no router.** An absent or empty `router.builder_pool` - which is every roster in the
factory today - means the card is dispatched with the operator's own roster path, occupying the
roster's own lanes, with no derived file and no extra log line: byte-for-byte the behaviour the
engine had before the router existed.

Both blocks are read **directly** from the yaml, like the lanes above and for the same reason. They
are also optional and unknown to `agents.load_config`, which ignores unknown top-level keys - verified
before this landed - so the same file is a valid roster for dispatch, the ADWs and the roster UI.

## 6. The status / commit protocol

The engine never invents a status. dispatch writes the card (`ready-for-agent -> running ->
done | blocked`, `specs/dispatch.md` 3); the engine **records** what the card says:

- One card, one commit: `git add -- <card>` then `git commit -m "factory: 003-slug.md -> done"
  -- <card>`. Path-scoped at every step, so a commit carries that card's `Status:` line and nothing
  else - not another card, not whatever else happens to be dirty in the checkout.
- Nothing staged means no commit. A dispatch that refused changed no bytes, and the engine never
  manufactures an empty commit to have something to push.
- **Adopt**: every cycle, before the pull, any `queue/*.md` that differs from `HEAD` is committed
  with whatever `Status:` it currently carries. `reap` can only record the cards of children *this
  process* is holding; a restart between dispatch's terminal write and the next reap (systemd's
  `Restart=always`, or a converge re-running `enable --now`) leaves none, and a `commit` that
  failed leaves none either. Without the sweep those cards read `done` on the server's disk and
  `running` at the hub forever, and the checkout stays dirty - which is itself what makes the next
  pull refuse. `queue/*.md` in the server's checkout has exactly one writer, so a dirty card is
  always a write-back the engine owes the hub.
- `git push origin integration` after the reap/adopt group, after each integration, and again after
  the dispatch group.

Two to three commits per card in the normal case: `-> running` when it is claimed, `-> done` (or
`-> blocked`) when it finishes, and `integrated` when it is parked. A run that finishes inside the
10-second claim window rides to the hub in fewer commits, and that commit's *message* can name the
claim (`-> running`) while its *content* already carries the terminal status - the message is chosen
when the claim is observed, the content is read when git stages it. **The CARD is the record**; the
commit subject is a convenience for a human reading `git log`, and no reader should key on it.

That is not a slogan here, it is what decides merges. The exit code of a run is logged and named,
but it lives in one process's memory and dies with it; the card on disk survives a restart, so the
card is what the integrate step reads (5). dispatch only ever writes `done` on exit 0, so the two
cannot disagree in practice - and where they could, the record that outlives the process wins.

## 7. Failure semantics

Nothing here is fatal. The engine's contract is that a bad cycle costs one cycle.

| Situation | What happens |
|---|---|
| **git cannot name a committer** (a fresh container/VPS: no `~/.gitconfig` for the service user, no repo-local identity) | One **loud** line naming the exact two `git config` commands that fix it, said once until it changes; the cycle does nothing else. Asked with `git var GIT_COMMITTER_IDENT` - git's own resolution, the same one `git commit` does - once per **cycle**, not once at startup, so an operator who fixes it is picked up on the next turn with no restart. Without this the engine logged `commit failed, will retry next cycle` once a minute forever while `systemctl is-active` reported `active`. The installer writes that identity itself when it converges the service (10). |
| **Cannot get onto `integration`** | One line, said once until the reason changes; the cycle does nothing else. Every commit the engine makes belongs on that branch. |
| **Pull fails** (no network, hub down) | One line naming git's own reason; the cycle stops before integrating or dispatching - but only after the reap, the adopt and the push have already run, so the state that would keep it failing is cleared first. |
| **Pull cannot fast-forward** (both boxes moved the working line) | Not a standoff, and not rare: integration is the LIVING line, so the engine commits to it on every card transition and one failed push plus one `queue-publish` produces it with no conflicting edit anywhere. The engine replays its own unpushed card commits on top of `origin/integration` (`git pull --rebase`) and carries on. **Never `--force`.** |
| **A CARD commit will not replay** (the laptop changed that same card at the hub) | That one commit is dropped (`rebase --skip`), named in the journal, and the replay continues: the hub wins, always. If even that cannot finish, the rebase is **aborted** - the checkout is left exactly as it was - and the cycle stops. |
| **A commit that is NOT a card write-back will not replay** | **Never dropped.** Since finished runs are fast-forwarded into the working line here, the local history carries real work; dropping one of those would lose merged code silently with the card already parked as integrated. The rebase is aborted, the checkout is untouched, the cycle stops, and the journal names the commit. Unreadable counts as "not a card commit" - fail-closed, because the failure on the other side is lost work. |
| **Push fails** | One line; the commits stay in the local history and `pending_push` stays set, so the next cycle pushes them again. Losing the network never loses the record. |
| **Commit fails** | One line; no retry state is needed. The card is still dirty on disk, so the adopt step tries again at the top of the next cycle (6). |
| **Rebase conflict / red suite / refused merge at the gate** | The card is blocked with the reason on it, committed and pushed (5.2). The engine moves to the next finished run. |
| **A card vanished before its integration** (the operator moved it at the hub) | Nothing is merged and nothing is said: the scan is re-read from disk every cycle, so a card that is no longer in `queue/` is simply not owed an integration by anyone. |
| **dispatch refuses** (exit 2, card untouched - bad `Adw:`, a config that will not load) | Its reason is already in the journal, on its own stderr. The engine names the card once and puts it in a **refused** set: not retried until the engine restarts. |
| **A card is `running` with no live child** | Named as **stranded**, once, and left alone. Re-dispatching would orphan the branch and worktree the first attempt cut. `just worktrees` reconciles those against the sessions table, which is the only place that knows the truth. Reported at startup for every such card, and at reap time for a child that died without writing a terminal status. |
| **A card is `done` in `queue/` with no live child** | Picked up by the integrate step from disk on the next cycle, whichever process left it there (5). This is the one recovery the engine does perform by itself, and it is safe precisely because it re-derives everything from git: the branch must resolve from the card's `Adw-Id:`, a worktree must hold it, and that worktree must be on it - a card failing any of those is **blocked with the named reason**, never re-dispatched and never left silent. |
| **A card becomes unreadable during its run** | One line; no commit, and no integration attempt. |
| **A lane is full** | The card is held, with one line naming the lane and the count (5.3). Not an error - the engine holds visibly and keeps cycling. |
| **Anything else raises inside a cycle** | Caught in `main`, logged as `cycle failed: <type>: <message>`, and the loop continues. A service never dies of one bad cycle. |
| **Ctrl-C / SIGINT** | One line, exit 0. Live runs are left alone. |

Log lines are **scrubbed to ASCII** on the way out (`engine.log`). This process is headless by
definition, and a single non-ASCII glyph reaching a cp1252 stdout takes the whole service down
(MAP.md's platform landmine). Losing an accent in a log line is the cheaper failure by a mile.

## 8. Flags

| Flag | Default | What |
|---|---|---|
| `--interval` | `60` | seconds between cycles |
| `--cap` | `2` | how many ADWs may run at once. Must be >= 1. |
| `--lanes` | `$SSSF_LANES`, else 2 slots per roster lane | per-lane slot overrides, `"xai=2,opencode-go=1"` (5.3) |
| `--once` | off | run exactly one cycle, then exit - for tests, and for looking before leaving it running. Does **not** wait for the runs it starts; they integrate on the next invocation, off the queue on disk (1). |
| `--config` | `$SSSF_CONFIG`, else `adws/adw_sssf_config/sssf.config.yaml` | passed through to every dispatch (or, with a builder pool, that run's derived copy of it - 5.4), the roster whose lanes and slots are enforced, and the roster whose `worktrees.enabled` must be true (1). The fallback is the **test lane** - the `up:` line logs whichever one is in force. |
| `--queue-dir` | `<repo root>/queue` | test override, mirroring `dispatch.py`. `Needs:` resolution always uses `<repo root>/queue` (dispatch's own contract). |

`$SSSF_INTEGRATION_BRANCH` (2) is read from the environment only - there is no flag, because it is a
property of the factory, not of one invocation. `main` is refused outright.

## 9. What it deliberately does not do

- **Never touches `main`.** It does not check it out, commit to it, or push it. `main` moves once per
  finished chunk, by the operator's own squash merge (2).
- **Never forces.** No `--force`, no `-f`, no force-push, anywhere. It does not even rewrite a run
  branch locally: the gate rebases a **detached copy** and leaves the branch exactly as the run
  published it (5), so no later push of it could ever need forcing in the first place.
- **Never re-dispatches a card**, and never retries a blocked one. See stranded (7) and 5.2.
- **Never prunes a worktree or deletes a branch.** `just worktrees` owns reconciliation and refuses
  anything unmerged; the engine leaves an integrated run's tree exactly where it is.
- **Never runs an agent.** Not at the gate, not anywhere. dispatch and the ADW below it own every
  model call, exactly as they do under `just work`.
- **Never validates `sssf.config.yaml`.** dispatch does, per card, and its refusal is visible in the
  journal and stops that card from being retried (7). A config typo must not turn the service into a
  systemd restart loop. The engine reads the same file for scheduling only - which lanes it names,
  how many slots each gets, and which models its builder pool offers (5.3, 5.4) - and every one of
  those readers skips what it cannot understand rather than refusing to run.

## 10. The systemd contract (for the installer to implement)

*(This was section 7 before the integration-branch revision - `installer/steps.py` still cites it by
that number. The contract itself is unchanged, byte for byte.)*

**Server/container target only.** The laptop is the workplace; nothing about this unit is ever
installed laptop-side (MAP.md's two-box model). The installer step that writes it belongs with the
server/container host selection, next to the rest of the factory-core install. **Unchanged by the
integration-branch work** - the unit below is exactly as it was.

```ini
# /etc/systemd/system/sdl-engine.service
[Unit]
Description=SDL factory engine - runs the Kanban
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<owner of the checkout>
WorkingDirectory=<repo>
Environment=SSSF_CONFIG=<roster>
ExecStart=<abs path to uv> run adws/engine.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Requirements the installer must satisfy for that unit to work:

- `WorkingDirectory` is the factory checkout itself. The engine derives the repo root from its own
  cwd (`git_helper.repo_root()`), and every child runs with that cwd.
- `ExecStart` must resolve `uv`. A systemd unit gets no login shell, so the installer writes an
  absolute path to `uv` (or a `PATH=` in the unit) rather than assuming the operator's profile.
- **`User=` is mandatory**, and it is the **owner of the checkout** (`installer/steps.py`'s
  `engine_service_user`, which reads it off the directory itself and falls back to `SUDO_USER`).
  Writing `/etc/systemd/system/` needs root, so the wizard runs under sudo; a unit with no `User=`
  is a unit systemd starts as root. On an operator-owned checkout that means every `git` call the
  engine makes dies with *"detected dubious ownership in repository at ..."* - the pull fails on
  cycle 1 and the service does nothing at all while `systemctl is-active` reports `active`. On a
  root-owned checkout it renders `User=root`, deliberately and visibly. That user also needs
  whatever git credentials the hub push wants (the engine pushes `integration`, so a credential
  helper or a deploy key must already be configured - the engine never prompts).
- **A committer identity must resolve in the checkout.** The engine-service step converges one
  itself (`installer/steps.py`'s `ensure_engine_git_identity`, run on every converge, before the unit
  is written): if `git var GIT_COMMITTER_IDENT` cannot answer in the checkout, it sets
  `user.name "sdl-factory engine"` / `user.email "engine@sdl-factory.local"` with `git config
  --local` - inside the repo, never on the host, and **only** when the host cannot already name a
  committer, so no operator identity on any config layer is ever written over. Without it a fresh
  container or VPS runs an `active` service that fails every `git commit` it ever makes (7). The
  engine names the same two values in its own refusal, so the journal and the installer agree.
- **`Environment=SSSF_CONFIG=` names the roster out loud.** `adws/engine.py`'s own default is the
  **test lane** (`adws/adw_sssf_config/sssf.config.yaml`, "TEST LANE ONLY - not the shipping
  roster"), and `--config` is forwarded to every dispatch, so a unit that says nothing ships every
  card on the test lane. `engine.py` and `dispatch.py` read `SSSF_CONFIG` exactly as the justfile
  does, so the supported way to choose a roster is
  `SSSF_CONFIG=adws/adw_sssf_config/sssf.shipping.config.yaml <wizard>` - the next converge keeps
  it. Hand-editing `ExecStart` is not supported: `detect_engine_service` compares the unit against
  `render_engine_unit` byte for byte and would park the edit. The engine also logs the roster it
  got on its `up:` line, so `journalctl` always names what the server is shipping on.
  `SSSF_LANES` and `SSSF_INTEGRATION_BRANCH` ride the same way, as further `Environment=` lines,
  when the operator wants something other than the defaults.
- `.env` reaches the ADWs through `uv run`/`dotenv` exactly as it does under `just`; the unit does
  not need to duplicate provider keys.
- `Restart=always` is the whole crash policy. The engine already survives its own bad cycles (7), so
  a restart means the process really died.
- **Stopping the service stops its children too** (systemd's default kill mode is the whole control
  group). That is deliberate: a stop is a stop, not a half-finished run. Cards left at `running` are
  named as stranded on the next start and reconciled with `just worktrees` - the engine never
  resumes them by itself.

`journalctl -u sdl-engine -f` is the engine's whole console: one timestamped ASCII line per event,
plus the ADWs' own output inherited from it.

## 11. Tests

`adws/tests/test_engine.py` - hermetic: real temp git repos with a real **local bare origin**, both
lines (`main` and `integration`) as they are on the server, real `git`, so the pull / rebase / merge
/ commit / push protocol is exercised for real rather than mocked. No network, no `uv`, no pi, no
model calls. Two outside-world seams are stubbed:

- `engine.dispatch_command` -> a tiny stand-in for dispatch **and the ADW below it**: it makes the
  same card write-backs (`Adw-Id:`, `ready-for-agent -> running -> done|blocked`) and, on demand,
  cuts the same branch + worktree off `integration` and commits real files there. That is what lets
  a test drive a real rebase, a real conflict and a real fast-forward.
- `engine.quality_commands` -> a one-line python process that records the directory it ran in (so a
  test can prove the gate judged the REBASED worktree) and exits green, red, or not at all.

The laptop is a **second clone of the same bare origin** (`_laptop_publishes`, `_laptop_parks`),
which is how the two-box model's divergence gets exercised without a network or a second machine.

Covers: creating/checking out/publishing `integration` and putting a stray checkout back on it,
`main` never moving across a full ship, the scan's ordering and exclusions, `Needs:` gating (the
dependent waits while its dependency is merely `done`, and runs in the same cycle its dependency is
parked), the cap, lane slots (roster parsing, the default of 2, an override, the hold message said
once, the slot released on reap, an unreadable roster leaving them unenforced, a malformed
`--lanes` refused), the claim commit+push landing in the same cycle, reap-to-`done` and
reap-to-`blocked`, a commit carrying only its own card, **the whole integrate path** (rebase +
green gate + ff-merge + park + the dependent unblocking), **two sibling branches integrating one
after another**, **a rebase conflict blocking the second card with its reason while the engine
carries on**, **a red suite blocking and merging nothing**, **a suite that cannot run at all
reading red**, a non-zero run never being integrated, the gate's real command set, pull failure
skipping the cycle, push failure retried on the next cycle, one failed push plus one laptop publish
recovering by itself, **a non-card commit never being dropped by the replay**, a write-back
orphaned by a restart, a card moved at the hub mid-write-back,
stranded detection at startup, a refused dispatch named once, a checkout with no origin running
local-only (and still integrating), `--once`, `--cap 0` refused, `SSSF_INTEGRATION_BRANCH=main`
refused, and that every log line is ASCII.

Added with the five defect fixes: **a run that finished after its engine died being integrated from
disk by a fresh process** (and its dependent rolling on from there), a `done` card that names no
branch being **blocked with the reason** instead of sitting in `queue/` forever, a branch holding
nothing new being **parked**, **the gate never rewriting the branch the run published** (proved by
pushing it, running a red gate, committing a repair on it and pushing again - the exact sequence that
failed forever before), an integrated branch still reading as **merged** to
`worktrees.is_merged_into_trunk` while deliberately *not* being an ancestor, the worktree ending
every gate pass **on its own branch**, a checkout with a **scrubbed identity** doing nothing and
naming both `git config` commands (said once), the installer writing exactly those two values, and
`worktrees.enabled: false` **refused at startup**.

Added with the router (5.4): a wave of five cards proving the pool **picks by free slots**, breaks
ties in the operator's own pool order, **skips a full lane**, and holds the last card with the counts
on it when every pool lane is full; each child occupying the lanes its *own* derived roster draws on;
the derived copy being **written, passed as `--config`, and deleted on reap** while the operator's
roster is left byte-for-byte unchanged; a **malformed pool entry** named and skipped with the rest
still routing; a pool on a roster with no `builder` agent ignored; the roster's `lanes:` block
**replacing** the default slot count while `--lanes` still overrides it, with unusable entries named
and skipped; and a roster with **no `router:` block** dispatching on the operator's own path with no
derived file at all. On the installer side (`installer/tests/test_steps.py`):
a host with no identity getting a repo-local one, an existing identity never being overwritten, a
failed write being named rather than swallowed, and the dry run probing read-only and writing
nothing.
