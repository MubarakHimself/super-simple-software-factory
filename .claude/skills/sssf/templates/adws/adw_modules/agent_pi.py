"""Pi coding agent interface — v1's only coding agent.

Runs `pi -p --mode json` and tails its JSONL stdout line by line, forwarding
each event to a callback WHILE the agent works (the streaming crack, solved
by construction). `--session-id` creates-or-continues, so running and
continuing an agent are the same call: same session id = same context window.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import time
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path

from .data_types import PiRequest, PiResult
from .utils import now_iso, operator_env


def _resolve_pi_cmd() -> list[str]:
    """The argv prefix that launches pi, resolved ONCE from PI_PATH.

    PI_PATH is a full command, not a bare path — on Windows it must be
    `node <path>/cli.js`. `pi` alone raises FileNotFoundError (CreateProcess
    ignores PATHEXT); `pi.cmd` launches but is a batch shim that forwards its
    arguments as `%*`, and cmd.exe truncates any argument at its first
    newline — silently gutting every agent's multi-line --system-prompt and
    turning the call into an empty, errored turn. Never invoke `pi` by name.

    shlex.split() in posix mode needs forward slashes to survive a Windows
    path: it treats backslash as an escape character, so `C:\\Users\\...`
    comes out mangled while `C:/Users/...` passes through untouched.
    """
    raw = os.environ.get("PI_PATH", "").strip()
    if not raw:
        raise RuntimeError(
            "PI_PATH is not set. adws must never invoke `pi` by name - set it "
            "in .env to the real launch command, e.g.\n"
            "  PI_PATH=node C:/path/to/@earendil-works/pi-coding-agent/dist/cli.js\n"
            "Use forward slashes - shlex.split() needs them to survive Windows "
            "paths. Re-derive it after a pi reinstall with: "
            'type "$(where pi.cmd)"'
        )
    cmd = shlex.split(raw, posix=True)
    if not cmd:
        raise RuntimeError(f"PI_PATH is set but parsed to no tokens: {raw!r}")
    target = cmd[-1]
    if "/" in target or "\\" in target:
        if not Path(target).is_file():
            raise RuntimeError(
                f"PI_PATH={raw!r} resolves to {target!r}, which does not exist "
                'on disk. Re-derive it after a pi reinstall with: '
                'type "$(where pi.cmd)"'
            )
    elif shutil.which(target) is None:
        raise RuntimeError(
            f"PI_PATH={raw!r} resolves to bare command {target!r}, which is "
            "not found on PATH."
        )
    return cmd


def pi_cmd() -> list[str]:
    """`_resolve_pi_cmd()`, ON DEMAND — never at import.

    This was a module-level `PI_CMD = _resolve_pi_cmd()`, and that one line
    turned a config problem into a dead factory. `adws/engine.py` imports this
    module transitively (engine -> dispatch -> agents -> agent_pi), so an unset,
    unparseable or moved `PI_PATH` raised before `argparse` had even run: even
    `uv run adws/engine.py --help` died with a raw traceback. Under the server
    unit's `Restart=always` that is a ten-second crash loop, for a process that
    never spawns pi itself — the exact shape specs/engine.md 7/9 promises cannot
    happen ("nothing here is fatal"; a config problem "must not turn the service
    into a systemd restart loop"). A pi upgrade that moves `dist/cli.js`, or a
    lost `.env`, was enough to do it overnight.

    Resolved at the CALL now, so the failure lands where pi is actually being
    launched: per card and visibly for a run, one named line and a held cycle
    for the engine's own preflight (`engine.pi_launchable`). Deliberately
    uncached for the same reason — an operator who repairs `PI_PATH` is picked
    up on the next call, with no restart. It is `shlex.split` plus one
    `is_file()`, which is nothing beside spawning a coding agent.
    """
    return _resolve_pi_cmd()


# Unattended runs must never discover ambient extensions that could prompt and
# hang — explicit `-e <path>` per request.extensions still works (rule 12).
NO_EXTENSION_DISCOVERY = ["-ne"]
MODELS_JSON = os.environ.get("PI_MODELS_PATH",
                             str(Path.home() / ".pi" / "agent" / "models.json"))

RESULT_SNIPPET_CHARS = 20_000   # tool output rides along whole; clip only guards pathological cases
ARG_VALUE_CHARS = 20_000        # args too — the UI scrolls, it must not be handed cut-off data
LABEL_CHARS = 80                # "bash: <command>" shown as the event name

# The arg that identifies a call at a glance, in the order tools tend to use.
PRIMARY_ARGS = ("command", "path", "file_path", "pattern", "query", "url")


def _count(value: str) -> int:
    """Parse pi's compact model-list counts (`272K`, `1.0M`)."""
    suffixes = {"K": 1_000, "M": 1_000_000}
    suffix = value[-1:].upper()
    if suffix in suffixes:
        return int(float(value[:-1]) * suffixes[suffix])
    return int(value)


@lru_cache(maxsize=32)
def _pi_catalog(extensions: tuple[str, ...] = ()) -> list[tuple[str, str, int]]:
    """Read pi's merged catalog for one exact extension set, including
    built-in providers, custom models, AND anything an extension registers
    (e.g. claude-bridge/* models, which only exist once pi-claude-bridge is
    loaded).

    `-ne` still disables AMBIENT discovery (rule 12) - but `extensions` are
    passed straight back in as explicit `-e <path>` flags, same as a real
    agent turn's own extension list, so a bridge-only model is not
    structurally invisible to a cost-free `--list-models` probe. Cached per
    exact extension tuple with `lru_cache`, so `agents.validate()` calling
    this once per agent in a roster shells `pi` at most once per DISTINCT
    extension set, not once per agent - most agents in one roster share the
    same set (roster-wide `defaults.harness_engineering`), so this is
    normally one subprocess call for the whole validate() pass, not five.
    """
    try:
        result = subprocess.run(
            [*pi_cmd(), *NO_EXTENSION_DISCOVERY,
             *[flag for ext in extensions for flag in ("-e", ext)],
             "--list-models"],
            capture_output=True, text=True, encoding="utf-8",
            timeout=30, env=operator_env(), check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    rows = []
    for line in result.stdout.splitlines()[1:]:
        columns = line.split()
        if len(columns) < 3:
            continue
        try:
            rows.append((columns[0], columns[1], _count(columns[2])))
        except ValueError:
            continue
    return rows


def resolve_model(pattern: str, extensions: tuple[str, ...] = ()) -> tuple[str, str]:
    """Resolve a model pattern to an explicit ``(provider, model_id)`` pair.

    Pi's catalog merges built-in models with ``~/.pi/agent/models.json``. Using
    that same merged view lets SSSF target direct providers such as
    ``openai/gpt-5.6-terra`` without re-registering built-in models locally.

    ``extensions`` is the caller's own merged ``harness_engineering`` list (a
    tuple - hashable, so it doubles as the catalog cache key). Pass the same
    extensions an agent actually runs with; a bridge model (``claude-bridge/*``)
    resolves only when the bridge extension that registers it is named here,
    exactly like a real pi invocation. The default of ``()`` reproduces the
    old no-extensions probe unchanged.
    """
    catalog = [(provider, model_id) for provider, model_id, _ in _pi_catalog(extensions)]
    if "/" in pattern:
        provider, model_id = pattern.split("/", 1)
        if (provider, model_id) in catalog:
            return provider, model_id
    matches = [(provider, model_id) for provider, model_id in catalog
               if pattern == model_id or pattern in model_id]
    exact = [match for match in matches
             if match[1] == pattern or match[1].endswith("/" + pattern)]
    if len(exact) == 1:
        return exact[0]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise ValueError(f"model pattern {pattern!r} not found in pi --list-models - "
                         "authenticate/register it or fix the config")
    raise ValueError(f"model pattern {pattern!r} is ambiguous: {matches}")


def _context_tokens(usage: dict) -> int:
    """Tokens occupying the window after a turn.

    Mirrors pi's own `calculateContextTokens` (coding-agent
    `core/compaction/compaction.ts`), which is what pi compacts against and
    shows in its footer: prefer the provider's `totalTokens`, else sum the
    parts. Cache reads count — cached prompt is still prompt.
    """
    total = usage.get("totalTokens") or 0
    if total:
        return int(total)
    return int(sum(usage.get(part) or 0
                   for part in ("input", "output", "cacheRead", "cacheWrite")))


def context_window(provider: str, model_id: str, extensions: tuple[str, ...] = ()) -> int:
    """The model's context ceiling from pi's merged model catalog.

    `extensions` is passed through to `_pi_catalog` for the same reason
    `resolve_model` takes it: a bridge-only model's context window is only
    listed once the extension that registers the model is loaded.
    """
    registry = json.loads(Path(MODELS_JSON).read_text(encoding="utf-8"))
    for model in registry.get("providers", {}).get(provider, {}).get("models", []):
        if model.get("id") == model_id:
            return int(model.get("contextWindow") or 0)
    for listed_provider, listed_model, window in _pi_catalog(extensions):
        if listed_provider == provider and listed_model == model_id:
            return window
    return 0


def _text_of(container: dict) -> str:
    """Join the text blocks of anything pi shapes as {content: [...]} — a
    message or a tool result."""
    return "".join(part.get("text", "") for part in container.get("content", []) or []
                   if isinstance(part, dict) and part.get("type") == "text")


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rstrip() + "..."


def _label(tool: str, args: dict) -> str:
    """One-line human name for a tool call: `bash: ls -la src`."""
    value = next((args[key] for key in PRIMARY_ARGS
                  if isinstance(args.get(key), str) and args[key].strip()), "")
    if not value:
        value = next((v for v in args.values() if isinstance(v, str) and v.strip()), "")
    value = " ".join(str(value).split())
    return f"{tool}: {_clip(value, LABEL_CHARS)}" if value else tool


class ToolCallTracker:
    """Folds pi's tool stream into ONE normalized record per completed call.

    pi announces a call as a `toolCall` content block, then emits
    tool_execution_start / _update / _end for it. Only the end carries the
    result, so that is where a record is emitted — one trace event per real
    tool call, the moment it returns, instead of three shapeless ones.

    The record carries the call's real span (`started_at`/`ended_at`), which the
    tracer writes to columns so the UI can lay tool calls on a time axis without
    parsing every payload.
    """

    def __init__(self) -> None:
        self._open: dict[str, dict] = {}

    def observe(self, event: dict) -> dict | None:
        """Returns the record for a finished tool call, else None."""
        etype = event.get("type", "")
        if etype == "message_end":
            for block in event.get("message", {}).get("content", []) or []:
                if isinstance(block, dict) and block.get("type") == "toolCall":
                    self._announce(block.get("id"), block.get("name"),
                                   block.get("arguments"))
            return None
        if etype == "tool_execution_start":
            self._announce(event.get("toolCallId"), event.get("toolName"),
                           event.get("args"))
            return None
        if etype != "tool_execution_end":
            return None

        call_id = str(event.get("toolCallId") or "")
        opened = self._open.pop(call_id, {})
        tool = str(event.get("toolName") or opened.get("tool") or "tool")
        args = event.get("args") or opened.get("args") or {}
        record = {
            "tool": tool,
            "tool_call_id": call_id,
            "args": {key: _clip(value, ARG_VALUE_CHARS) if isinstance(value, str) else value
                     for key, value in args.items()},
            "ok": not event.get("isError", False),
            "label": _label(tool, args),
        }
        result_text = _text_of(event.get("result") or {})
        if result_text:
            record["result_snippet"] = _clip(result_text, RESULT_SNIPPET_CHARS)
        record["ended_at"] = now_iso()
        if opened.get("clock"):
            record["duration_ms"] = int((time.monotonic() - opened["clock"]) * 1000)
        if opened.get("started_at"):
            record["started_at"] = opened["started_at"]
        return record

    def _announce(self, call_id, tool, args) -> None:
        """First sighting starts the clock; a later sighting only fills gaps."""
        if not call_id:
            return
        known = self._open.get(str(call_id), {})
        self._open[str(call_id)] = {
            "tool": tool or known.get("tool", ""),
            "args": args or known.get("args", {}),
            "started_at": known.get("started_at") or now_iso(),   # wall clock, for the row
            "clock": known.get("clock") or time.monotonic(),      # monotonic, for duration
        }


def run(request: PiRequest, on_event: Callable[[dict], None] | None = None,
        on_spawn: Callable[[int], None] | None = None,
        on_exit: Callable[[int], None] | None = None) -> PiResult:
    """Run one non-interactive pi turn.

    `on_spawn(pid)` and `on_exit(pid)` bracket the child process so the caller
    can record it as killable — a hung coding agent is otherwise a pid you have
    to hunt for in `ps` while the run sits there.
    """
    extensions = tuple(request.extensions)
    provider, model_id = resolve_model(request.model, extensions=extensions)
    cmd = [
        *pi_cmd(), *NO_EXTENSION_DISCOVERY, "-p", "--mode", "json",
        "--provider", provider, "--model", model_id,
        "--thinking", request.thinking,
        "--session-id", request.session_id,
        "--session-dir", request.session_dir,
        "--system-prompt", request.system_prompt,
    ]
    if request.tools:
        cmd += ["--tools", ",".join(request.tools)]
    for extension in request.extensions:
        cmd += ["-e", extension]
    cmd.append(request.prompt)

    raw_path = Path(request.raw_output_path)
    raw_path.parent.mkdir(parents=True, exist_ok=True)

    result = PiResult(session_id=request.session_id,
                      context_window=context_window(provider, model_id, extensions=extensions))
    # stdin is DEVNULL, deliberately. The prompt travels in argv, so the child
    # never needs stdin — but inheriting the parent's means pi sees a non-TTY
    # and can sit forever waiting for piped input that will never arrive or
    # EOF. That failure is silent and total: no request goes out, no bytes come
    # back, and the ADW blocks on a read loop with nothing to read. Observed as
    # a run that sat idle at 0% CPU with an empty raw_output.jsonl.
    process = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", bufsize=1, cwd=request.cwd,
                               env=operator_env())
    if on_spawn:
        on_spawn(process.pid)
    with raw_path.open("a", encoding="utf-8") as raw:
        assert process.stdout is not None
        for line in process.stdout:
            raw.write(line)
            raw.flush()                      # events land on disk as they happen
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "message_end":
                message = event.get("message", {})
                if message.get("role") == "assistant":
                    text = _text_of(message)
                    if text:
                        result.text = text   # last assistant message wins
                    usage = message.get("usage", {}) or {}
                    turn = _context_tokens(usage)
                    result.tokens += turn
                    result.usage.add_turn(usage, turn)
                    # Occupancy is read off the last VALID assistant turn, the
                    # way pi does it — an aborted or errored turn reports usage
                    # you can't trust, so it must not overwrite a good reading.
                    if turn and message.get("stopReason") not in ("aborted", "error"):
                        result.context_tokens = turn
                    result.cost += (usage.get("cost", {}) or {}).get("total", 0.0) or 0.0
            if on_event:
                on_event(event)

    stderr = process.stderr.read() if process.stderr else ""
    result.returncode = process.wait()
    if on_exit:
        on_exit(process.pid)
    if result.returncode != 0 and not result.text:
        raise RuntimeError(f"pi exited {result.returncode}: {stderr.strip()[-800:]}")
    return result
