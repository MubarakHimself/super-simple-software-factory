# Spec — Installer / Wizard (build phase 2)

One command converges a host into a working SDL Factory box. Three targets: **laptop**,
**server**, **container**. Interactive by default, flag-driven for CI. Nothing installs when
anyone later runs `pi` — that is the whole point (MAP rule 14).

**Authority order:** `MAP.md` wins on every conflict. Below it: the parked T30 ticket and the
`STATE.md` "pi — reset and verified" recipe (archaeology — the provider wiring is proven, the
opinions are not binding). Below that: `https://pi.dev/docs/latest` for pi mechanics, fetched
2026-08-12 and quoted inline where load-bearing.

**Hard boundaries this spec inherits and must not cross:**

- Never write to `.claude/skills/sssf/templates/` or `adws/adw_modules/`. The factory machinery is
  done and verified; the wizard is new code beside it. Enforced in code (§8.4), not by discipline.
- **Park, never delete** (MAP rule 5) on every replace path.
- **No Anthropic models for any test** (MAP rule 4). The verification pass runs on the test lane,
  `ollama-cloud/kimi-k2.7-code`.
- **`pi auth check` is disqualified** (MAP landmine). A lane is verified by a real round trip
  returning non-zero tokens, or it is not verified.
- **Never invoke `pi` by name programmatically** (MAP landmine). `PI_PATH` → `node <cli.js>`,
  forward slashes.

---

## 1. Deliverables

| Path | What |
|---|---|
| `installer/install.py` | The entry script. PEP 723 header, **stdlib only** (`dependencies = []`). CLI, detection, plan assembly, prompts, report, exit code. |
| `installer/steps.py` | The one module. `Step` definitions, the park primitives, config merge, subprocess wrapper. No other modules. |
| `installer/assets/pi/scripts/ollama-cloud-key.py` | Vendored verbatim from `~/.pi/agent/scripts/` (1,929 bytes at vendoring time). Byte-identical copy — record its sha256 in `installer/assets/pi/SOURCES.md`. |
| `installer/assets/pi/scripts/sync-ollama-cloud-models.py` | Same, 7,083 bytes. Vendored so a **fresh clone** can wire ollama-cloud without the parked tree. |
| `installer/assets/pi/ollama-cloud.provider.json` | Seed provider block (§6.7). The live model list comes from the sync script; this seed only guarantees the provider exists before the key does. |
| `installer/tests/test_steps.py` | Hermetic unit tests: park/snapshot naming, JSON merge, `.env` merge, forbidden-path guard, outcome classification. `tmp_path` only — no network, no subprocess against real tools, no model calls. |
| `pyproject.toml` | Two edits: `testpaths = ["adws/tests", "installer/tests"]`, and `[tool.ruff] extend-exclude` gains `"installer/assets"` (vendored byte-identical from `~/.pi/agent/scripts/`, sha256-recorded in `installer/assets/pi/SOURCES.md` — ruff never lints a copy this repo does not own and is not allowed to fix at the source). |
| `README.md` | Six-line "Install" section carrying the bootstrap one-liner and the entry command. |
| `justfile` (root) | §6.3's edits: `set windows-shell := ["cmd.exe","/c"]`, named-PROMPT recipes replacing `positional-arguments`, the `[windows]`/`[unix]` obs split, and the token-free `doctor` probe recipe. |

Nothing else. No framework, no plugin system, no step registry loaded from disk, no YAML.

---

## 2. The one command

```
uv run installer/install.py
```

Runs from a fresh clone, from any cwd inside the repo (the script resolves the repo root from its
own `__file__`, never from cwd).

**Bootstrap paradox, stated honestly:** the wizard cannot install the thing that launches it. `uv`
is the single prerequisite, and it is one documented line:

| OS | Get uv |
|---|---|
| Windows | `powershell -c "irm https://astral.sh/uv/install.ps1 \| iex"` |
| Linux / macOS / container | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

uv then supplies its own managed Python, so a bare server needs nothing else preinstalled. The
`uv` step in the plan is therefore a **version check plus optional `uv self update`**, not an
install (§6.2).

The PEP 723 header follows the ADW pattern exactly, with an empty dependency list so the wizard
starts on a fresh clone with **zero network for its own sake**:

```python
#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
```

(`uv run` on a script with inline metadata uses that script's own dependencies and skips the
surrounding project — already verified for this repo and documented in `pyproject.toml`.)

### 2.1 Flags

| Flag | Meaning |
|---|---|
| *(none)* | Interactive. Detect, propose, ask, converge, verify. |
| `--target {laptop,server,container}` | Skip the "where am I landing" question. |
| `--yes` | Non-interactive. Accept every detected default; never block on a prompt. Steps that genuinely need a human become `needs-operator` and print exact instructions. |
| `--dry-run` | Print the full plan — every action, every park that would happen, every instruction — and change nothing. Implies no writes, no installs, no network mutations. Detection still runs (read-only: `shutil.which`, file reads, `--version` calls). |
| `--verify-only` | Skip install; run §9 verification only. This is the drift check. |
| `--json` | Emit the plan (dry-run) or the result table (normal) as one JSON object on stdout; human text goes to stderr. For CI. |

`--yes` and `--dry-run` compose. `--dry-run --json` is the CI plan-review path.

### 2.2 Exit codes

| Code | Meaning |
|---|---|
| 0 | Every required step is `ok` / `installed`, plus any `expected-unavailable` that a declared platform rule permits. Verification passed. |
| 1 | A required step `failed`, or verification failed. |
| 2 | Everything the wizard can do is done, but at least one step is `needs-operator` (an auth login, a token). CI reads 2 as "needs a human", not "broken". |

Any exit prints the run log path and the report table.

### 2.3 Interactive shape — detect first, ask least

T30's rule stands: *"Detection is always better; every question is a chance to get it wrong."*
The minimum interactive session is **two questions**:

1. **Target.** Detected and proposed; Enter accepts.
   - `/.dockerenv` exists, or `/proc/1/cgroup` mentions docker/containerd/lxc, or `$container` is
     set → **container**.
   - `platform.system() == "Windows"` → **laptop**.
   - Linux, not a container → **server** if there is no `$DISPLAY`/`$WAYLAND_DISPLAY`, else
     **laptop**.
2. **Which lanes to auth**, as a checklist of the lanes this host will need, pre-ticked with the
   ones already holding credentials.

Everything else is asked only when detection is ambiguous or when a step is about to install
something intrusive on a personal machine (§6.5).

---

## 3. Execution model

Six ordered passes. Each is complete before the next begins.

```
detect  ->  plan  ->  confirm  ->  converge  ->  verify  ->  restart
```

- **detect** — read-only. Every step reports what it already sees.
- **plan** — build the ordered step list for the target; each step carries the actions it would
  take. This is exactly what `--dry-run` prints.
- **confirm** — interactive: show the plan, one Enter. `--yes`: skip.
- **converge** — apply in order. A `failed` required step stops the run (steps that follow it
  would be built on sand); a `needs-operator` step does not stop it.
