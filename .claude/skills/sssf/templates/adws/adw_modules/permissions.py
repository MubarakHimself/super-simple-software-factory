"""What an agent may CHANGE, enforced in code after the fact.

`tools:` is a capability list, not a sandbox, and two holes make it
unenforceable on its own:

  * `bash` runs anything. A builder handed bash to run a test suite can also
    run `git checkout adws/` — which is not hypothetical: one did, discarding
    uncommitted changes to the very quality check it was about to be judged by.
  * `write` reaches any path, not just the one report file an agent was given
    it for. A reviewer configured with "no edit, so it cannot quietly fix"
    could still rewrite the code it was reviewing.

So permission is verified the way every other claim in this system is —
after the fact, against the repo itself. `snapshot()` fingerprints the working
tree's change-set before an agent runs; `enforce()` compares it afterwards and
fails the phase if the agent touched anything outside its allowlist.

Comparing change-sets, rather than watching for writes, is what catches the
`git checkout` case: a path that was modified before the agent ran and is clean
afterwards has been reverted, and a reversion is a modification. Appearing,
disappearing, and changing all count.

A change-set is measured against HEAD, though, so it goes blind the moment the
agent MOVES HEAD — `git commit` hides an agent's whole diff behind it. So the
refs are recorded too (`snapshot_refs`/`enforce_refs`), and any movement of
HEAD or the branch across an agent phase is the same kind of breach.

A breach is NOT a gate violation. Gates are for work an agent can be asked to
redo; a breach cannot be corrected by re-prompting, because the write already
happened. It aborts the phase and names every offending path.

Two keys drive it, both in sssf.config.yaml:
    defaults.protected_files   paths no agent may touch unless it names them itself
    agents[].writes      None = unrestricted · [] = read-only · [...] = only these
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .data_types import AgentConfig, EventRecord, SSSFConfig


class PermissionBreach(RuntimeError):
    """An agent modified a path it was not permitted to modify."""


def _git(args: list[str], cwd) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                            encoding="utf-8")
    return result.stdout if result.returncode == 0 else ""


def _snapshot_tree(cwd) -> dict[str, str]:
    """Fingerprint every path `cwd`'s working tree currently differs on.

    Tracked files carry their numstat counts, so an edit to an already-dirty
    file still registers as a change. Untracked files are listed by name.
    Gitignored paths never appear, which is why the session runtime under
    `data_dir` — where handoff files legitimately land — needs no special case.
    """
    fingerprints: dict[str, str] = {}
    for line in _git(["diff", "HEAD", "--numstat"], cwd).splitlines():
        fields = line.split("\t")
        if len(fields) >= 3:
            path = fields[-1].strip()
            fingerprints[path] = f"{fields[0]},{fields[1]}"
    for path in _git(["ls-files", "--others", "--exclude-standard"], cwd).splitlines():
        if path.strip():
            fingerprints[path.strip()] = "untracked"
    return fingerprints


def snapshot(run) -> dict[str, str]:
    """Fingerprint the RUN's own tree — `run.repo_root`, the worktree once
    one has been entered."""
    return _snapshot_tree(run.repo_root)


# ── the ref tripwire: what the content snapshot cannot see ───────────────────
#
# THE HOLE THIS CLOSES. Everything above compares the WORKING TREE against
# HEAD. An agent that COMMITS erases its own evidence from that comparison:
# `git diff HEAD --numstat` after `git commit -am` reports nothing, the
# untracked list is empty, and `enforce()` concludes the agent touched no path
# at all. The same is true of `git checkout <branch>`, `git reset --hard`, and
# `git stash` — each one moves HEAD or the branch out from under the very
# baseline the content check is measured against, and every one of them is
# reachable from the `bash` tool the builder legitimately needs to run a test
# suite.
#
# So the refs are recorded too, before and after every agent phase, and any
# movement is a breach. It is deliberately absolute rather than clever: within
# ONE agent phase the runner never commits and never switches branches. Branch
# creation happens in `Run.enter_worktree()`, before any agent runs; commits
# happen in a `code` phase of their own (`git_helper.commit_all`), never inside
# an agent phase. So "HEAD moved during an agent phase" has exactly one
# author — the agent — and needs no bookkeeping to attribute.
#
# Two `rev-parse` answers from ONE git call per boundary, which is nothing
# beside the coding-agent turn it brackets.


def _snapshot_refs(cwd) -> tuple[str, str]:
    """`(HEAD sha, branch name)` for `cwd` — one `git rev-parse` for both.

    A non-git directory (the four read-only ADWs run fine in one) answers
    `("", "")` for both the before and the after, which compares equal and
    trips nothing. A detached HEAD answers `"HEAD"` for the branch, which is a
    perfectly good value to compare — it changing means the tree was
    reattached under the agent.
    """
    out = _git(["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], cwd).splitlines()
    head = out[0].strip() if out else ""
    branch = out[1].strip() if len(out) > 1 else ""
    return head, branch


def snapshot_refs(run) -> tuple[str, str]:
    """Record the RUN's own tree refs — the other half of `snapshot()`'s
    baseline, taken at the same moment and compared by `enforce_refs()`."""
    return _snapshot_refs(run.repo_root)


def enforce_refs(run, agent: AgentConfig, before: tuple[str, str]) -> None:
    """Fail the phase if HEAD or the branch moved while the agent was working.

    Checked BEFORE the content comparison in `enforce()`, and that order is the
    whole point: a commit is what BLINDS the content comparison, so discovering
    it afterwards would mean reporting "this agent touched nothing" about a run
    that rewrote the repo. Raising the same `PermissionBreach` means the caller
    needs no new branch — a breach already aborts the phase and is already
    traced, because it cannot be corrected by re-prompting (the write has
    happened).

    One honest caveat, named in the message rather than papered over: for the
    read-only ADWs `repo_root` IS the main checkout, where the operator is a
    legitimate second author. An operator committing there during a long
    `adw_scout` run trips this. That is the right trade — the alternative is a
    tripwire that is silent in exactly the checkout where an agent's commit
    would be least expected and hardest to spot — and the message says which
    two things it could be, so a human is never left guessing.
    """
    after = _snapshot_refs(run.repo_root)
    if after == before:
        return
    moved = []
    if after[0] != before[0]:
        moved.append(f"HEAD {before[0][:12] or '(none)'} -> {after[0][:12] or '(none)'}")
    if after[1] != before[1]:
        moved.append(f"branch {before[1] or '(none)'} -> {after[1] or '(none)'}")
    raise PermissionBreach(
        f"{agent.name} moved this run's git refs in {run.repo_root}: {'; '.join(moved)}. "
        f"The runner does not commit, branch or check out inside an agent phase - branches "
        f"are cut before any agent runs and commits happen in their own code phase - so "
        f"this came from the agent itself (a `git commit`, `checkout`, `reset` or `stash` "
        f"through its bash tool), or from a person working in this same checkout while the "
        f"run was in flight. Either way the content check below is now blind: a commit "
        f"moves the agent's edits behind HEAD, where `git diff HEAD` cannot see them. "
        f"Nothing was rolled back - this factory does not rewrite history it did not "
        f"write. Inspect it with: git -C {run.repo_root} log --stat -3")


def snapshot_main(run) -> dict[str, str]:
    """Fingerprint the MAIN CHECKOUT — always `run.main_root`, regardless of
    where the run's own tree has moved to. The other half of the tripwire's
    diff (5.5)."""
    return _snapshot_tree(run.main_root)


def changed_paths(before: dict[str, str], after: dict[str, str]) -> list[str]:
    """Every path whose state differs — appeared, vanished, or was rewritten."""
    return sorted({p for p in set(before) | set(after)
                   if before.get(p) != after.get(p)})


def _glob(pattern: str) -> re.Pattern:
    """Translate a pattern, with `*` stopping at a path separator.

    fnmatch would let `*` cross `/`, which quietly widens every pattern:
    `adws/adw_*.py` would match `adws/adw_data/sessions/x/y.py` as well as the
    ADW scripts it means. `**` is the way to say "cross directories".
    """
    out, i = [], 0
    while i < len(pattern):
        char = pattern[i]
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif char == "*":
            out.append("[^/]*")
            i += 1
        elif char == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(char))
            i += 1
    return re.compile("".join(out))


def _matches(path: str, pattern: str) -> bool:
    if pattern.endswith("/"):                      # directory prefix
        return path.startswith(pattern)
    if "*" in pattern or "?" in pattern:
        return _glob(pattern).fullmatch(path) is not None
    return path == pattern


def always_writable(cfg: SSSFConfig) -> list[str]:
    """The session runtime, which EVERY agent must be able to write.

    `context_handoff/` is the one place agents hand work to each other, and an
    agent's own prompts, raw_output.jsonl, and envelope.json land beside it.
    Scout writes its findings there, the reviewer its review, the planner its
    plan — a read-only agent is read-only with respect to the REPO, never with
    respect to its own report.

    This is granted from `data_dir` rather than left to .gitignore. The runtime
    is normally ignored, so it never even appears in a snapshot — but an agent's
    ability to record its work must not hang on a gitignore entry that someone
    can delete or that a changed `data_dir` can outgrow.
    """
    return [cfg.defaults.data_dir.rstrip("/") + "/"]


def permitted(path: str, agent: AgentConfig, cfg: SSSFConfig) -> bool:
    """Session runtime first, then the agent's own list, then what is protected."""
    if any(_matches(path, p) for p in always_writable(cfg)):
        return True
    if any(_matches(path, p) for p in (agent.writes or [])):
        return True                      # naming a path is what unlocks a protected one
    if any(_matches(path, p) for p in cfg.defaults.protected_files):
        return False
    return agent.writes is None          # None = unrestricted, [] = no repo writes


