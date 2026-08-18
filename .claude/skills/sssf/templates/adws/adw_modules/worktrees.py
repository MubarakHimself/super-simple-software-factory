"""The worktree layer: lifecycle (cut/rejoin a run's own tree) + reconciliation
(inventory it against the `sessions` table, plan a safe prune). See
specs/worktrees.md — section numbers in comments below refer to it.

Two halves, one module, no daemon, no lock server, no new store (MAP rule 1):
git's own worktree machinery IS the concurrency control (4.4 — git refuses to
check the same branch out twice), and the `sessions` table IS the registry.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import git_helper
from .data_types import RunWorktree, WorktreeRow, WorktreesConfig, WorktreeState
from .utils import minutes_since, operator_env, uv_cmd


class ReconciliationError(RuntimeError):
    """The tool could not answer (8.1's exit 2): not a git repository, an
    unreadable (not merely missing) db, or two branches sharing an adw_id."""


# ── lifecycle: ensure_run_worktree, worktree_for ─────────────────────────────

def resolve_root(main_root: Path, cfg: WorktreesConfig) -> Path:
    """Default = `<parent of main_root>/<main_root.name>-worktrees`, derived,
    not hardcoded (3.1). `worktrees.root` overrides it — the MAX_PATH escape
    hatch on Windows."""
    if cfg.root:
        return Path(cfg.root)
    return main_root.parent / f"{main_root.name}-worktrees"


def _sync_toolchain(path: Path) -> None:
    """`uv sync --project <path> --group dev`, pinned to the tree's own venv —
    prepared at creation (6.2), never mid-phase, so a provisioning failure
    surfaces as a clear code-phase failure before any tokens are spent, and
    `uv.lock` (tracked) means the tree resolves to exactly the pins the main
    checkout has.

    Skipped entirely when the tree has no `pyproject.toml` — a fresh repo in a
    test, or a non-Python project. This factory guarantees the Python
    toolchain and nothing else; `bun install` for `apps/ui` is the run's own
    business (6.2).
    """
    if not (path / "pyproject.toml").is_file():
        return
    env = {**operator_env(), "UV_PROJECT_ENVIRONMENT": str(path / ".venv")}
    # `uv` RESOLVED, never bare - the same fix as `engine.dispatch_command`,
    # `dispatch.py` and `quality.resolve_command`. This is the site with the
    # least forgiving failure of the four: the env it launches under is
    # `operator_env()` (venv bin stripped) on a service PATH with no
    # `~/.local/bin`, and a missing binary here raises FileNotFoundError, which
    # nothing below catches - so it escapes `ensure_run_worktree` and blocks the
    # card before a single agent has run. See `utils.uv_cmd`.
    result = subprocess.run(
        [uv_cmd(), "sync", "--project", str(path), "--group", "dev"],
        cwd=path, env=env, capture_output=True, text=True, encoding="utf-8",
        timeout=300, check=False)
    if result.returncode != 0:
        raise RuntimeError(
            f"uv sync failed provisioning the worktree at {path}:\n"
            f"{(result.stdout + result.stderr)[-2000:]}")


def ensure_run_worktree(main_root: Path, adw_id: str, prompt: str,
                        cfg: WorktreesConfig) -> RunWorktree:
    """Create or rejoin this run's branch AND its own working tree (4.3).

    Order of checks, in order — never reordered, this is what makes case 4 a
    real refusal instead of a race:
      1. a LIVE (non-prunable) worktree already holds `adw/<adw_id>_*` -> REJOIN.
      2. a stale registration (directory removed without `git worktree
         remove`) is cleared first — metadata only, never touches a file of
         work (9) — so it cannot block step 3/4 below.
      3. the target path exists on disk but git does not know it as this
         branch's worktree -> FAIL, naming the path. Park-never-delete
         applies to strangers too: never deleted, never written into.
      4. the branch exists without a worktree -> `worktree add <path> <branch>`
         (no `-b`: never re-cut an existing branch).
      5. neither exists -> if `cfg.trunk` (the factory trunk — `integration`
         by default) does not resolve here yet, self-heal it from `main`
         first (`ensure_factory_trunk`, MAP.md's integration-branch ruling —
         a plain `git branch`, never a checkout of `main` itself), THEN
         `worktree add -b <branch> <path> <base>`, one atomic command that
         creates the run's branch AND its tree — this is why the main
         checkout never moves (invariant 1).
    """
    root = resolve_root(main_root, cfg)
    prefix = f"adw/{adw_id}_"

    for w in git_helper.worktree_list(tree=main_root):
        branch = w.get("branch") or ""
        if branch.startswith(prefix) and not w.get("prunable"):
            path = Path(w["path"])
            _sync_toolchain(path)
            return RunWorktree(branch=branch, path=str(path), reused=True, base="")

    # A stale registration blocks a plain `worktree add` — clear it before
    # touching the branch/path below. Metadata only (9).
    git_helper.worktree_prune(tree=main_root)

    existing_branch = git_helper.find_run_branch(adw_id, tree=main_root)
    branch = existing_branch or git_helper.run_branch_name(adw_id, prompt)
    path = root / branch.removeprefix("adw/")   # 3.2: dir name == branch minus "adw/"

    if path.exists():
        raise RuntimeError(
            f"{path} exists on disk but git does not know it as a worktree for "
            f"{branch!r}. Park-never-delete applies to strangers too - this "
            f"factory will not touch it. Move it aside, or if it is genuinely "
            f"old debris, remove it yourself and rerun. "
            f"(`git -C {main_root} worktree list` shows what git DOES know about.)")

    base = ""
    if existing_branch:
        git_helper.worktree_add(path, branch, tree=main_root)
    else:
        if not git_helper.ref_exists(cfg.trunk, tree=main_root):
            healed = ensure_factory_trunk(main_root, cfg.trunk)
            if healed:
                print(f"worktrees: {healed}")
        base = (cfg.trunk if git_helper.ref_exists(cfg.trunk, tree=main_root)
               else git_helper.current_branch(tree=main_root))
        if base != cfg.trunk:
            print(f"WARNING: worktrees.trunk {cfg.trunk!r} does not resolve in this "
                 f"repo - basing {branch} off the main checkout's current HEAD "
                 f"({base!r}) instead.")
        git_helper.worktree_add(path, branch, tree=main_root, base=base)

    _sync_toolchain(path)
    return RunWorktree(branch=branch, path=str(path), reused=bool(existing_branch), base=base)


def ensure_factory_trunk(main_root: Path, trunk: str | None = None, *,
                         source: str = "main") -> str:
    """Self-heals the factory's own trunk (MAP.md's integration-branch
    ruling, 2026-08-15): the first run against a fresh checkout finds no
    `integration` branch at all, because nothing has cut one yet. Rather
    than let that degrade every such checkout to basing off whatever the
    main checkout happens to have checked out (`ensure_run_worktree`'s own
    fallback, kept below for when even THIS cannot heal), cut `trunk` from
    `source` right here — a plain `git branch <trunk> <source>`, never a
    checkout, so `source` (always `"main"` in practice — the one branch
    this call never creates, checks out, commits to, or moves) is left
    exactly as it was. Pushed to `origin` too, best effort, so the hub has
    it before any run's branch tries to compare against it remotely.

    `trunk` defaults to `git_helper.factory_trunk()` — env override
    `SSSF_INTEGRATION_BRANCH`, else `"integration"` — so a caller that just
    wants "the factory's trunk, whatever it is configured as" (the engine,
    a future server-side convergence step) can call this with no arguments.

    Never raises. Returns `""` when there was nothing to do (`trunk`
    already exists, or `trunk == source`) or nothing to heal FROM (`source`
    does not resolve either — a brand new repo with no commits yet; the
    caller's own fallback takes over from here) — else a short
    human-readable note of what happened, for the caller to log.
    """
    trunk = trunk or git_helper.factory_trunk()
    if trunk == source or git_helper.ref_exists(trunk, tree=main_root):
        return ""
    if not git_helper.ref_exists(source, tree=main_root):
        return ""
    try:
        git_helper.create_branch_from(trunk, source, tree=main_root)
    except RuntimeError as error:
        return f"could not create {trunk!r} from {source!r}: {error}"
    if not git_helper.has_remote("origin", tree=main_root):
        return f"created {trunk!r} from {source!r} (no 'origin' remote - stays local)"
    ok, push_error = git_helper.push_branch(trunk, tree=main_root)
    return (f"created {trunk!r} from {source!r} and pushed to origin" if ok
           else f"created {trunk!r} from {source!r} - push to origin failed: {push_error}")


def worktree_for(main_root: Path, adw_id: str) -> Path | None:
    """The path already registered for `adw_id`, if any — a read-only lookup
    for a caller that must not create anything."""
    prefix = f"adw/{adw_id}_"
    for w in git_helper.worktree_list(tree=main_root):
        if (w.get("branch") or "").startswith(prefix) and not w.get("prunable"):
            return Path(w["path"])
    return None


# ── the branch return: push a finished run's branch to origin ───────────────
#
# MAP.md's two-box model: the laptop's Gate can only see and merge a run's
# branch once it reaches the hub. Best-effort at run completion — never a
# reason to fail an otherwise-finished run (`Run.finish()` is the one call
# site; see runner.py).

def push_run_branch(main_root: Path, branch: str, trunk: str) -> tuple[str, str]:
    """Push `branch` to `origin`, IF it actually holds commits.

    Runs from `main_root`: every worktree shares one `.git`, so `branch` is
    a first-class ref there even when checked out in a linked worktree
    elsewhere (or, under `worktrees.enabled: false`, in `main_root` itself)
    — no need to cd anywhere to push it.

    Returns `(status, detail)`:
      - `("no-commits", "")` — nothing on `branch` beyond `trunk` yet (a
        worktree cut but no commit phase reached, or a read-only-shaped
        run) — nothing to make visible, so this is the silent, common case.
      - `("no-remote", "")` — no `origin` configured (a fresh clone fixture,
        a laptop-only experiment) — skip, not an error.
      - `("pushed", "")` — a clean `git push -u origin <branch>`.
      - `("failed", stderr)` — push attempted and refused; never raises,
        never retried with `--force`, never touches anything but `branch`.
    """
    ahead = (git_helper.rev_list_count(f"{trunk}..{branch}", tree=main_root)
             if trunk and git_helper.ref_exists(trunk, tree=main_root)
             else 1)  # trunk doesn't resolve here - can't measure "ahead", so don't gate on it
    if ahead == 0:
        return "no-commits", ""
    if not git_helper.has_remote("origin", tree=main_root):
        return "no-remote", ""
    ok, error = git_helper.push_branch(branch, tree=main_root)
    return ("pushed", "") if ok else ("failed", error)


# ── reconciliation: inventory, classify, prune_plan, render ─────────────────

def _first(mapping: dict[str, list[dict]], key: str) -> dict | None:
    values = mapping.get(key)
    return values[0] if values else None


def _adw_id_of(branch: str) -> str:
    """`adw/<adw_id>_<slug>` -> `<adw_id>`. Caller has already filtered to
    branches under `refs/heads/adw/`."""
    return branch.removeprefix("adw/").split("_", 1)[0]


def is_merged_into_trunk(main_root: Path, trunk: str, branch: str) -> bool:
    """Would merging `branch` into `trunk` change anything? (8.4) — exact,
    deterministic, and correct for squash, rebase and cherry-pick alike,
    unlike `merge-base --is-ancestor` (which a squash merge fails forever:
    the branch's own commits are never fast-forwarded into trunk, only a
    single new squash commit is).

    Requires git >= 2.38 (`--write-tree` mode). On an older git, or a merge
    `git_helper.merge_tree_write` cannot complete at all, this falls back to
    the ancestor test — which can only ever UNDER-report merged, the safe
    direction (parking work instead of pruning it).
    """
    tree_sha = git_helper.merge_tree_write(trunk, branch, tree=main_root)
    if tree_sha is not None:
        trunk_tree = git_helper.rev(f"{trunk}^{{tree}}", tree=main_root)
        return tree_sha == trunk_tree
    return git_helper.is_ancestor(branch, trunk, tree=main_root)


def classify(*, adw_id: str, dirty: bool, has_session: bool, session_status: str,
            live_processes: int, latest_event_age_minutes: float | None,
            merged_into_trunk: bool, ahead: int, trunk: str,
            stale_after_minutes: int) -> tuple[WorktreeState, str]:
    """Pure function over one row's precomputed facts -> (state, note).

    Order is the safety property (8.3), checked in this exact sequence and no
    other: alive, then orphan ("you cannot decide anything about a tree you
    cannot name"), then unmerged, then merged last. Nothing here shells out to
    git — every fact it needs arrives as a parameter — which is what makes it
    unit-testable without a repo.
    """
    if session_status == "running" or live_processes > 0:
        if latest_event_age_minutes is not None and latest_event_age_minutes > stale_after_minutes:
            hours = latest_event_age_minutes / 60
            return "alive", f"alive (stale {hours:.1f}h)"
        return "alive", ""

    evidence = f"{ahead} commit(s) not in {trunk}, tree {'dirty' if dirty else 'clean'}"

    if not has_session:
        return "orphan", f"CANNOT NAME: {evidence} - no session row for adw_id {adw_id}"
    if dirty or not merged_into_trunk:
        return "unmerged", f"HOLDS WORK: {evidence}, session {session_status or 'unknown'!r}"
    return "merged", ""


def _title_from_branch_event(payload_json: str | None) -> str:
    """The `title` field of the run's `branch` trace event payload (see
    `runner.Run._log_branch_and_title`), or "" when there is none — no
    payload at all, malformed JSON, or telemetry recorded before this fix
    (the pre-worktree `branch` PHASE logged a bare `{"branch": ...}`, no
    title). `_build_row` falls back to a humanized slug in that case.
    """
    if not payload_json:
        return ""
    try:
        payload = json.loads(payload_json)
    except (json.JSONDecodeError, TypeError):
        return ""
    return str(payload.get("title") or "") if isinstance(payload, dict) else ""


def _read_sessions(db_path: Path) -> dict[str, dict]:
    """adw_id -> {status, request, live_processes, latest_event, title}.

    Read-only by construction (`mode=ro`) — this is what makes "this tool
    never writes to sssf.db" checkable rather than merely intended (invariant
    6). A MISSING db file is not fatal (a fresh clone has branches and no
    trace); only a db that exists but cannot be opened/queried raises (8.1's
    exit 2 — "unreadable db").
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return {}
    uri = f"file:{db_path.as_posix()}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
        try:
            rows = conn.execute(
                "SELECT s.adw_id, s.status, s.request, "
                "  (SELECT COUNT(*) FROM processes p WHERE p.adw_id = s.adw_id "
                "     AND p.ended_at IS NULL) AS live_processes, "
                "  (SELECT MAX(e.started_at) FROM events e WHERE e.adw_id = s.adw_id) "
                "     AS latest_event, "
                "  (SELECT e2.payload_json FROM events e2 WHERE e2.adw_id = s.adw_id "
                "     AND e2.type = 'log' AND e2.name = 'branch' "
                "     ORDER BY e2.started_at DESC LIMIT 1) AS branch_payload "
                "FROM sessions s").fetchall()
        finally:
            conn.close()
    except sqlite3.Error as error:
        raise ReconciliationError(f"could not read {db_path}: {error}") from error
    return {row[0]: {"status": row[1] or "", "request": row[2] or "",
                     "live_processes": row[3] or 0, "latest_event": row[4] or "",
                     "title": _title_from_branch_event(row[5])}
           for row in rows}


