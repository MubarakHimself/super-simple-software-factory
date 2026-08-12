"""Hermetic tests for the dispatcher — the seam between the Board and the
factory (adws/dispatch.py). No network, no pi, no model calls: the one
subprocess boundary (`dispatch._stream`) is monkeypatched to a fake that
never actually launches anything.
"""

from __future__ import annotations

import re
from pathlib import Path

import dispatch
import pytest

TEMPLATE_BODY = """## Agent Brief

**Category:** enhancement
**Summary:** one line
**Current behavior:** what happens today
**Desired behavior:** what should happen instead
**Key interfaces:** files, functions, endpoints this touches
**Acceptance criteria:**
- [ ] first observable, testable condition
- [ ] second observable, testable condition
**Out of scope:** what this ticket deliberately does not do
"""


def _item(status: str = dispatch.READY, adw: str = "simple-sdlc", adw_id: str = "",
         created: str = "2026-08-12", context: str = "DEC-0042") -> str:
    """A fixture mirroring queue/TEMPLATE.md's exact shape."""
    return (
        f"# Add a /health endpoint\n\n"
        f"Status: {status}\n"
        f"Adw: {adw}\n"
        f"Adw-Id: {adw_id}\n"
        f"Created: {created}\n"
        f"Context: {context}\n\n"
        f"{TEMPLATE_BODY}"
    )


def _write(root: Path, name: str, text: str) -> Path:
    path = root / name
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def main_root(tmp_path):
    """A throwaway repo standing in for the main checkout: just enough of
    adws/ on disk for resolve_script's existence check — dispatch never reads
    these files' contents, only their presence."""
    root = tmp_path / "main"
    (root / "adws").mkdir(parents=True)
    for name in dispatch.KNOWN_WRITING_ADWS:
        (root / "adws" / f"adw_{name.replace('-', '_')}.py").write_text("# stub\n", encoding="utf-8")
    return root


# ── header parsing / write-back round trip ──────────────────────────────────

def test_parse_header_reads_the_five_keys_and_the_body_below_them():
    header = dispatch.parse_header(_item())

    assert header.title == "Add a /health endpoint"
    assert header.fields == {
        "status": dispatch.READY, "adw": "simple-sdlc", "adw-id": "",
        "created": "2026-08-12", "context": "DEC-0042",
    }
    assert dispatch.body_of(header).startswith("## Agent Brief")
    assert "**Out of scope:**" in dispatch.body_of(header)


# ── request_prompt: the branch-slug source (specs/worktrees.md 3.2) ────────

def test_request_prompt_leads_with_the_title_so_the_slug_is_legible():
    """specs/worktrees.md 3.2: 'a worktree must say what it holds without
    being opened.' Every card's Agent Brief boilerplate starts identically
    ('## Agent Brief\\n\\n**Category:** ...'), so slugify-ing the body alone
    gives every card the SAME useless slug. Leading with the H1 title fixes
    that; the body still follows, untouched, right after it."""
    header = dispatch.parse_header(_item())
    body = dispatch.body_of(header)
    prompt = dispatch.request_prompt(header)

    assert prompt == f"{header.title}\n\n{body}"
    assert prompt.startswith("Add a /health endpoint\n\n")
    assert body in prompt   # the ADW's actual task is still the full body

    from adw_modules import git_helper
    body_slug = git_helper.slugify(body)
    title_slug = git_helper.slugify(prompt)
    assert body_slug == "agent-brief-category-enhancement"   # the bug: identical on every card
    assert title_slug == "add-a-health-endpoint"              # the fix: legible, per-card


def test_write_status_round_trips_and_touches_only_its_own_two_lines(tmp_path):
    original = _item()
    path = _write(tmp_path, "001-add-health-endpoint.md", original)
    header = dispatch.parse_header(original)

    dispatch.write_status(path, header, dispatch.RUNNING, adw_id="deadbeef")
    once = path.read_text(encoding="utf-8")
    assert "Status: running\n" in once
    assert "Adw-Id: deadbeef\n" in once
    # Everything else survives byte for byte.
    for line in ("# Add a /health endpoint", "Adw: simple-sdlc",
                 "Created: 2026-08-12", "Context: DEC-0042",
                 "**Out of scope:** what this ticket deliberately does not do"):
        assert line in once

    dispatch.write_status(path, header, dispatch.DONE)
    twice = path.read_text(encoding="utf-8")
    assert "Status: done\n" in twice
    assert "Adw-Id: deadbeef\n" in twice   # unchanged by the second write-back


def test_write_status_refuses_a_file_missing_the_status_line():
    header = dispatch.QueueHeader(
        lines="# Title\n\nAdw: simple-sdlc\nAdw-Id:\n\nbody\n".splitlines(),
        trailing_newline=True, title="Title",
        fields={"adw": "simple-sdlc", "adw-id": ""},
        field_lines={"adw": 2, "adw-id": 3}, body_start=5)
    with pytest.raises(dispatch.DispatchError, match="missing Status:"):
        dispatch.write_status(Path("nope.md"), header, dispatch.RUNNING)


