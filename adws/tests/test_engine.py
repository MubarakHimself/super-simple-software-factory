"""Hermetic tests for the engine — the always-on worker that runs the Kanban
by itself (adws/engine.py, specs/engine.md).

Real temp git repos under `tmp_path` with a real LOCAL bare origin, real `git`
(already a hard dependency of this suite — see test_worktrees.py), so the pull /
rebase / merge / commit / push protocol is exercised for real rather than
mocked. Nothing here touches the network, the operator's own repo, `uv`, pi, or
a model: the two outside-world seams (`engine.dispatch_command`,
`engine.quality_commands`) are pointed at stand-ins — a tiny script that makes
exactly the write-backs, branch and worktree a real dispatch+ADW would, and a
one-line python process standing in for the deterministic suite.

The repos are shaped like the factory after MAP.md's 2026-08-15 ruling: `main`
exists and never moves (it is human-owned), `integration` is the living line
the engine pulls, pushes, merges runs into, and parks cards on.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import dispatch
import engine
import pytest
from adw_modules import git_helper, worktrees

# The stand-in for `uv run adws/dispatch.py` AND the ADW below it: the same
# card write-backs (ready-for-agent -> running -> done|blocked), the same
# Adw-Id: claim, and — when it is given work to do — the same branch + worktree
# + commit a real run leaves behind. None of the machinery.
#   argv: <card> <mode> <exit code> <marks dir> <release file> [<work>]
#   modes: done|blocked (claim then finish), hold (claim, then wait for the
#          release file — a run that is still going), refuse (touch nothing and
#          exit, dispatch's own exit-2 refusal path).
#   work:  "" (a run that commits nothing) or "<file>:<content>" pairs joined
#          by "|" — written and committed on this run's own branch, in this
#          run's own worktree, cut from `integration` exactly as
#          `worktrees.ensure_run_worktree` cuts it.
# The adw_id is the card's NNN prefix, so a test can name the branch it expects.
# Every invocation appends a line to <marks>/<card name>, so a test can count
# how many times a card was actually dispatched.
FAKE_DISPATCH = '''"""Stand-in for adws/dispatch.py used by test_engine.py."""
import subprocess
import sys
import time
from pathlib import Path

card = Path(sys.argv[1])
mode = sys.argv[2]
code = int(sys.argv[3])
marks = Path(sys.argv[4])
release = Path(sys.argv[5])
work = sys.argv[6] if len(sys.argv) > 6 else ""

root = Path.cwd()                      # the engine spawns dispatch in the main checkout
adw_id = card.stem.split("-")[0]
slug = card.stem.split("-", 1)[1] if "-" in card.stem else "run"

marks.mkdir(parents=True, exist_ok=True)
with (marks / card.name).open("a", encoding="utf-8") as handle:
    handle.write(mode + "\\n")


def git(*args, cwd=None):
    result = subprocess.run(["git", *args], cwd=str(cwd or root), capture_output=True,
                            text=True, encoding="utf-8")
    if result.returncode != 0:
        raise SystemExit("fake dispatch: git " + " ".join(args) + " failed: " + result.stderr)


def set_field(key, value):
    lines = card.read_text(encoding="utf-8").split("\\n")
    card.write_text("\\n".join(
        (key + ": " + value) if line.startswith(key + ":") else line
        for line in lines), encoding="utf-8")


if mode == "refuse":
    sys.exit(code)

set_field("Adw-Id", adw_id)
set_field("Status", "running")

if work:
    branch = "adw/" + adw_id + "_" + slug
    tree = root.parent / "wt" / (adw_id + "_" + slug)
    git("worktree", "add", "-b", branch, str(tree), "integration")
    for item in work.split("|"):
        name, _, content = item.partition(":")
        (tree / name).write_text(content + "\\n", encoding="utf-8")
    git("add", "-A", cwd=tree)
    git("commit", "-m", "run " + adw_id + ": " + slug, cwd=tree)

if mode == "hold":
    deadline = time.time() + 60
    while not release.exists() and time.time() < deadline:
        time.sleep(0.05)
set_field("Status", "done" if code == 0 else "blocked")
sys.exit(code)
'''

# The stand-in for the integration gate's suite: records the directory it ran
# in (so a test can prove the gate judged the REBASED worktree, not the main
# checkout) and exits with whatever the test asked for.
FAKE_GATE = ("import os, sys, pathlib; "
             "pathlib.Path(sys.argv[1]).open('a', encoding='utf-8')"
             ".write(os.getcwd() + '\\n'); "
             "sys.exit(int(sys.argv[2]))")

# A roster in the shape `agents.load_config` reads, cut down to what the engine
# itself looks at: the `provider/model` strings whose prefixes ARE the lanes.
ROSTER = """defaults:
  coding_agent: pi
  model: ollama-cloud/kimi-k2.7-code
agents:
  - name: builder
  - name: reviewer
    model: xai/grok-4.5
"""

BODY = """## Agent Brief

**Category:** enhancement
**Summary:** one line
**Acceptance criteria:**
- [ ] first observable, testable condition
**Out of scope:** what this ticket deliberately does not do
"""


def _card(status: str = dispatch.READY, needs: str | None = None,
          title: str = "Add a /health endpoint") -> str:
    """A card in queue/TEMPLATE.md's exact shape (`needs=None` omits the line)."""
    header = [f"Status: {status}", "Adw: simple-sdlc", "Adw-Id:",
              "Created: 2026-08-14", "Context:"]
    if needs is not None:
        header.append(f"Needs: {needs}")
    return f"# {title}\n\n" + "\n".join(header) + "\n\n" + BODY


def _git(*args: str, cwd: Path) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                            encoding="utf-8", check=False)
    assert result.returncode == 0, f"git {' '.join(args)} failed: {result.stderr}"
    return result.stdout.strip()


@pytest.fixture
def factory(tmp_path):
    """A main checkout with a queue, wired to a LOCAL bare origin — the two-box
    model's transport, in miniature. No network: `origin` is a directory.

    Both lines exist, as they do on the real server: `main` (human-owned, one
    squash per chunk, never written by the factory) and `integration` (the
    living line, checked out, tracking the hub).
    """
    origin = tmp_path / "origin.git"
    origin.mkdir()
    _git("init", "-q", "--bare", "-b", "main", cwd=origin)

    root = tmp_path / "main"
    root.mkdir()
    _git("init", "-q", "-b", "main", cwd=root)
    for key, value in (("user.email", "engine@example.com"), ("user.name", "Engine Test"),
                       ("commit.gpgsign", "false"), ("core.autocrlf", "false")):
        _git("config", key, value, cwd=root)
    (root / "queue" / "done").mkdir(parents=True)
    (root / "README.md").write_text("engine test\n", encoding="utf-8")
    _git("add", "-A", cwd=root)
    _git("commit", "-q", "-m", "init", cwd=root)
    _git("remote", "add", "origin", origin.as_posix(), cwd=root)
    _git("push", "-q", "-u", "origin", "main", cwd=root)
    _git("checkout", "-q", "-b", "integration", cwd=root)
    _git("push", "-q", "-u", "origin", "integration", cwd=root)

    fake = tmp_path / "fake_dispatch.py"
    fake.write_text(FAKE_DISPATCH, encoding="utf-8")
    roster = tmp_path / "roster.yaml"
    roster.write_text(ROSTER, encoding="utf-8")

    return SimpleNamespace(root=root, origin=origin, queue=root / "queue", fake=fake,
                           roster=roster, marks=tmp_path / "marks",
                           release=tmp_path / "release", gate=tmp_path / "gate.log")


