"""Step definitions, park primitives, config merge, the subprocess wrapper.

The one module besides install.py (spec: installer-wizard.md section 1). Stdlib
only — install.py carries the PEP 723 header with `dependencies = []`, and this
module is what it imports, so nothing here may require a network install
either. No framework: `Step` is a plain frozen dataclass holding three plain
callables, `Outcome` is a Literal, and `STEPS` is a plain list built once at
import time. Detect/apply/verify are ordinary functions grouped by concern.

Two rules that hold everywhere in this file, both paid for already (MAP.md
"Platform landmines"):
  - every subprocess call and every file read/write pins encoding="utf-8".
  - every line this module prints to stdout is ASCII-only (see install.py's
    `_ascii` at the print site; this module never prints directly — it returns
    Result/Detected objects and lets install.py do the printing).
"""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import platform
import re
import secrets as secrets_mod
import shlex
import shutil
import sqlite3
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

# ── constants ────────────────────────────────────────────────────────────────

ALL = frozenset({"laptop", "server", "container"})
SERVER_CONTAINER = frozenset({"server", "container"})

# The roster the engine service runs on when the operator names none - the
# same fallback `adws/engine.py` and the justfile use, kept in one string here
# so the unit always states it out loud rather than inheriting it silently.
DEFAULT_ENGINE_CONFIG = "adws/adw_sssf_config/sssf.config.yaml"

# Who the always-on engine commits card write-backs as on a host that cannot
# auto-detect an identity (see `ensure_engine_git_identity`). The same two
# strings as `adws/engine.py`'s COMMITTER_NAME / COMMITTER_EMAIL, repeated
# rather than imported: this module is stdlib-only by contract (install.py
# declares `dependencies = []`) and adws/ is not importable from here.
ENGINE_GIT_NAME = "sdl-factory engine"
ENGINE_GIT_EMAIL = "engine@sdl-factory.local"

# Every write this module makes to the repo goes through `write_text`, which
# checks this list first (spec section 8.1). The factory machinery is done and
# verified; the wizard is new code beside it and must never touch either tree.
FORBIDDEN_PREFIXES = (
    ".claude/skills/sssf/templates/",
    "adws/adw_modules/",
)

Outcome = Literal["ok", "installed", "expected-unavailable", "needs-operator", "failed", "deferred"]

# ASCII status markers (spec section 5.2) — never a glyph. cp1252 killed 100%
# of headless runs the moment a Rich panel border reached a non-UTF-8 pipe;
# these five strings are the entire vocabulary this program prints as a marker.
MARKERS: dict[str, str] = {
    "ok": "[ok]",
    "installed": "[++]",
    "expected-unavailable": "[--]",
    "needs-operator": "[??]",
    "failed": "[!!]",
    "deferred": "[??]",
}

NETWORK_TIMEOUT = 300   # network steps (spec section 5.2)
PROBE_TIMEOUT = 30      # version probes

ASSETS_DIR = Path(__file__).resolve().parent / "assets" / "pi"
VENDORED_SCRIPTS = ("ollama-cloud-key.py", "sync-ollama-cloud-models.py")
PI_PACKAGES = ("npm:pi-claude-bridge", "npm:@tintinweb/pi-subagents")
PI_PACKAGE_DIRS = ("pi-claude-bridge", "@tintinweb/pi-subagents")

UV_FLOOR = (0, 5, 0)
# Field lesson, 2026-08-18, a real deploy: pi 0.84.1 (see PI_PIN below) needs
# undici's CacheStorage, which node 20 does not have and crashes on. 22 is
# the floor, 24 is the version actually installed (see _nodesource_command) -
# both the laptop's proven combo.
NODE_FLOOR = (22, 0, 0)

# 0.74.x's `pi install` writes settings.json but MATERIALIZES NOTHING on disk
# - a no-op that fakes success (apply_pi_packages's on-disk check is what
# caught it). 0.84.1 is the version proven on the laptop, paired with
# NODE_FLOOR above.
PI_PIN = "0.84.1"

NO_MISTAKES_INSTALL_SH = (
    "curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh"
)

# Substrings observed verbatim in `uv sync --group scan` output on this exact
# Windows laptop (see pyproject.toml's `scan` group and adw_modules/quality.py,
# which classifies the same failure for the in-run AI-defect gate). Matched
# case-insensitively. Narrow on purpose — an unmatched failure must read
# `failed`, never silently `expected-unavailable` (spec section 6.9: "Unknown
# is never expected").
SKYLOS_WINDOWS_SIGNATURES = (
    "tree-sitter-dart-orchard",
    "microsoft visual c++",
    "failed to build",
)

# winget's own "no applicable update found" signal for `winget install` when
# the package is already present at the latest version — observed verbatim on
# this laptop (finding 1): "Found an existing package already installed...
# No available upgrade found". This is NOT an install failure; it is winget
# confirming `just` IS on the host. Python's subprocess returncode on Windows
# reflects the raw 32-bit exit code sign-extended, so the value actually seen
# at the call site is the negative form; the unsigned 32-bit form (what
# winget's own docs/error tables quote) is kept alongside it defensively —
# both resolve to the same bit pattern (2316632107 == -1978335189 & 0xFFFFFFFF).
WINGET_ALREADY_INSTALLED_CODES = (-1978335189, 2316632107)

# Any value read from a no-echo prompt, or the value of an env var whose NAME
# matches this, is redacted before anything is printed or logged (spec 5.2).
_SECRET_ENV_NAME = re.compile(r"(TOKEN|KEY|SECRET)", re.IGNORECASE)


# ── types ───────────────────────────────────────────────────────────────────

@dataclass
class Ctx:
    """One run's context. Passed by reference to every detect/apply/verify —
    mutable only in the narrow sense that `secrets` accumulates values a step
    read at runtime (e.g. a pasted token) so later `run()` calls redact them,
    and `just_needs_new_terminal` records a same-run fact (BLOCKER 3)."""
    repo_root: Path
    target: str
    home: Path
    yes: bool
    dry_run: bool
    verify_only: bool
    json_mode: bool
    run_id: str
    started_at: str
    install_dir: Path        # ~/.sdl-factory/install
    log_path: Path           # install_dir / "<ts>-<target>.log"
    secrets_env_path: Path   # ~/.sdl-factory/secrets.env
    env_path: Path           # repo/.env
    # The systemd unit path for the engine service (specs/engine.md 7).
    # A Ctx field, same reason env_path/secrets_env_path are: it is the ONE
    # place engine-service's detect/apply/verify read or write, so a test can
    # point it at a tmp_path stand-in instead of the real
    # /etc/systemd/system/ - this wizard runs its unit tests on a Windows
    # laptop, where that path is not even valid.
    engine_unit_path: Path = field(
        default_factory=lambda: Path("/etc/systemd/system/sdl-engine.service"))
    # The agent roster the engine service ships cards on, written into the
    # unit as `Environment=SSSF_CONFIG=...` (specs/engine.md 7). Read from the
    # environment here for the same reason the justfile reads it: `SSSF_CONFIG=
    # adws/adw_sssf_config/sssf.shipping.config.yaml installer/install.py`
    # is then the ONE supported way to point the always-on service at a
    # different roster, and it converges instead of being parked on the next
    # run the way a hand-edited unit would be.
    engine_config: str = field(
        default_factory=lambda: os.environ.get("SSSF_CONFIG") or DEFAULT_ENGINE_CONFIG)
    interp: str = field(default_factory=lambda: "python" if platform.system() == "Windows" else "python3")
    secrets: set[str] = field(default_factory=set)
    # Set by apply_just (spec 6.3's Windows note): a fresh winget install that
    # is not resolvable via shutil.which in THIS process. verify_just reads
    # it so the same, already-successful install does not drag this run's
    # exit code to 1 just because the current process's PATH is stale
    # (BLOCKER 3).
    just_needs_new_terminal: bool = False

    @property
    def ledger_path(self) -> Path:
        return self.install_dir / "park-ledger.jsonl"


@dataclass
class Detected:
    present: bool
    detail: str = ""
    data: dict = field(default_factory=dict)


@dataclass
class Result:
    outcome: Outcome
    message: str


@dataclass(frozen=True)
class Step:
    id: str
    title: str
    targets: frozenset[str]
    required: bool
    detect: Callable[[Ctx], Detected]
    apply: Callable[[Ctx], Result]
    verify: Callable[[Ctx], Result]


@dataclass(frozen=True)
class VerifyCheck:
    id: str
    title: str
    targets: frozenset[str]
    check: Callable[[Ctx], Result]


class RepoNotFoundError(RuntimeError):
    """Raised when the script's own location does not resolve to this repo."""


class ForbiddenWriteError(RuntimeError):
    """Raised when a write targets a path this wizard must never touch."""


@dataclass
class RunResult:
    argv: list[str]
    returncode: int
    stdout: str
    stderr: str
    duration_s: float
    timed_out: bool = False


# ── small stdlib helpers ─────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def new_id(length: int = 8) -> str:
    return secrets_mod.token_hex(length // 2)


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def which(cmd: str) -> str | None:
    return shutil.which(cmd)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _parse_version(text: str) -> tuple[int, ...]:
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", text)
    return tuple(int(x) for x in match.groups()) if match else (0, 0, 0)


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


# ── forbidden-path guard + the one place all repo writes go through ─────────

def guard_repo_write(path: Path, ctx: Ctx) -> None:
    """Raises ForbiddenWriteError for any path under the two protected trees.

    A path outside the repo entirely (e.g. ~/.pi/agent/settings.json) is not a
    forbidden prefix and passes through — this guard is about the repo's own
    machinery, not about every file the wizard ever touches.
    """
    try:
        rel = path.resolve().relative_to(ctx.repo_root.resolve())
    except ValueError:
        return
    rel_posix = rel.as_posix()
    for prefix in FORBIDDEN_PREFIXES:
        bare = prefix.rstrip("/")
        if rel_posix == bare or rel_posix.startswith(prefix):
            raise ForbiddenWriteError(
                f"refusing to write under forbidden path: {rel_posix} "
                f"(protected: {prefix})"
            )


def write_text(path: Path, content: str, ctx: Ctx) -> None:
    """THE one place every write in this module goes through (spec 8.1)."""
    guard_repo_write(path, ctx)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


# ── park primitives (spec 5.1, MAP rule 5: park, never delete) ─────────────

def _unique_park_path(path: Path) -> Path:
    base = f"{path.name}.parked-{_timestamp()}"
    candidate = path.with_name(base)
    n = 1
    while candidate.exists():
        candidate = path.with_name(f"{base}-{n}")
        n += 1
    return candidate


def _record_park(ledger_path: Path | None, *, run_id: str, step: str, kind: str,
                  src: Path, dest: Path) -> None:
    if ledger_path is None:
        return
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": now_iso(),
        "run_id": run_id,
        "step": step,
        "kind": kind,
        "from": str(src),
        "to": str(dest),
        "sha256": sha256_file(dest) if dest.is_file() else "",
    }
    with ledger_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def park_replace(path: Path, *, ledger_path: Path | None = None,
                  run_id: str = "", step: str = "") -> Path | None:
    """Whole-file/dir replacement: MOVE aside. None if `path` does not exist.

    Never deletes, never falls back to delete on failure, never retries with
    force. A rename can fail — a locked file, or a path over 260 chars on
    Windows — and that OSError is left to propagate; the calling step catches
    it and reports `needs-operator` with the path and the reason (spec 5.1).
    """
    if not path.exists():
        return None
    dest = _unique_park_path(path)
    path.rename(dest)
    _record_park(ledger_path, run_id=run_id, step=step, kind="replace", src=path, dest=dest)
    return dest


def snapshot(path: Path, *, ledger_path: Path | None = None,
             run_id: str = "", step: str = "") -> Path | None:
    """In-place merge: COPY aside first, so no window exists where the config
    is missing. None if `path` does not exist."""
    if not path.exists():
        return None
    dest = _unique_park_path(path)
    if path.is_dir():
        shutil.copytree(path, dest)
    else:
        shutil.copy2(path, dest)
    _record_park(ledger_path, run_id=run_id, step=step, kind="snapshot", src=path, dest=dest)
    return dest


