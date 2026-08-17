"""defaults.harness_engineering MERGES with each agent's own list (MAP.md
standing rule 3 / the `defaults.harness_engineering:` merge fix).

Before this fix, `agents.load_config` used `agent.setdefault("harness_engineering",
defaults...)`, which only fills in the defaults list when the agent names NONE
of its own - an agent that already lists its own extensions (e.g. planner's
subagents.ts) silently REPLACED the roster-wide defaults instead of gaining
them too. Wiring a roster-wide extension (e.g. pi-claude-bridge, needed by
every claude-bridge lane) into `defaults.harness_engineering` would then
silently vanish for any agent that already had its own list - exactly the
landmine rule 3 calls out. `merge_unique` plus its use in `load_config` is the
fix: union, order-stable, no duplicates, always applied - never a plain
replace.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

from adw_modules import agent_pi, git_helper
from adw_modules import agents as agents_mod

MINIMAL_AGENT = """\
    prompt_engineering:
      system: system.md
      user: user.md
"""

BRIDGE_EXT = "C:/fake/pi-claude-bridge/src/index.ts"
BASE_MODELS = (
    "PROVIDER       MODEL                COUNT\n"
    "ollama-cloud   kimi-k2.7-code       256K\n"
)
BRIDGE_MODELS = BASE_MODELS + "claude-bridge  claude-opus-4-8      200K\n"


def _write_config(tmp_path: Path, body: str) -> str:
    path = tmp_path / "sssf.test.config.yaml"
    path.write_text(body, encoding="utf-8")
    return str(path)


# ── merge_unique: pure logic, no YAML, no config ────────────────────────────

def test_merge_unique_is_union_order_stable_no_duplicates():
    assert agents_mod.merge_unique(["a", "b"], ["b", "c"]) == ["a", "b", "c"]


def test_merge_unique_base_items_always_lead():
    # defaults come first regardless of the agent's own ordering - the roster-
    # wide list is the stable prefix every agent's effective list shares.
    assert agents_mod.merge_unique(["x", "y"], ["z"]) == ["x", "y", "z"]


def test_merge_unique_empty_extra_returns_base_unchanged():
    assert agents_mod.merge_unique(["a", "b"], []) == ["a", "b"]


def test_merge_unique_empty_base_returns_extra_unchanged():
    assert agents_mod.merge_unique([], ["a", "b"]) == ["a", "b"]


def test_merge_unique_full_overlap_dedupes_to_base_order():
    assert agents_mod.merge_unique(["a", "b"], ["b", "a"]) == ["a", "b"]


def test_merge_unique_does_not_mutate_its_inputs():
    base, extra = ["a"], ["b"]
    agents_mod.merge_unique(base, extra)
    assert base == ["a"]
    assert extra == ["b"]


# ── expand_harness_paths: pure logic, no YAML, no config ───────────────────
# The two-box model fix (MAP.md "The two-box model" / installer/steps.py's
# engine-service lane): a per-host, outside-the-repo extension path (e.g.
# PI_BRIDGE_PATH) is never a literal absolute path baked into a config file
# tracked in git. os.path.expandvars covers both `$VAR`/`${VAR}` and, on
# Windows, `%VAR%` - one function call, no platform branching needed here.

def test_expand_harness_paths_expands_a_set_env_var(monkeypatch):
    monkeypatch.setenv("PI_BRIDGE_PATH", "C:/fake/pi-claude-bridge")

    result = agents_mod.expand_harness_paths(["${PI_BRIDGE_PATH}/src/index.ts"])

    assert result == ["C:/fake/pi-claude-bridge/src/index.ts"]


def test_expand_harness_paths_leaves_an_unresolved_var_verbatim(monkeypatch):
    monkeypatch.delenv("SOME_UNSET_VAR_XYZ", raising=False)

    result = agents_mod.expand_harness_paths(["${SOME_UNSET_VAR_XYZ}/src/index.ts"])

    # expandvars' own documented behavior for a name that is not in
    # os.environ: left exactly as written, not blanked, not raised - this is
    # the literal, nonexistent path that must fail LOUD downstream at
    # validate() time (see the validate() tests below), never silently here.
    assert result == ["${SOME_UNSET_VAR_XYZ}/src/index.ts"]


def test_expand_harness_paths_expands_user_home(monkeypatch):
    monkeypatch.setattr(os.path, "expanduser", lambda p: p.replace("~", "C:/fake/home", 1))

    result = agents_mod.expand_harness_paths(["~/ext.ts"])

    assert result == ["C:/fake/home/ext.ts"]


def test_expand_harness_paths_expands_vars_before_user_home(monkeypatch):
    # Order matters: an env var whose OWN value starts with ~ must still get
    # the ~ expanded - proves expandvars runs first, expanduser second.
    monkeypatch.setenv("EXT_HOME", "~/ext-root")
    monkeypatch.setattr(os.path, "expanduser", lambda p: p.replace("~", "C:/fake/home", 1))

    result = agents_mod.expand_harness_paths(["${EXT_HOME}/index.ts"])

    assert result == ["C:/fake/home/ext-root/index.ts"]


def test_expand_harness_paths_passes_through_a_plain_relative_path_unchanged():
    result = agents_mod.expand_harness_paths(["adws/adw_data/harness_engineering/subagents.ts"])
    assert result == ["adws/adw_data/harness_engineering/subagents.ts"]


def test_expand_harness_paths_empty_list_returns_empty_list():
    assert agents_mod.expand_harness_paths([]) == []


# ── load_config: the composition site, real YAML through the real loader ───

def test_load_config_agent_without_its_own_list_gets_the_defaults(tmp_path):
    config_path = _write_config(tmp_path, f"""\