- **verify** — §9. Real round trips. Runs even if converge reported `needs-operator`, so the
  report is honest about which half works.
- **restart** — §10.

### 3.1 The step contract

`steps.py` defines one dataclass and one enum. That is the whole "framework".

```python
Outcome = Literal["ok", "installed", "expected-unavailable", "needs-operator", "failed", "deferred"]

@dataclass(frozen=True)
class Step:
    id: str                     # "pi", "skylos", "ollama-cloud"
    title: str
    targets: frozenset[str]     # {"laptop","server","container"}
    required: bool              # False => a failure downgrades to a warning
    detect: Callable[[Ctx], Detected]
    apply:  Callable[[Ctx], Result]     # never called under --dry-run
    verify: Callable[[Ctx], Result]
```

| Outcome | When |
|---|---|
| `ok` | Already present and correct. Nothing done. |
| `installed` | The wizard changed the host and the change verified. |
| `expected-unavailable` | A **declared** platform rule says this cannot work here (today: skylos on Windows, §6.9). Never inferred — the rule is written in this spec and in the code beside it. |
| `needs-operator` | Only a human can finish it (a browser login, a token). Exact instructions printed. |
| `failed` | Anything else. Fail-closed: unknown means failed, never "probably fine". |
| `deferred` | Named in the plan, deliberately not built in this phase (the UI hook, §6.13). |

---

## 4. What each target gets

| Step | laptop | server | container | Notes |
|---|:---:|:---:|:---:|---|
| uv (check/upgrade) | ✅ | ✅ | ✅ | prerequisite, not installed by the wizard |
| just | ✅ | ✅ | ✅ | absent on this laptop today |
| sqlite (stdlib module) | ✅ | ✅ | ✅ | hard requirement — the tracer imports it |
| sqlite3 CLI | optional | optional | optional | convenience only; absence is `ok`, reported |
| node + npm | ✅ | ✅ | assumed | container: base image supplies it (§11) |
| pi + `PI_PATH` into `.env` | ✅ | ✅ | ✅ | |
| pi packages (bridge, subagents) | ✅ | ✅ | ✅ | |
| ollama-cloud provider wiring | ✅ | ✅ | ✅ | key comes from OpenCode auth |
| skylos | expected-unavailable | ✅ | ✅ | Windows/MSVC (§6.9) |
| no-mistakes | ✅ | ✅ | ✅ | **binary only, wired to nothing** |
| CodeGraph | ✅ | ✅ | ✅ | **binary only, no `codegraph install`** |
| Claude Code CLI | detect only | ✅ | ✅ | credential surface for the bridge |
| Codex CLI | detect only | ✅ | ✅ | credential surface for openai-codex |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | ✅ | ✅ | long-lived; survives headless runs |
| UI install | — | `deferred` | `deferred` | phase 3 extension point (§6.13) |

On the laptop the Claude Code and Codex CLIs are **detected and reported, never installed** — the
operator's harness is his, and both are already present. On server and container they are the
reason the bridges work at all: *"A server with pi and no `claude` CLI has a Claude lane that fails
at first use rather than at install."* (T30)

---

## 5. Two primitives everything else is built on

### 5.1 Park (MAP rule 5)

```python
park_replace(path) -> Path | None   # whole-file/dir replacement: MOVE aside
snapshot(path)     -> Path | None   # in-place merge: COPY aside first
```

Both produce a sibling named `<name>.parked-YYYYMMDD-HHMMSS`, matching the proven precedent
(`~/.pi/agent.disabled-20260811-230920`, 2,525 MB, nothing deleted). Both return `None` when the
path does not exist. **Neither ever removes anything, at any nesting, for any reason.**

- **Replacement** (the two ollama scripts, a corrupt `models.json`) → `park_replace`, then write.
- **Merge** (`settings.json`, `models.json`, `.env`) → `snapshot` once per run before the first
  write, then merge in place. Copy rather than move, so no window exists where pi finds no config.

Every park writes one line to `~/.sdl-factory/install/park-ledger.jsonl`:
`{"ts","run_id","step","kind","from","to","sha256"}`. The ledger lives outside the repo so it
survives a re-clone.

**Windows reality:** a rename can fail because a file is open, or because the path exceeds 260
chars — the known zero-byte `workspaces/aec-module/` shell is exactly this. On rename failure the
step reports `needs-operator` with the path and the reason. It never falls back to delete, never
retries with force.

**Uninstall / move-hosts is out of scope for this phase** (T30 lists it; MAP phase 2 does not).
The park primitives are the half of it that exists now, and any later uninstall path is built on
them.

### 5.2 `run()` — the subprocess wrapper

Every external command in the wizard goes through one function. Non-negotiable, all from MAP
landmines already paid for:

- `encoding="utf-8"` pinned at the call site (never an ambient `PYTHONUTF8`), `text=True`,
  `errors="replace"`.
- An **explicit timeout on every call**. Network steps: 300s. Version probes: 30s.
- `shell=False` and an argv list, always. No string commands. Shell one-liners from a vendor
  (`curl … | sh`) run as `["/bin/sh", "-c", "<one-liner>"]` with the one-liner written verbatim in
  this spec, never assembled from variables.
- stdout+stderr captured, appended to the run log, and **redacted** — any value the wizard read
  from a no-echo prompt or from an env var named `*TOKEN*`/`*KEY*`/`*SECRET*` is replaced with
  `[redacted]` before anything is printed or logged.
- **ASCII only on stdout.** Status markers are `[ok] [++] [--] [!!] [??]`, never glyphs. cp1252
  killed 100% of headless runs once already.
- One retry, once, for steps classified `network`; nothing else retries.

---

## 6. The steps

Order is dependency order. Each subsection states: detect / apply per OS / verify / idempotency /
park.

### 6.1 Preflight

Repo root resolved from `__file__`. Assert `MAP.md` and `adws/` exist (this is the right repo).
Create `~/.sdl-factory/install/`. Open the run log `<ts>-<target>.log`. Mint a `run_id`. Print
target, OS, arch, Python, cwd. **No writes to the repo yet.**

### 6.2 uv

- **detect** `uv --version`.
- **apply** nothing installs. If the version is below the floor (`0.5.0`, raise only with a
  reason), offer `uv self update`; `--yes` runs it, `--dry-run` prints it. If uv is somehow
  missing, the wizard could not have started — report `failed` with the bootstrap line.
- **verify** `uv --version` exits 0.

### 6.3 just

- **detect** `just --version`.
- **apply**
  | OS | Command |
  |---|---|
  | Windows | `winget install --id Casey.Just --silent --accept-package-agreements --accept-source-agreements`; if winget is absent, `cargo install just` when cargo exists, else `needs-operator` with the release-download instruction. |
  | Linux / container | `curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh \| bash -s -- --to ~/.local/bin` and ensure `~/.local/bin` is on PATH (report, do not edit shell rc files silently — see §6.14). |