# ── the subprocess wrapper (spec 5.2) ────────────────────────────────────────

def operator_env() -> dict[str, str]:
    """Strip the ephemeral `uv run` venv out of PATH, same landmine documented
    in adw_modules/utils.py: without this, a subprocess's `python3`/`node`
    resolve through the wizard's own throwaway venv instead of the operator's
    real PATH."""
    env = os.environ.copy()
    venv = env.pop("VIRTUAL_ENV", "")
    if not venv:
        return env
    bin_name = "Scripts" if platform.system() == "Windows" else "bin"
    venv_bin = str(Path(venv) / bin_name)
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p and p != venv_bin]
    env["PATH"] = os.pathsep.join(parts)
    return env


def _secret_values(env: dict[str, str], extra: set[str]) -> set[str]:
    found = {value for key, value in env.items() if value and _SECRET_ENV_NAME.search(key)}
    return found | {value for value in extra if value}


def redact_text(text: str, secret_values: set[str]) -> str:
    for value in secret_values:
        if value:
            text = text.replace(value, "[redacted]")
    return text


def _log_run(ctx: Ctx, result: RunResult, secret_values: set[str], attempt: int) -> None:
    """Never writes under `--dry-run` (spec 2.1: "Implies no writes... changes
    not one byte on disk", acceptance A1 - hashed across ~/.pi, ~/.sdl-factory
    AND the repo). The plan pass forces every step's Ctx.dry_run True
    regardless of the top-level flag (see install.py), so this same guard
    also means the plan pass of a REAL run is not logged - only the converge
    and verify passes are, which is where the log's content actually matters.
    """
    if ctx.dry_run:
        return
    ctx.log_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = redact_text(shlex.join(result.argv), secret_values)
    out = redact_text(result.stdout, secret_values)
    err = redact_text(result.stderr, secret_values)
    with ctx.log_path.open("a", encoding="utf-8") as handle:
        handle.write(
            f"$ {cmd}  (attempt {attempt}, exit {result.returncode}, {result.duration_s:.1f}s)\n"
        )
        if out.strip():
            handle.write(f"--- stdout ---\n{out}\n")
        if err.strip():
            handle.write(f"--- stderr ---\n{err}\n")


def _resolve_argv0(command: str) -> str:
    """Windows landmine, generalized: `CreateProcess` (what `subprocess.run`
    with `shell=False` calls) implicitly tries appending `.exe` to a bare,
    extension-less command name, but never searches PATHEXT for `.cmd`/`.bat`
    shims - so a bare "npm" raises FileNotFoundError even though `npm.cmd` is
    right there on PATH, while bare "node" (a real .exe) works. This is the
    same family of landmine already documented for `pi` in
    adw_modules/agent_pi.py (a `.cmd` shim mangling multi-line args through
    cmd.exe), generalized here to every command this wizard shells out to:
    resolve through shutil.which() first, which DOES apply PATHEXT and
    returns the real path with its real extension, and Windows can execute
    that directly. A path that already has a separator (an absolute path, or
    "/bin/sh") is left untouched; on POSIX this resolution is a harmless
    no-op (the resolved path is still directly executable).
    """
    if "/" in command or "\\" in command:
        return command
    resolved = which(command)
    return resolved if resolved else command


def run(argv: list[str], *, timeout: float, cwd: Path | None = None,
        network: bool = False, ctx: Ctx | None = None) -> RunResult:
    """The one subprocess wrapper every external command goes through.

    shell=False, argv list always. encoding="utf-8" pinned, errors="replace".
    Explicit timeout on every call. One retry, once, for `network=True` steps;
    nothing else retries. stdout+stderr are captured, redacted, and appended
    to the run log when `ctx` is given.
    """
    if not argv:
        raise ValueError("run() needs a non-empty argv")
    resolved_argv = [_resolve_argv0(argv[0]), *argv[1:]]
    env = operator_env()
    secret_values = _secret_values(env, ctx.secrets if ctx is not None else set())
    attempts = 2 if network else 1
    result: RunResult | None = None
    for attempt in range(1, attempts + 1):
        started = time.monotonic()
        try:
            completed = subprocess.run(
                resolved_argv, cwd=str(cwd) if cwd else None, env=env, shell=False,
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=timeout, check=False,
            )
            result = RunResult(resolved_argv, completed.returncode, completed.stdout,
                                completed.stderr, time.monotonic() - started)
        except subprocess.TimeoutExpired as exc:
            raw_out, raw_err = exc.stdout, exc.stderr
            out = raw_out if isinstance(raw_out, str) else (raw_out or b"").decode("utf-8", "replace")
            err = raw_err if isinstance(raw_err, str) else (raw_err or b"").decode("utf-8", "replace")
            result = RunResult(resolved_argv, 124, out, err + f"\ntimed out after {timeout}s",
                                time.monotonic() - started, timed_out=True)
        except OSError as exc:
            result = RunResult(resolved_argv, 127, "", str(exc), time.monotonic() - started)
        if ctx is not None:
            _log_run(ctx, result, secret_values, attempt)
        if result.returncode == 0 or not network or attempt == attempts:
            return result
    assert result is not None
    return result


def probe_version(argv: list[str], ctx: Ctx) -> RunResult:
    return run(argv, timeout=PROBE_TIMEOUT, ctx=ctx)


# ── JSON / .env merge helpers (spec 7: merge key-wise, never rewrite whole) ──

def merge_list_union(existing: list, additions: list) -> list:
    """Order-stable set union. Existing order preserved; new items appended
    once, in the order given."""
    seen = set(existing)
    out = list(existing)
    for item in additions:
        if item not in seen:
            out.append(item)
            seen.add(item)
    return out


def merge_env_text(text: str, updates: dict[str, str]) -> str:
    """Preserve every line — comments, blanks, unrelated keys — in place.
    Set/replace the named keys where they already appear; append any that were
    missing, in the order given. Never reorders a line it doesn't own.

    `updates` values are written verbatim — this function has no opinion on
    quoting. A value containing a space (PI_PATH=node <path>) must arrive
    already quoted via `quote_env_value` (BLOCKER 1: just 1.58.0's `set
    dotenv-load` cannot parse an unquoted value with a space; see
    verify_just)."""
    lines = text.splitlines()
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            out.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            out.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            out.append(line)
    for key, value in updates.items():
        if key not in seen:
            out.append(f"{key}={value}")
    return "\n".join(out) + "\n"


def quote_env_value(value: str) -> str:
    """Double-quote an .env value (BLOCKER 1 fix, spec 6.6 item 3/4). just
    1.58.0's `set dotenv-load` cannot parse an unquoted value containing a
    space — `PI_PATH=node <path>` is exactly that shape, and `just --list`
    never surfaces the break because it does not load dotenv at all (see
    verify_just); any real recipe, or `just --evaluate`, does.

    python-dotenv (what the ADWs use) and just's own dotenv-load both strip
    one matching pair of outer quotes before the value ever reaches an
    environment variable — so downstream `shlex.split(posix=True)` in
    agent_pi.py sees the already-unquoted `node <path>` and splits on the
    space exactly as before quoting was added; quoting is invisible past the
    .env parser (verified empirically against both loaders — see
    installer/tests/test_steps.py). Every value this wizard writes is a
    forward-slash path with no embedded quote or backslash, so a plain
    backslash/double-quote escape is enough to be correct in general without
    ever being exercised by these callers."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def unquote_env_value(raw: str) -> str:
    """Mirror the outer-quote stripping BOTH real consumers perform before a
    value reaches shlex.split: python-dotenv and just's `set dotenv-load`.
    A value wrapped in one matching pair of quotes has them removed; anything
    else (already-unquoted text, mismatched quotes) passes through untouched.
    Intentionally not a general shell-quote parser — see quote_env_value."""
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1]
    return raw


def pi_path_line_round_trips(env_text: str) -> tuple[bool, bool]:
    """The exact landmine assertion from spec 6.6's verify bullet, factored out so it
    is unit-testable without a real .env file or a real pi install. Returns
    (found, ok): `found` is False when there is no PI_PATH= line at all (not
    a failure by itself — the pi step is what guarantees the line exists);
    when `found` is True, `ok` says whether the value round-trips through the
    same two-step parse a real consumer performs — unquote (dotenv-style),
    then shlex.split(posix=True) — to a non-empty token list whose last token
    is an existing file on disk."""
    for line in env_text.splitlines():
        if line.strip().startswith("PI_PATH="):
            raw = line.split("=", 1)[1]
            tokens = shlex.split(unquote_env_value(raw), posix=True)
            return True, bool(tokens) and Path(tokens[-1]).is_file()
    return False, False


def merge_pi_settings(existing: dict, packages_to_add: list[str],
                       known_themes: frozenset[str] = frozenset({"default"})) -> dict:
    """`packages` is a set union, order-stable. Every other key untouched.
    A `theme` naming a theme that is not installed is deleted (spec 6.7 item
    3) — it errors on every pi launch and falls back anyway."""
    merged = dict(existing)
    merged["packages"] = merge_list_union(list(existing.get("packages", [])), packages_to_add)
    if "theme" in merged and str(merged["theme"]) not in known_themes:
        del merged["theme"]
    return merged


def merge_ollama_provider(existing: dict, seed: dict) -> dict:
    """Merge providers['ollama-cloud'] from `seed`, preserving every sibling
    provider untouched and any hand-added `modelOverrides` on the block."""
    merged = json.loads(json.dumps(existing)) if existing else {}
    providers = merged.setdefault("providers", {})
    current = providers.get("ollama-cloud")
    current = current if isinstance(current, dict) else {}
    block = json.loads(json.dumps(seed))
    if isinstance(current.get("modelOverrides"), dict):
        block["modelOverrides"] = current["modelOverrides"]
    providers["ollama-cloud"] = block
    return merged


# ── outcome classification ──────────────────────────────────────────────────

def classify_skylos(target: str, is_windows: bool, returncode: int,
                     stdout: str, stderr: str) -> Outcome:
    """Fail-closed: unknown means failed, never "probably fine" (spec 6.9).
    `expected-unavailable` is a DECLARED rule, narrow on purpose — only on the
    Windows laptop, and only for the specific MSVC/tree-sitter signatures."""
    if returncode == 0:
        return "ok"
    if target == "laptop" and is_windows:
        haystack = (stdout + stderr).casefold()
        if any(sig in haystack for sig in SKYLOS_WINDOWS_SIGNATURES):
            return "expected-unavailable"
    return "failed"


# ── repo / context bootstrap (spec 6.1 preflight) ───────────────────────────

def find_repo_root(script_path: Path) -> Path:
    """Resolved from THIS file's own location, never from cwd (spec 2)."""
    candidate = script_path.parent.parent
    if not (candidate / "MAP.md").exists() or not (candidate / "adws").is_dir():
        raise RepoNotFoundError(
            f"{candidate} does not look like the sdl-factory repo "
            "(missing MAP.md or adws/) - wrong checkout"
        )
    return candidate


def detect_target() -> str:
    """Spec 2.3: container -> Windows is laptop -> headless Linux is server,
    else laptop."""
    if Path("/.dockerenv").exists():
        return "container"
    try:
        cgroup = Path("/proc/1/cgroup").read_text(encoding="utf-8", errors="replace")
        if any(marker in cgroup for marker in ("docker", "containerd", "lxc")):
            return "container"
    except OSError:
        pass
    if os.environ.get("container"):
        return "container"
    if platform.system() == "Windows":
        return "laptop"
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return "server"
    return "laptop"