defaults:
  harness_engineering:
    - ext_a.ts
    - ext_b.ts
agents:
  - name: scout
{MINIMAL_AGENT}""")

    cfg = agents_mod.load_config(config_path)

    assert cfg.agents[0].harness_engineering == ["ext_a.ts", "ext_b.ts"]


def test_load_config_agent_with_own_list_merges_not_replaces(tmp_path):
    # THE regression case: before the fix, planner-style agents (their own
    # non-empty harness_engineering) silently dropped the defaults list
    # entirely instead of gaining it. This is wiring pi-claude-bridge into
    # defaults.harness_engineering while planner keeps naming subagents.ts -
    # the reviewer's new extension must not vanish for planner.
    config_path = _write_config(tmp_path, f"""\
defaults:
  harness_engineering:
    - pi-claude-bridge/src/index.ts
agents:
  - name: planner
    harness_engineering:
      - subagents.ts
{MINIMAL_AGENT}""")

    cfg = agents_mod.load_config(config_path)

    assert cfg.agents[0].harness_engineering == [
        "pi-claude-bridge/src/index.ts", "subagents.ts",
    ]


def test_load_config_merge_dedupes_an_item_named_in_both_lists(tmp_path):
    config_path = _write_config(tmp_path, f"""\
defaults:
  harness_engineering:
    - shared.ts
    - only_default.ts
agents:
  - name: reviewer
    harness_engineering:
      - shared.ts
      - only_agent.ts
{MINIMAL_AGENT}""")

    cfg = agents_mod.load_config(config_path)

    assert cfg.agents[0].harness_engineering == [
        "shared.ts", "only_default.ts", "only_agent.ts",
    ]


def test_load_config_agent_explicit_empty_list_still_gets_defaults(tmp_path):
    # An agent cannot opt OUT of a roster-wide extension by writing `[]` -
    # merge is unconditional, matching how `defaults.harness_engineering` is
    # documented (roster-wide, not an agent-declinable suggestion).
    config_path = _write_config(tmp_path, f"""\
defaults:
  harness_engineering:
    - ext_a.ts
agents:
  - name: builder
    harness_engineering: []
{MINIMAL_AGENT}""")

    cfg = agents_mod.load_config(config_path)

    assert cfg.agents[0].harness_engineering == ["ext_a.ts"]


def test_load_config_no_defaults_harness_engineering_keeps_agents_own_list(tmp_path):
    config_path = _write_config(tmp_path, f"""\