@pytest.fixture
def eng(factory):
    """An engine pointed at the fixture repo. Any child still alive when the
    test ends is killed here — `hold` runs would otherwise linger."""
    instance = engine.Engine(main_root=factory.root, queue_dir=factory.queue,
                             config=str(factory.roster), cap=2)
    yield instance
    for child in instance.children:
        if child.process.poll() is None:
            child.process.kill()
            child.process.wait(timeout=30)


def _use_fake(monkeypatch, factory, mode: str = "done", code: int = 0,
              work: str | dict[str, str] | None = None) -> None:
    """Point the dispatch seam at the stand-in script. `work` is one spec for
    every card, or a per-card mapping (that is how two runs are made to collide
    on the same file, or deliberately not to)."""
    def command(_engine, card: Path) -> list[str]:
        spec = work.get(card.name, "") if isinstance(work, dict) else (work or "")
        return [sys.executable, str(factory.fake), str(card), mode, str(code),
                str(factory.marks), str(factory.release), spec]
    monkeypatch.setattr(engine, "dispatch_command", command)


def _use_gate(monkeypatch, factory, green: bool = True, missing: bool = False) -> None:
    """Point the quality seam at the stand-in. `missing=True` is the fail-closed
    case: a suite that cannot run at all."""
    def commands(_engine, tree: Path) -> list[list[str]]:
        if missing:
            return [["sdl-factory-no-such-tool-anywhere"]]
        return [[sys.executable, "-c", FAKE_GATE, str(factory.gate), "0" if green else "1"]]
    monkeypatch.setattr(engine, "quality_commands", commands)


def _gate_ran_in(factory) -> list[Path]:
    """Every directory the gate's suite actually ran in, in order."""
    if not factory.gate.is_file():
        return []
    return [Path(line).resolve()
            for line in factory.gate.read_text(encoding="utf-8").splitlines() if line.strip()]


def _publish(factory, name: str, text: str) -> Path:
    """What the laptop does: write the card and commit it (queue-publish)."""
    path = factory.queue / name
    path.write_text(text, encoding="utf-8")
    _git("add", "--", f"queue/{name}", cwd=factory.root)
    _git("commit", "-q", "-m", f"publish {name}", cwd=factory.root)
    return path


def _laptop(factory) -> Path:
    """The OTHER box: a second clone of the same bare origin, on `integration`
    like every other worker on the living line. Everything the laptop does to
    the hub - publishing a card, an operator moving one by hand - happens here,
    which is how the two-box model's divergence gets into these tests without a
    network or a second machine."""
    path = factory.origin.parent / "laptop"
    if not path.exists():
        _git("clone", "-q", factory.origin.as_posix(), path.as_posix(),
             cwd=factory.origin.parent)
        for key, value in (("user.email", "laptop@example.com"), ("user.name", "Laptop Test"),
                           ("commit.gpgsign", "false"), ("core.autocrlf", "false")):
            _git("config", key, value, cwd=path)
        _git("checkout", "-q", "integration", cwd=path)
    return path


def _laptop_publishes(factory, name: str, text: str) -> None:
    """queue-publish from the laptop: the card lands at the hub, not here."""
    laptop = _laptop(factory)
    (laptop / "queue").mkdir(parents=True, exist_ok=True)
    (laptop / "queue" / name).write_text(text, encoding="utf-8")
    _git("add", "--", f"queue/{name}", cwd=laptop)
    _git("commit", "-q", "-m", f"publish {name}", cwd=laptop)
    _git("push", "-q", "origin", "integration", cwd=laptop)


def _laptop_parks(factory, name: str) -> None:
    """A HUMAN moving a card to queue/done/ at the hub. Parking is the ENGINE's
    job now (MAP.md 2026-08-15) - this is here for the one thing it still
    proves: when the hub and this server both changed the same card file, the
    hub's version wins and the service does not wedge."""
    laptop = _laptop(factory)
    _git("pull", "-q", "--ff-only", cwd=laptop)
    (laptop / "queue" / "done").mkdir(parents=True, exist_ok=True)
    _git("mv", f"queue/{name}", f"queue/done/{name}", cwd=laptop)
    _git("commit", "-q", "-m", f"operator: parked {name}", cwd=laptop)
    _git("push", "-q", "origin", "integration", cwd=laptop)


def _forget_integration(factory) -> None:
    """Rewind the world to before the integration branch existed: a checkout on
    `main` only, and a hub that has never seen the factory's working line."""
    _git("checkout", "-q", "main", cwd=factory.root)
    _git("branch", "-d", "integration", cwd=factory.root)
    _git("update-ref", "-d", "refs/remotes/origin/integration", cwd=factory.root)
    _git("update-ref", "-d", "refs/heads/integration", cwd=factory.origin)


def _origin_log(factory, branch: str = "integration") -> list[str]:
    return _git("log", "--format=%s", branch, cwd=factory.origin).splitlines()


def _origin_file(factory, path: str, branch: str = "integration") -> str:
    return _git("show", f"{branch}:{path}", cwd=factory.origin)


def _origin_card(factory, name: str) -> str:
    return _origin_file(factory, f"queue/{name}")


def _names(instance: engine.Engine) -> list[str]:
    return [child.card.name for child in instance.children]


def _wait_for_children(instance: engine.Engine, timeout: float = 60.0) -> None:
    for child in instance.children:
        child.process.wait(timeout=timeout)


def _marks(factory, name: str) -> list[str]:
    path = factory.marks / name
    if not path.is_file():
        return []
    return path.read_text(encoding="utf-8").split()


# ── the working line: integration, never main ───────────────────────────────

def test_the_engine_creates_checks_out_and_publishes_integration(factory, eng, capsys):
    """A checkout that has never seen the factory's working line: cut it from
    `main`, publish it, and only then do anything else - every commit this
    engine makes belongs on that branch and nowhere else."""
    _forget_integration(factory)
    _publish(factory, "001-first.md", _card())      # published on main, as it would be

    assert engine.ensure_trunk(eng) is True

    assert _git("rev-parse", "--abbrev-ref", "HEAD", cwd=factory.root) == "integration"
    assert _git("rev-parse", "integration", cwd=factory.origin) == \
           _git("rev-parse", "integration", cwd=factory.root)      # published to the hub
    out = capsys.readouterr().out
    assert "on integration: created from main" in out
    assert "published integration" in out