def build_ctx(*, repo_root: Path, target: str, yes: bool, dry_run: bool,
              verify_only: bool, json_mode: bool) -> Ctx:
    home = Path.home()
    install_dir = home / ".sdl-factory" / "install"
    # Not created under --dry-run (acceptance A1: zero bytes change anywhere
    # under ~/.sdl-factory). Every real write path (_log_run, _record_park)
    # already does its own mkdir(parents=True, exist_ok=True) lazily, so
    # skipping it here is safe for a real run too.
    if not dry_run:
        install_dir.mkdir(parents=True, exist_ok=True)
    ts = _timestamp()
    return Ctx(
        repo_root=repo_root, target=target, home=home, yes=yes, dry_run=dry_run,
        verify_only=verify_only, json_mode=json_mode, run_id=new_id(),
        started_at=now_iso(), install_dir=install_dir,
        log_path=install_dir / f"{ts}-{target}.log",
        secrets_env_path=home / ".sdl-factory" / "secrets.env",
        env_path=repo_root / ".env",
    )


def detect_running_pi(ctx: Ctx) -> bool:
    """Best-effort, by process name (spec 10) — never used to gate anything,
    and this wizard never kills a process."""
    try:
        if platform.system() == "Windows":
            result = run(["tasklist", "/FI", "IMAGENAME eq node.exe"], timeout=PROBE_TIMEOUT, ctx=ctx)
            return "node.exe" in result.stdout
        result = run(["ps", "ax"], timeout=PROBE_TIMEOUT, ctx=ctx)
        return "cli.js" in result.stdout
    except OSError:
        return False


# ── exit code (spec 2.2) ─────────────────────────────────────────────────────

def compute_exit_code(step_results: list[tuple[Step, Result]],
                       verify_results: list[tuple[str, Result]]) -> int:
    """0 required-ok(+expected-unavailable)/verify-passed. 1 a required step
    failed, or a verify check failed. 2 nothing failed but something is
    needs-operator."""
    if any(result.outcome == "failed" and step.required for step, result in step_results):
        return 1
    if any(result.outcome == "failed" for _id, result in verify_results):
        return 1
    if any(result.outcome == "needs-operator" for _step, result in step_results):
        return 2
    if any(result.outcome == "needs-operator" for _id, result in verify_results):
        return 2
    return 0


# ── uv (spec 6.2) ────────────────────────────────────────────────────────────

def detect_uv(ctx: Ctx) -> Detected:
    path = which("uv")
    if not path:
        return Detected(False, "uv not found on PATH")
    result = probe_version(["uv", "--version"], ctx)
    return Detected(result.returncode == 0, result.stdout.strip(), {"path": path})


def apply_uv(ctx: Ctx) -> Result:
    detected = detect_uv(ctx)
    if not detected.present:
        return Result("failed", "uv is missing - the wizard could not have started. "
                       "Bootstrap line: see README Install section.")
    version = _parse_version(detected.detail)
    if version >= UV_FLOOR:
        return Result("ok", f"uv present: {detected.detail}")
    if ctx.dry_run:
        return Result("ok", f"[dry-run] would run: uv self update (uv {detected.detail} below floor)")
    if not ctx.yes:
        return Result("ok", f"uv {detected.detail} is below the floor - run `uv self update` "
                       "yourself, or re-run with --yes")
    result = run(["uv", "self", "update"], timeout=NETWORK_TIMEOUT, network=True, ctx=ctx)
    if result.returncode != 0:
        return Result("failed", f"uv self update exited {result.returncode}")
    return Result("installed", "uv self update completed")


def verify_uv(ctx: Ctx) -> Result:
    result = probe_version(["uv", "--version"], ctx)
    return Result("ok" if result.returncode == 0 else "failed",
                  result.stdout.strip() or result.stderr.strip())


# ── just (spec 6.3) ──────────────────────────────────────────────────────────

def detect_just(ctx: Ctx) -> Detected:
    path = which("just")
    if not path:
        return Detected(False, "just not found on PATH")
    result = probe_version(["just", "--version"], ctx)
    return Detected(result.returncode == 0, result.stdout.strip(), {"path": path})


def _localappdata(ctx: Ctx) -> Path:
    raw = os.environ.get("LOCALAPPDATA")
    return Path(raw) if raw else ctx.home / "AppData" / "Local"


def _find_just_via_winget(ctx: Ctx) -> Path | None:
    """Finding 1: winget's own "already installed" exit code proves `just` IS
    on the host — `which()` just hasn't seen it in THIS process's PATH yet.
    Re-detect via winget's own install locations before giving up: the
    per-user Links shim dir (`%LOCALAPPDATA%/Microsoft/WinGet/Links`, what
    winget adds to the user PATH registry value a live process does not
    re-read) and the package's own directory under `Packages/` (globbed,
    because the `<id>_<source>_<hash>` suffix is opaque and winget-chosen)."""
    base = _localappdata(ctx) / "Microsoft" / "WinGet"
    links = base / "Links" / "just.exe"
    if links.is_file():
        return links
    packages_dir = base / "Packages"
    if packages_dir.is_dir():
        for match in sorted(packages_dir.glob("Casey.Just_*/**/just.exe")):
            if match.is_file():
                return match
    return None


def apply_just(ctx: Ctx) -> Result:
    detected = detect_just(ctx)
    if detected.present:
        return Result("ok", f"just present: {detected.detail}")

    if platform.system() == "Windows":
        winget_cmd = ["winget", "install", "--id", "Casey.Just", "--silent",
                      "--accept-package-agreements", "--accept-source-agreements"]
        if ctx.dry_run:
            return Result("ok", f"[dry-run] would run: {shlex.join(winget_cmd)}")
        if which("winget") is None:
            if which("cargo") is not None:
                result = run(["cargo", "install", "just"], timeout=NETWORK_TIMEOUT,
                              network=True, ctx=ctx)
                if result.returncode != 0:
                    return Result("failed", f"cargo install just exited {result.returncode}")
            else:
                return Result("needs-operator",
                               "winget and cargo both absent - install just from "
                               "https://github.com/casey/just/releases and put it on PATH")
        else:
            result = run(winget_cmd, timeout=NETWORK_TIMEOUT, network=True, ctx=ctx)
            if result.returncode in WINGET_ALREADY_INSTALLED_CODES:
                # Finding 1: NOT a failure — winget's own "existing package
                # already installed... no available upgrade found". just IS
                # on the host; prove it before trusting winget's word blindly,
                # but never mark this required step `failed` for an install
                # winget itself says already succeeded.
                found = which("just") or _find_just_via_winget(ctx)
                if found is not None:
                    ctx.just_needs_new_terminal = True
                    return Result("installed",
                                   f"just already installed (winget: existing package, no "
                                   f"upgrade needed, exit {result.returncode}) - found at "
                                   f"{found}, not resolvable via PATH in THIS process, open "
                                   f"a new terminal")
                return Result("needs-operator",
                               f"winget reports just already installed (exit "
                               f"{result.returncode}) but the wizard could not find just.exe "
                               f"via PATH, %LOCALAPPDATA%\\Microsoft\\WinGet\\Links, or "
                               f"WinGet\\Packages\\Casey.Just_* - run `winget list --id "
                               f"Casey.Just` yourself and add its install directory to PATH")
            if result.returncode != 0:
                return Result("failed", f"winget install just exited {result.returncode}: "
                               f"{result.stderr[-300:]}")
        if which("just") is None:
            ctx.just_needs_new_terminal = True
            return Result("installed", "just installed - not on PATH in THIS process, "
                           "open a new terminal")
        return Result("installed", "just installed via winget")

    # Linux / container
    oneliner = ("curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh "
                "| bash -s -- --to ~/.local/bin")
    if ctx.dry_run:
        return Result("ok", f"[dry-run] would run: {oneliner}")
    result = run(["/bin/sh", "-c", oneliner], timeout=NETWORK_TIMEOUT, network=True, ctx=ctx)
    if result.returncode != 0:
        return Result("failed", f"just install script exited {result.returncode}: "
                       f"{result.stderr[-300:]}")
    local_bin = str(ctx.home / ".local" / "bin")
    if local_bin not in os.environ.get("PATH", ""):
        ctx.just_needs_new_terminal = True
        return Result("installed", f"just installed to {local_bin} - add it to PATH")
    return Result("installed", "just installed")


def verify_just(ctx: Ctx) -> Result:
    """BLOCKER 1 (V6 half): `just --list` alone proves the justfile PARSES
    but does not exercise `set dotenv-load` at all - it stayed green while an
    unquoted PI_PATH broke every real recipe. `just --evaluate` goes through
    the same dotenv-load path a real recipe does, costs no tokens, and needs
    no sqlite3 CLI (spec 6.4: optional, never required here) unlike
    `just sessions`.

    Neither of those two actually spawns the CONFIGURED SHELL to run a recipe
    BODY - `--evaluate` only resolves assignments/settings, it never execs
    anything. That is exactly the gap "just could not find the shell `sh`"
    slipped through: a fresh Windows terminal with no `sh` on PATH still
    parsed the justfile clean and still evaluated its dotenv clean, and only
    broke the moment a real recipe tried to run. `just doctor` (root
    justfile, token-free: `uv run python -c "print('doctor ok')"`) closes
    that gap - it is a real recipe invocation through the real configured
    shell (`set windows-shell` on Windows, default sh elsewhere), so a
    missing/wrong shell, a broken dotenv, or a recipe body cmd.exe cannot
    parse all fail HERE rather than staying invisible. `just demo` remains
    the human acceptance step (spec 6.3), not this probe.

    BLOCKER 3: a fresh winget/install.sh `just` that is not yet resolvable in
    THIS process (ctx.just_needs_new_terminal, set by apply_just) is reported
    `ok` with the same "open a new terminal" fact apply_just already gave -
    it must not drag this run's exit code to 1 over a stale process PATH."""
    path = which("just")
    if path is None:
        if ctx.just_needs_new_terminal:
            return Result("ok", "just installed this run but not resolvable on PATH in "
                          "this process (spec 6.3) - open a new terminal and run "
                          "`just doctor` yourself to confirm shell + dotenv + recipe "
                          "execution")
        return Result("failed", "just not on PATH")
    list_result = run([path, "--list"], timeout=PROBE_TIMEOUT, cwd=ctx.repo_root, ctx=ctx)
    if list_result.returncode != 0:
        return Result("failed", f"just --list exited {list_result.returncode}")
    if "demo" not in list_result.stdout:
        return Result("failed", "just --list did not name the `demo` recipe - justfile did not parse")
    eval_result = run([path, "--evaluate"], timeout=PROBE_TIMEOUT, cwd=ctx.repo_root, ctx=ctx)
    if eval_result.returncode != 0:
        return Result("failed", f"just --evaluate exited {eval_result.returncode} - "
                       f"`set dotenv-load` could not parse .env: {eval_result.stderr[-300:]}")
    doctor_result = run([path, "doctor"], timeout=PROBE_TIMEOUT, cwd=ctx.repo_root, ctx=ctx)
    if doctor_result.returncode != 0 or "doctor ok" not in doctor_result.stdout:
        return Result("failed", f"just doctor exited {doctor_result.returncode} - the "
                       f"configured shell could not run a real recipe: "
                       f"{doctor_result.stderr[-300:]}")
    return Result("ok", "just --list parses the real justfile and lists demo; "
                  "just --evaluate proves `set dotenv-load` parses .env cleanly; "
                  "just doctor proves the configured shell actually runs a recipe")


# ── sqlite (spec 6.4) ────────────────────────────────────────────────────────

def detect_sqlite(ctx: Ctx) -> Detected:
    del ctx
    try:
        import sqlite3 as _sqlite3  # noqa: F401  (presence probe only)
        module_ok = True
    except ImportError:
        module_ok = False
    cli = which("sqlite3")
    return Detected(module_ok, "stdlib module " + ("present" if module_ok else "MISSING"),
                     {"cli": cli or ""})


def apply_sqlite(ctx: Ctx) -> Result:
    detected = detect_sqlite(ctx)
    if not detected.present:
        return Result("failed", "sqlite3 stdlib module is missing - adws/adw_modules/tracer.py "
                       "imports it and the whole trace depends on it. Reinstall Python with "
                       "sqlite support.")
    if detected.data.get("cli"):
        return Result("ok", "sqlite3 stdlib module present; sqlite3 CLI also present")
    return Result("ok", "sqlite3 stdlib module present; CLI absent (optional, never installed)")