def _build_row(adw_id: str, wt: dict | None, branch_rec: dict | None,
               session: dict | None, main_root: Path, cfg: WorktreesConfig,
               now: datetime) -> WorktreeRow:
    if wt is None and branch_rec is None:
        # A session that legitimately never cut anything — the 5th,
        # informational, --all-only row type (8.3).
        return WorktreeRow(adw_id=adw_id, state="no-tree",
                           request=(session or {}).get("request", ""),
                           status=(session or {}).get("status", ""))

    branch_name = (wt or branch_rec or {}).get("branch", "") or ""
    path = wt["path"] if wt else ""

    # Title (3(a)): the trace's own record when this run stamped one, else the
    # branch slug humanized — never a re-derivation from `request`, which can
    # run to hundreds of characters and was never meant to be a title.
    title = (session or {}).get("title", "")
    if not title and branch_name:
        slug = branch_name.split("_", 1)[1] if "_" in branch_name else ""
        title = git_helper.humanize_slug(slug) if slug else ""

    dirty = False
    if wt:
        dirty = git_helper.is_dirty(tree=path) or bool(git_helper.untracked_files(tree=path))

    ahead = 0
    if branch_name and git_helper.ref_exists(cfg.trunk, tree=main_root):
        ahead = git_helper.rev_list_count(f"{cfg.trunk}..{branch_name}", tree=main_root)

    merged = False
    if branch_name and not dirty:
        merged = is_merged_into_trunk(main_root, cfg.trunk, branch_name)

    age_minutes = None
    latest_event = (session or {}).get("latest_event")
    if latest_event:
        age_minutes = minutes_since(latest_event, now)

    state, note = classify(
        adw_id=adw_id, dirty=dirty, has_session=session is not None,
        session_status=(session or {}).get("status", ""),
        live_processes=(session or {}).get("live_processes", 0),
        latest_event_age_minutes=age_minutes, merged_into_trunk=merged,
        ahead=ahead, trunk=cfg.trunk, stale_after_minutes=cfg.stale_after_minutes)

    return WorktreeRow(adw_id=adw_id, branch=branch_name, path=path, title=title, state=state,
                       ahead=ahead, dirty=dirty,
                       request=(session or {}).get("request", ""),
                       status=(session or {}).get("status", ""), note=note)