def test_a_checkout_left_on_another_branch_is_put_back_on_integration(factory, eng):
    _git("checkout", "-q", "main", cwd=factory.root)

    assert engine.ensure_trunk(eng) is True
    assert _git("rev-parse", "--abbrev-ref", "HEAD", cwd=factory.root) == "integration"


def test_main_never_moves(factory, eng, monkeypatch):
    """The whole point of the two-branch model: the factory ships a card end to
    end and `main` is exactly where the operator left it."""
    _use_fake(monkeypatch, factory, mode="done", work="feature.txt:one")
    _use_gate(monkeypatch, factory)
    before = _git("rev-parse", "main", cwd=factory.origin)
    _publish(factory, "001-first.md", _card())

    engine.run_cycle(eng)
    _wait_for_children(eng)
    engine.run_cycle(eng)

    assert (factory.queue / "done" / "001-first.md").is_file()      # it really shipped
    assert _git("rev-parse", "main", cwd=factory.origin) == before
    assert _origin_log(factory, "main") == ["init"]


# ── the scan: what is dispatchable at all ───────────────────────────────────

def test_ready_cards_are_oldest_first_and_skip_everything_not_dispatchable(factory, eng):
    _publish(factory, "003-third.md", _card())
    _publish(factory, "002-blocked.md", _card(status=dispatch.BLOCKED))
    _publish(factory, "001-first.md", _card())
    _publish(factory, "TEMPLATE.md", _card())            # the template is not a card
    (factory.queue / "done").mkdir(exist_ok=True)
    (factory.queue / "done" / "000-merged.md").write_text(_card(), encoding="utf-8")

    assert [p.name for p in engine.ready_cards(eng)] == ["001-first.md", "003-third.md"]


def test_a_card_with_unmet_needs_is_held_and_named_once(factory, eng, capsys):
    _publish(factory, "001-auth-model.md", _card())
    _publish(factory, "002-billing.md", _card(needs="001-auth-model.md"))

    assert [p.name for p in engine.ready_cards(eng)] == ["001-auth-model.md"]
    out = capsys.readouterr().out
    assert "002-billing.md" in out and "waiting on: 001-auth-model.md" in out

    # Same unmet edge on the next scan -> said once, not once a minute.
    engine.ready_cards(eng)
    assert capsys.readouterr().out == ""

    # Finishing is not enough: `done` means the ADW pushed its own branch, and
    # the dependent would still cut its worktree from an integration without
    # that work in it. Only the integrate step's parking opens the gate.
    (factory.queue / "001-auth-model.md").write_text(
        _card(status=dispatch.DONE), encoding="utf-8")
    assert [p.name for p in engine.ready_cards(eng)] == []

    (factory.queue / "done" / "001-auth-model.md").write_text(
        _card(status=dispatch.DONE), encoding="utf-8")
    (factory.queue / "001-auth-model.md").unlink()
    assert [p.name for p in engine.ready_cards(eng)] == ["002-billing.md"]


def test_a_card_already_held_by_a_live_child_is_never_scanned_up_twice(factory, eng, monkeypatch):
    """Between spawn and dispatch's own claim write-back the card still reads
    ready-for-agent on disk — a scan in that window must not dispatch it again."""
    _use_fake(monkeypatch, factory, mode="hold")
    card = _publish(factory, "001-first.md", _card())

    engine.spawn(eng, card)
    assert engine.ready_cards(eng) == []


# ── the cap ─────────────────────────────────────────────────────────────────

def test_the_cap_bounds_how_many_run_at_once_and_the_next_card_waits(factory, eng, monkeypatch):
    _use_fake(monkeypatch, factory, mode="hold")
    for name in ("001-first.md", "002-second.md", "003-third.md"):
        _publish(factory, name, _card())
    eng.cap = 2

    engine.run_cycle(eng)
    assert _names(eng) == ["001-first.md", "002-second.md"]   # oldest NNN first

    engine.run_cycle(eng)                                     # still full
    assert _names(eng) == ["001-first.md", "002-second.md"]
    assert _marks(factory, "003-third.md") == []

    factory.release.write_text("go\n", encoding="utf-8")      # let both finish
    _wait_for_children(eng)
    engine.run_cycle(eng)

    assert _names(eng) == ["003-third.md"]
    assert _marks(factory, "003-third.md") == ["hold"]


# ── lanes: one provider account = one lane = one quota pool ─────────────────

def test_roster_lanes_are_the_distinct_provider_prefixes_of_its_models(factory):
    assert engine.roster_lanes(factory.roster) == ("ollama-cloud", "xai")


def test_a_roster_that_cannot_be_read_leaves_lane_slots_unenforced(tmp_path, capsys):
    instance = engine.Engine(main_root=tmp_path, queue_dir=tmp_path / "queue",
                             config=str(tmp_path / "nope.yaml"))
    engine.resolve_lanes(instance)

    assert instance.lanes == ()
    assert engine.full_lane(instance) is None
    assert "lane slots not enforced" in capsys.readouterr().out


def test_an_override_for_a_lane_the_roster_does_not_use_is_named_and_ignored(factory, capsys):
    instance = engine.Engine(main_root=factory.root, queue_dir=factory.queue,
                             config=str(factory.roster), lane_overrides={"nowhere": 1})
    engine.resolve_lanes(instance)

    assert instance.lane_slots == {"ollama-cloud": 2, "xai": 2}
    assert "--lanes names nowhere" in capsys.readouterr().out


def test_parse_lanes_reads_the_operators_shorthand_and_refuses_the_rest():
    assert engine.parse_lanes("xai=2,opencode-go=1") == {"xai": 2, "opencode-go": 1}
    assert engine.parse_lanes("  xai = 3 ") == {"xai": 3}
    assert engine.parse_lanes("") == {}
    for bad in ("xai", "xai=", "=2", "xai=two", "xai=0"):
        with pytest.raises(ValueError):
            engine.parse_lanes(bad)


def test_two_slots_per_lane_is_the_default_and_the_third_card_holds(
        factory, eng, monkeypatch, capsys):
    """The cap is deliberately out of the way here (5) - what holds the third
    card is the LANE, and it says so."""
    _use_fake(monkeypatch, factory, mode="hold")
    for name in ("001-first.md", "002-second.md", "003-third.md"):
        _publish(factory, name, _card())
    eng.cap = 5

    engine.run_cycle(eng)

    assert _names(eng) == ["001-first.md", "002-second.md"]
    assert eng.lane_slots == {"ollama-cloud": 2, "xai": 2}
    out = capsys.readouterr().out
    assert "holding 003-third.md: waiting for lane: ollama-cloud (0 free of 2)" in out

    engine.run_cycle(eng)                          # the hold is said once, not per cycle
    assert "waiting for lane" not in capsys.readouterr().out