# ── vocabulary — matches the Board's own contract, never reinvented ────────

def test_queue_status_vocabulary_matches_template_and_queue_ts():
    repo_root = Path(__file__).resolve().parents[2]
    template = (repo_root / "queue" / "TEMPLATE.md").read_text(encoding="utf-8")
    m = re.search(r"Status is one of:\s*([a-z][a-z-]*(?:\s*\|\s*[a-z][a-z-]*)*)\.", template)
    assert m, "queue/TEMPLATE.md's Status vocabulary sentence has moved or changed shape"
    from_template = {s.strip() for s in m.group(1).split("|")}

    queue_ts = (repo_root / "apps" / "ui" / "server" / "queue.ts").read_text(encoding="utf-8")
    m2 = re.search(r"VALID_STATUSES:\s*QueueStatus\[\]\s*=\s*\[([^\]]+)\]", queue_ts)
    assert m2, "apps/ui/server/queue.ts's VALID_STATUSES has moved or changed shape"
    from_ts = {s.strip().strip('"') for s in m2.group(1).split(",")}

    assert from_template == from_ts == set(dispatch.QUEUE_STATUSES)


def test_parse_header_rejects_a_status_outside_the_vocabulary():
    with pytest.raises(dispatch.DispatchError, match="unknown Status"):
        dispatch.parse_header(_item(status="in-review"))


# ── unknown-Adw rejection ────────────────────────────────────────────────────

@pytest.mark.parametrize("bad", ["scout", "plan", "quality", "prompt", "", "typo-workflow"])
def test_resolve_script_rejects_anything_outside_the_writing_set(main_root, bad):
    with pytest.raises(dispatch.DispatchError, match="not a known writing workflow"):
        dispatch.resolve_script(main_root, bad)


@pytest.mark.parametrize("name", dispatch.KNOWN_WRITING_ADWS)
def test_resolve_script_accepts_every_writing_adw(main_root, name):
    script = dispatch.resolve_script(main_root, name)
    assert script == main_root / "adws" / f"adw_{name.replace('-', '_')}.py"


def test_dispatch_rejects_an_unknown_adw_and_leaves_the_file_untouched(main_root):
    original = _item(adw="scout")
    path = _write(main_root, "001-bad-adw.md", original)

    code = dispatch.dispatch(path, main_root=main_root, config="cfg.yaml", adw_id_override=None)

    assert code == 2
    assert path.read_text(encoding="utf-8") == original   # no mutation on refusal


# ── in-progress refusal / rejoin (idempotence) ──────────────────────────────

def test_claim_refuses_a_running_item_with_no_adw_id_override():
    header = dispatch.parse_header(_item(status=dispatch.RUNNING, adw_id="cafebabe"))
    with pytest.raises(dispatch.DispatchError, match="already running"):
        dispatch.claim(Path("001-x.md"), header, None)


def test_claim_allows_a_running_item_when_the_adw_id_matches():
    header = dispatch.parse_header(_item(status=dispatch.RUNNING, adw_id="cafebabe"))
    assert dispatch.claim(Path("001-x.md"), header, "cafebabe") == "cafebabe"


def test_claim_refuses_an_adw_id_that_does_not_match_the_cards_own():
    header = dispatch.parse_header(_item(status=dispatch.RUNNING, adw_id="cafebabe"))
    with pytest.raises(dispatch.DispatchError, match="does not match"):
        dispatch.claim(Path("001-x.md"), header, "deadbeef")


def test_claim_mints_a_fresh_id_for_a_never_claimed_item():
    header = dispatch.parse_header(_item(status=dispatch.READY, adw_id=""))
    minted = dispatch.claim(Path("001-x.md"), header, None)
    assert re.fullmatch(r"[0-9a-f]{8}", minted)


def test_claim_reuses_the_cards_own_id_on_a_blocked_retry_with_no_override():
    header = dispatch.parse_header(_item(status=dispatch.BLOCKED, adw_id="cafebabe"))
    assert dispatch.claim(Path("001-x.md"), header, None) == "cafebabe"


def test_dispatch_refuses_a_running_item_and_leaves_it_untouched(main_root, monkeypatch):
    def _boom(*a, **k):
        raise AssertionError("must never spawn a subprocess for a refused item")
    monkeypatch.setattr(dispatch, "_stream", _boom)

    original = _item(status=dispatch.RUNNING, adw_id="cafebabe")
    path = _write(main_root, "001-in-progress.md", original)

    code = dispatch.dispatch(path, main_root=main_root, config="cfg.yaml", adw_id_override=None)

    assert code == 2
    assert path.read_text(encoding="utf-8") == original