def inventory(main_root: Path, cfg: WorktreesConfig,
             db_path: str | Path | None) -> list[WorktreeRow]:
    """Full outer join of the three read-only sources (8.2): `git worktree
    list`, `git for-each-ref refs/heads/adw/`, and the `sessions` table.

    Two branches sharing an adw_id is exit 2 with both names printed (via
    `ReconciliationError`) — which one holds the work is not decidable from
    here, and guessing is how work gets lost.
    """
    if not git_helper.is_repo(tree=main_root):
        raise ReconciliationError(f"{main_root} is not a git repository")

    main_resolved = str(Path(main_root).resolve())
    wt_by_id: dict[str, list[dict]] = {}
    for w in git_helper.worktree_list(tree=main_root):
        if str(Path(w["path"]).resolve()) == main_resolved:
            continue                                  # the main checkout's own row
        branch = w.get("branch") or ""
        if not branch.startswith("adw/"):
            continue                                  # not one of this factory's run branches
        wt_by_id.setdefault(_adw_id_of(branch), []).append(w)

    br_by_id: dict[str, list[dict]] = {}
    for b in git_helper.list_run_branches(tree=main_root):
        br_by_id.setdefault(_adw_id_of(b["branch"]), []).append(b)

    dupes: dict[str, list[str]] = {}
    for adw_id in set(wt_by_id) | set(br_by_id):
        names = {w["branch"] for w in wt_by_id.get(adw_id, [])} | \
               {b["branch"] for b in br_by_id.get(adw_id, [])}
        if len(names) > 1:
            dupes[adw_id] = sorted(names)
    if dupes:
        detail = "; ".join(f"{adw_id}: {names}" for adw_id, names in dupes.items())
        raise ReconciliationError(
            f"two branches share an adw_id - cannot decide which holds the work "
            f"({detail}). Rename or remove one of them.")

    sessions = _read_sessions(Path(db_path)) if db_path else {}

    now = datetime.now(timezone.utc)
    all_ids = set(wt_by_id) | set(br_by_id) | set(sessions)
    return [_build_row(adw_id, _first(wt_by_id, adw_id), _first(br_by_id, adw_id),
                       sessions.get(adw_id), main_root, cfg, now)
           for adw_id in sorted(all_ids)]