def test_a_lane_override_narrows_it_and_the_slot_is_released_when_a_run_is_reaped(
        factory, eng, monkeypatch, capsys):
    _use_fake(monkeypatch, factory, mode="hold")
    _publish(factory, "001-first.md", _card())
    _publish(factory, "002-second.md", _card())
    eng.cap = 5
    eng.lane_overrides = {"xai": 1}

    engine.run_cycle(eng)

    assert _names(eng) == ["001-first.md"]
    assert eng.lane_slots == {"ollama-cloud": 2, "xai": 1}
    assert "holding 002-second.md: waiting for lane: xai (0 free of 1)" in capsys.readouterr().out

    factory.release.write_text("go\n", encoding="utf-8")
    _wait_for_children(eng)
    engine.run_cycle(eng)                          # 001 reaped -> its slot comes back

    assert _names(eng) == ["002-second.md"]


# ── the status protocol: claim, then terminal, each committed and pushed ────

def test_the_claim_is_committed_and_pushed_in_the_same_cycle(factory, eng, monkeypatch):
    _use_fake(monkeypatch, factory, mode="hold")
    _publish(factory, "001-first.md", _card())

    engine.run_cycle(eng)

    assert _origin_log(factory)[0] == "factory: 001-first.md -> running"
    assert "Status: running" in _origin_card(factory, "001-first.md")
    assert eng.pending_push is False


def test_a_done_card_that_names_no_branch_is_blocked_rather_than_left_in_the_queue(
        factory, eng, monkeypatch):
    """A card at `done` whose `Adw-Id:` names no branch anywhere in the
    checkout. There is nothing to merge - and the integrate step now reads the
    queue off DISK, so leaving it at `done` in `queue/` would re-read it every
    60 seconds forever and hold every dependent behind it. It is blocked, with
    the reason on the card (MAP rule 11): never silence, and never a merge the
    engine cannot vouch for."""
    _use_fake(monkeypatch, factory, mode="done")           # a run that cuts no branch at all
    _publish(factory, "001-first.md", _card())

    engine.run_cycle(eng)
    _wait_for_children(eng)
    engine.run_cycle(eng)

    assert eng.children == []
    card = (factory.queue / "001-first.md").read_text(encoding="utf-8")
    assert "Status: blocked" in card
    assert "no adw/001_* branch in this checkout" in card
    assert not (factory.queue / "done" / "001-first.md").exists()   # nothing was merged
    assert "Blocked-reason:" in _origin_card(factory, "001-first.md")


def test_a_done_card_whose_branch_holds_nothing_new_is_parked(factory, eng, capsys):
    """A branch with nothing on it the working line does not already have: a
    run that committed nothing, or - the case that matters - a merge that
    landed and an engine that died before it could park the card. Nothing to
    merge and nothing to check, so the card is parked as it stands; leaving it
    at `done` in `queue/` would hold every dependent behind it forever."""
    tree = factory.root.parent / "wt" / "007_noop"
    _git("worktree", "add", "-q", "-b", "adw/007_noop", tree.as_posix(), "integration",
         cwd=factory.root)
    _publish(factory, "007-noop.md",
             _card(status=dispatch.DONE).replace("Adw-Id:", "Adw-Id: 007"))

    engine.run_cycle(eng)

    assert (factory.queue / "done" / "007-noop.md").is_file()
    assert "nothing to merge for 007-noop.md" in capsys.readouterr().out
    assert "factory: 007-noop.md integrated" in _origin_log(factory)


def test_a_failed_run_is_reaped_as_blocked_and_never_integrated(
        factory, eng, monkeypatch, capsys):
    _use_fake(monkeypatch, factory, mode="done", code=1, work="feature.txt:one")
    _publish(factory, "001-first.md", _card())

    engine.run_cycle(eng)
    _wait_for_children(eng)
    engine.run_cycle(eng)

    assert "Status: blocked" in _origin_card(factory, "001-first.md")
    assert "not integrating 001-first.md: its run exited 1" in capsys.readouterr().out
    assert _gate_ran_in(factory) == []                     # the gate was never asked
    assert "run 001: first" not in _origin_log(factory)    # its commit stayed off the line


def test_a_status_commit_carries_only_its_own_card(factory, eng, monkeypatch):
    """Path-scoped commits: whatever else is dirty in the checkout stays dirty."""
    _use_fake(monkeypatch, factory, mode="hold")
    _publish(factory, "001-first.md", _card())
    _publish(factory, "002-second.md", _card(status=dispatch.BLOCKED))
    (factory.root / "README.md").write_text("locally dirty\n", encoding="utf-8")
    (factory.queue / "002-second.md").write_text(
        _card(status=dispatch.BLOCKED, title="edited by hand"), encoding="utf-8")
    eng.cap = 1

    engine.run_cycle(eng)

    touched = _git("show", "--name-only", "--format=", "HEAD", cwd=factory.root).split()
    assert touched == ["queue/001-first.md"]
    assert "README.md" in _git("status", "--porcelain", cwd=factory.root)


# ── the integrate step: rebase, re-verify, ff-merge, park ───────────────────

def test_a_clean_run_is_rebased_verified_ff_merged_and_parked(factory, eng, monkeypatch, capsys):
    """The whole autonomous path, and the wave that follows it: the dependent
    card becomes dispatchable in the SAME cycle its dependency was parked,
    because parking is what satisfies `Needs:`."""
    _use_fake(monkeypatch, factory, mode="done", work={"001-first.md": "feature.txt:one"})
    _use_gate(monkeypatch, factory)
    _publish(factory, "001-first.md", _card())
    _publish(factory, "002-second.md", _card(needs="001-first.md"))

    engine.run_cycle(eng)
    assert _names(eng) == ["001-first.md"]              # the dependent is not eligible yet
    assert _marks(factory, "002-second.md") == []
    _wait_for_children(eng)

    engine.run_cycle(eng)                               # reap -> integrate -> park -> dispatch

    assert not (factory.queue / "001-first.md").exists()
    assert (factory.queue / "done" / "001-first.md").is_file()
    log = _origin_log(factory)
    assert "factory: 001-first.md integrated" in log
    assert "run 001: first" in log                      # the run's own commit is on the line
    assert _origin_file(factory, "feature.txt") == "one"
    assert _gate_ran_in(factory) == [(factory.root.parent / "wt" / "001_first").resolve()]
    assert "rebased a detached copy of adw/001_first onto integration" in capsys.readouterr().out
    assert _names(eng) == ["002-second.md"]             # the wave rolled on by itself