agents:
  - name: planner
    harness_engineering:
      - subagents.ts
{MINIMAL_AGENT}""")

    cfg = agents_mod.load_config(config_path)

    assert cfg.agents[0].harness_engineering == ["subagents.ts"]


def test_load_config_no_harness_engineering_anywhere_is_empty_list(tmp_path):
    config_path = _write_config(tmp_path, f"""\
agents:
  - name: documenter
{MINIMAL_AGENT}""")

    cfg = agents_mod.load_config(config_path)

    assert cfg.agents[0].harness_engineering == []


def test_load_config_merge_is_independent_per_agent(tmp_path):
    # Two agents in the same config, one with its own list and one without -
    # each gets its own correctly-merged result, not a shared/mutated list.
    config_path = _write_config(tmp_path, f"""\
defaults:
  harness_engineering:
    - roster_wide.ts
agents:
  - name: planner
    harness_engineering:
      - subagents.ts
{MINIMAL_AGENT}
  - name: scout
{MINIMAL_AGENT}""")

    cfg = agents_mod.load_config(config_path)

    planner = next(a for a in cfg.agents if a.name == "planner")
    scout = next(a for a in cfg.agents if a.name == "scout")
    assert planner.harness_engineering == ["roster_wide.ts", "subagents.ts"]
    assert scout.harness_engineering == ["roster_wide.ts"]


# ── load_config: expand_harness_paths applied at the real composition site ──
# The regression this closes: sssf.shipping.config.yaml names
# `${PI_BRIDGE_PATH}/src/index.ts` (never a literal per-laptop path baked
# into a file tracked in git) - load_config must expand it, for BOTH
# defaults.harness_engineering and an agent's own list, before merge_unique
# ever sees it.

def test_load_config_expands_an_env_var_in_defaults_harness_engineering(tmp_path, monkeypatch):
    monkeypatch.setenv("PI_BRIDGE_PATH", "C:/fake/pi-claude-bridge")
    config_path = _write_config(tmp_path, f"""\
defaults:
  harness_engineering:
    - ${{PI_BRIDGE_PATH}}/src/index.ts
agents:
  - name: scout
{MINIMAL_AGENT}""")

    cfg = agents_mod.load_config(config_path)

    assert cfg.agents[0].harness_engineering == ["C:/fake/pi-claude-bridge/src/index.ts"]


def test_load_config_expands_an_env_var_in_an_agents_own_harness_engineering(tmp_path, monkeypatch):
    monkeypatch.setenv("EXT_HOME", "C:/fake/ext")
    config_path = _write_config(tmp_path, f"""\
agents:
  - name: planner
    harness_engineering:
      - ${{EXT_HOME}}/subagents.ts
{MINIMAL_AGENT}""")

    cfg = agents_mod.load_config(config_path)

    assert cfg.agents[0].harness_engineering == ["C:/fake/ext/subagents.ts"]


def test_load_config_leaves_an_unresolved_env_var_verbatim_not_blank(tmp_path, monkeypatch):
    monkeypatch.delenv("SOME_UNSET_VAR_XYZ", raising=False)
    config_path = _write_config(tmp_path, f"""\
defaults:
  harness_engineering:
    - ${{SOME_UNSET_VAR_XYZ}}/src/index.ts
agents:
  - name: reviewer
{MINIMAL_AGENT}""")

    cfg = agents_mod.load_config(config_path)

    assert cfg.agents[0].harness_engineering == ["${SOME_UNSET_VAR_XYZ}/src/index.ts"]


# ── validate(): the actual reported bug, end to end ─────────────────────────
# validate() -> agent_pi.resolve_model() -> _pi_catalog() used to shell
# `pi -ne --list-models` with NO extensions, ever - so a claude-bridge/*
# model (registered only once pi-claude-bridge loads) was structurally
# invisible, and validate() SystemExits a shipping config that is actually
# fine. The fix threads an agent's own MERGED harness_engineering (composed
# by load_config's merge_unique, tested above) into the catalog probe as
# explicit -e flags. No real pi process runs - subprocess.run is mocked.

def test_validate_resolves_a_bridge_model_via_its_merged_extensions(tmp_path, monkeypatch):
    system_md, user_md = tmp_path / "system.md", tmp_path / "user.md"
    system_md.write_text("system", encoding="utf-8")
    user_md.write_text("user", encoding="utf-8")

    config_path = _write_config(tmp_path, f"""\
