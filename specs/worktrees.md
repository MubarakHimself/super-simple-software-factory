# Spec - Worktree layer (build phase 5)

One worktree per concurrently running agent, created by code at the top of every writing ADW,
outside the repo, reconciled against the `sessions` table by one command, and **never
force-removed while it holds work**.

Build phase 5 of `MAP.md`, pulled forward by operator overrule (2026-08-12 night): the first real
workload is a whole agentic harness shipping in parallel chunks, so worktree-per-run must work out
of the box.

**Authority order:** `MAP.md` (rule 11 + phase 5) wins on every conflict. Below it: the parked
attempt's knowledge (`T27-worktree-lifecycle.md`, `T03-isolation.md`, and the code under git tag
`park/opus5-2026-08-12` - archaeology, steal the lessons not the code). Below that:
`docs/research/video-1-notes.md` diagram 08. Below that: the live code
(`git_helper.py`, `runner.py`, `permissions.py`, `quality.py`, `agents.py`, `session.py`).

**Hard boundaries this spec inherits:**

- **Park, never delete** (MAP rule 5). A worktree holding uncommitted or unmerged work is NEVER
  force-removed. That refusal is the whole point of this layer, and it is enforced in the planner,
  not at the CLI, so no future flag can route around it.
- Never write to `.claude/skills/sssf/templates/`.
- Production-grade, no mock data. ASCII only - source, console, and this document.
- `encoding="utf-8"` pinned at every subprocess pipe and every `open`/`read_text`/`write_text`.
- No Anthropic models in verification. Test lane `ollama-cloud/kimi-k2.7-code`.
- KISS (rule 1): **no daemon, no lock server, no new store.** Git's own worktree machinery and the
  `sessions` table are the state. The mutex already exists - see 4.4.

Everything below was checked against the live code and against real git/uv on this laptop
(git 2.55.0.windows.2, uv 0.12.2); the empirical results are quoted inline where load-bearing.

---

## 1. What this phase delivers

| Path | What |
|---|---|
| `adws/adw_modules/worktrees.py` | The one new module. Two halves: **lifecycle** (`ensure_run_worktree`, `worktree_for`) and **reconciliation** (`inventory`, `classify`, `prune_plan`, `render`). |
| `adws/worktrees.py` | The reconciliation CLI. PEP 723 header like every other script in `adws/`. Deliberately NOT named `adw_*.py` - see 8.1. |
| `adws/adw_modules/git_helper.py` | Every function gains an explicit `tree=` argument; new worktree plumbing (`worktree_add`, `worktree_list`, `worktree_remove`). |
| `adws/adw_modules/runner.py` | `Run.main_root` (new, immutable) + `Run.enter_worktree()` which rebinds `Run.repo_root`. |
| `adws/adw_modules/session.py` | Resolve `db` and `data_dir` absolute against `main_root`; refuse to join a live run. |
| `adws/adw_modules/permissions.py` | Snapshot the run's own tree (unchanged semantics, new cwd) + the main-checkout tripwire (5.4). |
| `adws/adw_modules/quality.py` | `uv --project` + pinned `UV_PROJECT_ENVIRONMENT` (6). |
| `adws/adw_modules/gates.py` | Relative artifact paths resolve against `run.repo_root`, not the process cwd. |
| `adws/adw_modules/changes.py` | Pass `tree=run.repo_root` to every git call. |
| `adws/adw_modules/data_types.py` | `WorktreesConfig`, `RunWorktree`, `WorktreeRow`, `WorktreeState`. |
| The 8 writing ADWs | `branch` phase becomes the `worktree` phase. One or two lines each. |
| `adws/adw_sssf_config/sssf.config.yaml` | A `worktrees:` block (3). |
| `adws/tests/test_worktrees.py` | Hermetic tests against real temp repos - no network, no model calls. |
| `justfile` | `worktrees`, `worktrees-prune`. |

**Not delivered here, on purpose:** merging (that is the PR and Gate 2), a `merge_check` phase
(evidence-gated, see MAP open questions), sandboxes (dead-listed for v1), any GC daemon, any UI
work. The inventory ships a `--json` mode so the Gate tab can consume it later without this phase
guessing at a UI.

---

## 2. Invariants

These are the sentences the tests check. Everything else in this spec is machinery for them.

1. **The main checkout never moves.** No run ever checks out a branch, commits, or writes source
   in `C:/Users/Mubarak/Documents/sdl-factory`. It stays on trunk, clean, all night. This is what
   makes N parallel runs possible, and it is what today's `ensure_run_branch` (a `git checkout -b`
   in the main tree) makes impossible.
2. **One writing run = one branch = one worktree**, keyed by `adw_id`. Rejoining `--adw-id` reuses
   both.