def test_sibling_branches_integrate_one_after_another(factory, eng, monkeypatch):
    """Two runs cut from the same integration tip. The second is not a
    fast-forward of the first's merge - which is exactly what used to make the
    second merge refuse - so it is REBASED onto the new tip first, and then it
    is."""
    _use_fake(monkeypatch, factory, mode="done",
              work={"001-first.md": "one.txt:1", "002-second.md": "two.txt:2"})
    _use_gate(monkeypatch, factory)
    _publish(factory, "001-first.md", _card())
    _publish(factory, "002-second.md", _card())

    engine.run_cycle(eng)
    assert _names(eng) == ["001-first.md", "002-second.md"]
    _wait_for_children(eng)
    engine.run_cycle(eng)

    assert (factory.queue / "done" / "001-first.md").is_file()
    assert (factory.queue / "done" / "002-second.md").is_file()
    assert _origin_file(factory, "one.txt") == "1"
    assert _origin_file(factory, "two.txt") == "2"
    log = _origin_log(factory)
    assert "factory: 001-first.md integrated" in log
    assert "factory: 002-second.md integrated" in log
    assert len(_gate_ran_in(factory)) == 2              # each was verified on its own rebase


def test_a_rebase_conflict_blocks_the_card_with_its_reason_and_the_engine_carries_on(
        factory, eng, monkeypatch):
    """Two runs that touched the same file. The first integrates; the second
    cannot be replayed onto it, so it is blocked - visibly, on the card, with
    the reason - and nothing half-merged is left behind."""
    _use_fake(monkeypatch, factory, mode="done",
              work={"001-first.md": "shared.txt:from-001",
                    "002-second.md": "shared.txt:from-002"})
    _use_gate(monkeypatch, factory)
    _publish(factory, "001-first.md", _card())
    _publish(factory, "002-second.md", _card())

    engine.run_cycle(eng)
    _wait_for_children(eng)
    engine.run_cycle(eng)

    assert (factory.queue / "done" / "001-first.md").is_file()
    assert _origin_file(factory, "shared.txt") == "from-001"

    blocked = (factory.queue / "002-second.md").read_text(encoding="utf-8")
    assert "Status: blocked" in blocked
    assert "Blocked-reason: rebase conflict with integration" in blocked
    assert "Blocked-reason: rebase conflict with integration" in _origin_card(
        factory, "002-second.md")
    assert "## Agent Brief" in blocked                  # the body survived byte for byte
    assert not engine.rebase_in_progress(factory.root.parent / "wt" / "002_second")
    assert len(_gate_ran_in(factory)) == 1              # the gate is never asked about a conflict

    engine.run_cycle(eng)                               # and the service keeps cycling
    assert eng.children == []


def test_a_red_suite_blocks_the_card_and_merges_nothing(factory, eng, monkeypatch):
    _use_fake(monkeypatch, factory, mode="done", work="feature.txt:one")
    _use_gate(monkeypatch, factory, green=False)
    _publish(factory, "001-first.md", _card())

    engine.run_cycle(eng)
    _wait_for_children(eng)
    engine.run_cycle(eng)

    blocked = (factory.queue / "001-first.md").read_text(encoding="utf-8")
    assert "Status: blocked" in blocked
    assert "Blocked-reason: quality suite red" in blocked
    assert not (factory.queue / "done" / "001-first.md").exists()
    assert "run 001: first" not in _origin_log(factory)
    assert "factory: 001-first.md -> blocked" in _origin_log(factory)


def test_a_suite_that_cannot_run_at_all_reads_red(factory, eng, monkeypatch):
    """Fail-closed, the same rule the in-run quality block follows: the gate
    refuses a merge it cannot vouch for."""
    _use_fake(monkeypatch, factory, mode="done", work="feature.txt:one")
    _use_gate(monkeypatch, factory, missing=True)
    _publish(factory, "001-first.md", _card())

    engine.run_cycle(eng)
    _wait_for_children(eng)
    engine.run_cycle(eng)

    blocked = (factory.queue / "001-first.md").read_text(encoding="utf-8")
    assert "Status: blocked" in blocked
    assert "could not run at all" in blocked
    assert "run 001: first" not in _origin_log(factory)


def test_the_gate_never_rewrites_the_branch_the_run_already_published(
        factory, eng, monkeypatch):
    """A red gate used to leave the run's branch REBASED while the hub still
    held its pre-rebase commits. Every later push of that branch was then
    refused - and this factory has no `--force` anywhere - so a repair run
    could never publish its fix and the hub's compare link kept showing stale
    code. The gate rebases a DETACHED COPY now: branch, hub copy and worktree
    all end exactly where the run left them."""
    _use_fake(monkeypatch, factory, mode="done", work="feature.txt:one")
    _use_gate(monkeypatch, factory, green=False)
    _publish(factory, "001-first.md", _card())

    engine.run_cycle(eng)
    _wait_for_children(eng)
    branch = "adw/001_first"
    tree = factory.root.parent / "wt" / "001_first"
    _git("push", "-q", "-u", "origin", branch, cwd=factory.root)    # what the run itself does
    published = _git("rev-parse", branch, cwd=factory.origin)

    engine.run_cycle(eng)                                           # red gate -> blocked

    assert "Blocked-reason: quality suite red" in (
        factory.queue / "001-first.md").read_text(encoding="utf-8")
    assert _git("rev-parse", branch, cwd=factory.root) == published   # not rewritten
    # And the tree is back on its own branch, which is what a repair dispatch
    # rejoins (worktrees.ensure_run_worktree) - a detached tree it would refuse.
    assert _git("rev-parse", "--abbrev-ref", "HEAD", cwd=tree) == branch

    (tree / "fix.txt").write_text("repaired\n", encoding="utf-8")    # the repair run's commit
    _git("add", "-A", cwd=tree)
    _git("commit", "-q", "-m", "repair 001", cwd=tree)
    ok, error = git_helper.push_branch(branch, tree=factory.root)

    assert ok, f"the repair run could not publish its fix: {error}"


