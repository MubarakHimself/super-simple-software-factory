# Install

`/sssf install` — stamp the entire factory out of the skill and into the current working directory.

## Run it

```bash
uv run .claude/skills/sssf/scripts/install.py
```

Run from the **target repo root** — the cwd is where everything lands. If the skill lives in your user scope, the path is `~/.claude/skills/sssf/scripts/install.py`.

## What gets stamped

`install.py` copies `templates/` into the cwd:

| Stamped | From | Tracked? |
|---|---|---|
| `adws/adw_sssf_config/sssf.config.yaml` | `templates/sssf.config.yaml` | yes — the agent roster |
| `.env.sample` | `templates/env.sample` | yes |
| `adws/adw_*.py` | `templates/adws/` | yes — the twelve starter ADWs |
| `adws/adw_modules/` | `templates/adws/adw_modules/` | yes — all low-level logic |
| `adws/adw_data/prompt_engineering/{planner,builder,scout,reviewer,documenter}/` | `templates/prompt_engineering/` | yes — **the user-owned home for prompts** |
| `adws/adw_data/harness_engineering/` | `templates/harness_engineering/` | yes — **the user-owned home for pi extensions** |
| `justfile` | `templates/justfile` | yes — starter recipes: `just demo`, the workflows, the trace reads, `just obs` |
| `pyproject.toml` | `templates/pyproject.toml` | yes — the merge gate's toolchain (`dev` group). A project that already has one keeps it and gets the group appended |
| `queue/TEMPLATE.md` | `templates/queue/TEMPLATE.md` | yes — the card header contract `dispatch.py` parses; the Board and the engine both skip it by name |
| `adws/adw_data/sessions/`, `adws/adw_data/sssf.db` | created at runtime | no — gitignored |

The two `*_engineering` dirs mirror the two config keys of the same name: `prompt_engineering` is what an agent is told, `harness_engineering` is what its harness can do. Both are yours the moment they are stamped. Edit them in `adws/adw_data/`, never back inside the skill.

`harness_engineering/` ships with `subagents.ts` — the pi extension backing `subagent_create` / `_continue` / `_list` / `_remove`, wired to the planner and scout in the starter roster.

## Idempotency — two worlds, one rule each

Re-running is safe, and it is how you take a skill upgrade. Every stamped file belongs to exactly one of two worlds:

| World | Paths | What a re-run does |
|---|---|---|
| **Factory-owned** — the machinery | `adws/*.py`, `adws/adw_modules/**`, `adws/tests/**`, `queue/TEMPLATE.md` | **Refreshed to the skill's current bytes, every run, no `--force`.** A file that already matches is not rewritten at all (its mtime stays put) and is reported as `current`; one that differs is reported by name under `refreshed`. |
| **Operator-owned** — your decisions | `adws/adw_sssf_config/sssf.config.yaml`, `adws/adw_data/**` (prompts, harness extensions, runtime state), `pyproject.toml`, `justfile`, `.env.sample`, `.gitignore`, every `queue/` card | **Never overwritten without `--force`** — reported as `kept`. `pyproject.toml` and `.gitignore` additionally get append-only merges: the merge gate's `[dependency-groups]`/`[tool.ruff]` tables and the runtime ignore lines are *added* when absent, and nothing you already wrote is edited. |

`--force` still means overwrite everything, both worlds — including your roster and your prompts. You almost never need it now.

**Why factory code refreshes itself.** On 2026-08-18 a project stamped by an older skill was re-stamped by the current one. Under the old rule ("skip every file that already exists") the new modules landed and the old ones stayed: a brand-new `adw_modules/worktrees.py` importing `RunWorktree` from a `data_types.py` that predated the class. `uv run adws/engine.py --help` died on `ImportError` and the deploy's preflight caught it. The `adws/` tree is one program split across files; it only works at one generation, so the stamp keeps it at one generation.

After a re-stamp that reports refreshed files, read `git diff -- adws/` before committing — that diff is your changelog for the skill upgrade.

## Post-install checklist

1. **Env** — `cp .env.sample .env`. The starter roster runs entirely on one provider (`ollama-cloud`), and a provider that carries its own `apiKey` in `~/.pi/agent/models.json` needs no key in `.env` at all; set one only for a provider whose entry reads it from the environment. (v1 runs Pi; `ANTHROPIC_API_KEY` / `CLAUDE_CODE_PATH` are only needed once Claude Code lands in v2.)
2. **Pi is installed and on PATH** — `pi --version`. Set `PI_PATH` in `.env` if it is not.
3. **The model resolves** — the starter roster puts one already-runnable lane on `defaults.model` and gives no agent an override, so this is one check, not five: `pi --list-models` must list `ollama-cloud/kimi-k2.7-code`. If that is not a lane you have, change that ONE line to a `provider/id` the command does print — the whole roster follows it. See `references/config.md` for model resolution.
4. **Gitignore** — `install.py` appends `adws/adw_data/sessions/`, `adws/adw_data/sssf.db*`, and `.env` for you; confirm they landed. All three are runtime or secrets and must never be committed.
5. **Git repo** — ADWs that end in a commit phase call `git_helper.commit_all`, which raises if the cwd is not a git repository. Run `git init` and make a first commit before using `adw_plan_build.py`, `adw_plan_build_test.py`, or `adw_simple_sdlc.py`. `adw_document.py` needs one too: it measures the change with `git diff` against a base ref (`main` by default, `--base` to override).
6. **Smoke test** — `just demo` runs two cheap read-only workflows back to back, or run the smallest ADW directly:

```bash
just demo                                                    # both, end to end
uv run adws/adw_prompt.py "reply with a one-line summary of this repo"   # the raw form
```

Green means the whole path works: config validated, session minted, Pi ran, envelope parsed, events landed in `adws/adw_data/sssf.db`. Verify the trace exists before trusting anything larger:

```bash
sqlite3 adws/adw_data/sssf.db "select adw_id, status from sessions order by started_at desc limit 1;"
```

If the smoke test fails, fix it before composing chains — every multi-agent ADW rides on this exact path.