defaults:
  harness_engineering:
    - {BRIDGE_EXT}
agents:
  - name: reviewer
    model: claude-bridge/claude-opus-4-8
    prompt_engineering:
      system: {system_md.as_posix()}
      user: {user_md.as_posix()}
""")

    calls: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        stdout = BRIDGE_MODELS if BRIDGE_EXT in cmd else BASE_MODELS
        return SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    agent_pi._pi_catalog.cache_clear()
    monkeypatch.setattr(subprocess, "run", fake_run)
    try:
        cfg = agents_mod.load_config(config_path)
        agents_mod.validate(cfg, ["reviewer"])   # must NOT raise SystemExit
    finally:
        agent_pi._pi_catalog.cache_clear()

    assert calls, "resolve_model never shelled pi"
    assert BRIDGE_EXT in calls[0]                # the merged extension rode along as -e


def test_validate_without_the_bridge_extension_still_systemexits(tmp_path, monkeypatch):
    """Control: a bridge model with NO extension merged in is still, correctly,
    an unresolvable config - the fix widens what the probe can SEE, it does
    not make validate() stop checking."""
    system_md, user_md = tmp_path / "system.md", tmp_path / "user.md"
    system_md.write_text("system", encoding="utf-8")
    user_md.write_text("user", encoding="utf-8")

    config_path = _write_config(tmp_path, f"""\
agents:
  - name: reviewer
    model: claude-bridge/claude-opus-4-8
    prompt_engineering:
      system: {system_md.as_posix()}
      user: {user_md.as_posix()}
""")

    agent_pi._pi_catalog.cache_clear()
    monkeypatch.setattr(subprocess, "run",
                        lambda cmd, **kwargs: SimpleNamespace(returncode=0, stdout=BASE_MODELS, stderr=""))
    try:
        cfg = agents_mod.load_config(config_path)
        try:
            agents_mod.validate(cfg, ["reviewer"])
            raised = False
        except SystemExit:
            raised = True
    finally:
        agent_pi._pi_catalog.cache_clear()

    assert raised


# ── validate(): the same round trip, but through a ${VAR} extension path ───
# The installer-wizard fix (sssf.shipping.config.yaml now names
# `${PI_BRIDGE_PATH}/src/index.ts`, never a literal per-laptop path): the
# resolved-env-var case must behave EXACTLY like the literal-path case above
# (test_validate_resolves_a_bridge_model_via_its_merged_extensions), and the
# unresolved case must SystemExit exactly like naming no extension at all
# (test_validate_without_the_bridge_extension_still_systemexits) - the
# requirement that the current SystemExit behavior "stays".

def test_validate_resolves_a_bridge_model_via_an_expanded_env_var_extension(tmp_path, monkeypatch):
    system_md, user_md = tmp_path / "system.md", tmp_path / "user.md"
    system_md.write_text("system", encoding="utf-8")
    user_md.write_text("user", encoding="utf-8")
    monkeypatch.setenv("PI_BRIDGE_PATH", "C:/fake/pi-claude-bridge")

    config_path = _write_config(tmp_path, f"""\
defaults:
  harness_engineering:
    - ${{PI_BRIDGE_PATH}}/src/index.ts
agents:
  - name: reviewer
    model: claude-bridge/claude-opus-4-8
    prompt_engineering:
      system: {system_md.as_posix()}
      user: {user_md.as_posix()}