3. **The factory's own state stays in the main repo**: `sssf.db`, `sessions/<adw_id>/**`,
   prompts, config, extensions, `.env`. The worktree holds only the work.
4. **A worktree with uncommitted or unmerged work is never removed by this factory.** Not by a
   flag, not by `--force`, not by a timeout. It is listed, named, and flagged.
5. **A run either merges or leaves a visible, named artifact explaining why not** (MAP rule 11).
   `just worktrees` is that visibility, and it exits non-zero while anything is stranded.
6. **The inventory is read-only.** Read-only git commands, `sqlite3 ... mode=ro`. Only
   `worktrees-prune` mutates, and only rows in state `merged`.

---

## 3. Layout, naming, and configuration

### 3.1 Root

```
C:/Users/Mubarak/Documents/sdl-factory/                 <- the main checkout, always on trunk
C:/Users/Mubarak/Documents/sdl-factory-worktrees/       <- the worktree root
    a1b2c3d4_add-health-endpoint/
    9f8e7d6c_wire-the-lane-balancer/
```

Default root = `<parent of main_root>/<main_root.name>-worktrees`, derived, not hardcoded.

**Why outside the repo** - four independent reasons, each sufficient:

- An agent's cwd is its own worktree. A sibling run's tree is not reachable by any relative path
  from inside it, so agents cannot write into each other by accident or by confusion.
- `ruff check .`, `pytest`, `mypy adws`, and `skylos .` all run with cwd = the worktree. A worktree
  nested inside the repo would be walked by every one of them, in every other run, forever.
- `permissions.snapshot()` lists untracked files. A nested worktree would appear as a mountain of
  untracked paths in every snapshot and turn every phase into a false permission breach.
- Nothing needs a `.gitignore` entry, so nobody can delete the entry and break the invariant.

Windows `MAX_PATH`: the longest name this scheme can produce is `<8 hex>_<40 char slug>` = 49
chars under a 48-char root. Deep `node_modules` under that is the only realistic risk; if it bites,
the fix is `worktrees.root: "C:/wt"`, not a redesign.

### 3.2 Name

`<adw_id>_<slug>`, matching the branch `adw/<adw_id>_<slug>` one-for-one - same
`git_helper.slugify(prompt)` that already names branches, so the directory listing is readable
without opening anything. This is T27's first requirement: *"a worktree must say what it holds
without being opened."*

The `adw_id` is the identity; the slug is a legibility aid. Lookups match on the
`adw/<adw_id>_` prefix alone (exactly as `find_run_branch` already does), because a rejoined run's
prompt - and therefore its slug - can differ from the one that cut the branch.

### 3.3 Config block

```yaml
worktrees:
  enabled: true              # false = pre-worktree behaviour (branch in the main checkout)
  root: ""                   # "" = <parent of repo>/<repo-name>-worktrees
  trunk: integration         # what runs fork from and ff-merge into (main is human-owned)
  stale_after_minutes: 30    # a 'running' session silent this long is reported stale (8.3)
```

Config only - no auto-discovery (MAP rule 12). `SSSF_CONFIG=other.yaml` already swaps the whole
file for one run, which covers the server's different disk.

One exception, added with the integration-branch ruling (MAP.md, 2026-08-15): `trunk` also reads
`$SSSF_INTEGRATION_BRANCH` when that is set, because the engine and the worktree layer have to
agree on the working line and a systemd unit selects it with an `Environment=` line rather than a
hand-edited config. `adw_modules/git_helper.py` (`FACTORY_TRUNK_ENV` / `factory_trunk()`) is the
one place that name is decided; everything else asks there. An unset or empty value means
`integration`. If the branch does not exist yet, `worktrees.ensure_factory_trunk` creates it from
`main` without ever checking `main` out.

`enabled: false` exists for one reason: a box that cannot support worktrees (or a debugging
session) must still be able to run the factory, and turning the layer off must be a written
decision in a config file rather than an accident.

---

## 4. Lifecycle

### 4.1 When a worktree is created

**Every run of a writing ADW gets one, at the start, before any agent runs.** Parallel-safe by
default - the operator's out-of-the-box demand. No heuristic, no "only if another run is active",
because a heuristic is a thing that is wrong at 3am.

The 8 writing ADWs (the ones that call `ensure_run_branch` today): `adw_build`,
`adw_build_review`, `adw_build_test`, `adw_document`, `adw_plan_build`, `adw_plan_build_test`,
`adw_plan_build_test_quality`, `adw_simple_sdlc`.

The 4 read-only ADWs get nothing: `adw_prompt`, `adw_scout`, `adw_plan` (writes only its plan into
the session dir), `adw_quality`. They cut no branch today and cut no worktree tomorrow.
`adw_quality` deliberately keeps reading the **main checkout** - "run the checks on what is on my
desk" is its whole job.

### 4.2 The phase