def _roll_back(run, path: str, before: dict[str, str], after: dict[str, str]) -> str:
    """Undo one unauthorized change. Returns a word describing what happened.

    Only changes the agent INTRODUCED are undone. A path that was already dirty
    when the agent started is left exactly as it is: the operator had
    uncommitted work there, and discarding it to tidy up would be the same harm
    this module exists to prevent, committed by the cleanup instead of the agent.
    """
    if path in before:
        # Already dirty beforehand. If it is gone from the diff now, the agent
        # reverted an engineer's uncommitted work and the content is not ours
        # to reconstruct — say so loudly rather than pretend it was handled.
        return "REVERTED-BY-AGENT (uncommitted work lost, cannot restore)" \
            if path not in after else "left as-is (was already modified)"
    if after.get(path) == "untracked":
        try:
            (Path(run.repo_root) / path).unlink()
            return "deleted"
        except OSError as error:
            return f"could not delete ({error})"
    result = subprocess.run(["git", "checkout", "--", path],
                            cwd=run.repo_root, capture_output=True, text=True,
                            encoding="utf-8")
    return "rolled back" if result.returncode == 0 else "could not roll back"


def _check_main_checkout(run) -> list[str]:
    """The tripwire (5.5): the enforcement window narrows to the run's own
    tree the moment a worktree exists, so an agent using `bash` with an
    absolute path into the main checkout would otherwise be invisible to
    `enforce()` below. The baseline is seeded by `Run.enter_worktree()` —
    BEFORE any agent runs, not lazily here — so this compares `run.main_root`
    against a snapshot that predates the first agent phase, not one taken
    after it. A changed path matching `protected_files` raises the SAME
    `PermissionBreach` a same-tree breach would (MAP rule 13 — the factory's
    own machinery must not change under a running ADW); anything else is
    returned for the caller to log as non-fatal drift — the operator editing
    `apps/ui` or `docs/` in the main checkout while a run is in flight is
    normal life on this laptop and must not abort an overnight run.

    No-op when the run has no worktree (`repo_root == main_root`): `enforce`'s
    own same-tree check already covers that directory in full, and snapshotting
    it a second time would just re-report the same permitted changes as drift.
    """
    if str(run.repo_root) == str(run.main_root):
        return []
    before = run._main_checkout_snapshot
    after = snapshot_main(run)
    run._main_checkout_snapshot = after
    if before is None:
        # Unreachable in normal operation: `enter_worktree()` seeds the
        # baseline before the first agent phase runs, and the guard above
        # already returns early for any run that has not entered a worktree
        # (repo_root == main_root). Kept as a defensive no-op rather than an
        # AttributeError if a future call path ever reaches here first.
        return []
    touched = changed_paths(before, after)
    if not touched:
        return []
    protected = run.cfg.defaults.protected_files
    breaches = [p for p in touched if any(_matches(p, pattern) for pattern in protected)]
    if breaches:
        raise PermissionBreach(
            f"the main checkout ({run.main_root}) changed during this run and touched "
            f"protected path(s): {breaches} - the factory's own machinery must not "
            f"change under a running ADW (MAP rule 13). This did not come through the "
            f"run's own tree ({run.repo_root}); something wrote there directly.")
    return touched