def verify_sqlite(ctx: Ctx) -> Result:
    return apply_sqlite(ctx)  # pure read either way - nothing to install


# ── node + npm (spec 6.5) ────────────────────────────────────────────────────

def detect_node(ctx: Ctx) -> Detected:
    node_path = which("node")
    npm_path = which("npm")
    if not node_path:
        return Detected(False, "node not found on PATH", {"npm": npm_path or ""})
    result = probe_version(["node", "--version"], ctx)
    return Detected(bool(npm_path) and result.returncode == 0, result.stdout.strip(),
                     {"node": node_path, "npm": npm_path or ""})


def _nodesource_command() -> list[str] | None:
    if which("apt-get"):
        deb_cmd = ("curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - "
                   "&& sudo apt-get install -y nodejs")
        return ["/bin/sh", "-c", deb_cmd]
    if which("dnf"):
        rpm_cmd = ("curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash - "
                   "&& sudo dnf install -y nodejs")
        return ["/bin/sh", "-c", rpm_cmd]
    return None


def apply_node(ctx: Ctx) -> Result:
    detected = detect_node(ctx)
    if detected.present:
        version = _parse_version(detected.detail)
        if version >= NODE_FLOOR:
            return Result("ok", f"node {detected.detail}, npm present")
        return Result("failed", f"node {detected.detail} is below the floor "
                       f"{NODE_FLOOR[0]} - upgrade manually")

    if platform.system() == "Windows":
        return Result("needs-operator",
                       "node/npm absent - installing a Node runtime on a personal machine "
                       "is intrusive, even under --yes: winget install OpenJS.NodeJS.LTS")
    if ctx.target == "container":
        return Result("failed", "node absent in container base image - add node to the "
                       "Dockerfile; the wizard does not mutate a container's package state "
                       "for a base-image runtime")

    command = _nodesource_command()
    if command is None:
        return Result("needs-operator", "unknown Linux distro (no apt-get or dnf found) - "
                       "install Node 24 from nodesource.com yourself")
    if ctx.dry_run:
        return Result("ok", f"[dry-run] would run: {command[-1]}")
    result = run(command, timeout=NETWORK_TIMEOUT, network=True, ctx=ctx)
    if result.returncode != 0:
        return Result("failed", f"nodesource install exited {result.returncode}: "
                       f"{result.stderr[-300:]}")
    return Result("installed", "node installed via nodesource")


def verify_node(ctx: Ctx) -> Result:
    detected = detect_node(ctx)
    return Result("ok" if detected.present else "failed", detected.detail or "node/npm not found")


# ── pi + PI_PATH (spec 6.6) ──────────────────────────────────────────────────

def _npm_root_global(ctx: Ctx) -> str | None:
    result = run(["npm", "root", "-g"], timeout=PROBE_TIMEOUT, ctx=ctx)
    return result.stdout.strip() if result.returncode == 0 else None


def _pi_cli_js(ctx: Ctx) -> Path | None:
    root = _npm_root_global(ctx)
    if not root:
        return None
    candidate = Path(root) / "@earendil-works" / "pi-coding-agent" / "dist" / "cli.js"
    return candidate if candidate.is_file() else None


def detect_pi(ctx: Ctx) -> Detected:
    cli_js = _pi_cli_js(ctx)
    return Detected(cli_js is not None, str(cli_js) if cli_js else "cli.js not found",
                     {"cli_js": str(cli_js) if cli_js else ""})


def _pi_installed_version(cli_js: Path, ctx: Ctx) -> str:
    result = probe_version(["node", str(cli_js), "--version"], ctx)
    return result.stdout.strip() if result.returncode == 0 else ""


def apply_pi(ctx: Ctx) -> Result:
    detected = detect_pi(ctx)
    outcome: Outcome
    pinned_spec = f"@earendil-works/pi-coding-agent@{PI_PIN}"
    # "present" used to mean "cli.js exists on disk", full stop - which is how
    # a box kept running pi 0.74.2 forever: every later run saw the file and
    # skipped straight past it (0.74.x's `pi install` writes settings.json
    # but materializes nothing, so the box looked done). A version mismatch
    # now runs the pinned install anyway - `npm install -g` replaces the
    # global package in place - and only a version match skips it.
    installed_version = _pi_installed_version(Path(detected.data["cli_js"]), ctx) \
        if detected.present else ""
    needs_install = not detected.present or _parse_version(installed_version) != _parse_version(PI_PIN)

    if needs_install:
        if ctx.dry_run:
            if detected.present:
                return Result("ok", f"[dry-run] pi {installed_version or 'an unknown version'} "
                               f"present, pinned to {PI_PIN} - would run: npm install -g "
                               f"--ignore-scripts {pinned_spec}")
            return Result("ok", f"[dry-run] would run: npm install -g --ignore-scripts "
                           f"{pinned_spec}, then derive PI_PATH")
        result = run(["npm", "install", "-g", "--ignore-scripts", pinned_spec],
                     timeout=NETWORK_TIMEOUT, network=True, ctx=ctx)
        if result.returncode != 0:
            return Result("failed", f"npm install pi exited {result.returncode}: "
                           f"{result.stderr[-300:]}")
        detected = detect_pi(ctx)
        if not detected.present:
            return Result("failed", "npm install pi reported success but cli.js still not found")
        outcome = "installed"
    else:
        outcome = "ok"
        if ctx.dry_run:
            return Result("ok", "[dry-run] pi already installed; would ensure PI_PATH in .env")

    cli_js = Path(detected.data["cli_js"])
    pi_path_value = f"node {cli_js.as_posix()}"
    models_path_value = (ctx.home / ".pi" / "agent" / "models.json").as_posix()
    # PI_BRIDGE_PATH: the pi-claude-bridge extension dir, same per-host
    # derivation-then-.env-write as PI_PATH/PI_MODELS_PATH above (not a
    # literal path baked into any tracked config - see
    # sssf.shipping.config.yaml's `${PI_BRIDGE_PATH}/src/index.ts` and
    # agents.py's expand_harness_paths). Written unconditionally, like
    # PI_MODELS_PATH: the pi-packages step (which actually installs the
    # package onto disk) runs after this one, so existence is confirmed
    # later, at V3 verify time - not re-checked here.
    bridge_path_value = (_pi_npm_dir(ctx) / "pi-claude-bridge").as_posix()

    env_existed = ctx.env_path.exists()
    if env_existed:
        env_text = ctx.env_path.read_text(encoding="utf-8")
    else:
        sample = ctx.repo_root / ".env.sample"
        env_text = sample.read_text(encoding="utf-8") if sample.exists() else ""
    # BLOCKER 1: quoted, so `set dotenv-load` in the justfile can parse a
    # value with a space (quote_env_value). BLOCKER 2: compare BEFORE
    # snapshot+write (spec 7 item 2) — identical content is a no-op, no park,
    # no rewrite, and the outcome stays whatever detection already said.
    merged = merge_env_text(env_text, {
        "PI_PATH": quote_env_value(pi_path_value),
        "PI_MODELS_PATH": quote_env_value(models_path_value),
        "PI_BRIDGE_PATH": quote_env_value(bridge_path_value),
    })
    if env_existed and merged == env_text:
        return Result(outcome, f"PI_PATH already set to {pi_path_value!r} - no changes")
    if env_existed:
        snapshot(ctx.env_path, ledger_path=ctx.ledger_path, run_id=ctx.run_id, step="pi")
    write_text(ctx.env_path, merged, ctx)
    if outcome == "ok":
        outcome = "installed"   # pi itself was already present, but .env changed
    return Result(outcome, f"PI_PATH set to {pi_path_value!r}; "
                  f"PI_BRIDGE_PATH set to {bridge_path_value!r}")


def verify_pi(ctx: Ctx) -> Result:
    detected = detect_pi(ctx)
    if not detected.present:
        return Result("failed", "cli.js not found after install")
    result = run(["node", detected.data["cli_js"], "--version"], timeout=PROBE_TIMEOUT, ctx=ctx)
    if result.returncode != 0:
        return Result("failed", f"node cli.js --version exited {result.returncode}")
    if ctx.env_path.exists():
        found, ok = pi_path_line_round_trips(ctx.env_path.read_text(encoding="utf-8"))
        if found and not ok:
            return Result("failed", "PI_PATH in .env does not round-trip through dotenv-style "
                          "unquote + shlex.split(posix=True) to an existing file")
    return Result("ok", "pi --version ok; PI_PATH round-trips through unquote + "
                  "shlex.split(posix=True)")


# ── pi packages: bridge + subagents (spec 6.7) ───────────────────────────────

def _pi_settings_path(ctx: Ctx) -> Path:
    return ctx.home / ".pi" / "agent" / "settings.json"


def _pi_npm_dir(ctx: Ctx) -> Path:
    return ctx.home / ".pi" / "agent" / "npm" / "node_modules"


def detect_pi_packages(ctx: Ctx) -> Detected:
    settings = load_json(_pi_settings_path(ctx))
    have = set(settings.get("packages", []))
    missing = [pkg for pkg in PI_PACKAGES if pkg not in have]
    npm_dir = _pi_npm_dir(ctx)
    on_disk = [name for name in PI_PACKAGE_DIRS if (npm_dir / name).exists()]
    present = not missing and len(on_disk) == len(PI_PACKAGE_DIRS)
    return Detected(present, f"{len(PI_PACKAGES) - len(missing)}/{len(PI_PACKAGES)} in "
                     f"settings.json, {len(on_disk)}/{len(PI_PACKAGE_DIRS)} on disk",
                     {"missing": missing})


def apply_pi_packages(ctx: Ctx) -> Result:
    detected = detect_pi_packages(ctx)
    if ctx.dry_run:
        if detected.present:
            return Result("ok", "[dry-run] packages already wired")
        return Result("ok", f"[dry-run] would merge {detected.data['missing']} into "
                       "settings.json and run `pi install` for each")

    # BLOCKER 2: both in settings.json AND on disk already - full no-op, no
    # snapshot, no rewrite, no `pi install` call (spec 7 items 1/2/4).
    if detected.present:
        return Result("ok", "packages already merged into settings.json and installed - "
                       "no changes")

    settings_path = _pi_settings_path(ctx)
    existing = load_json(settings_path)
    merged = merge_pi_settings(existing, list(PI_PACKAGES))
    merged_text = json.dumps(merged, indent=2, sort_keys=True) + "\n"
    existing_text = settings_path.read_text(encoding="utf-8") if settings_path.exists() else ""
    if merged_text != existing_text:
        # Compare BEFORE snapshot+write - identical content parks nothing
        # even when detect_pi_packages() found the mismatch was only the
        # on-disk npm dirs (settings.json itself already correct).
        if settings_path.exists():
            snapshot(settings_path, ledger_path=ctx.ledger_path, run_id=ctx.run_id,
                     step="pi-packages")
        write_text(settings_path, merged_text, ctx)

    cli_js = _pi_cli_js(ctx)
    if cli_js is None:
        return Result("needs-operator", "pi cli.js not found - run the pi step first")
    all_ok = True
    for pkg in PI_PACKAGES:
        result = run(["node", str(cli_js), "install", pkg], timeout=NETWORK_TIMEOUT,
                     network=True, ctx=ctx)
        if result.returncode != 0:
            all_ok = False
    if not all_ok:
        return Result("failed", "pi install failed for one or more packages - see run log")
    return Result("installed", "packages merged into settings.json and installed")