The existing `branch` phase becomes the `worktree` phase - the same position in the chain, one
code phase, no agent:

```python
with run.phase(PhaseParams(name="worktree", kind="code", owner="git",
                           description="Cut or join this run's branch and its own working tree")) as ph:
    ph.log(**run.enter_worktree(prompt))     # branch=..., path=..., reused=..., base=...
```

`Run.enter_worktree(prompt) -> dict` is the only new call site in an ADW. It:

1. resolves the worktree root and the run's path,
2. calls `worktrees.ensure_run_worktree(...)`,
3. **rebinds `run.repo_root` to the worktree path**, and stores `run.worktree`,
4. returns the fields to log.

`adw_simple_sdlc` needs one extra edit: its `baseline = git_helper.rev("HEAD")` currently runs
before any phase, against the main checkout. It moves to just after the worktree phase, with
`tree=run.repo_root`, so the baseline is the run's own starting commit.

### 4.3 `ensure_run_worktree` - create or rejoin

```
branch = adw/<adw_id>_<slug>        (git_helper.run_branch_name, unchanged)
path   = <worktrees.root>/<adw_id>_<slug>

1. A registered worktree already holds a branch matching `adw/<adw_id>_*`?
   -> REJOIN. Return its path. (Slug mismatch is fine; adw_id is the key.)
2. The branch exists but no worktree holds it (someone removed the directory)?
   -> `git worktree add <path> <branch>`     (no -b: never re-cut an existing branch)
3. Neither exists?
   -> `git worktree add -b <branch> <path> <base>`
      base = worktrees.trunk if it resolves, else the main checkout's HEAD (logged loudly).
4. `path` exists on disk but git does not know it?
   -> FAIL the phase, naming the path and the exact command the operator can run.
      Never delete it, never write into it. Park-never-delete applies to strangers too.
5. `uv sync` the new tree (6.2), if it has a pyproject.toml.
```

Step 3 is one atomic git command that creates the branch **and** the tree, which is why the main
checkout never moves. `ensure_run_branch` survives in `git_helper` for `worktrees.enabled: false`
and for its tests, but no ADW calls it any more.

**Base is trunk, not "current HEAD."** Today's `create_branch` cuts from wherever the main
checkout happens to be sitting. Under parallelism that is not a decision, it is a race. Trunk-based
(MAP rule 11) says `main`.

### 4.4 The mutex already exists - verified

```
$ git worktree add ../wt-b adw/aaaa1111_test
fatal: 'adw/aaaa1111_test' is already used by worktree at '.../wt-a'
```

Git refuses to check the same branch out twice. One branch per `adw_id` therefore means one tree
per `adw_id`, enforced by git itself. That is the entire concurrency-control story. No lock file,
no lock server, no daemon - MAP rule 1.

Two runs can never collide on a path either: `adw_id` is `secrets.token_hex(4)`.

### 4.5 Rejoin safety

`--adw-id` naming a run whose session row still says `running`:

- newest event for that `adw_id` is younger than `worktrees.stale_after_minutes` (30):
  **refuse to start**, print `just procs <adw_id>`. Two processes in one tree is the only thing in
  this design that can actually destroy work.
- newest event is older than that: **proceed with a loud warning**. A 30-minute-silent run is dead
  or hung (pi streams a `tool_call` event per tool call; no healthy phase is silent that long), and
  refusing recovery is how work gets stranded - the exact failure this phase exists to end.

No pid probing. `os.kill(pid, 0)` **terminates the process on Windows** (CPython routes non-signal
values to `TerminateProcess`), and a `tasklist`/`/proc` platform branch is a system where a
timestamp comparison will do.

### 4.6 End of run

Nothing is removed at the end of a run. Not on success, not on failure. The run finishes, the
session row is written, the worktree stays on disk with its branch. Removal is a separate,
explicit, human-invoked act (9) - because "cleaned up automatically" is how ten worktrees of
finished work went missing the first time.

---

## 5. The one variable that moves

`run.repo_root` already exists and is already the cwd of all three subprocess families:

| Consumer | Today | Under worktrees |
|---|---|---|
| `agents.execute` -> `PiRequest.cwd` | `run.repo_root` | unchanged - now the worktree |
| `quality._run` -> `subprocess(cwd=)` | `run.repo_root` | unchanged - now the worktree |
| `permissions.snapshot/_roll_back` | `run.repo_root` | unchanged - now the worktree |

So the layer's real job is small: **point `run.repo_root` at the worktree, and make sure nothing
else follows it there.**

### 5.1 The process never chdir's

`os.chdir` into the worktree would be one line and would be wrong. Every relative path in the
codebase falls into one of two classes, and chdir flips both:

