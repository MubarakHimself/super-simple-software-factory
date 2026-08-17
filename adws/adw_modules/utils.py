"""Small shared helpers. Anything bigger belongs in its own module."""

from __future__ import annotations

import os
import secrets
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

# The repo's own .env first: a project's checked-out configuration outranks
# anything machine-wide, and `override=False` (the default) means whatever the
# operator already exported in their shell outranks both.
load_dotenv()


def machine_secrets_path() -> Path:
    """`~/.sdl-factory/secrets.env` — the MACHINE's own credential file.

    `SDL_FACTORY_HOME` redirects it, the same variable the app plane's
    `machines.ts` honours, so a test never reads the operator's real one.
    """
    home = os.environ.get("SDL_FACTORY_HOME", "").strip()
    return (Path(home) if home else Path.home()) / ".sdl-factory" / "secrets.env"


def load_machine_secrets() -> bool:
    """Load `~/.sdl-factory/secrets.env` into this process's environment.

    THE GAP THIS CLOSES. Three separate paths write CLAUDE_CODE_OAUTH_TOKEN
    into that file — the app's "Sign in on <machine>" capture
    (`apps/ui/server/app/auth-sessions.ts:writeCaptured`), the Providers sync
    (`providers-v3.ts`), and `installer/steps.py:apply_oauth_token` — and until
    this function existed NOTHING on a running factory read it back. The
    sdl-engine systemd unit names no `EnvironmentFile`, and `apply_oauth_token`
    deliberately writes only a COMMENT into the repo's `.env` ("source with:
    set -a; . ~/.sdl-factory/secrets.env"), which no process ever sources. So a
    Claude sign-in the app reported `completed`, and a Claude sync the app
    reported `applied`, left the planner/reviewer claude-bridge lanes
    unauthenticated: `pi-claude-bridge` authenticates from
    `~/.claude/.credentials.json` or `$CLAUDE_CODE_OAUTH_TOKEN`, `claude
    setup-token` saves no credentials file, and the variable never reached the
    engine's children.

    It is loaded HERE, at module import, because `adw_modules.utils` is
    imported by every ADW, by `engine.py` and by `dispatch.py`, and
    `operator_env()` below copies `os.environ` into every child process — so
    one load reaches the whole tree, on BOTH deploy paths (the installer's unit
    and the inline bootstrap's), without either unit writer having to change.

    `override=False`: a value already in the environment, or in the repo's own
    `.env`, wins. Returns whether a file was found, for the caller that wants
    to say so.
    """
    try:
        path = machine_secrets_path()
        if not path.is_file():
            return False
        load_dotenv(path, override=False)
        return True
    except OSError:
        # This runs at IMPORT time, in every ADW, in dispatch and in the
        # always-on engine. A secrets.env with the wrong owner or mode - the
        # exact state a file written by another user leaves behind - would
        # otherwise raise here and take down every run in the factory at the
        # import line, before anything could report why. A credential that
        # cannot be read is a lane that is not signed in, which the auth probes
        # already say out loud; it is not a reason to stop the engine.
        return False


load_machine_secrets()


def operator_env() -> dict[str, str]:
    """The engineer's own environment, as their shell would hand it over.

    Agents and quality blocks are meant to see exactly what the operator sees:
    their PATH, their toolchains, their globally installed packages. Copying
    os.environ gets almost all the way there — but ADWs launch under `uv run`,
    which prepends its ephemeral venv's bin to PATH and sets VIRTUAL_ENV. That
    venv holds the ADW's OWN dependencies (pydantic, pyyaml), not the
    operator's, so anything a subprocess resolves through it — `python3`,
    `pip`, every globally pip-installed CLI — silently becomes the wrong one.

    Stripping the venv restores parity: `python3` in an agent's bash is the
    same `python3` the engineer gets in their terminal. The ADW's own imports
    are unaffected; this env is only ever handed to child processes.
    """
    env = os.environ.copy()
    venv = env.pop("VIRTUAL_ENV", "")
    if not venv:
        return env
    venv_bin = str(Path(venv) / "bin")
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p and p != venv_bin]
    env["PATH"] = os.pathsep.join(parts)
    return env


def new_id(length: int = 8) -> str:
    return secrets.token_hex(length // 2)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def under(root: str | Path, value: str | Path) -> Path:
    """Absolute in, absolute out; relative in, joined to `root`.

    Used to resolve config values (`observability.db`, `defaults.data_dir`)
    against `main_root` rather than the process cwd — the fix for the
    silent-loss landmine (spec 5.3): once an agent's cwd moves to a worktree,
    a bare relative path in a variable handed to it would resolve INSIDE that
    worktree instead of the main repo. The config object itself is never
    mutated — only the resolved Path this returns.
    """
    p = Path(value)
    return p if p.is_absolute() else Path(root) / p


def minutes_since(iso_ts: str, now: datetime | None = None) -> float:
    """Minutes between `iso_ts` (a `now_iso()`-shaped timestamp) and `now`
    (defaults to this instant, UTC).

    A malformed or empty timestamp reads as infinitely old rather than
    raising — every caller uses this to decide staleness (session.py's live-
    rejoin guard, worktrees.py's `alive (stale Nh)` annotation), and a crash
    here must never block the recovery path it exists to protect.
    """
    if not iso_ts:
        return float("inf")
    try:
        then = datetime.fromisoformat(iso_ts)
    except ValueError:
        return float("inf")
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    return ((now or datetime.now(timezone.utc)) - then).total_seconds() / 60


def resolve_prompt(arg: str) -> str:
    """CLI prompt arg: a file path resolves to its contents, else inline text."""
    try:
        p = Path(arg)
        if p.is_file():
            return p.read_text(encoding="utf-8")
    except OSError:
        pass
    return arg


def engineer_name() -> str:
    name = os.environ.get("ENGINEER_NAME", "").strip()
    if name:
        return name
    try:
        out = subprocess.run(["git", "config", "user.name"],
                             capture_output=True, text=True, encoding="utf-8", timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except OSError:
        pass
    return os.environ.get("USER", "engineer")