def enforce(run, phase, agent: AgentConfig, before: dict[str, str]) -> list[str]:
    """Compare the tree against `before`; undo and raise if the agent overstepped.

    Returns the paths it legitimately changed, so the trace records what an
    agent actually touched rather than only what it claimed in its envelope.

    Detection alone would leave the repo holding the unauthorized change while
    reporting a failure, so anything the agent introduced outside its allowlist
    is rolled back before the phase dies. What it cannot undo, it names.
    """
    after = snapshot(run)
    touched = changed_paths(before, after)
    breaches = [p for p in touched if not permitted(p, agent, run.cfg)]

    drift = _check_main_checkout(run)               # may itself raise PermissionBreach
    if drift:
        run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                     type="log", name="main_checkout_drift",
                                     payload={"agent": agent.name, "paths": drift,
                                              "main_root": str(run.main_root)}))

    if not breaches:
        return touched

    outcomes = {p: _roll_back(run, p, before, after) for p in breaches}
    scope = ("read-only" if agent.writes == []
             else f"limited to {agent.writes}" if agent.writes
             else f"barred from {run.cfg.defaults.protected_files}")
    detail = "\n".join(f"  - {p} - {outcome}" for p, outcome in outcomes.items())
    raise PermissionBreach(
        f"{agent.name} is {scope} but modified {len(breaches)} path(s):\n{detail}")