- **the work** (`ruff check .`, `pytest adws/tests`, `skylos .`, the agent's own file writes) -
  must resolve in the worktree. Already does, via `cwd=run.repo_root`.
- **the factory** (`adws/adw_sssf_config/sssf.config.yaml`, `adws/adw_data/prompt_engineering/**`,
  `adws/adw_data/harness_engineering/subagents.ts`, `data_dir`, `observability.db`, `.env` loaded
  at import by `utils.load_dotenv()`) - must resolve in the main checkout. Already does, via the
  process cwd.

Keeping the process cwd in the main repo makes the factory-side default correct and leaves exactly
one leak to plug: `git_helper`.

### 5.2 `git_helper` gets an explicit tree

`git_helper._git` takes no `cwd` and inherits the process cwd - which after this change means
**the main checkout**. Left alone, `commit_all()` would commit the operator's main tree, and
`ensure_run_branch` would move it. So:

```python
def _git(*args: str, tree: Path | str | None = None) -> str:
    result = subprocess.run(["git", *args], cwd=tree, capture_output=True,
                            text=True, encoding="utf-8")
```

- **Mutating** functions (`create_branch`, `commit_all`, `ensure_run_branch`) take `tree` as a
  **required keyword-only** argument. Forgetting it is a mypy error at the call site, not a silent
  commit to the wrong tree.
- **Query** functions (`rev`, `short_sha`, `merge_base`, `diff_*`, `is_dirty`, `untracked_files`,
  `current_branch`, `ref_exists`, `changed_files`) take `tree: ... | None = None`, defaulting to
  the process cwd - which keeps `repo_root()`, the reconciliation CLI, and the existing tests
  working unchanged.
- New: `worktree_list(tree)`, `worktree_add(...)`, `worktree_remove(...)`, all `--porcelain` where
  a porcelain form exists.

Call sites to update: the 8 ADWs' commit/branch calls, `changes.py` (already takes `run`, so
`tree=run.repo_root` throughout), and `quality.ai_defects`'s `merge_base` call.

### 5.3 Session paths become absolute - the silent-loss landmine

`cfg.defaults.data_dir` is `adws/adw_data` and `cfg.observability.db` is
`adws/adw_data/sssf.db` - both **relative**, both resolved today against the process cwd. The
handoff directory is then handed to the agent as a string:

```python
variables = {..., "context_handoff_dir": str(run.context_handoff_dir)}   # agents.py:95
```

With the agent's cwd moved to the worktree, that relative string resolves **inside the worktree**,
where `adws/adw_data/sessions/` is gitignored. The scout would write its findings into a directory
the planner never reads, both phases would go green, and the handoff would be silently empty. This
is the single most dangerous interaction in the phase.

Fix, in `session.ensure`, before the `Tracer` is constructed:

```python
main_root = git_helper.repo_root()                    # process cwd is still the main repo
db        = utils.under(main_root, cfg.observability.db)
data_dir  = utils.under(main_root, cfg.defaults.data_dir)     # -> Run.session_dir, handoff, jsonl
```

`utils.under(root, value)` is four lines: absolute in, absolute out; relative in, joined to root.
The config object is **not** mutated - the justfile and the UI keep using their own relative path,
and the console banner just prints an absolute one.

Consequences, all good: `Run.session_dir`, `context_handoff_dir`, `agent_map.json`, the per-agent
prompt/envelope/`raw_output.jsonl` dirs, `events.jsonl`, and `quality._check_dir` all land in the
main repo whatever any cwd says; `permissions.always_writable`'s `data_dir` prefix becomes a no-op
for the run's tree (the session runtime is no longer inside it and cannot appear in its git
status), which is strictly safer.

**The one unknown to verify (13, V3):** the agent is now told an absolute handoff path *outside*
its cwd. Nothing in `agent_pi.py` restricts pi's tools to cwd - it passes `cwd=request.cwd` to
`subprocess.Popen` and no jail flag - but "nothing in the code restricts it" is not "verified,"
and this factory does not trust unverified claims. If a real round trip shows pi refusing, the
fallback is already scoped: keep the handoff dir at `<worktree>/.sssf/handoff/` and have the
code phase copy it into the session dir at phase end. Fallback only on evidence.

### 5.4 Gates resolve against the run's tree

`gates.artifacts_exist`, `files_non_empty`, `json_parses`, `diff_matches_claims` all do
`Path(a).exists()` - resolved against the ADW process cwd, i.e. the main checkout. An agent that
writes `specs/plan.md` in its worktree would be told its artifact does not exist, or - far worse -
a stale file of the same name in the main checkout would make a false claim pass.

Every gate already receives `run`. Add one helper and use it in all four:

```python
def _resolve(run, path: str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else Path(run.repo_root) / p
```

`gates.tests_pass(command)` gains `cwd=run.repo_root` on its `subprocess.run`, for the same reason.

