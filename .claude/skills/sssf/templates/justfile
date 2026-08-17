# SSSF starter recipes. Stamped by install.py, then yours to edit.
#
# Deliberately small. These are the handful you need on day one: run something,
# watch it, and open the trace. Add your own as your chains grow, and see the
# example branch for the fuller set (orchestrator agents, kill, rosters, ipi).

# `.env` reaches every ADW through this, so keys work without exporting them.
set dotenv-load
# just has no `sh` on Windows PATH by default (installer-wizard.md 6.3/9);
# cmd.exe is always there. `just` only applies `windows-shell` when actually
# running on Windows, so Linux/mac keep the default shell - the server is
# unaffected.
set windows-shell := ["cmd.exe", "/c"]

# Every recipe passes this through, so `SSSF_CONFIG=other.yaml just sdlc "..."`
# swaps the whole roster for one run.
config := env_var_or_default("SSSF_CONFIG", "adws/adw_sssf_config/sssf.config.yaml")
db     := "adws/adw_data/sssf.db"

# list every recipe
default:
    @just --list

# Token-free probe for shell + dotenv + real recipe execution (installer-wizard.md
# 6.3/9, V6): `just --list` only proves the justfile parses, `just --evaluate`
# only proves `set dotenv-load` parsed .env - neither one actually runs a
# recipe body through the configured shell. This does, for zero cost.

# probe: shell + dotenv + recipe execution actually work (no tokens spent)
doctor:
    uv run python -c "print('doctor ok')"

# ── first run ───────────────────────────────────────────────────────────────

# Proves the whole path works: config validated, session minted, agent ran,
# envelope parsed, gates checked, trace written. Costs a few cents and changes
# nothing in your repo, because both workflows are read-only.
#
# (`just --list` shows only the LAST comment line, so that one is the summary.)

# start here: two cheap read-only runs, end to end
demo:
    @echo "1/2  adw_prompt: one agent, one prompt"
    uv run adws/adw_prompt.py --config {{config}} --agent scout "reply with a one-line summary of this repo"
    @echo "\n2/2  adw_scout: read-only recon"
    uv run adws/adw_scout.py --config {{config}} "list the top-level directories in this repo and what each is for. change nothing."
    @echo "\nboth done. now run:  just sessions    (or: just obs)"

# ── run a workflow ──────────────────────────────────────────────────────────
# Args pass straight through: "<prompt or path/to/prompt.md>" [--adw-id X]
#
# PROMPT is its own named parameter (not folded into the variadic ARGS) and
# is re-quoted in every recipe body below - `"{{PROMPT}}"` - so a multi-word
# prompt survives as ONE argument. `set positional-arguments` + `"$@"` (the
# previous shape) relied on a POSIX shell forwarding raw argv; cmd.exe has no
# such mechanism - it flattens a recipe's trailing args onto the end of the
# single command line it runs, splitting an unquoted multi-word prompt into
# several words. Quoting `{{PROMPT}}` ourselves works identically under both
# cmd.exe and sh, so this shape needs no per-OS branch.

# one agent, one prompt: just prompt "summarize this repo"
prompt PROMPT *ARGS:
    uv run adws/adw_prompt.py --config {{config}} "{{PROMPT}}" {{ARGS}}

# read-only recon: just scout "where is auth handled"
scout PROMPT *ARGS:
    uv run adws/adw_scout.py --config {{config}} "{{PROMPT}}" {{ARGS}}

# plan only: just plan "add a /health endpoint"
plan PROMPT *ARGS:
    uv run adws/adw_plan.py --config {{config}} "{{PROMPT}}" {{ARGS}}

# planner, builder, commit: just plan-build "add a /health endpoint"
plan-build PROMPT *ARGS:
    uv run adws/adw_plan_build.py --config {{config}} "{{PROMPT}}" {{ARGS}}

# plan, build, test, commit: just sdlc "add a /health endpoint"
sdlc PROMPT *ARGS:
    uv run adws/adw_plan_build_test.py --config {{config}} "{{PROMPT}}" {{ARGS}}

# the full chain, plus review and docs: just simple-sdlc "add a /health endpoint"
simple-sdlc PROMPT *ARGS:
    uv run adws/adw_simple_sdlc.py --config {{config}} "{{PROMPT}}" {{ARGS}}

# ── dispatch ────────────────────────────────────────────────────────────────
# The seam between the Board and the factory: claims a queue/*.md item,
# routes it (by its `Adw:` line) to the writing ADW that runs it, and writes
# Status back as it goes - ready-for-agent -> running -> done|blocked. Never
# moves the file to queue/done/ - that is the MERGE event and Gate owns it.

# dispatch one queue item: just work queue/001-add-health-endpoint.md
work FILE *ARGS:
    uv run adws/dispatch.py {{FILE}} --config {{config}} {{ARGS}}

# dispatch the lowest-numbered ready-for-agent item on the Board
work-next *ARGS:
    uv run adws/dispatch.py --next --config {{config}} {{ARGS}}