- **verify** three checks, not two: `just --list` inside the repo exits 0 and lists `demo` (proves it
  parses the real justfile, not just that a binary exists); `just --evaluate` exits 0 (proves
  `set dotenv-load` actually parses `.env` — verified against the real 1.58.0 binary: `--list` does
  not touch dotenv at all and stays green on an unquoted, broken `PI_PATH`; `--evaluate` fails loudly
  on exactly that value and passes once it is quoted, per §6.6 item 3); **and** `just doctor` exits 0
  and prints `doctor ok`. Neither `--list` nor `--evaluate` ever spawns the *configured shell* to run
  a recipe body — that is exactly the gap that let "just could not find the shell `sh`" through: a
  fresh Windows terminal with no `sh` on PATH parsed the justfile clean and evaluated its dotenv
  clean, and only broke the moment a real recipe tried to run. `doctor` (root justfile: `uv run
  python -c "print('doctor ok')"`) is a real, token-free recipe invocation through the real
  configured shell, so a missing/wrong shell fails right here. `--evaluate`/`doctor` cost no tokens
  and need no `sqlite3` CLI, unlike `just sessions`. `just demo` stays the human acceptance step
  (§2.3, §13), never this probe.
- **The root justfile sets `windows-shell`.** `set dotenv-load` was already there; Windows has no
  `sh` on PATH by default and `just` 1.58.0 has no fallback, so every recipe failed with "just could
  not find the shell `sh`" in a fresh terminal even though `just --list`/`just --evaluate` both
  stayed green (the exact gap `doctor` above exists to close). Fix, in the root justfile only (never
  the `.claude/skills/sssf/templates/justfile` mirror — forbidden tree, §8.4; MAP already records
  mirror-sync as a later installer-phase task, so this divergence is expected, not drift):
  `set windows-shell := ["cmd.exe", "/c"]`. `just` only applies `windows-shell` on Windows, so
  Linux/mac keep the default `sh` — the server is unaffected. Every existing recipe was checked
  against cmd.exe and three needed a fix, made directly in the recipe bodies (not a wizard step —
  the justfile is data the wizard ships, not code path it runs):
  - `prompt`/`scout`/`plan`/`plan-build`/`sdlc`/`simple-sdlc` used `set positional-arguments` +
    `"$@"` to forward a possibly multi-word prompt intact. cmd.exe has no POSIX argv-forwarding
    mechanism — it flattens a recipe's trailing arguments onto the end of the one command line it
    runs, so an unquoted multi-word prompt gets split into separate words (verified empirically: a
    two-word prompt arrived as two separate `sys.argv` entries). Fixed by giving each recipe a named
    `PROMPT` parameter, quoted explicitly in the body (`"{{PROMPT}}"`) ahead of a variadic `*ARGS`
    tail for flags like `--adw-id X` — pure `{{}}` substitution, shell-agnostic, so no per-OS branch
    is needed and `set positional-arguments` was removed (it was also corrupting the plain
    single-parameter recipes `phases`/`tail`/`procs` under cmd.exe the same way, independent of `$@`).
  - `obs` used `(SSSF_DB=... bun run server/index.ts &)` to background the API server before running
    `bunx vite` in the foreground — POSIX subshell/inline-env syntax with no cmd.exe equivalent
    (cmd's `&` is a sequential separator, not "background", and it has no inline `VAR=val cmd` form).
    Fixed with `just`'s own `[windows]`/`[unix]` per-recipe OS attributes: two bodies named `obs`,
    the Windows one using `start /B cmd /c "set SSSF_DB=...&& bun run server/index.ts"` (verified:
    returns immediately, the child sees the env var); `just` picks the matching one automatically,
    `just --list`/`just obs` still show/run one `obs`.
  - `demo`'s `@echo "…\n…"` lines print their literal quote/`\n` characters under cmd.exe (cmd's
    `echo` does not strip quotes or interpret backslash escapes) — cosmetic only, every line still
    exits 0 and the two real `uv run` lines are unaffected (their prompts are literal
    justfile-authored double-quoted text, unaffected by the `$@`/positional-arguments issue above).
    Left as-is: not a "not cmd-compatible" recipe, just a plainer terminal.
- **Windows note:** a fresh `winget` install is not on PATH in the *current* process. The wizard
  re-resolves via `shutil.which` after install and, if still missing, reports `installed` plus a
  "open a new terminal" line rather than failing — and this step's own verify (and §9's V6, which
  calls the same function) read that exact fact as `ok`, not `failed`: an install that already
  succeeded must never drag this run's exit code to 1 over a stale process PATH.
- **winget "already installed" is not a failure.** `winget install` on a package that is already at
  the latest version exits with winget's own "Found an existing package already installed... No
  available upgrade found" code (observed verbatim: `-1978335189`, unsigned `2316632107`) — this
  proves `just` **is** on the host, just not resolvable via `which()` in *this* process yet, and a
  REQUIRED step must never map it to `failed`. On that exact code the wizard sets
  `ctx.just_needs_new_terminal = True` and re-detects before trusting winget's word blindly: `which("just")`
  again, then the per-user winget Links shim dir (`%LOCALAPPDATA%/Microsoft/WinGet/Links/just.exe` —
  what winget adds to the user PATH registry value a live process does not re-read), then the
  package's own directory under `%LOCALAPPDATA%/Microsoft/WinGet/Packages/Casey.Just_*/**/just.exe`
  (globbed — the `<id>_<source>_<hash>` suffix is winget-chosen and opaque). Found anywhere →
  `installed`, never `failed`. Found nowhere despite winget's claim → `needs-operator` (a real
  contradiction between winget's own report and the filesystem; a human resolves it), still never
  `failed` on a required step over an install winget itself says already succeeded.

### 6.4 sqlite

- **detect** `import sqlite3` in the *target* interpreter (the one `uv run` gives the ADWs), plus
  `shutil.which("sqlite3")`.
- The **stdlib module is required** — `adws/adw_modules/tracer.py` imports it and the whole trace
  depends on it. Missing module → `failed`.
- The **CLI is optional** everywhere (Windows has none by default and needs none). Absent → `ok`
  with a note. Never installed.

### 6.5 node + npm

pi, the bridge, the subagents package and CodeGraph are all npm-distributed, so node is a hard
prerequisite.

- **detect** `node --version` (floor: 20), `npm --version`.
- **apply**
  | OS | Behaviour |
  |---|---|
  | Windows | Present on this laptop already. If absent: **ask first even under `--yes`** — installing a Node runtime on a personal machine is intrusive. `--yes` turns this into `needs-operator` printing `winget install OpenJS.NodeJS.LTS`. |
  | Linux server | Install via the distro's nodesource setup if absent; report the exact commands in the plan. |
  | Container | **Assumed present in the base image.** Absent → `failed` with "add node to the image"; the wizard does not mutate a container's package state for a runtime that belongs in its Dockerfile. |

### 6.6 pi, and `PI_PATH`

- **detect** `shutil.which("pi")` and the npm global root; look for
  `<npm root -g>/@earendil-works/pi-coding-agent/dist/cli.js`.
- **apply** `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` (the docs' own
  command; `--ignore-scripts` is theirs too).