def test_an_integrated_branch_is_left_unrewritten_and_still_reads_as_merged(
        factory, eng, monkeypatch):
    """The other half of rebasing a copy: reconciliation must still see the
    branch as merged, or `just worktrees` would hold every integrated run
    forever as "HOLDS WORK". It does - `is_merged_into_trunk` compares CONTENT
    (`merge-tree`), never ancestry, which is exactly why a rebased copy landing
    on the line is enough."""
    _use_fake(monkeypatch, factory, mode="done", work="feature.txt:one")
    _use_gate(monkeypatch, factory)
    _publish(factory, "001-first.md", _card())

    engine.run_cycle(eng)
    _wait_for_children(eng)
    branch = "adw/001_first"
    tree = factory.root.parent / "wt" / "001_first"
    # Move the working line under the run, so the rebase really has work to do
    # and the merged commit really is a different one from the branch's tip.
    (factory.root / "hub.txt").write_text("another card landed\n", encoding="utf-8")
    _git("add", "-A", cwd=factory.root)
    _git("commit", "-q", "-m", "another card landed", cwd=factory.root)
    published = _git("rev-parse", branch, cwd=factory.root)

    engine.run_cycle(eng)

    assert (factory.queue / "done" / "001-first.md").is_file()        # it really merged
    assert _origin_file(factory, "feature.txt") == "one"
    assert _git("rev-parse", branch, cwd=factory.root) == published   # and was not rewritten
    assert not git_helper.is_ancestor(branch, "integration", tree=factory.root)
    assert worktrees.is_merged_into_trunk(factory.root, "integration", branch)
    assert _git("rev-parse", "--abbrev-ref", "HEAD", cwd=tree) == branch


def test_the_gate_runs_the_factorys_own_toolchain_pinned_to_the_tree(tmp_path):
    """The seam's real value (what the stand-in stands in FOR): quality.py's
    lint / typecheck / test blocks, pinned to the tree being judged, and no
    agent anywhere near it."""
    instance = engine.Engine(main_root=tmp_path, queue_dir=tmp_path, config="cfg.yaml")
    commands = engine.quality_commands(instance, tmp_path / "wt")

    tools = [argv[argv.index("dev") + 1] for argv in commands]
    assert tools == ["ruff", "mypy", "pytest"]
    for argv in commands:
        assert argv[:4] == ["uv", "run", "--project", str(tmp_path / "wt")]


# ── failure semantics ───────────────────────────────────────────────────────

def test_a_pull_failure_logs_one_line_and_skips_the_whole_cycle(factory, eng, monkeypatch, capsys):
    _use_fake(monkeypatch, factory, mode="done")
    _publish(factory, "001-first.md", _card())
    _git("remote", "set-url", "origin", (factory.origin.parent / "gone.git").as_posix(),
         cwd=factory.root)

    engine.run_cycle(eng)

    assert eng.children == []
    assert _marks(factory, "001-first.md") == []
    assert "pull failed, skipping this cycle" in capsys.readouterr().out


def test_a_push_failure_keeps_the_commit_and_retries_next_cycle(factory, eng, monkeypatch, capsys):
    """A broken push URL with a working fetch URL: the pull still works, the
    push does not. The record is safe locally and goes out when it can."""
    _use_fake(monkeypatch, factory, mode="hold")
    _publish(factory, "001-first.md", _card())
    _git("remote", "set-url", "--push", "origin",
         (factory.origin.parent / "gone.git").as_posix(), cwd=factory.root)

    engine.run_cycle(eng)

    assert eng.pending_push is True
    assert "push failed, will retry next cycle" in capsys.readouterr().out
    assert "factory: 001-first.md -> running" in _git(
        "log", "--format=%s", "-1", cwd=factory.root)        # committed locally
    assert _origin_log(factory) == ["init"]   # nothing of this card is at the hub yet

    _git("remote", "set-url", "--push", "origin", factory.origin.as_posix(), cwd=factory.root)
    engine.run_cycle(eng)

    assert eng.pending_push is False
    assert "factory: 001-first.md -> running" in _origin_log(factory)


def test_one_failed_push_plus_one_laptop_publish_never_wedges_the_service(
        factory, eng, monkeypatch, capsys):
    """The two-box steady state: integration is the LIVING line, so both boxes
    commit to it and a single failed push leaves the histories diverged the
    moment the laptop publishes again. `--ff-only` alone refuses that forever,
    and with the pull in front of the reap and the push nothing on this box
    could ever clear it - the service stops dispatching until a human logs into
    the server. It must recover on its own instead."""
    _use_fake(monkeypatch, factory, mode="done", work={"001-first.md": "feature.txt:one"})
    _use_gate(monkeypatch, factory)
    _publish(factory, "001-first.md", _card())
    _git("remote", "set-url", "--push", "origin",
         (factory.origin.parent / "gone.git").as_posix(), cwd=factory.root)

    engine.run_cycle(eng)                       # claims 001, commits, push fails
    assert eng.pending_push is True

    _laptop_publishes(factory, "002-second.md", _card())     # the hub moves too
    _git("remote", "set-url", "--push", "origin", factory.origin.as_posix(), cwd=factory.root)
    _wait_for_children(eng)

    engine.run_cycle(eng)                       # recovers: replay, then dispatch 002
    _wait_for_children(eng)
    engine.run_cycle(eng)

    out = capsys.readouterr().out
    assert "pull failed" not in out
    log = _origin_log(factory)
    assert "publish 001-first.md" in log          # this box's commits reached the hub
    assert "factory: 001-first.md integrated" in log        # and its run finished the whole trip
    assert "Status: done" in _origin_file(factory, "queue/done/001-first.md")   # record and all
    assert "publish 002-second.md" in log         # on top of the laptop's, not instead of
    assert _marks(factory, "002-second.md") == ["done"]   # the laptop's card really ran
    assert eng.pending_push is False


def test_a_commit_that_is_not_a_card_write_back_is_never_dropped(
        factory, eng, monkeypatch, capsys):
    """The replay may DROP a commit, and what makes that safe is that it only
    ever drops card write-backs. Now that finished runs are fast-forwarded into
    the working line here, the local history also carries somebody's actual
    WORK - dropping one of those would lose merged code silently, with the card
    already parked as integrated. So the replay refuses and aborts instead."""
    _use_fake(monkeypatch, factory, mode="done")
    (factory.root / "feature.txt").write_text("from the server\n", encoding="utf-8")
    _git("add", "-A", cwd=factory.root)
    _git("commit", "-q", "-m", "run 001: first", cwd=factory.root)   # merged, not pushed yet

    laptop = _laptop(factory)                                        # and the hub moved it too
    (laptop / "feature.txt").write_text("from the laptop\n", encoding="utf-8")
    _git("add", "-A", cwd=laptop)
    _git("commit", "-q", "-m", "operator: edited feature.txt", cwd=laptop)
    _git("push", "-q", "origin", "integration", cwd=laptop)

    engine.run_cycle(eng)

    out = capsys.readouterr().out
    assert "is NOT a card write-back" in out
    assert "pull failed, skipping this cycle" in out
    assert not engine.rebase_in_progress(factory.root)
    assert "run 001: first" in _git("log", "--format=%s", cwd=factory.root)   # still here
    assert _git("status", "--porcelain", cwd=factory.root) == ""              # nothing half-done