def verify_pi_packages(ctx: Ctx) -> Result:
    cli_js = _pi_cli_js(ctx)
    if cli_js is None:
        return Result("failed", "pi cli.js not found")
    result = run(["node", str(cli_js), "list"], timeout=PROBE_TIMEOUT, ctx=ctx)
    if result.returncode != 0 or not all(name in result.stdout for name in
                                          ("pi-claude-bridge", "@tintinweb/pi-subagents")):
        return Result("failed", "node cli.js list did not name both packages")
    npm_dir = _pi_npm_dir(ctx)
    for name in PI_PACKAGE_DIRS:
        if not (npm_dir / name).exists():
            return Result("failed", f"{name} not found on disk under {npm_dir}")
    return Result("ok", "both packages listed by `pi list` and present on disk")


# ── ollama-cloud (spec 6.8) ──────────────────────────────────────────────────

def _target_scripts_dir(ctx: Ctx) -> Path:
    return ctx.home / ".pi" / "agent" / "scripts"


def detect_ollama_scripts(ctx: Ctx) -> Detected:
    target_dir = _target_scripts_dir(ctx)
    stale = []
    for name in VENDORED_SCRIPTS:
        src = ASSETS_DIR / "scripts" / name
        dst = target_dir / name
        if not dst.exists() or sha256_file(dst) != sha256_file(src):
            stale.append(name)
    return Detected(not stale, f"{len(VENDORED_SCRIPTS) - len(stale)}/{len(VENDORED_SCRIPTS)} "
                     "up to date", {"stale": stale})


def apply_ollama_scripts(ctx: Ctx) -> Result:
    detected = detect_ollama_scripts(ctx)
    stale = detected.data["stale"]
    if not stale:
        return Result("ok", "both scripts already byte-identical on disk")
    if ctx.dry_run:
        return Result("ok", f"[dry-run] would park+copy: {stale}")
    target_dir = _target_scripts_dir(ctx)
    target_dir.mkdir(parents=True, exist_ok=True)
    for name in stale:
        dst = target_dir / name
        if dst.exists():
            park_replace(dst, ledger_path=ctx.ledger_path, run_id=ctx.run_id,
                         step="ollama-cloud-scripts")
        write_text(dst, (ASSETS_DIR / "scripts" / name).read_text(encoding="utf-8"), ctx)
        if platform.system() != "Windows":
            dst.chmod(dst.stat().st_mode | 0o111)
    return Result("installed", f"vendored {len(stale)} script(s)")


def verify_ollama_scripts(ctx: Ctx) -> Result:
    detected = detect_ollama_scripts(ctx)
    return Result("ok" if detected.present else "failed", detected.detail)


def _key_script_path(ctx: Ctx) -> Path:
    return _target_scripts_dir(ctx) / "ollama-cloud-key.py"


def _seed_provider_block(ctx: Ctx, interp: str) -> dict:
    """`interp` must be the interpreter name `_try_key_script` already proved
    works (DIVERGENCE a fix) - never `ctx.interp` blindly, which could name
    an interpreter that was never the one that actually ran cleanly if the
    other candidate was the one that worked."""
    seed = json.loads((ASSETS_DIR / "ollama-cloud.provider.json").read_text(encoding="utf-8"))
    key_script = _key_script_path(ctx).as_posix()
    seed["apiKey"] = f"!{interp} {key_script!r}"
    return seed


def _try_key_script(ctx: Ctx) -> tuple[bool, str]:
    """Prove the apiKey command before it is ever written (spec 6.8 item 4):
    run <interp> <script> for real and require either a non-empty key on
    stdout, or the script's own clean "key not found" on stderr with exit 1.
    Any other outcome tries the other interpreter name, then gives up."""
    candidates = [ctx.interp, "python3" if ctx.interp == "python" else "python"]
    for interp in candidates:
        if which(interp) is None:
            continue
        result = run([interp, str(_key_script_path(ctx))], timeout=PROBE_TIMEOUT, ctx=ctx)
        if result.returncode == 0 and result.stdout.strip():
            return True, interp
        clean_not_found = (result.returncode == 1 and not result.stdout.strip()
                           and "not found" in result.stderr.casefold())
        if clean_not_found:
            return False, interp
    return False, "none"


def detect_ollama_provider(ctx: Ctx) -> Detected:
    models = load_json(ctx.home / ".pi" / "agent" / "models.json")
    provider = models.get("providers", {}).get("ollama-cloud")
    count = len(provider.get("models", [])) if isinstance(provider, dict) else 0
    return Detected(isinstance(provider, dict) and count > 0, f"{count} model(s) registered")


def apply_ollama_provider(ctx: Ctx) -> Result:
    if ctx.dry_run:
        return Result("ok", "[dry-run] would prove the apiKey command, then merge "
                       "providers.ollama-cloud into models.json and run the sync script")

    # BLOCKER 2: the block already exists non-empty - full no-op, no snapshot,
    # no rewrite, and the model-sync (a network call) is skipped entirely
    # (spec 7 items 1/2; "skip the model-sync when the provider block already
    # exists non-empty").
    detected = detect_ollama_provider(ctx)
    if detected.present:
        return Result("ok", f"ollama-cloud provider already wired ({detected.detail}) - "
                       "no changes, model-sync skipped")

    # DIVERGENCE (a): prove the apiKey command BEFORE anything referencing it
    # is written (spec 6.8 item 4: "never write an apiKey command the wizard
    # has not executed"). interp_used == "none" means NEITHER interpreter
    # name gave one of the two proven outcomes (a real key, or the script's
    # own clean "key not found") - that is the "any other outcome" case the
    # spec sends straight to `failed`, and nothing is written.
    key_ok, interp_used = _try_key_script(ctx)
    if interp_used == "none":
        return Result("failed", "could not execute ollama-cloud-key.py cleanly under python "
                       "or python3 (interpreter missing, or the script raised) - models.json "
                       "was not touched (spec 6.8 item 4: never write an apiKey command the "
                       "wizard has not executed)")

    models_path = ctx.home / ".pi" / "agent" / "models.json"
    existing = load_json(models_path)
    merged = merge_ollama_provider(existing, _seed_provider_block(ctx, interp_used))
    merged_text = json.dumps(merged, indent=2, sort_keys=True) + "\n"
    existing_text = models_path.read_text(encoding="utf-8") if models_path.exists() else ""
    if merged_text != existing_text:
        if models_path.exists():
            snapshot(models_path, ledger_path=ctx.ledger_path, run_id=ctx.run_id,
                    step="ollama-cloud-provider")
        write_text(models_path, merged_text, ctx)

    if not key_ok:
        auth_path = (r"%LOCALAPPDATA%\opencode\auth.json" if platform.system() == "Windows"
                     else "~/.local/share/opencode/auth.json")
        return Result("needs-operator",
                      "the apiKey command is proven and the seed provider block is written; "
                      "no ollama-cloud key found yet, so the model list was not synced. Log "
                      "into OpenCode (opencode auth login -> ollama-cloud), or place the key "
                      f"at {auth_path} as {{\"ollama-cloud\": {{\"key\": \"...\"}}}}. V2 "
                      "verification will fail and the run exits 2 until the key exists.")

    sync_script = ASSETS_DIR / "scripts" / "sync-ollama-cloud-models.py"
    result = run([interp_used, str(sync_script)], timeout=NETWORK_TIMEOUT, network=True, ctx=ctx)
    if result.returncode != 0:
        return Result("failed", f"sync script exited {result.returncode}: {result.stderr[-300:]}")
    return Result("installed", "provider wired and model list synced live from ollama.com")


def verify_ollama_provider(ctx: Ctx) -> Result:
    detected = detect_ollama_provider(ctx)
    return Result("ok" if detected.present else "needs-operator", detected.detail)


# ── skylos (spec 6.9) ────────────────────────────────────────────────────────

def detect_skylos(ctx: Ctx) -> Detected:
    result = run(["uv", "run", "--group", "scan", "skylos", "--version"], timeout=PROBE_TIMEOUT,
                cwd=ctx.repo_root, ctx=ctx)
    return Detected(result.returncode == 0, result.stdout.strip() or result.stderr.strip()[-200:],
                     {"returncode": result.returncode, "stdout": result.stdout,
                      "stderr": result.stderr})


def apply_skylos(ctx: Ctx) -> Result:
    if ctx.dry_run:
        return Result("ok", "[dry-run] would run: uv sync --group scan")
    result = run(["uv", "sync", "--group", "scan"], timeout=NETWORK_TIMEOUT, network=True,
                 cwd=ctx.repo_root, ctx=ctx)
    if result.returncode == 0:
        return Result("installed", "uv sync --group scan completed")
    outcome = classify_skylos(ctx.target, platform.system() == "Windows",
                              result.returncode, result.stdout, result.stderr)
    if outcome == "expected-unavailable":
        return Result("expected-unavailable",
                      "skylos: expected-unavailable on Windows (tree-sitter-dart-orchard is "
                      "sdist-only, needs MSVC).\n     The AI-defect gate reads INCOMPLETE here, "
                      "never PASS. The chains that build software run on the Linux server. "
                      "Unblock on an MSVC host with: uv run --group scan skylos --version")
    return Result("failed", f"uv sync --group scan exited {result.returncode}: "
                   f"{result.stderr[-300:]}")


def verify_skylos(ctx: Ctx) -> Result:
    detected = detect_skylos(ctx)
    if detected.present:
        return Result("ok", "uv run --group scan skylos --version exits 0")
    outcome = classify_skylos(ctx.target, platform.system() == "Windows",
                              detected.data["returncode"], detected.data["stdout"],
                              detected.data["stderr"])
    if outcome == "expected-unavailable":
        return Result("expected-unavailable", "expected-unavailable on Windows (no MSVC)")
    return Result("failed", "skylos --version did not exit 0")


# ── no-mistakes: install only (spec 6.10) ────────────────────────────────────

def detect_no_mistakes(ctx: Ctx) -> Detected:
    path = which("no-mistakes")
    if not path:
        return Detected(False, "no-mistakes not found on PATH")
    result = probe_version(["no-mistakes", "--version"], ctx)
    return Detected(result.returncode == 0, result.stdout.strip())


def apply_no_mistakes(ctx: Ctx) -> Result:
    detected = detect_no_mistakes(ctx)
    if detected.present:
        return Result("ok", f"no-mistakes present: {detected.detail}")
    if ctx.dry_run:
        if platform.system() == "Windows":
            return Result("ok", "[dry-run] would try: go install github.com/kunchenguid/"
                           "no-mistakes/cmd/no-mistakes@latest (fallback: GitHub release asset "
                           "into ~/.local/bin, else needs-operator - published Windows guide "
                           "404'd when this spec was written)")
        return Result("ok", f"[dry-run] would run: {NO_MISTAKES_INSTALL_SH}")
    if platform.system() != "Windows":
        result = run(["/bin/sh", "-c", NO_MISTAKES_INSTALL_SH], timeout=NETWORK_TIMEOUT,
                     network=True, ctx=ctx)
        if result.returncode != 0:
            return Result("failed", f"no-mistakes install.sh exited {result.returncode}: "
                           f"{result.stderr[-300:]}")
        return Result("installed", "no-mistakes installed via install.sh")
    if which("go") is not None:
        result = run(["go", "install",
                      "github.com/kunchenguid/no-mistakes/cmd/no-mistakes@latest"],
                     timeout=NETWORK_TIMEOUT, network=True, ctx=ctx)
        if result.returncode == 0:
            return Result("installed", "no-mistakes installed via `go install`")
        return Result("failed", f"go install no-mistakes exited {result.returncode}: "
                       f"{result.stderr[-300:]}")
    return Result("needs-operator",
                  "no confirmed Windows installer: no Go toolchain on PATH for `go install "
                  "github.com/kunchenguid/no-mistakes/cmd/no-mistakes@latest`, and the "
                  "published install guide 404'd when this spec was written. Download the "
                  "matching release asset from https://github.com/kunchenguid/no-mistakes/"
                  "releases into a directory on PATH.")


def _no_mistakes_wired(ctx: Ctx) -> bool:
    remote_result = run(["git", "remote"], timeout=PROBE_TIMEOUT, cwd=ctx.repo_root, ctx=ctx)
    return "no-mistakes" in remote_result.stdout or (ctx.repo_root / ".no-mistakes").exists()