- **derive `PI_PATH`** — the step that closes a real hole: a fresh clone has no `.env`, and
  `agent_pi._resolve_pi_cmd()` raises without `PI_PATH`.
  1. `npm root -g` → join `@earendil-works/pi-coding-agent/dist/cli.js` → assert `is_file()`.
  2. Rewrite backslashes to forward slashes. `shlex.split(posix=True)` treats a backslash as an
     escape; `C:/Users/...` survives, `C:\Users\...` does not.
  3. Value: `PI_PATH="node <that path>"` — **double-quoted**. just 1.58.0's `set dotenv-load`
     (the justfile's own line) cannot parse an unquoted value containing a space, and `PI_PATH=node
     <path>` is exactly that shape — verified against the real binary: `just --evaluate` fails with
     "Error parsing line" unquoted, and passes quoted. `python-dotenv` (what the ADWs use) and
     `just`'s dotenv-load both strip one matching pair of outer quotes before the value reaches an
     environment variable, so `agent_pi._resolve_pi_cmd()`'s `shlex.split(posix=True)` sees the
     already-unquoted `node <path>` and splits on the space exactly as before — quoting is invisible
     past the `.env` parser.
  4. Compare the merged text against the current `.env` FIRST (spec §7 item 2): identical content is
     a no-op — no snapshot, no rewrite, and the step's outcome stays whatever detection already said.
     Only when the merge actually changes something does `snapshot(.env)` run, immediately before the
     rewrite. If `.env` does not exist, seed it from `.env.sample` first, then set the key (always a
     write, since the file is being created) — preserve every other line, comments included.
  5. Also set `PI_MODELS_PATH` to the absolute `~/.pi/agent/models.json` (forward slashes), quoted
     the same way as `PI_PATH`, so nothing depends on home-dir expansion.
- **Linux/container:** the same node+cli.js form is preferred (an absolute path is never ambiguous).
  If pi came from `https://pi.dev/install.sh` as a self-contained binary, `PI_PATH` is the
  **resolved absolute path** of that binary — `agent_pi` accepts a bare command on PATH, but the
  wizard never writes one. The cmd.exe truncation bug is Windows-only; the absolute-path rule is
  universal because it is cheaper than remembering which hosts are safe.
- **verify** `node <cli.js> --version` exits 0, and the value written to `.env` round-trips through
  the same two-step parse a real consumer performs — strip one matching pair of outer quotes (what
  `python-dotenv`/`just`'s dotenv-load do), then `shlex.split(posix=True)` — back to an existing
  file. Test that last assertion in `installer/tests/` — it is the exact failure this landmine
  describes.

### 6.7 pi packages — the bridge and the subagents

Two packages, exactly the two the proven reset holds: `pi-claude-bridge`, `@tintinweb/pi-subagents`.

pi supports both a declarative and an imperative path, and the wizard uses **both**, because using
only the declarative one is what caused the launch-time install T30 recorded:

- `settings.json` key `"packages"` — what pi auto-installs at launch (docs: *"project packages
  auto-installed on startup"*, installed to `~/.pi/agent/npm/`).
- `pi install npm:<pkg>` — imperative, ahead of time (docs: `pi install`, `pi remove`, `pi list`,
  `pi update --extensions`).

**apply**
0. Detect first: when both packages already appear in `settings.json` **and** exist on disk under
   `~/.pi/agent/npm/node_modules/`, the whole step is a full no-op — no snapshot, no rewrite, no
   `node <cli.js> install` call (spec §7 items 1/2/4).
1. Otherwise, compare the merged `settings.json` against what is on disk **before** writing —
   `snapshot(~/.pi/agent/settings.json)` runs only when the merge actually changes the file; create
   the file if absent (always a write, nothing to compare against).
2. **Merge** the `packages` array — union, order-stable, no duplicates. Preserve every other key
   untouched. pi rewrites this file itself (it persisted `defaultProvider`/`defaultModel` from the
   TUI), so the wizard must be a merger, never an author. Corollary from MAP rule 12: nothing the
   factory *depends on* may live only here — `PI_PATH` and the roster live in `.env` and
   `sssf.config.yaml`, which is why this step writes only `packages`.
3. One-line checklist item from the T30 audit: **if a `theme` key names a theme that is not
   installed, remove the key** (it errors on every launch and falls back). Do not create
   `themes/`. Park nothing extra — this is a key deletion folded into the same compare-then-snapshot
   cycle as item 1, not a separate park.
4. `node <cli.js> install npm:pi-claude-bridge` and `… npm:@tintinweb/pi-subagents`. Programmatic
   invocation, so `PI_PATH` form, never `pi`. Only reached when item 0 did not already short-circuit.
5. Do **not** pin versions. Unpinned specs are what `pi update --extensions` reconciles; a pin
   would silently freeze the bridge. (Reconsider only if a bridge break traces to a version.)

**verify** `node <cli.js> list` names both, and `~/.pi/agent/npm/node_modules/<pkg>` exists on
disk. Plus V1 in §9 — the convergence probe, which is the real test.

**Idempotency:** `pi install` on an already-installed package is a no-op; the merge is a set union;
a second run is a full no-op (item 0) and reports both as `ok` — zero snapshots, zero `pi install`
calls, matching acceptance A5.

### 6.8 ollama-cloud provider wiring

The non-obvious part, recovered once already from `~/.pi-backup-20260811`. There was never a
third-party ollama package — this is hand-built, and this is the restore:

**apply**
1. `~/.pi/agent/scripts/` created if absent.
2. For each vendored script: compare sha256 against what is on disk. Identical → `ok`. Different or
   absent → `park_replace(existing)`, copy the vendored file, `chmod +x` on POSIX.
3. Detect first: when `providers["ollama-cloud"].models` in `~/.pi/agent/models.json` is already
   non-empty, the rest of this step is a full no-op — no snapshot, no rewrite, and the model-sync
   (item 8, a network call) does not run (spec §7 items 1/2: "skip the model-sync when the provider
   block already exists non-empty").
4. Otherwise, **prove the apiKey command before anything referencing it is written** — order matters:
   the wizard runs `<interp> <script>` — `python` on Windows, `python3` on POSIX, whichever name
   actually gives a clean result — and requires either a non-empty key on stdout or the script's own
   clean "key not found" on stderr with exit 1. Any other outcome (interpreter missing, traceback
   under *both* names) → `failed`, and `models.json` is not touched at all this run. Never write an
   `apiKey` command the wizard has not executed.
5. `snapshot(~/.pi/agent/models.json)`; create `{"providers":{}}` if absent. Compare the merged
   document against the current file first (spec §7 item 2) — identical content is a no-op, no
   snapshot, no rewrite.
6. Merge `providers["ollama-cloud"]` from the seed asset, then rewrite the host-specific field using
   the **proven** interpreter name from item 4 — never a blind per-OS default, the name that actually
   ran clean is the name that gets written:
   ```json
   "ollama-cloud": {
     "api": "openai-completions",
     "apiKey": "!<interp> '<abs>/.pi/agent/scripts/ollama-cloud-key.py'",
     "authHeader": true,
     "baseUrl": "https://ollama.com/v1",
     "compat": {
       "maxTokensField": "max_tokens",
       "supportsDeveloperRole": false,
       "supportsReasoningEffort": true,
       "supportsUsageInStreaming": true
     },
     "models": [ … ]
   }
   ```
   `<abs>` uses forward slashes on every OS.
7. Preserve every other provider in the file. Merge, never overwrite the document.
8. Run `python <sync-ollama-cloud-models.py>` to regenerate the block from
   `https://ollama.com/v1/models` live (skipped entirely by item 3 once the block is already wired).
   The roster drifts; the seed's model list is a floor, not a truth. Classify as a `network` step
   (one retry).
   - Sync needs the key. **No key → this step is `needs-operator`**, not `failed`, and prints:
     log into OpenCode (`opencode auth login` → ollama-cloud), or place the key at
     `%LOCALAPPDATA%\opencode\auth.json` (Windows) / `~/.local/share/opencode/auth.json` (POSIX)
     as `{"ollama-cloud": {"key": "..."}}`. The seed provider block from items 5/6 is still written in
     this case (the apiKey command was proven in item 4, just found no key yet). The verification
     round trip (V2) will then fail and the run exits 2 — correct and honest: the host is not
     finished.
9. Do **not** use the sync script's `--from-server` flag. It reads connection details out of a
   personal babysitter script path. It is recorded here as prior art for the local↔server credential
   problem, and left alone.

**Restart required:** pi composes models from `models.json` at startup. See §10.

**Why the key script matters beyond ollama:** it reads OpenCode's `auth.json`, which is why
ollama-cloud and opencode-go surface the same models — **they are one subscription, one quota**
(MAP roster). The lane balancer already knows this; the wizard must not present them as two.

### 6.9 skylos — and the Windows reality

- **apply** `uv sync --group scan` (the group already exists in `pyproject.toml`, deliberately
  separate from `dev` so a failure cannot take ruff/mypy/pytest down with it).
- **verify** `uv run --group scan skylos --version` exits 0.
- **Windows laptop classification — the declared rule:**
  > `skylos` ships wheels, but depends on `tree-sitter-dart-orchard`, which publishes **sdist
  > only, on every platform**, so it compiles from source everywhere. Linux has gcc. This laptop
  > has no MSVC and never will — it is a planning box.

  On `target == laptop and platform == Windows`, a provisioning failure whose captured output
  mentions `tree-sitter-dart-orchard`, `Microsoft Visual C++`, or `error: failed to build` is
  reported as **`expected-unavailable`**, with this exact line printed:

  ```
  [--] skylos: expected-unavailable on Windows (tree-sitter-dart-orchard is sdist-only, needs MSVC).
       The AI-defect gate reads INCOMPLETE here, never PASS. The chains that build software run on
       the Linux server. Unblock on an MSVC host with: uv run --group scan skylos --version
  ```

  Any **other** failure text → `failed`. Unknown is never expected.
- **Linux server / container:** required. Failure → `failed`, run stops. Container base image needs
  a C toolchain (§11); that is a Dockerfile fact, not a wizard fallback.
- The wizard changes **no** quality wiring. `quality.ai_defects()` already treats provisioning
  failure as `incomplete`, fail-closed, and lives in the forbidden `adw_modules/` tree.

### 6.10 no-mistakes — INSTALL ONLY

MAP: the shape is decided (disposable worktree + merge-check into current `main` + open the PR,
its own review/test/docs/lint off) **but the operator wants a proper deep study before anything is
wired.** So this step installs a binary and touches nothing else.

- **apply**
  | OS | Command |
  |---|---|
  | Linux / macOS / container | `/bin/sh -c "curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh \| sh"` |
  | Windows | The project's PowerShell installer from its installation guide. **The published guide URL 404'd when this spec was written — the builder must read the current install docs and record the exact one-liner here before implementing.** Ordered fallbacks: `go install github.com/kunchenguid/no-mistakes/cmd/no-mistakes@latest` when Go is present; else download the matching GitHub release asset into `~/.local/bin`; else `needs-operator`. Never invent a command. |
- **Forbidden in this phase, enforced:** `no-mistakes init`, adding a `no-mistakes` git remote,
  starting or enabling its daemon, writing any pipeline-stage config.
- **verify** (this step's own, `required: False`) two assertions, and the second is the interesting
  one:
  1. `no-mistakes --version` exits 0.
  2. `git remote` in the repo contains **no** `no-mistakes` entry, and no `.no-mistakes/` directory
     exists in the repo. A wizard that quietly wired it would fail its own verification.
  Assertion 2 alone, **independent of assertion 1**, is what §9's V7 checks — a missing binary
  (assertion 1) must never turn V7 `needs-operator`; the two are different questions with different
  owners (this step is optional and may legitimately have no confirmed Windows installer; V7 is
  asking only "did the wizard wire it," which it can answer regardless).
- Print one line: *wiring deferred pending the deep study (MAP open questions)*.

### 6.11 CodeGraph — binary only

`npm i -g @colbymchenry/codegraph` (node is already a prerequisite). Standalone installers exist
(`install.sh` / `install.ps1`) and are the fallback when the npm global install is unavailable.

**Deliberately not run by the wizard:**

- `codegraph install` — it auto-detects installed agents and **writes MCP entries into their
  configs plus marker-fenced sections into `CLAUDE.md` / `AGENTS.md`, and edits Claude Code's
  auto-allow list**. That is wiring into the operator's harness and into whatever repo it runs in.
  Out of scope, and inside this repo it would edit instruction files the factory reads.
- `codegraph init` — creates `.codegraph/` and starts a file watcher. It is a **per-project**
  action for the messy internal codebases CodeGraph was requested for, not for the factory repo.

**verify** `codegraph --version` exits 0. Then print the two commands the operator runs himself, in
a target repo, when he wants them — including `CODEGRAPH_NO_DAEMON=1` as the watcher escape hatch.

Recorded so the expectation stays right (T30): documentation-factory's `codebase` mode already
extracts structure. CodeGraph supplies **more structure** — it improves the half that works and
does not recover the missing half (intent, normally harvested from commit messages). Install it for
navigation. Do not expect it to fix documentation quality on a repo with bad history.

### 6.12 Server / container: the credential surface

The bridges do not talk to providers directly — they front subscriptions through CLIs that must be
installed **and logged in** on whichever host runs the factory.

1. **Claude Code CLI.** Install if absent (server/container only). Detect on laptop.
2. **Codex CLI.** Same.
3. **`CLAUDE_CODE_OAUTH_TOKEN`** — the long-lived token that survives headless runs, where a
   short-lived signed-in session cannot refresh itself:
   ```
   CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)
   ```
   `claude setup-token` still needs a browser for the login it is based on. **Documented path:**
   run it on the laptop, carry the token to the server. The wizard:
   - interactive: explains, then reads the token with a **no-echo prompt** (`getpass`);
   - `--yes`: reads `CLAUDE_CODE_OAUTH_TOKEN` from the environment if set, else `needs-operator`
     printing the two commands verbatim;
   - writes it to `~/.sdl-factory/secrets.env`, mode `0600`, **never** into the repo, never into
     the run log, never to stdout — redacted at every site (§5.2);
   - appends one commented line to the repo `.env` naming where secrets live and how to source
     them (`set -a; . ~/.sdl-factory/secrets.env; set +a`).
4. **Codex auth** is a browser flow against a ChatGPT subscription (no per-token APIs — MAP rule 7).
   On a headless server the wizard prints the exact `ssh -L` port-forward recipe and waits. It never
   drives a browser.

### 6.13 UI — the phase 3 extension point

MAP: *"Server install also installs the UI."* The UI is phase 3 and does not exist. Building
anything speculative here would violate KISS and rule 1.

So the plan contains a real, named step that reports `deferred`:

```python
# EXTENSION POINT — phase 3 UI. Do not build ahead of the UI itself.
# Fill in when specs/ui-*.md lands. Constraints already known:
#   - loopback bind only; the shipped trace viewer binds 0.0.0.0
#     (apps/visualizer/server/index.ts) — loopback + Tailscale on the server
#   - Tailscale is a convenience, never a dependency (MAP)
#   - reads SQLite; pi RPC is an option, not the spine
# Returns Result("deferred") today. No package.json, no port, no service, no stub app.
def ui_install(ctx: Ctx) -> Result: ...
```

The plan prints: `[??] ui: deferred to phase 3 (extension point in steps.py:ui_install)`. Nothing
else. That is the entire hook.

### 6.14 Auth pass — the operator's job, always

Provider auth is never automated. For each lane this host needs, the wizard **detects credential
presence by looking at credential stores** — `~/.pi/agent/auth.json` entries, OpenCode's
`auth.json`, the relevant env vars — and never by asking pi.

> **`pi auth check` is disqualified as a health gate.** It reported ready on an expired token and
> not_ready on a working one in the same session. A lane is verified only by a real round trip
> returning non-zero tokens (MAP landmine, `STATE.md`).

| Lane | What the wizard prints |
|---|---|
| ollama-cloud / opencode-go | one subscription, one quota. `opencode auth login` → ollama-cloud, or place the key in OpenCode's `auth.json` (§6.8). |
| xai | launch pi, `/login xai`, choose "Use a subscription". |
| openai-codex | `codex login` (browser; `ssh -L` on a headless server). Recorded state: token expired, operator re-login pending. |
| claude-bridge | `claude` login on a browser host, then `claude setup-token` (§6.12). |

- **Interactive:** print the instruction, wait on Enter, re-detect, report. Loop at most twice per
  lane, then move on as `needs-operator`.
- **`--yes`:** print every instruction in one block and mark each unauthed lane `needs-operator`.
  Exit 2.

**Note for the human instructions:** they may say plain `pi` and `/login`. The "never invoke `pi`
by name" rule binds *programmatic* invocation — the failure is cmd.exe truncating a multi-line
`--system-prompt` at its first newline. A human typing `pi` in a terminal is fine.

---

## 7. Idempotency

Re-running is the drift check, and it must converge.

1. Every step detects before it acts. Nothing installs because a step "usually needs to".
2. File writes compare sha256 first; identical content is `ok` and does not park.
3. JSON is **merged key-wise**, never rewritten wholesale: `packages` is a set union, `providers`
   preserves siblings, `.env` preserves comments and unrelated keys.
4. npm globals and `pi install` are no-ops when already at the wanted version.
5. **Acceptance:** a second consecutive run on an unchanged host reports **zero `installed`, zero
   park actions**, and exits 0. This is testable and is criterion A5 in §13.
6. The final report always prints the skipped count, the way `install.py` already behaves.

---

## 8. Guards

1. **Forbidden write prefixes**, checked in the one place all writes go through:
   `.claude/skills/sssf/templates/`, `adws/adw_modules/`. Any attempted write under them raises and
   fails the run loudly. The factory machinery is verified; the wizard is beside it.
2. **No git operations.** The wizard never commits, never branches, never adds a remote. It reads
   `git remote` once, to prove no-mistakes is not wired (§6.10).
3. **No process killing.** It reports a running pi; it does not stop one.
4. **Secrets** never reach stdout, the log, the JSON output, or the repo.
5. **Mirror-sync is not this script's job.** MAP parks `adws/` ↔ `templates/adws/` sync in "the
   installer phase", and it belongs in that phase — but as a separate tool with its own review. The
   wizard converges *hosts*, not the repo, and it may not write to `templates/` at all. See §12.
6. **The `defaults.harness_engineering:` merge fix** (MAP rule 3) lives in the config loader and
   `agent_pi` — forbidden tree, different job, explicitly out of scope.

---

## 9. Verification — real round trips only

Runs last, always, even after `needs-operator`. Each check prints one ASCII line and lands in the
report.

| # | Check | How | Pass condition |
|---|---|---|---|
| **V1** | **Nothing installs at launch** (MAP rule 14 — the point of the phase) | **DEFERRED to the server phase** (see caveat below) — spec'd as: launch pi once headlessly, `-p` with a short prompt, `--no-session`, hard timeout, capture stdout+stderr | Output contains **no** npm chatter (`/added \d+ packages/`, `npm install`, download lines). The T30 observation — *"added 102 packages… added 4 packages…"* then an `fd` download, before the TUI — is the exact regression this catches. **On this build, the deterministic fallback pair runs instead** (see caveat). |
| **V2** | **Test-lane round trip through the factory** | `uv run adws/adw_prompt.py --config adws/adw_sssf_config/sssf.config.yaml --agent scout --adw-id <minted> "reply with the single word OK"` | exit 0, **and** `SELECT status, total_tokens FROM sessions WHERE adw_id=?` in `adws/adw_data/sssf.db` returns `success` and `total_tokens > 0`. Non-zero tokens is the standard; anything less is not verification. |
| **V3** | claude-bridge **registration** (deliberately *not* a round trip) | `node <cli.js> -ne -e ~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts --provider claude-bridge --list-models` | at least one `claude-*` model listed. **No Anthropic call is made** — MAP rule 4, and the mechanism was already proven once (`BRIDGE_OK`); there is no reason to spend Claude quota again. |
| **V4** | pi-subagents loads | `node <cli.js> list` names it; extension loads with no error under an explicit `-e` | listed, clean load. No agent call. |
| **V5** | skylos | `uv run --group scan skylos --version` | exit 0, **or** `expected-unavailable` under the §6.9 rule. |
| **V6** | toolchain | `uv`, `just --list` **and** `just --evaluate` **and** `just doctor`, `node`, `npm`, `no-mistakes`, `codegraph` versions; `import sqlite3` | no sub-check is `failed` (see V6 caveat — `needs-operator` is a declared, visible exception, not silent) |
| **V7** | no-mistakes not wired | `git remote`, `.no-mistakes/` | absent — **independent of whether the no-mistakes binary is installed** (the binary check lives in §6.10's own verify, an optional/`required: False` step; V7 must not fail or need-operator over a fact it never claimed to check) |
| **V8** | server only | `claude --version`, `codex --version`, token present in `~/.sdl-factory/secrets.env` | exit 0; token presence reported **redacted** |

**Kimi caveat, carried from MAP:** Kimi K2.7-code's envelope compliance is imperfect — the first
response of the first real round trip was invalid envelope JSON and recovered on retry inside the
same session. V2 therefore leans on the ADW's own retry budget and allows **one** repeat of the
whole ADW call. A second failure is `failed`, reported with the `adw_id` so the trace is a visible,
named artifact rather than silence.

**V6 caveat — three checks, and what "all exit 0" means:** verified against the real 1.58.0 binary,
`just --list` never loads `.env` (`set dotenv-load`), so it stayed green through the whole
BLOCKER-1-shaped regression (an unquoted `PI_PATH` broke every real recipe while `--list` kept
reporting success). `just --evaluate` goes through the same dotenv-load path a real recipe does,
costs no tokens, and needs no `sqlite3` CLI (§6.4: optional, never required) unlike `just sessions` —
but neither `--list` nor `--evaluate` ever spawns the *configured shell* to run a recipe body, which
is exactly the gap "just could not find the shell `sh`" fell through (§6.3): a fresh Windows terminal
with no `sh` on PATH parsed the justfile clean and evaluated its dotenv clean, and only broke the
moment a real recipe tried to run. `just doctor` (root justfile's token-free recipe, §6.3) closes
that gap — it is a real recipe invocation through the real configured shell, so a missing/wrong shell
or a cmd.exe-incompatible recipe body fails right here, not later at `just demo`.

Separately: a `just` that was installed earlier in **this same run** but is not yet resolvable via
`shutil.which` in this process (§6.3's Windows note) reads `ok` here, not `failed` — a stale process
PATH must never drag a successful install's exit code to 1.

Honesty residual 3(a) — `verify_v6_toolchain` runs six sub-checks (`uv`, `just`, `node`,
`no-mistakes`, `codegraph`, `sqlite`); only `no-mistakes` can legitimately read `needs-operator`
(§6.10 — no confirmed Windows installer, and its own Step is already `required: False`). **Decided,
spec-honest reading:** "all exit 0" means *no sub-check outcome is `failed`* — a `needs-operator`
sub-result does not fail V6 (it is the SAME already-declared optional gap the no-mistakes Step
carries, not a new V6 failure mode), but it is never swallowed either: `verify_v6_toolchain` surfaces
it inline as a visible `[!] no-mistakes: <message>` in its own `ok` message rather than reporting a
bare, misleadingly-clean "ok". The alternative (fail V6 outright on any needs-operator sub-check) was
rejected because it would turn an already-known, already-declared, optional-binary gap into a
required-check failure — a worse and less honest outcome than making it visible.

**V1 — deferred to the server phase, decided (not guessed):** whether `-ne` also suppresses package
installation at launch was never settled experimentally in this build — that probe needs a live pi
launch on a host where a declared package is deliberately absent, and this Windows laptop is not
that host (pi's own launch-install behavior is exactly what §6.9/MAP already say the server is for:
"the chains that build software run on the Linux server"). Recorded here rather than guessed:
- **The launch probe is DEFERRED to the server phase.** A cold host — freshly converged, nothing
  cached — is the natural place to run it once, honestly, rather than faking a "clean launch" claim
  on a laptop that was never the target for this check.
- **The deterministic fallback pair (already implemented, `verify_v1_no_launch_install` in
  `installer/steps.py`) is the accepted laptop/this-build check**: `node <cli.js> list` names both
  packages **and** `~/.pi/agent/npm/node_modules/<pkg>` exists on disk for each. It is reported
  labeled as exactly that — "V1 fallback (deterministic pair, not a launch probe)" — never as a
  launch observation that did not happen.
- **Acceptance A3 (§13) is server-phase scope.** "After A2, V1 passes: a cold pi launch prints no npm
  install output" is the real launch-probe claim and is verified on the server, not on this laptop
  build; on the laptop, A3 is satisfied by the deterministic fallback pair passing, and the report
  says so rather than claiming the launch itself was observed.

---

## 10. Restart pi

`models.json` is composed at startup, so provider changes need a restart; packages installed by
`pi install` are picked up by the next launch.

- The wizard **detects** a running pi process (best effort, by process name) and reports it. It
  does not kill it.
- Its own V1 probe is a fresh process **after every write** — so the wizard has already proven that
  a cold start is clean before it says so.
- The closing line, always printed:
  ```
  [ok] restart pi to pick up models.json and packages:  exit any running pi, then run:  pi
  ```
- Report the extension hot-reload nuance once, as a convenience: extensions in the auto-discovery
  dirs (`~/.pi/agent/extensions/`, `.pi/extensions/`) support `/reload`; `models.json` does not.

---

## 11. Platform differences, in one place

| Concern | Windows laptop | Linux server | Container |
|---|---|---|---|
| Bootstrap | `irm https://astral.sh/uv/install.ps1 \| iex` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | same as server, or bake uv into the image |
| just | winget → cargo → `needs-operator`; PATH not live in the current process | `just.systems/install.sh --to ~/.local/bin` | same; PATH set in the image |
| node | ask before installing, even under `--yes` | install if absent | **must be in the base image**; absent = `failed` |
| `PI_PATH` | `node C:/Users/.../@earendil-works/pi-coding-agent/dist/cli.js` — forward slashes are load-bearing | absolute cli.js or resolved binary path | same as server; path must be inside the image, not a mount |
| skylos | `expected-unavailable` (no MSVC) | required | required; base image needs a C toolchain (gcc, python headers) |
| sqlite3 CLI | absent, fine | usually present | usually present |
| Provider auth | browser available — do the logins here | no browser: `claude setup-token` from the laptop, `ssh -L` for codex | **no interactive auth at all** — credentials are injected as env or mounted files; the wizard prints what to mount and exits 2 if absent |
| State | `~/.pi/`, `~/.sdl-factory/` on the box | same | **must be an explicit mount, or accepted as disposable.** The wizard prints exactly which paths need mounting: `~/.pi/agent/`, `~/.sdl-factory/`, and the repo's `adws/adw_data/`. |
| Daemons / services | none | none in this phase (UI service is phase 3) | none — no systemd; anything wanting a service is `deferred` |
| Park failures | rename can fail on locked or >260-char paths → `needs-operator`, never delete | rare | rare |
| Claude/Codex CLIs | detect only | install + auth | install; auth via injected token |
| Tailscale | not used | convenience only, never a dependency | not used |

---

## 12. Choices this spec makes that MAP did not dictate

Each is a decision, not a discovery, and each is cheap to reverse.

1. **uv is a prerequisite, not an install target.** The wizard cannot install its own launcher.
   One documented one-liner per OS; the step checks and offers `uv self update`.
2. **stdlib-only PEP 723 header (`dependencies = []`).** A fresh clone on a fresh server runs the
   wizard with zero dependency download. `rich` would be nicer and is not worth the network.
3. **Two files, `install.py` + `steps.py`.** The seam is CLI/orchestration vs. step definitions.
   No third module, no registry, no config file.
4. **Park has two flavours** — `park_replace` (move, for whole-file replacement) and `snapshot`
   (copy, before an in-place merge). One primitive could not do both without either deleting or
   leaving a config-less window.
5. **Secrets go to `~/.sdl-factory/secrets.env` (0600), never to the repo `.env`.** The repo gets
   `PI_PATH`/`PI_MODELS_PATH` and a comment pointing at the secrets file. A re-clone or a worktree
   must not carry tokens.
6. **CodeGraph is installed but `codegraph install` is never run.** It rewrites `CLAUDE.md` /
   `AGENTS.md` and Claude Code's allow-list — that is wiring the operator's harness, and it is not
   what "install CodeGraph" was asked for.
7. **`codegraph init` is a per-project operator action,** not a wizard step. The factory repo does
   not need an index of itself, and it would start a watcher.
8. **claude-bridge is verified by registration, not by a round trip.** Rule 4 forbids Anthropic in
   tests and the mechanism was already proven once. Registration + a listed model is the strongest
   check that costs nothing.
9. **V2 goes through `adw_prompt.py` rather than a raw pi call.** It proves the whole path the
   factory actually uses — config validated, session minted, agent ran, envelope parsed, gates
   checked, trace written — and reuses code the wizard is forbidden to touch.
10. **Exit code 2 for `needs-operator`.** Auth is the operator's job by rule; CI needs to tell "a
    human owes us a login" apart from "the install is broken".
11. **Node install asks first on Windows even under `--yes`.** A personal laptop is not a server.
12. **Mirror-sync (`adws/` ↔ `templates/adws/`) is excluded.** MAP parks it in the installer phase;
    it is the same phase but a separate tool, because the wizard converges hosts and is forbidden
    to write into `templates/`.
13. **Uninstall / move-hosts is deferred**, with the park primitives built now as its foundation.
14. **`--verify-only` and `--json` added** beyond the three required flags: the first makes the
    drift check a first-class command, the second makes CI consumption honest. Both are ten lines.
15. **The `/wizard` skill (bash generator) was not used.** MAP and the task call for one Python
    script with a real exit code, matching the ADWs — and rule 8 forbids burying process steps in a
    skill.

---

## 13. Acceptance criteria

| # | Criterion |
|---|---|
| A1 | `uv run installer/install.py --dry-run --target server` on the Windows laptop prints the full server plan, exits 0, and **changes not one byte** on disk (verify with a before/after tree hash of `~/.pi`, `~/.sdl-factory` and the repo). |
| A2 | `uv run installer/install.py --target laptop --yes` on this laptop: installs `just`, converges pi + both packages + the ollama-cloud block, classifies skylos `expected-unavailable` with the §6.9 wording, installs no-mistakes and CodeGraph without wiring either, writes a valid `PI_PATH` into `.env`. |
| A3 | **Server-phase scope** (§9 V1 caveat): after A2, V1's real claim — a cold pi launch prints no npm install output — is verified on the server, not this laptop build. Here, A3 is satisfied by V1's deterministic fallback pair passing (`node <cli.js> list` names both packages **and** both exist under `~/.pi/agent/npm/node_modules/`), reported labeled as a fallback, never as an observed launch. |
| A4 | After A2, V2 passes: `adw_prompt --agent scout` on `ollama-cloud/kimi-k2.7-code` exits 0 and the session row shows `success` with `total_tokens > 0`. No Anthropic model is called anywhere in the run. |
| A5 | A second immediate run reports zero `installed`, zero park actions, exits 0. |
| A6 | Every replace path parked: the ledger at `~/.sdl-factory/install/park-ledger.jsonl` accounts for every changed file, and nothing was deleted (`park-ledger` entries all resolve to existing paths). |
| A7 | A write attempt under `adws/adw_modules/` or `.claude/skills/sssf/templates/` raises and fails the run — proven by a unit test, not by inspection. |
| A8 | `git remote` shows no `no-mistakes` entry and no `.codegraph/` or `.no-mistakes/` directory exists in the repo after a full run. |
| A9 | With no ollama-cloud key present, the run exits **2**, names the exact file to create, and does not claim success. |
| A10 | `--json` output parses, and its per-step outcomes match the human table exactly. |
| A11 | No non-ASCII byte reaches stdout in any run; every subprocess call site pins `encoding="utf-8"`; a grep for an unpinned `open(`/`read_text(`/`subprocess.run(` in `installer/` returns nothing. |
| A12 | No token, key or secret appears in `~/.sdl-factory/install/*.log`, in stdout, or in the JSON output. |

---

## 14. Sources

- `MAP.md` — build phase 2, standing rules 1/4/5/7/8/11/12/13/14, Platform landmines, Roster, Open
  questions (no-mistakes deep study).
- `sdl-factory-parked-20260812/wayfinder-record/tickets/T30-installer-wizard.md` — targets, the
  bridges' CLI requirement, the tool list, the ollama-cloud recipe, the launch-install observation,
  the park instruction, the CodeGraph caveat. Reference only.
- `sdl-factory-parked-20260812/wayfinder-record/STATE.md` §"pi — reset and verified" — the five
  files in `~/.pi/agent/`, exactly two extensions, the 2,525 MB park, the `-e` bridge invocation
  and its `--list-models` evidence, `pi auth check` disqualified, test lane.
- `https://pi.dev/docs/latest` (fetched 2026-08-12): `/settings` (`packages`, `extensions`,
  `defaultProvider`, global `~/.pi/agent/settings.json` vs project `.pi/settings.json`);
  `/extensions` (`-e`, `--no-extensions`, auto-discovery dirs, `/reload`); `/packages`
  (`pi install` / `pi remove` / `pi list` / `pi update --extensions`, `npm:`/`git:` specifiers,
  install location `~/.pi/agent/npm/`, project packages auto-installed on startup);
  `/custom-provider` (`providers` block shape, `api`, `baseUrl`, `apiKey`, `compat`, **restart
  required**); `/providers` (`/login` subscription flows, `auth.json`, resolution order); install
  via `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.
- Live host inspection (2026-08-12): `~/.pi/agent/{settings,models}.json`, both `scripts/`,
  `.env`'s `PI_PATH`, `adws/adw_modules/agent_pi.py:25-73`, `adws/adw_modules/tracer.py` schema,
  `pyproject.toml` groups `dev`/`scan`, `justfile`. Confirmed absent on this laptop: `just`,
  `sqlite3` CLI.
- Vendor docs: `github.com/colbymchenry/codegraph` (npm package, `install.sh`/`install.ps1`, what
  `codegraph install` and `codegraph init` do, `CODEGRAPH_NO_DAEMON=1`);
  `github.com/kunchenguid/no-mistakes` (Go, `docs/install.sh`, `no-mistakes init` is what wires a
  repo — **the Windows one-liner is unconfirmed and flagged in §6.10**).