# ── engine ──────────────────────────────────────────────────────────────────
# The always-on worker that runs the Board by itself (specs/engine.md). One
# cycle every ~60s: pull, reap finished runs and push their card status back,
# then dispatch every ready-for-agent card whose Needs: are satisfied, up to
# --cap at once. On the server systemd runs this exact command as
# sdl-engine.service; this recipe is the same process in the foreground -
# `just engine --once` runs a single cycle and exits, which is the way to see
# what it would do without leaving it running.

# run the engine loop in the foreground (--once for a single cycle)
engine *ARGS:
    uv run adws/engine.py --config {{config}} {{ARGS}}

# ── worktrees ───────────────────────────────────────────────────────────────
# Reconciled against the sessions table, never guessed. A run either merges or
# leaves a visible, named artifact explaining why not (MAP rule 11) - this is
# that visibility. `just worktrees-prune` only ever removes MERGED trees; a
# worktree holding uncommitted or unmerged work is never force-removed, by any
# flag, ever (spec invariant 4).

# every run's worktree, reconciled against the sessions table (exit 1 = work is stranded)
worktrees *ARGS:
    uv run adws/worktrees.py --config {{config}} {{ARGS}}

# remove ONLY finished-and-merged worktrees; dry run unless you pass --yes
worktrees-prune *ARGS:
    uv run adws/worktrees.py --config {{config}} --prune {{ARGS}}

# ── shipping report ──────────────────────────────────────────────────────────
# MAP.md's shipping report, replacing the morning-brief ritual: a deterministic,
# code-assembled account of every commit and card sitting on `integration` that
# `main` does not have yet - what `ship-check` reads before the operator's one
# squash merge. Pure read-only git: nothing here pushes, merges, or touches main.

# the shipping report for the current chunk (--changelog / --range BASE..TIP)
ship-report *ARGS:
    uv run adws/ship_report.py {{ARGS}}

# ── hygiene ─────────────────────────────────────────────────────────────────
# Regenerable tool caches only (.ruff_cache/.mypy_cache/.pytest_cache/every
# __pycache__) - never .venv, never adw_data, never a worktree (they live
# outside the repo entirely). Prints every path it removes. One `uv run`
# invocation, so it runs the same under cmd.exe (this justfile's
# windows-shell) and sh - no OS-specific recipe body needed.

# sweep regenerable caches - never .venv/adw_data/worktrees; pass --dry-run to preview
clean *ARGS:
    uv run adws/clean.py {{ARGS}}

# ── watch it ────────────────────────────────────────────────────────────────
# Reads never block a running workflow, the db is WAL. Poll as hard as you like.

# the last 10 runs
sessions:
    @sqlite3 {{db}} "select adw_id, status, substr(request,1,50), total_tokens, round(total_cost,4) from sessions order by started_at desc limit 10;"

# phase status in sequence: just phases <adw_id>
phases ADW_ID:
    @sqlite3 {{db}} "select seq, name, kind, owner, status, attempt from phases where adw_id='{{ADW_ID}}' order by seq;"

# the live event tail: just tail <adw_id>
tail ADW_ID:
    @sqlite3 {{db}} "select rowid, type, name, started_at from events where adw_id='{{ADW_ID}}' order by rowid desc limit 25;"

# what a run has alive right now, with pids: just procs <adw_id>
procs ADW_ID:
    @sqlite3 {{db}} "select kind, name, pid, command, started_at from processes where adw_id='{{ADW_ID}}' and ended_at is null order by id;"

# ── observability UI ────────────────────────────────────────────────────────

# WHERE THE SKILL ACTUALLY IS. `install.py` stamps this justfile into your
# project but never stamps the SKILL itself, so in a stamped repo the visualizer
# normally lives only under ~/.claude/skills/sssf — while the factory's own
# checkout (and any project that vendored the skill) carries a repo-local copy.
# This recipe used to hardcode the repo-local path, so `just obs` — the trace-UI
# step the install banner points at — failed with a missing directory in every
# stamped project. Resolved project-then-user, the same order the app's
# `init.ts` uses for the identical directory; a `just --evaluate` prints the one
# that was picked.
visualizer := if path_exists(justfile_directory() / ".claude/skills/sssf/apps/visualizer") == "true" { justfile_directory() / ".claude/skills/sssf/apps/visualizer" } else { home_directory() / ".claude/skills/sssf/apps/visualizer" }

# Needs bun. The db path is passed explicitly because the server runs from the
# app dir and would otherwise look for a trace db sitting next to itself.
# The API server backgrounds so `bunx vite` can run in the foreground after it
# - `(VAR=val cmd &)` is POSIX subshell/inline-env syntax with no cmd.exe
# equivalent (cmd's `&` is a sequential separator, not "background", and it
# has no inline `VAR=val cmd` form at all), so this one recipe needs an
# OS-specific body. `[windows]`/`[unix]` (just 1.58's own per-OS recipe
# attributes) pick the matching body automatically - `just --list`/`just obs`
# still show/run one `obs`, same as before.

# boot the trace UI, http://localhost:4601 (api on :4600)
[windows]
obs:
    cd /d "{{visualizer}}" && bun install && start /B cmd /c "set SSSF_DB={{justfile_directory()}}/{{db}}&& bun run server/index.ts" && bunx vite

[unix]
obs:
    cd "{{visualizer}}" && bun install && (SSSF_DB={{justfile_directory()}}/{{db}} bun run server/index.ts &) && bunx vite
