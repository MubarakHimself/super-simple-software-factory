"""Hermetic tests for adw_modules.agent_pi's model-catalog resolution.

The bug this guards: `_pi_catalog()` used to shell `pi -ne --list-models`
with NO extensions, ever — so a model an extension registers (e.g. any
claude-bridge/* model, which pi-claude-bridge adds) was structurally
invisible to `resolve_model()`, and `agents.validate()` (which calls
`resolve_model()` for every agent before a run starts) SystemExits a
shipping config that names a bridge model, even though a real bridge round
trip would work fine. The fix: `_pi_catalog` takes the caller's own
extension list and passes each one back as an explicit `-e` flag — the SAME
merged `harness_engineering` list an agent actually runs with — and
`lru_cache`s per exact extension tuple, so a roster whose several agents
share one extension set shells `pi` once, not once per agent.

No real `pi` process ever runs here — `subprocess.run` is monkeypatched.
"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest
from adw_modules import agent_pi

BRIDGE_EXT = "C:/fake/pi-claude-bridge/src/index.ts"
OTHER_EXT = "C:/fake/other-extension.ts"

BASE_MODELS = (
    "PROVIDER       MODEL                COUNT\n"
    "ollama-cloud   kimi-k2.7-code       256K\n"
    "xai            grok-4.5             128K\n"
)
BRIDGE_MODELS = BASE_MODELS + "claude-bridge  claude-opus-4-8      200K\n"


@pytest.fixture(autouse=True)
def _clear_catalog_cache():
    """Every test starts with a cold cache — `_pi_catalog` is a module-level
    `lru_cache`; a hit carried over from a previous test would silently
    short-circuit the very subprocess call the next test means to observe."""
    agent_pi._pi_catalog.cache_clear()
    yield
    agent_pi._pi_catalog.cache_clear()


def _fake_run(calls: list[list[str]], stdout: str, returncode: int = 0):
    """Stand-in for `subprocess.run`: records the argv it was called with and
    returns pi's `--list-models` shape (returncode + stdout)."""

    def run(cmd, **kwargs):
        calls.append(cmd)
        return SimpleNamespace(returncode=returncode, stdout=stdout, stderr="")

    return run


# ── the no-extensions path is unchanged ─────────────────────────────────────

def test_no_extensions_path_shells_ne_with_no_e_flags(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", _fake_run(calls, BASE_MODELS))

    provider, model_id = agent_pi.resolve_model("ollama-cloud/kimi-k2.7-code")

    assert (provider, model_id) == ("ollama-cloud", "kimi-k2.7-code")
    assert len(calls) == 1
    assert "-ne" in calls[0]
    assert "-e" not in calls[0]          # unchanged: no extensions -> no -e flags at all
    assert calls[0][-1] == "--list-models"


def test_no_extensions_and_explicit_empty_tuple_are_the_same_call(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", _fake_run(calls, BASE_MODELS))

    agent_pi.resolve_model("ollama-cloud/kimi-k2.7-code")                 # default extensions=()
    agent_pi.resolve_model("ollama-cloud/kimi-k2.7-code", extensions=())  # explicit, same cache key

    assert len(calls) == 1               # same key both times -> one subprocess call total


# ── bridge-model resolution with -e present ─────────────────────────────────

def test_bridge_model_invisible_without_the_e_flag(monkeypatch):
    """The exact shape of the original bug: a catalog probe with NO -e flags
    never lists a bridge model, so resolution fails even though the
    extension is installed and would register it if loaded."""
    calls: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", _fake_run(calls, BASE_MODELS))

    with pytest.raises(ValueError, match="not found"):
        agent_pi.resolve_model("claude-bridge/claude-opus-4-8", extensions=())

    assert "-e" not in calls[0]


def test_bridge_model_resolves_when_its_extension_is_passed(monkeypatch):
    calls: list[list[str]] = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        stdout = BRIDGE_MODELS if BRIDGE_EXT in cmd else BASE_MODELS
        return SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    monkeypatch.setattr(subprocess, "run", run)

    provider, model_id = agent_pi.resolve_model(
        "claude-bridge/claude-opus-4-8", extensions=(BRIDGE_EXT,))

    assert (provider, model_id) == ("claude-bridge", "claude-opus-4-8")
    assert calls[0].count("-e") == 1
    ext_index = calls[0].index("-e")
    assert calls[0][ext_index + 1] == BRIDGE_EXT


def test_multiple_extensions_each_get_their_own_e_flag(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", _fake_run(calls, BRIDGE_MODELS))

    agent_pi.resolve_model("claude-bridge/claude-opus-4-8",
                           extensions=(BRIDGE_EXT, OTHER_EXT))

    cmd = calls[0]
    e_positions = [i for i, tok in enumerate(cmd) if tok == "-e"]
    assert len(e_positions) == 2
    assert cmd[e_positions[0] + 1] == BRIDGE_EXT
    assert cmd[e_positions[1] + 1] == OTHER_EXT


# ── cache behaviour: per exact extension-set, not per call ─────────────────

def test_same_extension_set_shells_pi_once_for_a_whole_roster(monkeypatch):
    """The roster case agents.validate() hits: several agents share the SAME
    merged harness_engineering (e.g. every agent inherits just `defaults`).
    Resolving all of them must not shell `pi` once per agent."""
    calls: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", _fake_run(calls, BRIDGE_MODELS))

    for _ in range(5):   # simulate validate() walking a 5-agent roster
        agent_pi.resolve_model("claude-bridge/claude-opus-4-8", extensions=(BRIDGE_EXT,))

    assert len(calls) == 1


def test_a_different_extension_set_shells_pi_again(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", _fake_run(calls, BRIDGE_MODELS))

    agent_pi.resolve_model("claude-bridge/claude-opus-4-8", extensions=(BRIDGE_EXT,))
    agent_pi.resolve_model("claude-bridge/claude-opus-4-8", extensions=(BRIDGE_EXT, OTHER_EXT))

    assert len(calls) == 2               # a genuinely different set -> a fresh probe
