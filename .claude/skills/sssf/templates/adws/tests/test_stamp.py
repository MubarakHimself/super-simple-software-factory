"""The stamp is intact - the one test suite a stamped project starts with.

Two jobs, and the second is the reason this file is not optional:

1. It says something true about the project. A stamped factory is a set of
   scripts that only work together: every adws/*.py must carry its own PEP 723
   header (that is what lets `uv run adws/adw_plan.py` resolve dependencies in
   a project with no lockfile), every module those scripts import must be on
   disk, and the roster they all read must parse. Mirror drift - a skill
   version that stamped fewer files than the ADWs import - is exactly what
   this catches, on the box, before a card is dispatched.

2. It keeps `pytest -q adws/tests` GREEN-CAPABLE. adws/engine.py's integration
   gate runs that command against every branch before merging it, and the gate
   is fail-closed: pytest exits 5 ("no tests collected") on an empty directory
   and the gate reads that as RED, forever. A project that deletes this file
   without adding its own stops merging cards.

Add your project's own tests beside this one. Do not leave the directory
empty.
"""

from __future__ import annotations

import importlib
import re
from pathlib import Path

import yaml

ADWS = Path(__file__).resolve().parent.parent
ROOT = ADWS.parent

# The packages the factory's scripts may import but a fresh server does not
# have installed anywhere. A script that imports one of these and does NOT
# declare it inline has nothing to resolve against.
THIRD_PARTY = ("pydantic", "yaml", "rich", "dotenv")


def _top_level_scripts() -> list[Path]:
    return sorted(p for p in ADWS.glob("*.py") if p.name != "__init__.py")


def test_every_script_that_needs_a_pep723_header_has_one() -> None:
    """`uv run adws/<script>.py` resolves the script's OWN dependencies from
    that header, and nothing else does - a stamped project has no lockfile
    covering adws/. A script that imports pydantic without declaring it dies
    with ModuleNotFoundError on a fresh box.

    Stdlib-only scripts (clean.py, ship_report.py) legitimately carry no
    header: `uv run` on them needs nothing to resolve. So the rule is not
    "every script", it is "every script that imports something".
    """
    scripts = _top_level_scripts()
    assert scripts, f"no adws/*.py under {ADWS} - this project was never stamped"
    missing = []
    for path in scripts:
        text = path.read_text(encoding="utf-8")
        imports_third_party = any(
            re.search(rf"^\s*(?:import|from)\s+{name}\b", text, re.MULTILINE)
            for name in THIRD_PARTY
        )
        if imports_third_party and "# /// script" not in text[:2000]:
            missing.append(path.name)
    assert not missing, f"adws/*.py importing a third-party package with no PEP 723 header: {missing}"


def test_the_modules_the_scripts_import_are_on_disk() -> None:
    """Mirror drift check: the ADWs import these by name, and a stamp that
    predates one of them fails at run time on the server, not here."""
    expected = [
        "agent_cc.py", "agent_pi.py", "agents.py", "changes.py", "console.py",
        "data_types.py", "gates.py", "git_helper.py", "permissions.py",
        "prompts.py", "quality.py", "runner.py", "session.py", "tracer.py",
        "utils.py", "worktrees.py",
    ]
    present = {p.name for p in (ADWS / "adw_modules").glob("*.py")}
    missing = [name for name in expected if name not in present]
    assert not missing, f"adws/adw_modules is missing {missing} - re-run the sssf install"


def test_the_core_modules_import_cleanly() -> None:
    """Import-time errors are the expensive kind: they surface as a dead
    systemd unit, not as a failed run. Only the modules that need no
    environment are imported here - agent_pi and everything that imports it
    resolve PI_PATH at import time and belong to a configured host.

    worktrees is on this list because of a real failure (2026-08-18): a project
    stamped by an old skill, re-stamped by a new one, ended up with a NEW
    worktrees.py importing RunWorktree, WorktreeRow, WorktreesConfig and
    WorktreeState from an OLD data_types.py that predated all four. Importing
    each module alone proves nothing about that; worktrees is the module that
    reaches ACROSS files, so importing it is what catches an adws/ tree living
    at two generations at once - on the box, before a card is dispatched. The
    stamp itself now refreshes factory-owned code on every run, which is the
    fix; this is the detector for the day something slips past it.
    """
    for name in ("adw_modules.data_types", "adw_modules.quality",
                 "adw_modules.gates", "adw_modules.git_helper",
                 "adw_modules.tracer", "adw_modules.utils",
                 "adw_modules.worktrees"):
        importlib.import_module(name)


def test_the_roster_parses_and_names_a_default_agent() -> None:
    """Every ADW reads this file; a syntax error in it fails every run."""
    roster = ROOT / "adws" / "adw_sssf_config" / "sssf.config.yaml"
    assert roster.is_file(), f"{roster} is missing - the factory has no agent roster"
    loaded = yaml.safe_load(roster.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict), "the roster must be a YAML mapping"
    defaults = loaded.get("defaults")
    assert isinstance(defaults, dict) and defaults.get("model"), \
        "the roster's `defaults` block must name a model"
    # `agents:` is a LIST of blocks, each with its own `name` - the shape
    # adw_modules/agents.py reads.
    agents = loaded.get("agents")
    assert isinstance(agents, list) and agents, "the roster names no agents"
    unnamed = [i for i, agent in enumerate(agents)
               if not isinstance(agent, dict) or not agent.get("name")]
    assert not unnamed, f"agent block(s) {unnamed} have no `name`"