""")

    calls: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        stdout = BRIDGE_MODELS if BRIDGE_EXT in cmd else BASE_MODELS
        return SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    agent_pi._pi_catalog.cache_clear()
    monkeypatch.setattr(subprocess, "run", fake_run)
    try:
        cfg = agents_mod.load_config(config_path)
        agents_mod.validate(cfg, ["reviewer"])   # must NOT raise SystemExit
    finally:
        agent_pi._pi_catalog.cache_clear()

    assert calls, "resolve_model never shelled pi"
    assert BRIDGE_EXT in calls[0]   # ${PI_BRIDGE_PATH} expanded to the real path before the -e flag


def test_validate_still_systemexits_when_the_harness_engineering_env_var_is_unresolved(
        tmp_path, monkeypatch):
    """The requirement, stated directly: an unresolved ${VAR} (expandvars
    leaves it verbatim - see expand_harness_paths above) must still fail LOUD
    at validate() - the SAME SystemExit behavior as naming no extension at
    all, just reached via a different kind of bad path (a literal
    "${VAR}/..." string that matches no real pi extension)."""
    system_md, user_md = tmp_path / "system.md", tmp_path / "user.md"
    system_md.write_text("system", encoding="utf-8")
    user_md.write_text("user", encoding="utf-8")
    monkeypatch.delenv("SOME_UNSET_VAR_XYZ", raising=False)

    config_path = _write_config(tmp_path, f"""\
defaults:
  harness_engineering:
    - ${{SOME_UNSET_VAR_XYZ}}/src/index.ts
agents:
  - name: reviewer
    model: claude-bridge/claude-opus-4-8
    prompt_engineering:
      system: {system_md.as_posix()}
      user: {user_md.as_posix()}
""")

    agent_pi._pi_catalog.cache_clear()
    monkeypatch.setattr(subprocess, "run",
                        lambda cmd, **kwargs: SimpleNamespace(returncode=0, stdout=BASE_MODELS, stderr=""))
    try:
        cfg = agents_mod.load_config(config_path)
        try:
            agents_mod.validate(cfg, ["reviewer"])
            raised = False
        except SystemExit:
            raised = True
    finally:
        agent_pi._pi_catalog.cache_clear()

    assert raised


# ── $SSSF_INTEGRATION_BRANCH reaches the RUN side ───────────────────────────
# specs/engine.md 2: "the worktree and dispatch side read the same variable".
# They did not. `engine.py`, `adws/worktrees.py` and `quality.ai_defects` all
# resolve the trunk through the env-aware `git_helper.factory_trunk()`, while
# everything loaded from `load_config` read `worktrees.trunk` literally off the
# roster - so setting the variable split the factory in two: runs cut from (and
# measured against) a stale `integration` while the engine merged into the
# branch the variable named. Inert at the defaults, and a quiet bifurcation the
# day the documented configuration was used.

TRUNK_CONFIG = """\
defaults:
  model: ollama-cloud/kimi-k2.7-code
worktrees:
  trunk: integration
agents:
  - name: builder
""" + MINIMAL_AGENT

NO_WORKTREES_CONFIG = """\
defaults:
  model: ollama-cloud/kimi-k2.7-code
agents:
  - name: builder
""" + MINIMAL_AGENT


def test_load_config_applies_the_integration_branch_env_over_the_roster(tmp_path, monkeypatch):
    monkeypatch.setenv(git_helper.FACTORY_TRUNK_ENV, "night-line")

    cfg = agents_mod.load_config(_write_config(tmp_path, TRUNK_CONFIG))

    assert cfg.worktrees.trunk == "night-line"
    assert cfg.worktrees.trunk == git_helper.factory_trunk()   # one answer, not two


def test_load_config_adds_a_worktrees_block_when_the_roster_has_none(tmp_path, monkeypatch):
    monkeypatch.setenv(git_helper.FACTORY_TRUNK_ENV, "night-line")

    cfg = agents_mod.load_config(_write_config(tmp_path, NO_WORKTREES_CONFIG))

    assert cfg.worktrees.trunk == "night-line"


def test_load_config_leaves_the_rosters_own_trunk_alone_when_the_env_says_nothing(
        tmp_path, monkeypatch):
    """Unset and EMPTY both mean "the file has the last word" - not
    `factory_trunk()`'s default, which would quietly overwrite a roster that
    deliberately names another line."""
    for value in (None, "", "   "):
        if value is None:
            monkeypatch.delenv(git_helper.FACTORY_TRUNK_ENV, raising=False)
        else:
            monkeypatch.setenv(git_helper.FACTORY_TRUNK_ENV, value)

        cfg = agents_mod.load_config(_write_config(
            tmp_path, TRUNK_CONFIG.replace("trunk: integration", "trunk: house-line")))

        assert cfg.worktrees.trunk == "house-line"