### 5.5 The enforcement window narrows - and the tripwire that answers it

Today `permissions.enforce` sees everything, because there is one tree. Under worktrees it sees
only the run's tree, so an agent that used `bash` with an absolute path into the main checkout
would be invisible to it. That is a real regression introduced by this layer and it gets written
down rather than glossed.

Sandboxes are dead-listed for v1, so the available answer is a tripwire, and it is ten lines of
already-written code:

- Before the first agent phase, `permissions.snapshot()` the **main checkout** (`cwd=main_root`).
- After each agent phase, snapshot again. For every changed path:
  - matches `defaults.protected_files` -> **`PermissionBreach`**, phase dies, path named. An agent
    rewriting `adws/adw_modules/` mid-run is precisely what MAP rule 13 exists to stop, and a
    factory changing under a running ADW invalidates that run anyway.
  - anything else -> a `main_checkout_drift` log event, not fatal. The operator editing
    `apps/ui` or `docs/` in the main checkout while a run is in flight is normal life on this
    laptop and must not abort an overnight run.

The session runtime under `data_dir` is gitignored, so the factory's own writes never appear in
this snapshot and need no special case.

---

## 6. uv, and the toolchain per tree

**Measured on this laptop (uv 0.12.2), not assumed:**

| Invocation | Environment used |
|---|---|
| `uv run ...` with cwd=`<proj>` | `<proj>/.venv` - uv walks up from **cwd** |
| `UV_PROJECT_ENVIRONMENT=<abs>` + `uv run` | `<abs>` - the env var wins |
| `uv run --project <proj>` from a foreign cwd | `<proj>/.venv`, and **cwd is unchanged** |

So the study's flag is real: with cwd = the worktree, `uv` would silently pick up a *different*
project than the operator expects, and an inherited `UV_PROJECT_ENVIRONMENT` could silently
redirect every parallel run into one shared venv.

### 6.1 The decision

Every `quality.py` block becomes fully explicit - nothing ambient, nothing inferred:

```python
DEV  = ["uv", "run", "--project", str(run.repo_root), "--group", "dev"]
SCAN = ["uv", "run", "--project", str(run.repo_root), "--group", "scan"]
env  = {**operator_env(), "UV_PROJECT_ENVIRONMENT": str(Path(run.repo_root) / ".venv")}
cwd  = run.repo_root
```

- `--project` fixes *which* project, without moving cwd (tests still resolve their own relative
  paths correctly).
- `UV_PROJECT_ENVIRONMENT`, absolute and per-tree, fixes *which* venv and makes it impossible for
  an exported value in the operator's shell - or in the `uv run` that launched the ADW - to
  redirect it.
- **Per-tree, never shared.** A shared venv is a correctness bug the moment one run adds a
  dependency, and a race the moment two runs `uv sync` at once. uv hardlinks from its global cache,
  so the real cost of `<worktree>/.venv` is seconds and near-zero disk.
- `.venv/` is already in `.gitignore`, so the per-tree venv never appears in a diff, in a
  permission snapshot, or in a commit.

`DEV`/`SCAN` become small functions of `run` rather than module constants. `pytest -q adws/tests`,
`ruff check .`, `mypy adws` and `skylos .` keep their existing relative arguments - they *should*
mean the worktree.

### 6.2 Prepared at creation, not mid-phase

`ensure_run_worktree` runs `uv sync --project <path> --group dev` (with the same pinned
`UV_PROJECT_ENVIRONMENT`) as its last step, when the tree has a `pyproject.toml`. Two reasons: a
provisioning failure surfaces as a clear code-phase failure before any tokens are spent, rather
than as a mysterious lint failure three phases later; and `uv.lock` is tracked, so the tree
resolves to exactly the same pins the main checkout has.

Non-Python toolchains (`bun install` for `apps/ui`) are the run's own business - its build and test
commands already do that work. The factory guarantees the Python toolchain and nothing else.

---

## 7. Trace db and session state under parallelism

The db and every session directory stay in the **main repo** (5.3). Three ADW processes in three
worktrees write to one `adws/adw_data/sssf.db`.

That already works, and it works because of decisions the tracer made before this phase existed:
WAL journal mode (readers never block the writer, and the UI can poll as hard as it likes),
`synchronous=NORMAL`, `busy_timeout=5000`, `isolation_level=None` so every write is one short
autocommitted statement. Contention between run processes is measured in milliseconds.

What this phase adds: **nothing.** Explicitly:

- No connection pooling, no write queue, no lock file. If a real N=8 parallel night produces
  `SQLITE_BUSY`, the fix is to raise `busy_timeout` on evidence - not to build a system now.
- `events.jsonl` is per-session (`sessions/<adw_id>/events.jsonl`), so the file half of the trace
  has no cross-run contention at all.