def test_a_write_back_orphaned_by_a_restart_is_recorded_on_the_next_cycle(
        factory, eng, monkeypatch):
    """dispatch writes the terminal status; the engine records it. A restart
    between those two (systemd's Restart=always, or a converge re-running
    `enable --now`) leaves no child to reap: without a sweep the card says
    `done` on this disk and `running` at the hub forever, and the checkout
    stays dirty - which is also what makes the next pull refuse."""
    _use_fake(monkeypatch, factory, mode="done")
    card = _publish(factory, "001-first.md", _card(status=dispatch.RUNNING))
    card.write_text(_card(status=dispatch.DONE), encoding="utf-8")

    engine.run_cycle(eng)

    assert "factory: 001-first.md -> done" in _origin_log(factory)
    assert _git("status", "--porcelain", cwd=factory.root) == ""   # nothing left dirty
    assert _marks(factory, "001-first.md") == []                   # never re-dispatched
    # And the same cycle reads that adopted `done` back off disk as work owed
    # an integration. This one names no run at all (empty Adw-Id:), so it is
    # blocked with the reason on it rather than sitting at `done` in queue/
    # forever - which is the dead end the disk scan exists to end.
    assert "Blocked-reason: no Adw-Id:" in _origin_card(factory, "001-first.md")


def test_a_run_that_finished_after_its_engine_died_is_integrated_from_disk(
        factory, eng, monkeypatch):
    """The stranded-finished-run dead end. A run came back clean and its branch
    is mergeable, but the process that dispatched it is gone - systemd's
    `Restart=always` after a crash, a converge re-running `enable --now`, or an
    `--once` invocation that exited while its child was still going. The new
    process holds no child and no memory of it, so a merge queue kept in RAM
    left that card at `done` in `queue/` forever, and nothing on the Board ever
    said why. The queue on DISK is the queue."""
    _use_fake(monkeypatch, factory, mode="done", work="feature.txt:one")
    _use_gate(monkeypatch, factory)
    _publish(factory, "001-first.md", _card())
    _publish(factory, "002-second.md", _card(needs="001-first.md"))

    engine.run_cycle(eng)                       # dispatches 001
    _wait_for_children(eng)                     # which finishes and writes `done` itself

    restarted = engine.Engine(main_root=factory.root, queue_dir=factory.queue,
                              config=str(factory.roster), cap=2)
    engine.run_cycle(restarted)                 # a fresh process: no children, no memory

    assert (factory.queue / "done" / "001-first.md").is_file()
    assert _origin_file(factory, "feature.txt") == "one"
    assert "factory: 001-first.md integrated" in _origin_log(factory)
    assert _names(restarted) == ["002-second.md"]      # and the wave rolls on from there
    for child in restarted.children:
        child.process.wait(timeout=60)


def test_a_checkout_that_cannot_name_a_committer_does_nothing_and_says_how_to_fix_it(
        factory, eng, monkeypatch, capsys):
    """A fresh container or VPS: the service user has no `~/.gitconfig` and the
    checkout has no identity either, so every `git commit` dies with "unable to
    auto-detect email address". The engine used to log `commit failed, will
    retry next cycle` once a minute forever while `systemctl is-active`
    reported the service healthy. It refuses the cycle instead, out loud, once,
    naming the exact two commands."""
    _use_fake(monkeypatch, factory, mode="done")
    _publish(factory, "001-first.md", _card())
    _git("config", "--unset", "user.email", cwd=factory.root)
    _git("config", "--unset", "user.name", cwd=factory.root)
    # No host auto-detection either, on any machine this suite runs on: git's
    # own switch for "the config is the only source of an identity".
    _git("config", "user.useConfigOnly", "true", cwd=factory.root)
    for name in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "EMAIL",
                 "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(factory.root.parent / "no-such-home"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")

    engine.run_cycle(eng)

    out = capsys.readouterr().out
    assert "NO COMMITTER IDENTITY" in out
    assert 'config user.name "sdl-factory engine"' in out
    assert 'config user.email "engine@sdl-factory.local"' in out
    assert eng.children == []                        # nothing was dispatched
    assert _marks(factory, "001-first.md") == []

    engine.run_cycle(eng)                            # said once, not once a minute
    assert "NO COMMITTER IDENTITY" not in capsys.readouterr().out


def test_the_installer_writes_exactly_the_committer_that_refusal_names():
    """The two commands the engine prints and the two values the installer's
    engine-service step writes must be the same pair. `installer/steps.py` is
    stdlib-only by contract and cannot import this module, so the strings are
    repeated there - and checked here against the source, the way
    test_dispatch.py checks the Board's status vocabulary."""
    repo_root = Path(engine.__file__).resolve().parent.parent
    text = (repo_root / "installer" / "steps.py").read_text(encoding="utf-8")

    assert f'ENGINE_GIT_NAME = "{engine.COMMITTER_NAME}"' in text
    assert f'ENGINE_GIT_EMAIL = "{engine.COMMITTER_EMAIL}"' in text


def test_a_card_moved_at_the_hub_mid_write_back_never_wedges_the_service(
        factory, eng, monkeypatch, capsys):
    """The other half of the same wedge: an uncommitted terminal write-back
    plus any upstream change to that same card. A card moved to queue/done/ at
    the hub is exactly that, and it used to make every later pull refuse
    ("local changes would be overwritten by merge") for good."""
    _use_fake(monkeypatch, factory, mode="done")
    card = _publish(factory, "001-first.md", _card(status=dispatch.RUNNING))
    _git("push", "-q", "origin", "integration", cwd=factory.root)
    card.write_text(_card(status=dispatch.DONE), encoding="utf-8")   # dispatch's write-back
    _laptop_parks(factory, "001-first.md")                           # and the hub moved it

    engine.run_cycle(eng)
    _publish(factory, "002-second.md", _card())
    engine.run_cycle(eng)
    _wait_for_children(eng)
    engine.run_cycle(eng)

    assert "pull failed" not in capsys.readouterr().out
    assert not (factory.queue / "001-first.md").exists()          # the hub's version won
    assert (factory.queue / "done" / "001-first.md").is_file()
    assert _marks(factory, "002-second.md") == ["done"]           # still shipping work
    assert eng.pending_push is False


def test_a_stranded_running_card_is_named_at_startup_and_never_dispatched(
        factory, eng, monkeypatch, capsys):
    _use_fake(monkeypatch, factory, mode="done")
    original = _card(status=dispatch.RUNNING)
    _publish(factory, "001-in-flight.md", original)

    engine.run_cycle(eng)

    out = capsys.readouterr().out
    assert "stranded: 001-in-flight.md" in out
    assert "just worktrees" in out
    assert eng.children == []
    assert _marks(factory, "001-in-flight.md") == []
    assert (factory.queue / "001-in-flight.md").read_text(encoding="utf-8") == original

    engine.run_cycle(eng)                       # said once at startup, not every cycle
    assert "stranded" not in capsys.readouterr().out