def exit_code_for(rows: list[WorktreeRow]) -> int:
    """0 nothing stranded — 1 at least one `unmerged`/`orphan` row (8.1)."""
    return 1 if any(r.state in ("unmerged", "orphan") for r in rows) else 0


_STATE_ORDER = {"alive": 0, "unmerged": 1, "orphan": 2, "merged": 3, "no-tree": 4}


def render(rows: list[WorktreeRow]) -> str:
    """ASCII table, and a table even when empty (8.5) — an empty-but-headed
    table says "nothing is stranded"; no output at all says "the tool broke".
    """
    ordered = sorted(rows, key=lambda r: (_STATE_ORDER.get(r.state, 9), r.adw_id))
    # TITLE leads (before ADW_ID): "an id tells me nothing - I want to know
    # which worktree ran which ticket" — the human name, not the id, is what
    # answers that at a glance. From the trace when the run stamped one, else
    # the branch slug humanized (`_build_row`); "" only for a no-tree row.
    header = f"{'STATE':<9} {'TITLE':<28} {'ADW_ID':<9} {'BRANCH':<40} {'AHEAD':>5} D {'REQUEST'}"
    sep = f"{'-' * 9} {'-' * 28} {'-' * 9} {'-' * 40} {'-' * 5} - {'-' * 30}"
    lines = [header, sep]
    for row in ordered:
        dirty_mark = "*" if row.dirty else " "
        # Collapse internal whitespace first — a multi-line prompt stored
        # verbatim as `row.request` would otherwise inject raw newlines into
        # the middle of an ASCII table row and break it across lines.
        request = " ".join((row.request or "").split())[:60]
        title = " ".join((row.title or "").split())[:28]
        lines.append(f"{row.state:<9} {title:<28} {row.adw_id:<9} {row.branch:<40} "
                     f"{row.ahead:>5} {dirty_mark} {request}")
        if row.path:
            lines.append(f"          worktree: {row.path}")
        if row.note:
            lines.append(f"          {row.note}")

    counts: dict[str, int] = {}
    for row in ordered:
        counts[row.state] = counts.get(row.state, 0) + 1
    stranded = counts.get("unmerged", 0) + counts.get("orphan", 0)
    parts = [f"{counts[s]} {s}" for s in ("alive", "merged", "no-tree") if counts.get(s)]
    if stranded:
        parts.append(f"{stranded} STRANDED (unmerged/orphan)")
    summary = ", ".join(parts) if parts else "nothing"
    lines.append("")
    lines.append(f"{len(ordered)} row(s): {summary}. exit {exit_code_for(ordered)}.")
    return "\n".join(lines)