def test_dispatch_rejoin_with_matching_adw_id_proceeds_past_the_refusal(main_root, monkeypatch):
    calls = []

    def _fake_stream(cmd, *, cwd, env):
        calls.append(cmd)
        return 0
    monkeypatch.setattr(dispatch, "_stream", _fake_stream)

    path = _write(main_root, "001-in-progress.md",
                  _item(status=dispatch.RUNNING, adw_id="cafebabe"))

    code = dispatch.dispatch(path, main_root=main_root, config="cfg.yaml",
                             adw_id_override="cafebabe")

    assert code == 0
    assert len(calls) == 1
    assert "--adw-id" in calls[0] and "cafebabe" in calls[0]
    final = path.read_text(encoding="utf-8")
    assert "Status: done\n" in final
    assert "Adw-Id: cafebabe\n" in final


# ── end-to-end dispatch (the subprocess boundary faked) ─────────────────────

def test_dispatch_success_path_mints_an_id_and_writes_running_then_done(main_root, monkeypatch):
    calls = []

    def _fake_stream(cmd, *, cwd, env):
        calls.append((cmd, cwd))
        return 0
    monkeypatch.setattr(dispatch, "_stream", _fake_stream)

    path = _write(main_root, "001-add-health-endpoint.md", _item())

    code = dispatch.dispatch(path, main_root=main_root, config="cfg.yaml", adw_id_override=None)

    assert code == 0
    cmd, cwd = calls[0]
    assert cmd[0:2] == ["uv", "run"]
    assert Path(cmd[2]) == Path("adws") / "adw_simple_sdlc.py"
    assert cmd[3].startswith("Add a /health endpoint\n\n")  # title leads -> legible slug
    assert "## Agent Brief" in cmd[3]                        # the body, still present verbatim
    assert cmd[4] == "--config" and cmd[5] == "cfg.yaml"
    assert cmd[6] == "--adw-id"
    minted = cmd[7]
    assert re.fullmatch(r"[0-9a-f]{8}", minted)
    assert cwd == main_root

    final = path.read_text(encoding="utf-8")
    assert "Status: done\n" in final
    assert f"Adw-Id: {minted}\n" in final


def test_dispatch_failure_path_writes_blocked(main_root, monkeypatch):
    monkeypatch.setattr(dispatch, "_stream", lambda cmd, *, cwd, env: 1)
    path = _write(main_root, "001-add-health-endpoint.md", _item())

    code = dispatch.dispatch(path, main_root=main_root, config="cfg.yaml", adw_id_override=None)

    assert code == 1
    assert "Status: blocked\n" in path.read_text(encoding="utf-8")


def test_dispatch_a_launch_failure_still_writes_blocked_not_stuck_running(main_root, monkeypatch):
    def _explode(cmd, *, cwd, env):
        raise OSError("uv not found")
    monkeypatch.setattr(dispatch, "_stream", _explode)

    path = _write(main_root, "001-add-health-endpoint.md", _item())

    code = dispatch.dispatch(path, main_root=main_root, config="cfg.yaml", adw_id_override=None)

    assert code == 1
    assert "Status: blocked\n" in path.read_text(encoding="utf-8")


# ── --next: lowest-numbered ready item ──────────────────────────────────────

def test_pick_next_finds_the_lowest_numbered_ready_item(tmp_path):
    (tmp_path / "TEMPLATE.md").write_text(_item(), encoding="utf-8")
    _write(tmp_path, "003-third.md", _item(status=dispatch.READY))
    _write(tmp_path, "002-second-not-ready.md", _item(status=dispatch.BLOCKED))
    _write(tmp_path, "001-first-ready.md", _item(status=dispatch.READY))

    picked = dispatch.pick_next(tmp_path)

    assert picked.name == "001-first-ready.md"


def test_pick_next_skips_malformed_items(tmp_path):
    _write(tmp_path, "001-broken.md", "not a valid queue item at all\n")
    _write(tmp_path, "002-ready.md", _item(status=dispatch.READY))

    picked = dispatch.pick_next(tmp_path)

    assert picked.name == "002-ready.md"


def test_pick_next_ignores_the_done_subdirectory(tmp_path):
    done = tmp_path / "done"
    done.mkdir()
    _write(done, "000-already-merged.md", _item(status=dispatch.READY))

    with pytest.raises(dispatch.DispatchError, match="no 'ready-for-agent' item"):
        dispatch.pick_next(tmp_path)


def test_pick_next_raises_when_nothing_is_ready(tmp_path):
    _write(tmp_path, "001-blocked.md", _item(status=dispatch.BLOCKED))

    with pytest.raises(dispatch.DispatchError, match="no 'ready-for-agent' item"):
        dispatch.pick_next(tmp_path)