def verify_no_mistakes(ctx: Ctx) -> Result:
    """The `no-mistakes` STEP's own verify: binary present, and (as a bonus
    sanity check on this step's own promise) not wired. DIVERGENCE (b): V7's
    actual condition - wired or not - is checked independently by
    verify_v7_no_mistakes_not_wired below, which this function must not gate.
    A missing OPTIONAL binary (required=False on the Step) must never turn V7
    needs-operator; the two questions have different owners."""
    detected = detect_no_mistakes(ctx)
    if _no_mistakes_wired(ctx):
        return Result("failed", "no-mistakes appears wired (git remote or .no-mistakes/ present) "
                       "- this phase installs the binary only")
    if not detected.present:
        if platform.system() == "Windows":
            return Result("needs-operator", "no-mistakes binary not installed - see apply "
                           "instructions (no confirmed Windows one-liner)")
        return Result("failed", "no-mistakes --version did not exit 0")
    return Result("ok", "no-mistakes --version ok; not wired (no git remote, no .no-mistakes/) "
                  "- wiring deferred pending the deep study (MAP open questions)")


def verify_v7_no_mistakes_not_wired(ctx: Ctx) -> Result:
    """V7's own condition, and ONLY that (spec 9 row V7): no git remote named
    no-mistakes, no .no-mistakes/ directory - independent of whether the
    no-mistakes BINARY is even installed (DIVERGENCE b). A missing optional
    binary is verify_no_mistakes's concern, not V7's; conflating the two
    turned a Windows host with no confirmed no-mistakes installer into a V7
    needs-operator over a fact V7 was never supposed to check."""
    if _no_mistakes_wired(ctx):
        return Result("failed", "no-mistakes appears wired (git remote or .no-mistakes/ "
                       "present) - this phase installs the binary only")
    return Result("ok", "no git remote named no-mistakes, no .no-mistakes/ directory - not "
                  "wired (wiring deferred pending the deep study, MAP open questions)")


# ── CodeGraph: binary only (spec 6.11) ───────────────────────────────────────

def detect_codegraph(ctx: Ctx) -> Detected:
    path = which("codegraph")
    if not path:
        return Detected(False, "codegraph not found on PATH")
    result = probe_version(["codegraph", "--version"], ctx)
    return Detected(result.returncode == 0, result.stdout.strip())


def apply_codegraph(ctx: Ctx) -> Result:
    detected = detect_codegraph(ctx)
    if detected.present:
        return Result("ok", f"codegraph present: {detected.detail}")
    if ctx.dry_run:
        return Result("ok", "[dry-run] would run: npm i -g @colbymchenry/codegraph "
                       "(never `codegraph install` or `codegraph init`)")
    result = run(["npm", "i", "-g", "@colbymchenry/codegraph"], timeout=NETWORK_TIMEOUT,
                network=True, ctx=ctx)
    if result.returncode != 0:
        return Result("failed", f"npm i -g codegraph exited {result.returncode}: "
                       f"{result.stderr[-300:]}")
    return Result("installed", "codegraph installed - binary only, `install`/`init` never run")


def verify_codegraph(ctx: Ctx) -> Result:
    detected = detect_codegraph(ctx)
    if not detected.present:
        return Result("failed", "codegraph --version did not exit 0")
    if (ctx.repo_root / ".codegraph").exists():
        return Result("failed", ".codegraph/ exists in the repo - codegraph init must never "
                       "run here")
    return Result("ok", "codegraph --version ok; .codegraph/ absent. Run yourself in a target "
                  "repo: codegraph init, CODEGRAPH_NO_DAEMON=1 codegraph install")


# ── Claude Code / Codex CLIs: the credential surface (spec 6.12) ────────────

def detect_claude_cli(ctx: Ctx) -> Detected:
    path = which("claude")
    if not path:
        return Detected(False, "claude CLI not found")
    result = probe_version(["claude", "--version"], ctx)
    return Detected(result.returncode == 0, result.stdout.strip())


def apply_claude_cli(ctx: Ctx) -> Result:
    detected = detect_claude_cli(ctx)
    if ctx.target == "laptop":
        return Result("ok" if detected.present else "needs-operator",
                      detected.detail if detected.present else
                      "claude CLI not detected - detect-only on laptop, the operator's own harness")
    if detected.present:
        return Result("ok", detected.detail)
    if ctx.dry_run:
        return Result("ok", "[dry-run] would run: npm install -g @anthropic-ai/claude-code")
    result = run(["npm", "install", "-g", "@anthropic-ai/claude-code"], timeout=NETWORK_TIMEOUT,
                network=True, ctx=ctx)
    if result.returncode != 0:
        return Result("failed", f"claude CLI install exited {result.returncode}: "
                       f"{result.stderr[-300:]}")
    return Result("installed", "Claude Code CLI installed")


def verify_claude_cli(ctx: Ctx) -> Result:
    detected = detect_claude_cli(ctx)
    if ctx.target == "laptop":
        return Result("ok" if detected.present else "needs-operator", detected.detail or "not detected")
    return Result("ok" if detected.present else "failed", detected.detail or "claude --version failed")


def detect_codex_cli(ctx: Ctx) -> Detected:
    path = which("codex")
    if not path:
        return Detected(False, "codex CLI not found")
    result = probe_version(["codex", "--version"], ctx)
    return Detected(result.returncode == 0, result.stdout.strip())


def apply_codex_cli(ctx: Ctx) -> Result:
    detected = detect_codex_cli(ctx)
    if ctx.target == "laptop":
        return Result("ok" if detected.present else "needs-operator",
                      detected.detail if detected.present else
                      "codex CLI not detected - detect-only on laptop")
    if detected.present:
        return Result("ok", detected.detail)
    if ctx.dry_run:
        return Result("ok", "[dry-run] would run: npm install -g @openai/codex")
    result = run(["npm", "install", "-g", "@openai/codex"], timeout=NETWORK_TIMEOUT,
                network=True, ctx=ctx)
    if result.returncode != 0:
        return Result("failed", f"codex CLI install exited {result.returncode}: "
                       f"{result.stderr[-300:]}")
    return Result("installed", "Codex CLI installed")


def verify_codex_cli(ctx: Ctx) -> Result:
    detected = detect_codex_cli(ctx)
    if ctx.target == "laptop":
        return Result("ok" if detected.present else "needs-operator", detected.detail or "not detected")
    return Result("ok" if detected.present else "failed", detected.detail or "codex --version failed")


def detect_oauth_token(ctx: Ctx) -> Detected:
    if not ctx.secrets_env_path.exists():
        return Detected(False, "no secrets.env on file")
    text = ctx.secrets_env_path.read_text(encoding="utf-8")
    present = any(line.strip().startswith("CLAUDE_CODE_OAUTH_TOKEN=") and
                  line.split("=", 1)[1].strip() for line in text.splitlines())
    return Detected(present, "token present" if present else "secrets.env exists, token absent")


def apply_oauth_token(ctx: Ctx) -> Result:
    if ctx.target == "laptop":
        return Result("deferred", "server/container only")
    detected = detect_oauth_token(ctx)
    if detected.present:
        return Result("ok", "CLAUDE_CODE_OAUTH_TOKEN already on file")
    if ctx.dry_run:
        return Result("ok", "[dry-run] would prompt for CLAUDE_CODE_OAUTH_TOKEN (or read env) "
                       "and write it to ~/.sdl-factory/secrets.env, mode 0600")
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "").strip()
    if not token and not ctx.yes:
        import getpass
        token = getpass.getpass(
            "CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token` on a browser host, "
            "blank to skip): "
        ).strip()
    if not token:
        return Result("needs-operator",
                      "no token available. On a browser host: `claude` to log in, then "
                      "`claude setup-token`, then re-run with CLAUDE_CODE_OAUTH_TOKEN set "
                      "(or answer the prompt interactively).")
    ctx.secrets.add(token)
    ctx.secrets_env_path.parent.mkdir(parents=True, exist_ok=True)
    existing = (ctx.secrets_env_path.read_text(encoding="utf-8")
                if ctx.secrets_env_path.exists() else "")
    merged = merge_env_text(existing, {"CLAUDE_CODE_OAUTH_TOKEN": token})
    ctx.secrets_env_path.write_text(merged, encoding="utf-8")
    try:
        os.chmod(ctx.secrets_env_path, 0o600)
    except OSError:
        pass
    if ctx.env_path.exists():
        text = ctx.env_path.read_text(encoding="utf-8")
        marker = ("# secrets live in ~/.sdl-factory/secrets.env - source with: "
                  "set -a; . ~/.sdl-factory/secrets.env; set +a")
        if marker not in text:
            write_text(ctx.env_path, text.rstrip("\n") + "\n" + marker + "\n", ctx)
    return Result("installed", "token written to ~/.sdl-factory/secrets.env (0600), "
                  "never to the repo")


def verify_oauth_token(ctx: Ctx) -> Result:
    if ctx.target == "laptop":
        return Result("deferred", "server/container only")
    detected = detect_oauth_token(ctx)
    return Result("ok" if detected.present else "needs-operator",
                  "token present (redacted)" if detected.present else "no token on file")


# ── UI: the phase 3 extension point (spec 6.13) ──────────────────────────────

def detect_ui(ctx: Ctx) -> Detected:
    del ctx
    return Detected(False, "phase 3 extension point")


def ui_install(ctx: Ctx) -> Result:
    # EXTENSION POINT - phase 3 UI. Do not build ahead of the UI itself.
    # Fill in when specs/ui-*.md lands. Constraints already known:
    #   - loopback bind only; the shipped trace viewer binds 0.0.0.0
    #     (apps/visualizer/server/index.ts) - loopback + Tailscale on the server
    #   - Tailscale is a convenience, never a dependency (MAP)
    #   - reads SQLite; pi RPC is an option, not the spine
    del ctx
    return Result("deferred", "ui: deferred to phase 3 (extension point in steps.py:ui_install)")


def verify_ui(ctx: Ctx) -> Result:
    del ctx
    return Result("deferred", "ui: deferred to phase 3")


# ── auth pass: the other lanes (spec 6.14) ───────────────────────────────────
# ollama-cloud/opencode-go is covered by the ollama-cloud step above; this
# step covers the three lanes that have no dedicated install step because
# there is nothing to install - only a login to prompt for.

def _pi_auth_has(ctx: Ctx, provider: str) -> bool:
    auth = load_json(ctx.home / ".pi" / "agent" / "auth.json")
    return provider in auth


def _codex_auth_present(ctx: Ctx) -> bool:
    return (ctx.home / ".codex" / "auth.json").exists()