@dataclass
class PruneAction:
    """One row's disposition under `worktrees-prune` — either the exact,
    argv-list commands that would remove it (`prunable=True`), or the reason
    it is kept. `commands` are argv lists WITHOUT the leading "git", ready for
    `git_helper.run(*command, tree=main_root)`."""

    adw_id: str
    branch: str
    path: str
    prunable: bool
    reason: str = ""
    commands: list[list[str]] = field(default_factory=list)


def prune_plan(rows: list[WorktreeRow]) -> list[PruneAction]:
    """What `worktrees-prune` would do — a PURE function over already-
    classified rows, so the refusal ("only merged rows, never `--force`, never
    `-D`") is unit-testable without a repo and cannot be routed around by any
    future flag or caller (9).
    """
    actions = []
    for row in rows:
        if row.state != "merged":
            reason = row.note or f"state={row.state}"
            actions.append(PruneAction(
                adw_id=row.adw_id, branch=row.branch, path=row.path, prunable=False,
                reason=f"kept {row.adw_id} {row.branch} - {reason}. this tool never "
                      f"removes these. merge it, or remove it yourself once you have "
                      f"looked."))
            continue
        commands: list[list[str]] = []
        if row.path:
            commands.append(["worktree", "remove", row.path])
        if row.branch:
            commands.append(["branch", "-d", row.branch])
        actions.append(PruneAction(adw_id=row.adw_id, branch=row.branch, path=row.path,
                                   prunable=True, commands=commands))
    return actions


def apply_prune(main_root: Path, plan: list[PruneAction]) -> list[str]:
    """Execute only the `prunable` actions, in the order `prune_plan` gave
    them, reporting git's own refusal rather than raising — git is the
    second/third safety net (9): a dirty tree or an unmerged branch is
    refused by git itself, and no `--force`/`-D` is ever passed here to route
    around that. `git worktree prune`'s metadata sweep runs once, at the end,
    only if something was actually removed.
    """
    report = []
    removed_any = False
    for action in plan:
        if not action.prunable:
            continue
        ok = True
        for command in action.commands:
            result = git_helper.run(*command, tree=main_root)
            if result.returncode != 0:
                ok = False
                report.append(f"{action.adw_id} {action.branch}: git {' '.join(command)} "
                              f"refused - {result.stderr.strip()}")
                break
            removed_any = True
        if ok:
            report.append(f"{action.adw_id} {action.branch}: pruned")
    if removed_any:
        git_helper.worktree_prune(tree=main_root)
    return report