def test_a_refused_dispatch_is_named_once_and_not_retried(factory, eng, monkeypatch, capsys):
    """dispatch's own exit-2 refusal leaves the card untouched — re-dispatching
    it every 60s forever would be pure noise."""
    _use_fake(monkeypatch, factory, mode="refuse", code=2)
    _publish(factory, "001-first.md", _card())

    engine.run_cycle(eng)
    _wait_for_children(eng)
    engine.run_cycle(eng)

    assert _marks(factory, "001-first.md") == ["refuse"]      # dispatched exactly once
    assert "001-first.md" in eng.refused
    assert "dispatch refused it" in capsys.readouterr().out

    engine.run_cycle(eng)
    assert _marks(factory, "001-first.md") == ["refuse"]
    assert eng.children == []
    # A refusal changed no bytes, so the engine never manufactured a commit
    # (and with nothing to push, never touched the hub either).
    assert _origin_log(factory) == ["init"]


def test_a_checkout_with_no_origin_runs_local_only(factory, eng, monkeypatch):
    """`just engine` on a laptop repo with no hub: no pull, no push, still runs
    - and still integrates."""
    _use_fake(monkeypatch, factory, mode="done", work="feature.txt:one")
    _use_gate(monkeypatch, factory)
    _publish(factory, "001-first.md", _card())
    _git("remote", "remove", "origin", cwd=factory.root)

    engine.run_cycle(eng)
    _wait_for_children(eng)
    engine.run_cycle(eng)

    assert _marks(factory, "001-first.md") == ["done"]
    assert eng.pending_push is False
    assert (factory.queue / "done" / "001-first.md").is_file()
    assert "factory: 001-first.md integrated" in _git("log", "--format=%s", cwd=factory.root)


# ── the CLI ─────────────────────────────────────────────────────────────────

def test_once_runs_exactly_one_cycle_and_exits(factory, monkeypatch):
    _use_fake(monkeypatch, factory, mode="done")
    _publish(factory, "001-first.md", _card())
    _publish(factory, "002-second.md", _card())
    monkeypatch.chdir(factory.root)
    monkeypatch.delenv("SSSF_INTEGRATION_BRANCH", raising=False)
    monkeypatch.delenv("SSSF_LANES", raising=False)

    # A second cycle would mean --once did not stop the loop. Interrupting on
    # it keeps the failure a failed assertion rather than a hung test (and
    # --interval 0 means a broken --once reaches that second cycle at once).
    cycles = []
    real_cycle = engine.run_cycle

    def counted(instance):
        cycles.append(instance)
        if len(cycles) > 1:
            raise KeyboardInterrupt
        real_cycle(instance)
    monkeypatch.setattr(engine, "run_cycle", counted)

    code = engine.main(["--once", "--cap", "1", "--interval", "0",
                        "--config", str(factory.roster)])

    assert code == 0
    assert len(cycles) == 1
    deadline = time.monotonic() + 30
    while _marks(factory, "001-first.md") != ["done"] and time.monotonic() < deadline:
        time.sleep(0.05)
    assert _marks(factory, "001-first.md") == ["done"]
    assert _marks(factory, "002-second.md") == []     # --cap 1 held the second one back


def test_once_does_not_wait_for_its_runs_and_says_who_integrates_them(
        factory, monkeypatch, capsys):
    """`--once` is one cycle, not one shipment: a run takes minutes and a cycle
    takes seconds. That is honest rather than lossy now, because the integrate
    step reads the queue off disk - so the last line it prints says exactly
    where the work it left behind gets picked up."""
    _use_fake(monkeypatch, factory, mode="hold")
    _publish(factory, "001-first.md", _card())
    monkeypatch.chdir(factory.root)
    monkeypatch.delenv("SSSF_INTEGRATION_BRANCH", raising=False)
    monkeypatch.delenv("SSSF_LANES", raising=False)

    code = engine.main(["--once", "--cap", "1", "--interval", "0",
                        "--config", str(factory.roster)])

    assert code == 0
    out = capsys.readouterr().out
    assert "--once: 1 run(s) still going" in out
    assert "next invocation integrates it straight off the queue on disk" in out

    factory.release.write_text("go\n", encoding="utf-8")   # let the child finish and exit
    deadline = time.monotonic() + 60
    card = factory.queue / "001-first.md"
    while "Status: done" not in card.read_text(encoding="utf-8") and time.monotonic() < deadline:
        time.sleep(0.05)
    assert "Status: done" in card.read_text(encoding="utf-8")


def test_the_engine_refuses_to_start_when_the_roster_turns_worktrees_off(
        factory, monkeypatch, capsys):
    """`worktrees.enabled: false` is pre-worktree behaviour - a run's branch cut
    IN the main checkout. That is the one checkout this engine checks
    `integration` out in, every cycle: it would yank a live run's branch out
    from under it mid-flight, and no worktree would ever hold a finished branch
    for the integrate step to rebase. Refused at startup, by name."""
    roster = factory.roster.parent / "no-worktrees.yaml"
    roster.write_text(ROSTER + "worktrees:\n  enabled: false\n", encoding="utf-8")
    monkeypatch.chdir(factory.root)

    with pytest.raises(SystemExit):
        engine.main(["--once", "--config", str(roster)])

    assert "worktrees.enabled: true" in capsys.readouterr().err


def test_worktrees_are_read_as_enabled_unless_a_roster_says_otherwise(factory, tmp_path):
    """True is `WorktreesConfig`'s own default, and a roster that cannot be read
    at all is dispatch's refusal to make - per card, visibly - never a service
    that will not come up."""
    assert engine.worktrees_enabled(factory.roster) is True
    assert engine.worktrees_enabled(tmp_path / "no-such-roster.yaml") is True


def test_a_cap_below_one_is_refused(factory, monkeypatch):
    monkeypatch.chdir(factory.root)
    with pytest.raises(SystemExit):
        engine.main(["--once", "--cap", "0"])


def test_a_malformed_lanes_value_is_refused_at_startup(factory, monkeypatch):
    monkeypatch.chdir(factory.root)
    with pytest.raises(SystemExit):
        engine.main(["--once", "--lanes", "xai"])


def test_the_working_line_can_never_be_main(factory, monkeypatch):
    """`main` is human-owned - one squash commit per finished chunk, merged by
    the operator. An engine pointed at it would commit card statuses onto the
    one branch that must only ever hold clean combined snapshots."""
    monkeypatch.chdir(factory.root)
    monkeypatch.setenv("SSSF_INTEGRATION_BRANCH", "main")
    with pytest.raises(SystemExit):
        engine.main(["--once"])


def test_every_log_line_is_ascii_only(capsys):
    """MAP.md's platform landmine: one non-ASCII glyph on a cp1252 stdout takes
    a headless service down. The engine scrubs on the way out."""
    engine.log("worktree café -> done — finished")
    out = capsys.readouterr().out
    assert out.strip()
    out.encode("ascii")     # raises if anything survived unscrubbed