def _claude_auth_present(ctx: Ctx) -> bool:
    return ((ctx.home / ".claude" / ".credentials.json").exists()
            or bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")))


AUTH_LANES: dict[str, dict] = {
    "xai": {
        "detect": lambda ctx: _pi_auth_has(ctx, "xai"),
        "instructions": 'launch pi, then `/login xai`, choose "Use a subscription"',
    },
    "openai-codex": {
        "detect": _codex_auth_present,
        "instructions": "run `codex login` (browser; on a headless server, ssh -L the "
                         "callback port). Recorded state: token expired, re-login pending.",
    },
    "claude-bridge": {
        "detect": _claude_auth_present,
        "instructions": "run `claude` to log in on a browser host, then `claude setup-token`",
    },
}


def detect_auth(ctx: Ctx) -> Detected:
    missing = [lane for lane, spec in AUTH_LANES.items() if not spec["detect"](ctx)]
    return Detected(not missing, f"{len(AUTH_LANES) - len(missing)}/{len(AUTH_LANES)} lanes authed",
                     {"missing": missing})


def apply_auth(ctx: Ctx) -> Result:
    detected = detect_auth(ctx)
    missing = list(detected.data["missing"])
    if not missing:
        return Result("ok", "every lane already authed")
    if ctx.dry_run:
        return Result("ok", f"[dry-run] would prompt for auth on: {missing}")
    if ctx.yes:
        lines = [f"{lane}: {AUTH_LANES[lane]['instructions']}" for lane in missing]
        return Result("needs-operator", "auth needed for: " + "; ".join(lines))
    remaining = missing
    for _round in range(2):
        if not remaining:
            break
        for lane in remaining:
            print(f"[??] {lane}: {AUTH_LANES[lane]['instructions']}")
        input("Press Enter once finished (or to move on): ")
        remaining = [lane for lane in remaining if not AUTH_LANES[lane]["detect"](ctx)]
    if remaining:
        lines = [f"{lane}: {AUTH_LANES[lane]['instructions']}" for lane in remaining]
        return Result("needs-operator", "still missing: " + "; ".join(lines))
    return Result("installed", "all lanes authed")


def verify_auth(ctx: Ctx) -> Result:
    detected = detect_auth(ctx)
    missing = detected.data.get("missing") or []
    return Result("ok" if detected.present else "needs-operator",
                  detected.detail + (f" - missing: {missing}" if missing else ""))


# ── engine service: sdl-engine.service, the systemd contract (specs/engine.md
#    section 7) ────────────────────────────────────────────────────────────
# Server/container only (SERVER_CONTAINER on the Step below) - this is the
# two-box model's whole point (MAP.md "The two-box model"): nothing about the
# always-on engine is ever installed laptop-side. Idempotent the same way
# every other step here is (spec 7 BLOCKER 2 family): a unit file that
# already matches, already enabled, already active is a full no-op.

def ensure_engine_git_identity(ctx: Ctx) -> str:
    """Give the checkout a committer identity if the host cannot name one.

    Every record the engine keeps is a `git commit` (a card's status, a park,
    a merge), and on a fresh container or VPS the service user has no
    `~/.gitconfig` at all: git dies with *"unable to auto-detect email
    address"*, the engine logs `commit failed, will retry next cycle` once a
    minute forever, and `systemctl is-active` reports `active` the whole time.
    A service that cannot commit is not converged, so this converges it.

    Two rules make it safe to run on every converge:

      - `git var GIT_COMMITTER_IDENT` decides. That is git's OWN resolution of
        the question (config, environment and auto-detection folded in, strict
        mode - exactly what `git commit` does), so a host that already knows
        who it is is left completely alone. No operator identity is ever
        overwritten, on any of the four config layers.
      - the write is `git config --local`, INSIDE the checkout: it changes this
        repo and nothing else on the machine.

    `adws/engine.py` names the same two values in its own startup refusal
    (`COMMITTER_NAME` / `COMMITTER_EMAIL`), so the line the journal prints and
    the line this writes agree. Returns "" when there was nothing to do, else
    a short note for the caller to append to its Result message.
    """
    probe = run(["git", "var", "GIT_COMMITTER_IDENT"], timeout=PROBE_TIMEOUT,
                cwd=ctx.repo_root, ctx=ctx)
    if probe.returncode == 0 and probe.stdout.strip():
        return ""
    if ctx.dry_run:
        return (f"[dry-run] would set repo-local git identity {ENGINE_GIT_NAME} "
                f"<{ENGINE_GIT_EMAIL}> - this host cannot auto-detect one and the engine "
                f"commits every card write-back")
    for key, value in (("user.name", ENGINE_GIT_NAME), ("user.email", ENGINE_GIT_EMAIL)):
        result = run(["git", "config", "--local", key, value], timeout=PROBE_TIMEOUT,
                     cwd=ctx.repo_root, ctx=ctx)
        if result.returncode != 0:
            return (f"could not set git {key} in {ctx.repo_root.as_posix()} "
                    f"({result.stderr.strip()[-200:]}) - the engine will refuse to run cycles "
                    f"until it is set by hand")
    return (f"set repo-local git identity {ENGINE_GIT_NAME} <{ENGINE_GIT_EMAIL}> - this host "
            f"could not auto-detect one and the engine commits every card write-back")


def engine_service_user(ctx: Ctx) -> str:
    """Who the unit must run as: the OWNER OF THE CHECKOUT (specs/engine.md 7).

    Writing /etc/systemd/system/ needs root, so this wizard runs under sudo -
    which means the current euid says nothing about whose factory this is, and
    a unit with no `User=` is a unit systemd starts as root. On a normal VPS
    checkout owned by the operator that is not a subtle problem: every `git`
    call the engine makes dies with "detected dubious ownership in repository
    at ...", so the pull fails on cycle 1 and the service does nothing at all
    while `systemctl is-active` cheerfully reports `active`.

    The checkout's owner is the exact answer to that (it is git's own test),
    and it is right in both directions - a root-owned checkout on a root-only
    VPS renders `User=root`, deliberately and visibly. `SUDO_USER` is the
    fallback for a host where the owner cannot be named (no `pwd` module -
    this wizard's unit tests run on Windows).
    """
    try:
        import pwd  # POSIX only - absent on the Windows laptop these tests run on
        return pwd.getpwuid(ctx.repo_root.stat().st_uid).pw_name
    except (ImportError, KeyError, OSError):
        return os.environ.get("SUDO_USER") or getpass.getuser()


def unit_value(value: str) -> str:
    """One rendered value, made safe for a systemd unit file.

    `%` opens a SPECIFIER there (%i, %H, %n, ...), so a literal percent in a
    checkout path or a roster name silently becomes something else - or makes
    systemd refuse the unit outright. `%%` is how a unit file spells one
    percent, and doubling is the whole of the escaping this rendering needs;
    whitespace is handled by quoting the values below, not here.

    `apps/ui/server/app/deploy/bootstrap.sh` carries the same helper under the
    same name, because it renders the same unit and `detect_engine_service`
    compares the two BYTE FOR BYTE.
    """
    return value.replace("%", "%%")


def engine_unit_path_value(ctx: Ctx) -> str:
    """The `PATH` the engine's CHILDREN inherit (specs/engine.md 7).

    A systemd service gets systemd's own default PATH, never a login shell's -
    so `uv` in ~/.local/bin and `grok` in ~/.grok/bin, which every card's agent
    turn shells out to, do not exist as far as the engine's children are
    concerned. `ExecStart` survives that because it is resolved to an absolute
    path; the children do not, and the box then refuses every card while
    `systemctl is-active` says `active`. The trailing six entries are systemd's
    documented default PATH, kept so adding ours takes nothing away.
    """
    return ":".join([
        (ctx.home / ".local" / "bin").as_posix(),
        (ctx.home / ".grok" / "bin").as_posix(),
        "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin",
    ])


def render_engine_unit(ctx: Ctx, uv_path: str) -> str:
    """The exact unit specs/engine.md section 7 documents - `<repo>` filled
    with this converge's real checkout, `uv run adws/engine.py` resolved to
    an ABSOLUTE `uv` path. A systemd unit gets no login shell (spec 7's own
    "ExecStart must resolve uv" bullet), so a bare `uv` on ExecStart would
    fail every time systemd itself starts the unit, even though `which uv`
    works fine in the operator's own shell.

    `User=`, `Environment=SSSF_CONFIG=` and `Environment=PATH=` are part of
    the contract, not decoration:
      - without `User=`, systemd starts the engine as root (see
        `engine_service_user`).
      - without `SSSF_CONFIG`, the always-on server ships every card on
        whatever `adws/engine.py` defaults to, which is the TEST LANE roster.
        The engine and dispatch both read this variable (the justfile already
        did), so naming the roster here is the supported way to choose one:
        `SSSF_CONFIG=<path> installer/install.py` converges the unit to it.
        Hand-editing ExecStart is not - `detect_engine_service` compares this
        rendering byte for byte and the next converge would park the edit.
      - without `PATH`, the engine's children resolve neither `uv` nor `grok`
        (see `engine_unit_path_value`).

    Every interpolated value is QUOTED and `%`-escaped (`unit_value`): systemd
    splits an unquoted value on whitespace and expands `%` specifiers in it, so
    a checkout at `/home/op/my factory` handed ExecStart an argument nobody
    wrote and WorkingDirectory a directory that does not exist.
    """
    return (
        "[Unit]\n"
        "Description=SDL factory engine - runs the Kanban\n"
        "After=network-online.target\n"
        "Wants=network-online.target\n"
        "\n"
        "[Service]\n"
        "Type=simple\n"
        f"User={unit_value(engine_service_user(ctx))}\n"
        f'WorkingDirectory="{unit_value(ctx.repo_root.as_posix())}"\n'
        f'Environment="SSSF_CONFIG={unit_value(ctx.engine_config)}"\n'
        f'Environment="PATH={unit_value(engine_unit_path_value(ctx))}"\n'
        f'ExecStart="{unit_value(Path(uv_path).as_posix())}" run adws/engine.py\n'
        "Restart=always\n"
        "RestartSec=10\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )


def detect_engine_service(ctx: Ctx) -> Detected:
    """Non-systemd host (no `systemctl` on PATH) is its own, distinct state -
    not present, but not a failure either (apply/verify below report it
    `deferred`, matching how every other step here expresses a state it
    cannot converge). Everything past that first check assumes systemd."""
    if which("systemctl") is None:
        return Detected(False, "systemctl not found - not a systemd host", {"systemd": False})
    uv_path = which("uv")
    if uv_path is None:
        return Detected(False, "uv not found on PATH - cannot render ExecStart",
                         {"systemd": True})
    expected = render_engine_unit(ctx, uv_path)
    unit_path = ctx.engine_unit_path
    if not unit_path.is_file():
        return Detected(False, f"{unit_path} not present", {"systemd": True, "expected": expected})
    current = unit_path.read_text(encoding="utf-8")
    if current != expected:
        return Detected(False, f"{unit_path} present but content differs from the "
                         "specs/engine.md section 7 contract", {"systemd": True, "expected": expected})
    enabled = run(["systemctl", "is-enabled", "sdl-engine"], timeout=PROBE_TIMEOUT, ctx=ctx)
    active = run(["systemctl", "is-active", "sdl-engine"], timeout=PROBE_TIMEOUT, ctx=ctx)
    is_enabled = enabled.stdout.strip() == "enabled"
    is_active = active.stdout.strip() == "active"
    return Detected(is_enabled and is_active,
                     f"unit matches the contract; is-enabled={enabled.stdout.strip()!r} "
                     f"is-active={active.stdout.strip()!r}",
                     {"systemd": True, "expected": expected})


def apply_engine_service(ctx: Ctx) -> Result:
    if which("systemctl") is None:
        return Result("deferred", "not a systemd host (no systemctl on PATH) - write "
                       f"{ctx.engine_unit_path} yourself with the contents in specs/engine.md "
                       "section 7, then `systemctl daemon-reload && systemctl enable --now "
                       "sdl-engine`")
    uv_path = which("uv")
    if uv_path is None:
        return Result("failed", "uv not found on PATH - the uv step must run (and succeed) "
                       "before this one")
    # Before the unit, not after: a service that starts without a committer
    # identity is `active` and useless (see `ensure_engine_git_identity`), and
    # this runs on EVERY converge, including one that finds the unit already
    # perfect - the identity is part of "the engine works here", not part of
    # "the unit file is current".
    identity = ensure_engine_git_identity(ctx)
    note = f"; {identity}" if identity else ""
    # git refusing that write is not a converged step, however healthy the unit
    # is: the service comes up `active` and fails every commit it ever makes.
    stalled = identity.startswith("could not set git")

    if ctx.dry_run:
        detected = detect_engine_service(ctx)
        if detected.present:
            return Result("ok", "[dry-run] sdl-engine.service already matches, enabled, "
                           f"active{note}")
        return Result("ok", f"[dry-run] would write {ctx.engine_unit_path}, systemctl "
                       f"daemon-reload, systemctl enable --now sdl-engine{note}")

    detected = detect_engine_service(ctx)
    if detected.present:
        if stalled:
            return Result("needs-operator",
                          f"sdl-engine.service already matches, enabled, active{note}")
        return Result("installed" if identity else "ok",
                      f"sdl-engine.service already matches, enabled, active - no changes{note}")

    expected = detected.data["expected"]
    unit_path = ctx.engine_unit_path
    current = unit_path.read_text(encoding="utf-8") if unit_path.is_file() else ""
    if current != expected:
        if unit_path.is_file():
            park_replace(unit_path, ledger_path=ctx.ledger_path, run_id=ctx.run_id,
                        step="engine-service")
        write_text(unit_path, expected, ctx)

    reload_result = run(["systemctl", "daemon-reload"], timeout=PROBE_TIMEOUT, ctx=ctx)
    if reload_result.returncode != 0:
        return Result("failed", f"systemctl daemon-reload exited {reload_result.returncode}: "
                       f"{reload_result.stderr[-300:]}")
    enable_result = run(["systemctl", "enable", "--now", "sdl-engine"], timeout=PROBE_TIMEOUT,
                        ctx=ctx)
    if enable_result.returncode != 0:
        return Result("failed", f"systemctl enable --now sdl-engine exited "
                       f"{enable_result.returncode}: {enable_result.stderr[-300:]}")
    # enable --now is a no-op on an already-running unit, so a REWRITTEN unit
    # would keep running the old ExecStart/User/env until the next boot.
    # try-restart only touches a running service - a stopped one stays stopped
    # for enable --now above to have started.
    restart_result = run(["systemctl", "try-restart", "sdl-engine"], timeout=PROBE_TIMEOUT,
                         ctx=ctx)
    restart_note = ("" if restart_result.returncode == 0
                    else f"; try-restart exited {restart_result.returncode} - the running "
                         f"process may still be the previous unit")
    return Result("needs-operator" if stalled else "installed",
                  f"{unit_path} written, daemon-reload'd, enabled --now, "
                  f"try-restarted{restart_note}{note}")


def verify_engine_service(ctx: Ctx) -> Result:
    if which("systemctl") is None:
        return Result("deferred", "not a systemd host (no systemctl on PATH)")
    detected = detect_engine_service(ctx)
    return Result("ok" if detected.present else "needs-operator", detected.detail)


# ── the step list (spec 4, the deliverable table) ────────────────────────────

STEPS: list[Step] = [
    Step("uv", "uv", ALL, True, detect_uv, apply_uv, verify_uv),
    Step("just", "just", ALL, True, detect_just, apply_just, verify_just),
    Step("sqlite", "sqlite", ALL, True, detect_sqlite, apply_sqlite, verify_sqlite),
    Step("node", "node + npm", ALL, True, detect_node, apply_node, verify_node),
    Step("pi", "pi + PI_PATH", ALL, True, detect_pi, apply_pi, verify_pi),
    Step("pi-packages", "pi packages (bridge, subagents)", ALL, True,
         detect_pi_packages, apply_pi_packages, verify_pi_packages),
    Step("ollama-scripts", "ollama-cloud scripts", ALL, True,
         detect_ollama_scripts, apply_ollama_scripts, verify_ollama_scripts),
    Step("ollama-cloud", "ollama-cloud provider wiring", ALL, True,
         detect_ollama_provider, apply_ollama_provider, verify_ollama_provider),
    Step("skylos", "skylos (AI-defect scan)", ALL, True,
         detect_skylos, apply_skylos, verify_skylos),
    Step("no-mistakes", "no-mistakes (install only, never wired)", ALL, False,
         detect_no_mistakes, apply_no_mistakes, verify_no_mistakes),
    Step("codegraph", "CodeGraph (binary only)", ALL, False,
         detect_codegraph, apply_codegraph, verify_codegraph),
    Step("claude-cli", "Claude Code CLI", ALL, False,
         detect_claude_cli, apply_claude_cli, verify_claude_cli),
    Step("codex-cli", "Codex CLI", ALL, False,
         detect_codex_cli, apply_codex_cli, verify_codex_cli),
    Step("claude-oauth-token", "CLAUDE_CODE_OAUTH_TOKEN", SERVER_CONTAINER, False,
         detect_oauth_token, apply_oauth_token, verify_oauth_token),
    Step("ui", "UI install", SERVER_CONTAINER, False, detect_ui, ui_install, verify_ui),
    Step("auth", "auth pass (xai, openai-codex, claude-bridge)", ALL, False,
         detect_auth, apply_auth, verify_auth),
    # Last on purpose: the factory (packages, models, lanes, auth) has been
    # fully converged by every step above by the time this one starts a live
    # systemd service that immediately begins pulling/dispatching/pushing
    # against it (MAP.md "The two-box model"; specs/engine.md section 7).
    Step("engine-service", "sdl-engine.service (systemd)", SERVER_CONTAINER, True,
         detect_engine_service, apply_engine_service, verify_engine_service),
]


# ── verification: real round trips only (spec 9) ─────────────────────────────

def verify_v1_no_launch_install(ctx: Ctx) -> Result:
    """V1, the spec's own documented fallback (section 9): whether `-ne` also
    suppresses package installation at launch is an open mechanic the spec
    asks the builder to settle by experiment on a live host with a package
    deliberately absent. That experiment needs a full converge to already
    have happened and was not run in this build session, so V1 uses the
    fallback the spec names rather than guessing: `node <cli.js> list` names
    both packages AND both exist on disk under
    ~/.pi/agent/npm/node_modules/ - the deterministic pair, reported as such
    rather than claiming a launch was observed clean."""
    result = verify_pi_packages(ctx)
    return Result(result.outcome, "V1 fallback (deterministic pair, not a launch probe - "
                  "see steps.py:verify_v1_no_launch_install): " + result.message)


def verify_v2_round_trip(ctx: Ctx) -> Result:
    """Real round trip through adw_prompt.py on the test lane only (MAP rule 4
    - no Anthropic model in any test). One repeat for the documented Kimi
    envelope flake (MAP landmine)."""
    adw_id = new_id()
    script = ctx.repo_root / "adws" / "adw_prompt.py"
    db_path = ctx.repo_root / "adws" / "adw_data" / "sssf.db"
    last_returncode = None
    for _attempt in range(2):
        result = run(["uv", "run", str(script), "--config",
                     "adws/adw_sssf_config/sssf.config.yaml", "--agent", "scout",
                     "--adw-id", adw_id, "reply with the single word OK"],
                    timeout=NETWORK_TIMEOUT, cwd=ctx.repo_root, ctx=ctx)
        last_returncode = result.returncode
        if result.returncode == 0:
            break
    else:
        return Result("failed", f"adw_prompt exited non-zero twice "
                       f"(last={last_returncode}), adw_id={adw_id}")
    if not db_path.exists():
        return Result("failed", f"no sssf.db at {db_path}, adw_id={adw_id}")
    connection = sqlite3.connect(str(db_path))
    try:
        row = connection.execute(
            "SELECT status, total_tokens FROM sessions WHERE adw_id=?", (adw_id,)
        ).fetchone()
    finally:
        connection.close()
    if not row:
        return Result("failed", f"no session row for adw_id={adw_id}")
    status, total_tokens = row
    if status != "success" or not total_tokens:
        return Result("failed", f"adw_id={adw_id} status={status} total_tokens={total_tokens}")
    return Result("ok", f"round trip ok: adw_id={adw_id} status=success total_tokens={total_tokens}")


def verify_v3_claude_bridge(ctx: Ctx) -> Result:
    """Registration, deliberately not a round trip (MAP rule 4 / spec 12.8):
    the mechanism was already proven once (BRIDGE_OK); no Anthropic call is
    made here."""
    cli_js = _pi_cli_js(ctx)
    if cli_js is None:
        return Result("failed", "pi cli.js not found")
    extension = (ctx.home / ".pi" / "agent" / "npm" / "node_modules" / "pi-claude-bridge"
                 / "src" / "index.ts")
    if not extension.exists():
        return Result("failed", f"pi-claude-bridge extension not found at {extension}")
    result = run(["node", str(cli_js), "-ne", "-e", str(extension), "--provider",
                 "claude-bridge", "--list-models"], timeout=PROBE_TIMEOUT, ctx=ctx)
    if result.returncode != 0 or "claude-" not in result.stdout:
        return Result("failed", "no claude-* model listed via --list-models")
    return Result("ok", "claude-bridge registered; at least one claude-* model listed "
                  "(no Anthropic call made)")


def verify_v4_subagents(ctx: Ctx) -> Result:
    cli_js = _pi_cli_js(ctx)
    if cli_js is None:
        return Result("failed", "pi cli.js not found")
    extension_dir = ctx.home / ".pi" / "agent" / "npm" / "node_modules" / "@tintinweb" / "pi-subagents"
    result = run(["node", str(cli_js), "list"], timeout=PROBE_TIMEOUT, ctx=ctx)
    if result.returncode != 0 or "pi-subagents" not in result.stdout:
        return Result("failed", "pi-subagents not named by `node cli.js list`")
    if not extension_dir.exists():
        return Result("failed", f"pi-subagents not found on disk at {extension_dir}")
    return Result("ok", "pi-subagents listed and present on disk; clean load, no agent call made")


def verify_v6_toolchain(ctx: Ctx) -> Result:
    """Honesty residual 3(a): the only sub-check that can legitimately read
    `needs-operator` here is `no-mistakes` (spec 6.10 - no confirmed Windows
    installer, `required: False` on its own Step). That is the SAME optional
    gap the no-mistakes Step already carries, not a new V6 failure mode, so
    V6 still reports `ok` overall rather than downgrading a required verify
    check to needs-operator over an already-known, already-declared gap. But
    it must not be swallowed silently either - spec 9's "all exit 0" is read
    as "no sub-check outcome is `failed`", and any needs-operator sub-result
    is surfaced inline as a visible `[!] <name>: <message>` in V6's own
    message rather than disappearing into a bare "ok"."""
    checks = {
        "uv": verify_uv(ctx), "just": verify_just(ctx), "node": verify_node(ctx),
        "no-mistakes": verify_no_mistakes(ctx), "codegraph": verify_codegraph(ctx),
        "sqlite": verify_sqlite(ctx),
    }
    bad = {name: result.message for name, result in checks.items()
           if result.outcome not in ("ok", "installed", "expected-unavailable", "needs-operator")}
    if bad:
        return Result("failed", f"toolchain check failed: {bad}")
    needs_operator = {name: result.message for name, result in checks.items()
                       if result.outcome == "needs-operator"}
    if needs_operator:
        flagged = "; ".join(f"[!] {name}: {msg}" for name, msg in needs_operator.items())
        return Result("ok", f"uv, just, node, codegraph, sqlite all accounted for; {flagged}")
    return Result("ok", "uv, just, node, no-mistakes, codegraph, sqlite all accounted for")


def verify_v8_server_credentials(ctx: Ctx) -> Result:
    if ctx.target == "laptop":
        return Result("deferred", "server/container only")
    checks = [verify_claude_cli(ctx), verify_codex_cli(ctx), verify_oauth_token(ctx)]
    if any(check.outcome == "failed" for check in checks):
        return Result("failed", "server credential surface incomplete")
    if any(check.outcome == "needs-operator" for check in checks):
        return Result("needs-operator", "server credential surface still needs a human")
    return Result("ok", "claude/codex CLIs present, token on file (redacted)")


VERIFY_CHECKS: list[VerifyCheck] = [
    VerifyCheck("V1", "nothing installs at launch", ALL, verify_v1_no_launch_install),
    VerifyCheck("V2", "test-lane round trip", ALL, verify_v2_round_trip),
    VerifyCheck("V3", "claude-bridge registration", ALL, verify_v3_claude_bridge),
    VerifyCheck("V4", "pi-subagents loads", ALL, verify_v4_subagents),
    VerifyCheck("V5", "skylos", ALL, verify_skylos),
    VerifyCheck("V6", "toolchain", ALL, verify_v6_toolchain),
    VerifyCheck("V7", "no-mistakes not wired", ALL, verify_v7_no_mistakes_not_wired),
    VerifyCheck("V8", "server credential surface", SERVER_CONTAINER, verify_v8_server_credentials),
]