- One constraint worth writing down: **the db must live on a local disk.** WAL over a network
  share is broken by design. True on the laptop and on the VPS today; it becomes a real constraint
  the day someone mounts the repo over SMB.

The `sessions` table is also the registry (T27's "no new store"): `adw_id`, `adw_name`, `request`,
`status`, plus `processes` for liveness. Joined to `git worktree list` on the `adw_id` embedded in
the branch name, that is a named inventory for free.

---

## 8. Reconciliation - `just worktrees`

T27's lived failure, in one sentence: *ten to twenty worktrees, none named for what they hold, a
finished feature stranded in one, and recovery meaning opening each in turn.* This command is the
recovery tool that did not exist.

### 8.1 Shape

`adws/worktrees.py`, invoked by the orchestrator with an observable exit code (MAP rule 8).
Deliberately **not** `adw_*.py` and deliberately **not** a session-creating ADW - it has no phases,
no envelopes and no agents, and opening a session to print a report would write a `sessions` row
into the very table it reads, crowding real runs out of `just sessions`. (Lesson kept verbatim
from the parked attempt.)

```
uv run adws/worktrees.py                     # table (default)
uv run adws/worktrees.py --json              # machine-readable; a future Gate tab reads this
uv run adws/worktrees.py --all               # include sessions that never cut a tree
uv run adws/worktrees.py --prune             # dry run: prints exactly what it would do
uv run adws/worktrees.py --prune --yes       # perform it
uv run adws/worktrees.py --trunk main --config adws/adw_sssf_config/sssf.config.yaml
```

Exit codes: **0** nothing stranded - **1** at least one `unmerged` or `orphan` row - **2** the tool
could not answer (not a git repo, unreadable db, two branches sharing an `adw_id`).

Exit 1 is a **report, not a crash**: it makes "is anything stranded?" a shell condition, which is
what lets the future morning-brief digest ask the question without parsing a table.

### 8.2 The join

Three read-only sources, no new store:

1. `git worktree list --porcelain` - parsed as blank-line-separated records, never the human
   format (it pads with spaces and a path containing a space is unparseable). Verified: git prints
   forward slashes here even on Windows. The main checkout's own row is filtered out by
   `path == main_root`.
2. `git for-each-ref refs/heads/adw/` - every run branch with its tip sha and committer date.
   Branches are included even when no worktree holds them: a removed directory does not un-strand
   the commits on its branch.
3. `sessions` (+ `processes`, + `max(events.started_at)` per `adw_id`), opened
   `sqlite3.connect("file:...?mode=ro", uri=True)`. Read-only by construction is what makes "this
   tool never writes to sssf.db" checkable rather than merely intended. A missing db is not fatal
   (a fresh clone has branches and no trace).

Join key: `adw/<adw_id>_<slug>` -> `adw_id`. Two branches sharing an `adw_id` is exit 2 with both
names printed - which one holds the work is not decidable from here, and guessing is how work gets
lost.

### 8.3 The four states

Classification is a pure function over one row, in this order. Order is the safety property:

| # | State | Test | Prunable |
|---|---|---|---|
| 1 | `alive` | live `processes` rows, or `sessions.status = 'running'`. Annotated `alive (stale 3h)` when the newest event is older than `stale_after_minutes`. | never |
| 2 | `orphan` | no `sessions` row for this `adw_id` - the db cannot name what this tree holds | never |
| 3 | `unmerged` | tree is dirty, or has untracked files, or the branch has commits trunk does not have | **never - FLAG LOUDLY** |
| 4 | `merged` | clean tree, and merging it into trunk would change nothing (8.4) | yes, and only this |

`orphan` is checked before `unmerged` on purpose: you cannot decide anything about a tree you
cannot name. Its row still carries `ahead` and `dirty`, so an orphan holding work reads as an
orphan holding work.

Stranded = `{orphan, unmerged}`. That set drives exit 1 and the closing summary line.

A fifth, informational row type exists behind `--all`: `no-tree`, a session that legitimately never
cut anything (`adw_scout`, `adw_prompt`, `adw_plan`). It is never stranded, never pruned, and off
by default so the standard table is exactly the operator's four states.

### 8.4 "Merged" survives a squash merge - verified

`git merge-base --is-ancestor` is the obvious test and it is wrong for the way this factory
actually merges: a squash-merged PR leaves the branch a non-ancestor forever, so every shipped run
would sit in `unmerged` and accumulate exactly the noise this tool exists to remove.

Measured on git 2.55, after squash-merging a branch into main:

```
git merge-base --is-ancestor adw/... main   -> no
git rev-list --count main..adw/...          -> 1
git merge-tree --write-tree main adw/...    -> f4b3548...   ==   git rev-parse main^{tree}
```

So the test is: **`git merge-tree --write-tree <trunk> <branch>` equals `<trunk>^{tree}`** - merging
this branch into trunk would produce trunk's exact tree, i.e. it contributes nothing trunk does not
already have. Exact, deterministic, and correct for squash, rebase and cherry-pick alike.

Requires git >= 2.38 (`--write-tree` mode). Older git, or a merge that conflicts: fall back to the
ancestor test and put the reason in the row's note. Falling back can only ever *under*-report
merged, which parks work instead of pruning it - the safe direction.

### 8.5 Output

ASCII table, and **a table even when empty** - an empty-but-headed table says "nothing is
stranded," while no output at all says "the tool broke."

```
STATE     ADW_ID    BRANCH                                 AHEAD D REQUEST
--------- --------- -------------------------------------- ----- - ---------------------------
alive     a1b2c3d4  adw/a1b2c3d4_add-health-endpoint           2 * add a /health endpoint
          worktree: C:/Users/Mubarak/Documents/sdl-factory-worktrees/a1b2c3d4_add-health-endpoint
unmerged  9f8e7d6c  adw/9f8e7d6c_wire-the-lane-balancer        7   wire the lane balancer
          worktree: C:/.../sdl-factory-worktrees/9f8e7d6c_wire-the-lane-balancer
          HOLDS WORK: 7 commit(s) not in main, tree clean, session finished 'success'
merged    5d4c3b2a  adw/5d4c3b2a_fix-the-encoding-pass         0   fix the encoding pass

3 row(s): 1 alive, 1 merged, 1 STRANDED (unmerged/orphan). exit 1.
```

Every stranded row prints a `HOLDS WORK:`/`CANNOT NAME:` line stating the evidence in plain words.
That line is the "visible, named artifact explaining why it did not merge" of MAP rule 11.

---

## 9. Pruning - `just worktrees-prune`

**Only `merged` rows. Everything else is kept and reported.** The refusal lives in `prune_plan`,
not at the CLI, so no future flag or caller can route around it - and `prune_plan` is a pure
function, so the refusal is unit-testable without a repo.

For each prunable row, in order:

1. `git worktree remove <path>` - **no `--force`.** Git refuses a dirty tree on its own: a second
   safety net that does not depend on this module's classification being right.
2. `git branch -d <branch>` - **never `-D`.** Git refuses an unmerged branch on its own: a third
   net. (A squash-merged branch will be refused here even when 8.4 correctly called it merged;
   that is git being conservative, it is reported, and the operator's own `-D` is one command away.
   The factory does not force it.)
3. Once, at the end: `git worktree prune` - git's own bookkeeping sweep for directories that no
   longer exist. Metadata only; it can never touch a file of work.

Refused rows print the reason:

```
kept 9f8e7d6c adw/9f8e7d6c_wire-the-lane-balancer - unmerged: 7 commit(s) not in main.
     this tool never removes these. merge it, or remove it yourself once you have looked.
```

There is **no `--force`, no `--older-than`, no age-based reaping.** The parked attempt had an
`abandoned` state that auto-pruned stale branches after N days; it is deliberately dropped. "Old"
is not "finished," and the entire lived failure was work that *looked* abandoned and was not.

`--prune` without `--yes` is a dry run that prints the exact argv it would execute.

---

## 10. justfile

```just
# every run's worktree, reconciled against the sessions table (exit 1 = work is stranded)
worktrees *ARGS:
    uv run adws/worktrees.py --config {{config}} {{ARGS}}

# remove ONLY finished-and-merged worktrees; dry run unless you pass --yes
worktrees-prune *ARGS:
    uv run adws/worktrees.py --config {{config}} --prune {{ARGS}}
```

`{{ARGS}}` (not `positional-arguments`) for the cmd.exe reason already documented in the justfile.
Both recipes carry a `just --list` summary line as the last comment.

---

## 11. Tests - `adws/tests/test_worktrees.py`

Hermetic: real temp git repos under `tmp_path`, real `git` (already a hard dependency), a real
temp sqlite db. No network, no pi, no model calls, no touching the operator's repo.

| Test | Asserts |
|---|---|
| create | `ensure_run_worktree` makes `<root>/<id>_<slug>` on branch `adw/<id>_<slug>`, and the **main checkout's HEAD and branch are unchanged** (invariant 1) |
| base | the branch is cut from trunk, not from whatever the main checkout had checked out |
| rejoin | same `adw_id`, different prompt -> the same path, no second branch, `reused=True` |
| rejoin after directory removal | branch survives, tree is re-added, no `-b` |
| stranger path | a non-worktree directory at the target path fails the phase and is left untouched on disk |
| parallel | two `adw_id`s -> two trees, two branches, both usable |
| git mutex | a second `worktree add` for a checked-out branch fails, and the message is surfaced |
| classify | pure-function table over the four states + the ordering rule (orphan before unmerged) |
| classify squash | a squash-merged branch classifies `merged` via the `merge-tree` test |
| prune refusal | `prune_plan` returns no command for `unmerged`/`orphan`/`alive`, dirty or not |
| prune plan | a merged row yields exactly `worktree remove` then `branch -d`, no `--force`, no `-D` |
| inventory | full outer join over branches/worktrees/sessions; missing db is not fatal; duplicate `adw_id` raises |
| read-only | the inventory leaves the db byte-identical (mtime + sha) |
| paths | `utils.under` + `session.ensure` keep `db`/`data_dir`/handoff in the main repo when `repo_root` is a worktree |
| gates | a relative artifact resolves against `run.repo_root`, not the process cwd |

---

## 12. Order of work

1. `git_helper` `tree=` seam + worktree plumbing, with its tests. Nothing behaves differently yet.
2. `utils.under`, `session.ensure` absolutization, `Run.main_root`. Nothing behaves differently yet
   (the values are identical while `repo_root == main_root`).
3. `gates` + `changes` + `quality` cwd/project correctness. Still no behaviour change.
4. `worktrees.py` lifecycle half + `Run.enter_worktree`.
5. Flip the 8 ADWs from `branch` to `worktree`. **First real behaviour change.**
6. `permissions` main-checkout tripwire.
7. `worktrees.py` reconciliation half + `adws/worktrees.py` CLI + justfile recipes.
8. Verification (13).

Steps 1-3 are pure refactors that leave the live factory byte-identical in behaviour, which is
what makes step 5 a small, reviewable flip.

---

## 13. Verification - real, on the test lane

No step below is satisfied by a unit test. `ollama-cloud/kimi-k2.7-code` throughout (MAP rule 4);
watch the retry budget (its envelope compliance is imperfect - MAP landmine).

| # | Check | Evidence that counts |
|---|---|---|
| V1 | One real writing run end to end | The worktree exists, the branch has the commits, and `git -C <main> status` is **clean** and still on `main` afterwards |
| V2 | Two runs **at the same time** | Two trees, two branches, both suites green, both sessions in `sssf.db` with interleaved events, no `SQLITE_BUSY` in either log |
| V3 | **The handoff crosses the boundary** (5.3) | A scout/planner pair in a worktree: the planner's prompt actually contains the scout's findings, and the files are in `adws/adw_data/sessions/<id>/context_handoff/` in the **main** repo, not in the worktree |
| V4 | Quality runs against the worktree | Deliberately break lint in the worktree only; `ruff` fails. Deliberately break it in the main checkout only; the run stays green |
| V5 | uv resolution | `<worktree>/.venv` exists after the worktree phase; the `command.log` argv shows `--project <worktree>`; the main repo's `.venv` mtime is unchanged |
| V6 | Permission enforcement still bites | An agent with `writes: []` that touches a repo file in its worktree still raises `PermissionBreach` and is rolled back |
| V7 | Rejoin | `--adw-id` on a finished run reuses the same tree and branch, and continues the phase sequence |
| V8 | Reconciliation is honest | With one merged, one unmerged and one orphan tree on disk: correct states, exit 1, and `sqlite3` reports the db file unchanged |
| V9 | Prune refuses | `--prune --yes` removes only the merged tree; the unmerged and orphan trees are still on disk afterwards, with their files intact |
| V10 | The `just` surface | `just worktrees` and `just worktrees-prune` run from a fresh terminal on this laptop (cmd.exe), ASCII only, no glyph errors |

---

## 14. Risks, written down

| Risk | Standing |
|---|---|
| pi refuses absolute write paths outside its cwd | The one real unknown. V3 settles it; the fallback (worktree-local handoff + copy-back) is pre-scoped in 5.3 and is taken only on evidence. |
| Enforcement window narrows to the run's tree | Accepted, with the protected-files tripwire (5.5) as the answer. Full isolation is a sandbox, dead-listed for v1. |
| Disk growth: N trees x (checkout + `.venv`) | Bounded by `just worktrees-prune` after merges, and by uv's hardlinked cache. The alternative - auto-reaping - is the failure this phase exists to prevent. |
| `MAX_PATH` on Windows for deep dependency trees | 49-char names under a short root; `worktrees.root` is the escape hatch. Linux server is unaffected. |
| A branch merged by squash that `git branch -d` still refuses | Reported, never forced. One operator command away. |
| A run killed mid-phase leaves `status='running'` forever | Handled by the staleness annotation (8.3) and the rejoin rule (4.5), not by pid probing - `os.kill(pid, 0)` **kills** on Windows. |
| Two processes in one worktree | Prevented by git's own branch mutex (4.4) plus the rejoin refusal (4.5). |
| `data_dir` on a network share | Documented constraint (7): WAL needs a local disk. |
