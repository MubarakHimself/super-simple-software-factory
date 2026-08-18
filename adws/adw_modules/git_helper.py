"""Low-level git operations for code phases. All low-level logic lives in adw_modules.

Every function takes an explicit `tree=` naming the working directory git runs
against, rather than inheriting the process cwd. Under the worktree layer the
process cwd stays the main checkout (see runner.py/session.py) while an agent's
own work happens in a worktree named by `run.repo_root` - so a git call with no
`tree` and one with the wrong `tree` are both bugs, just very different ones.

    - QUERY functions (rev, short_sha, merge_base, diff_*, is_dirty,
      untracked_files, current_branch, ref_exists, changed_files, is_repo,
      is_ancestor) take `tree: Path | str | None = None`, defaulting to the
      process cwd - this is what keeps `repo_root()`, the reconciliation CLI,
      and the pre-worktree tests working unchanged.
    - MUTATING functions (create_branch, commit_all, ensure_run_branch) take
      `tree` as a REQUIRED keyword-only argument. Forgetting it is a mypy
      error at the call site, not a silent commit to the wrong tree.

EVERY git subprocess in this module goes through `_run_git` below, and nothing
in here calls `subprocess.run` directly. That single door is what makes three
guarantees hold everywhere rather than at the sites somebody remembered:
unattended git never PROMPTS (`git_env`), never SIGNS (`SIGNING_OFF`), and
never runs forever (`NETWORK_TIMEOUT` / `LOCAL_TIMEOUT`). All three exist
because the engine's loop is a single thread: one git command waiting on a
password prompt with no terminal to print it on stops the whole factory,
silently, while systemd still calls the service `active`.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

# ── the factory trunk (MAP.md's integration-branch ruling, 2026-08-15) ──────
#
# Run branches fork from this and are measured against it - never `main`,
# which is human-owned now, moved only by a squash merge in the UI, and
# never checked out, committed to, or moved by anything in this file. Env
# override so a server converge, a systemd unit, or an operator's shell can
# name a different line without editing a config file (the same pattern
# `SSSF_CONFIG` already uses for the roster - see dispatch.py/engine.py).
FACTORY_TRUNK_ENV = "SSSF_INTEGRATION_BRANCH"
FACTORY_TRUNK_DEFAULT = "integration"


def factory_trunk() -> str:
    """The factory's own working line: env override `SSSF_INTEGRATION_BRANCH`,
    else `"integration"`. The one place this name is decided - every caller
    that wants "the trunk, whatever it is configured as" asks here rather
    than repeating the literal (engine.py's `integration_branch()` is a thin
    alias over this, so the loop and the worktree layer can never disagree
    about which branch the factory is standing on).

    An unset variable and an EMPTY one mean the same thing: the default. A
    systemd unit with a bare `Environment=SSSF_INTEGRATION_BRANCH=` would
    otherwise hand every caller `""` as a branch name, which git answers for
    with a different error at each call site.
    """
    return (os.environ.get(FACTORY_TRUNK_ENV) or "").strip() or FACTORY_TRUNK_DEFAULT


# ── how every git subprocess in this factory is launched ────────────────────
#
# THE FAILURE THIS CLOSES. Nothing here ran with a timeout or a non-interactive
# environment, and the factory's whole point is that it runs unattended. A git
# that decides to ASK a question - for a password, for an SSH host key, for a
# GPG passphrase - has no terminal to ask on under systemd, and blocks forever
# holding the engine's single loop thread. The service stays `active`, the
# journal stays silent, and the Board stops moving with no error anywhere.
# Every one of these is a real, reachable state on a fresh server: an https
# remote whose credential helper is not configured, a hub whose host key is not
# in known_hosts yet, a `commit.gpgsign = true` inherited from the operator's
# own global gitconfig.
#
# So git is launched here, and only here, with the questions turned off.


def git_env() -> dict[str, str]:
    """The environment EVERY git subprocess this module launches runs under.

    A fixed overlay on the operator's own environment, not a replacement - git
    still needs their HOME, their SSH agent, their credential helpers. What is
    pinned:

        GIT_TERMINAL_PROMPT=0   git fails instead of prompting for credentials.
        GIT_ASKPASS=""          and does not shell out to a GUI asker either -
                                empty rather than unset, because an inherited
                                SSH_ASKPASS/GIT_ASKPASS from the operator's
                                desktop session is exactly what pops an
                                invisible dialog on a headless box.
        GIT_SSH_COMMAND         BatchMode=yes: ssh fails rather than asking for
                                a passphrase or a password.
                                StrictHostKeyChecking=accept-new: a hub whose
                                key is not known yet is trusted on first sight
                                (and pinned after), instead of hanging on
                                "Are you sure you want to continue connecting?"
                                - while a key that CHANGED is still refused,
                                which `no` would not give us.
        GIT_OPTIONAL_LOCKS=0    a read-only query never takes index.lock, so a
                                background `git status` cannot make a concurrent
                                run's commit fail on a lock it did not need.

    Deliberately NOT cached: the operator's environment is read at each call, so
    a repaired `.env` or a newly started ssh-agent is picked up with no restart -
    the same rule `agent_pi.pi_cmd()` and `utils.uv_bin()` follow.
    """
    return {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "",
        "GIT_SSH_COMMAND": "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
        "GIT_OPTIONAL_LOCKS": "0",
    }


# Signing, neutralized centrally. `-c` overrides beat every config file, and
# they are prepended to EVERY invocation rather than sniffed per verb: `-c
# commit.gpgsign=false` is inert for `git status` and correct for `git commit`,
# `git merge`, `git rebase`, `git cherry-pick` and `git am` alike - all of which
# create commits, and all of which this factory runs. Sniffing the verb would
# have to enumerate that list correctly forever; this cannot get it wrong.
#
# It is here rather than at the three commit sites (this file's `commit_all`,
# engine.py's `commit_card` and `park_card`) because every one of them reaches
# git through `_git`/`run` below, so one place covers them all - and covers the
# next commit site nobody remembers to update. An operator with `commit.gpgsign
# = true` in their global gitconfig would otherwise have every factory commit
# hang waiting for a passphrase prompt that has no terminal to appear on.
SIGNING_OFF = ("-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false")

# Default ceilings. A git command that has not answered in this long is not
# slow, it is stuck - and the engine's loop is single-threaded, so stuck means
# the whole factory stops. Two tiers, because the honest bound is different by
# an order of magnitude: a push over a slow link legitimately takes minutes,
# while `rev-parse` in a local checkout takes milliseconds and one that has run
# for a minute is never going to answer.
NETWORK_TIMEOUT = 300.0
LOCAL_TIMEOUT = 60.0

# The verbs that touch the network. Everything else is a local query or a local
# mutation, and gets the short ceiling.
NETWORK_VERBS = frozenset({"push", "fetch", "pull", "clone", "ls-remote"})

# What a timed-out `run()` reports back. 124 is what `timeout(1)` uses and what
# `quality._run` already stamps on its own expiries, so every reader in this
# factory already means the same thing by it.
TIMEOUT_RETURNCODE = 124


# git's pre-subcommand options that take their value as a SEPARATE argument.
# `git -c key=value push` puts `key=value` between the option and the verb, and
# a scan that only skipped things starting with `-` would read that value as
# the verb and quietly give a push the 60s local ceiling.
_OPTIONS_WITH_VALUES = frozenset({"-c", "-C", "--git-dir", "--work-tree",
                                  "--namespace", "--exec-path"})


def _timeout_for(args: tuple[str, ...], override: float | None) -> float:
    """The ceiling for this invocation: the caller's own, else the tier the
    verb belongs to.

    The verb is the first argument that is neither an option nor an option's
    value, so neither a `--no-pager` flag nor a `-c key=value` pair can hide it
    and silently downgrade a network call to the local ceiling.
    """
    if override is not None:
        return override
    skip_next = False
    for arg in args:
        if skip_next:
            skip_next = False
            continue
        if arg.startswith("-"):
            # `--git-dir=x` carries its value inline and needs no skip; the
            # separate-value spelling does.
            skip_next = arg in _OPTIONS_WITH_VALUES
            continue
        return NETWORK_TIMEOUT if arg in NETWORK_VERBS else LOCAL_TIMEOUT
    return LOCAL_TIMEOUT


def _argv(args: tuple[str, ...]) -> list[str]:
    return ["git", *SIGNING_OFF, *args]


def _run_git(args: tuple[str, ...], tree: Path | str | None,
             timeout: float | None) -> subprocess.CompletedProcess[str]:
    """One git subprocess, with this module's environment, signing overrides and
    timeout applied. A timeout comes back as a FAILED CompletedProcess rather
    than an exception, because that is the shape every caller in this file
    already branches on - `returncode != 0` with git's own words in `stderr`.
    Letting `TimeoutExpired` escape would sail past every one of those checks
    and land in `engine.run_cycle`'s catch-all as an unnamed cycle failure."""
    limit = _timeout_for(args, timeout)
    try:
        return subprocess.run(_argv(args), cwd=tree, capture_output=True, text=True,
                              encoding="utf-8", env=git_env(), timeout=limit, check=False)
    except subprocess.TimeoutExpired as expired:
        # TimeoutExpired.stdout/.stderr are typed bytes|str and a timeout can
        # interrupt the reader before it has decoded anything, so both are
        # normalized here even though the call above passed `encoding=`.
        def _text(raw: bytes | str | None) -> str:
            if isinstance(raw, bytes):
                return raw.decode("utf-8", errors="replace")
            return raw or ""
        return subprocess.CompletedProcess(
            args=_argv(args), returncode=TIMEOUT_RETURNCODE, stdout=_text(expired.stdout),
            stderr=(_text(expired.stderr)
                    + f"\ngit {' '.join(args)} timed out after {limit:g}s and was killed. "
                      f"Unattended git never prompts (GIT_TERMINAL_PROMPT=0, ssh BatchMode), "
                      f"so this is a hung network call or a stuck lock, not a question "
                      f"waiting for an answer."))


def _git(*args: str, tree: Path | str | None = None,
         timeout: float | None = None) -> str:
    result = _run_git(args, tree, timeout)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def run(*args: str, tree: Path | str,
        timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    """Run an arbitrary git subcommand against `tree`, never raising.

    For callers that need to inspect a REFUSAL rather than treat it as fatal -
    git itself is the second/third safety net for `worktrees-prune` (a dirty
    tree or an unmerged branch is refused by git itself; this factory never
    passes --force or -D to route around that refusal).

    A timeout is one more refusal: exit 124 with the reason in `stderr`, which
    every existing caller already handles as "this git command did not work",
    with no new branch to write.
    """
    return _run_git(args, tree, timeout)


def is_repo(tree: Path | str | None = None) -> bool:
    return _run_git(("rev-parse", "--git-dir"), tree, None).returncode == 0


def repo_root() -> Path:
    """Absolute root of the codebase — where agents are spawned to work.

    The git toplevel when there is one, else the process cwd (ADWs run fine in a
    non-git dir; only a commit phase requires a repo). Always absolute, so it is
    safe to hand to a subprocess regardless of where the ADW was launched from.

    Deliberately takes no `tree`: this always answers for the PROCESS's own
    cwd, which under the worktree layer is always the main checkout (5.1) -
    this is `Run.main_root`'s source, not a general-purpose query.
    """
    if is_repo():
        return Path(_git("rev-parse", "--show-toplevel")).resolve()
    return Path.cwd().resolve()


def current_branch(tree: Path | str | None = None) -> str:
    return _git("rev-parse", "--abbrev-ref", "HEAD", tree=tree)


def create_branch(name: str, *, tree: Path | str) -> str:
    _git("checkout", "-b", name, tree=tree)
    return name


def create_branch_from(name: str, base: str, *, tree: Path | str) -> str:
    """`git branch <name> <base>` — creates `name` pointing at `base`
    WITHOUT checking it out, unlike `create_branch` (`checkout -b`, only
    safe when `tree` is a throwaway or single-purpose checkout). This is how
    `worktrees.ensure_factory_trunk` self-heals the factory's own trunk from
    `main`: `main` is read here exactly once, for its tip commit, and is
    never checked out, committed to, or moved by this call."""
    return _git("branch", name, base, tree=tree)


# ── branch-per-run (MAP.md standing rule 11) ─────────────────────────────────
#
# The factory trunk (`factory_trunk()`, above) + short-lived `adw/<adw_id>_<slug>`,
# one branch per unit of work. The branch is cut before any agent runs, so the
# slug has to come from something
# code already has at that point — the prompt string — not from an agent's
# judgement. It is a legibility aid, not an identity: the adw_id is what
# actually disambiguates two runs, so lookups match on the `adw/<adw_id>_`
# prefix and never care whether the slug matches too.

_SLUG_WORD_RE = re.compile(r"[a-z0-9]+")


def slugify(text: str, max_words: int = 4, max_len: int = 40) -> str:
    """Deterministic kebab-case slug from free text — no agent in the loop.

    First `max_words` alphanumeric tokens, lowercased and dash-joined, capped
    at `max_len` chars. Text with no alphanumeric tokens at all (empty,
    punctuation-only) falls back to "run" rather than producing an empty or
    trailing-dash branch name.
    """
    words = _SLUG_WORD_RE.findall(text.lower())[:max_words]
    slug = "-".join(words)[:max_len].rstrip("-")
    return slug or "run"


def run_branch_name(adw_id: str, prompt: str) -> str:
    """The branch name a fresh run of `adw_id` would cut, from its prompt."""
    return f"adw/{adw_id}_{slugify(prompt)}"


# ── human titles (worktree naming — "which worktree ran which ticket") ──────
#
# One rule, every reader: `dispatch.py`'s `request_prompt` leads a dispatched
# run's prompt with the queue card's own H1, on its own first line, so
# extracting the first line recovers that title verbatim. A direct,
# non-dispatched prompt (`just build "..."`, or a `prompt.md` file) has no
# such structure — its first non-blank line IS the whole ask — so the same
# extraction is capped to the first few words instead. No caller ever has to
# know or branch on which case it is.

_TITLE_MAX_WORDS = 8
_MARKDOWN_HEADING_RE = re.compile(r"^#+\s+")


def derive_title(prompt: str, max_words: int = _TITLE_MAX_WORDS) -> str:
    """The run's human title, straight from the prompt handed to it. Stamped
    once, at branch-cut time (`Run.enter_worktree`), into the trace's
    `branch` event payload — every other surface (worktrees CLI,
    morning-brief, the UI) reads it back rather than recomputing it.

    A leading markdown "# " (a `prompt.md` file that itself starts with an
    H1) is stripped, same as `dispatch.py`'s own H1 parser strips it.
    """
    first_line = next((line.strip() for line in (prompt or "").splitlines() if line.strip()), "")
    first_line = _MARKDOWN_HEADING_RE.sub("", first_line, count=1).strip()
    words = first_line.split()
    if len(words) <= max_words:
        return first_line
    return " ".join(words[:max_words])


def humanize_slug(slug: str) -> str:
    """Fallback title when no trace event carries a real one — telemetry
    recorded before this fix, or `worktrees.enabled: false`'s pre-worktree
    branch. "add-a-clamp-helper" -> "Add a clamp helper": dashes to spaces,
    sentence case. Never used once a run stamps a real title (`derive_title`
    above); readers try that first."""
    words = [w for w in slug.split("-") if w]
    if not words:
        return slug
    text = " ".join(words)
    return text[0].upper() + text[1:]


def find_run_branch(adw_id: str, tree: Path | str | None = None) -> str | None:
    """The branch already cut for `adw_id`, if a prior phase cut one.

    Matched by the `adw/<adw_id>_` prefix alone, not the full name — a joined
    run's prompt (and therefore its slug) can differ from the one that cut the
    branch originally, so the adw_id is the only stable key. Never raises:
    this is a question, like `ref_exists`. If more than one somehow matches
    (should not happen — one branch per adw_id), the lexicographically first
    is returned, which is at least deterministic.
    """
    result = _run_git(
        ("branch", "--list", f"adw/{adw_id}_*", "--format=%(refname:short)"), tree, None)
    if result.returncode != 0:
        return None
    branches = sorted(line for line in result.stdout.splitlines() if line)
    return branches[0] if branches else None


def ensure_run_branch(adw_id: str, prompt: str, *, tree: Path | str) -> str:
    """Cut or join this run's branch. Returns the branch now checked out.

    A fresh `adw_id` cuts `adw/<adw_id>_<slug>` off `tree`'s current HEAD.
    Joining an existing run — `--adw-id` naming a session that already cut a
    branch, in this process or an earlier one — switches to that branch instead
    of cutting a second one for the same unit of work.

    Kept for `worktrees.enabled: false` (pre-worktree behaviour, a branch cut
    IN the main checkout) and for its own tests. No writing ADW calls this
    directly any more — `Run.enter_worktree()` does, only on that config path.
    """
    existing = find_run_branch(adw_id, tree=tree)
    if existing:
        _git("checkout", existing, tree=tree)
        return existing
    return create_branch(run_branch_name(adw_id, prompt), tree=tree)


def commit_all(message: str, *, tree: Path | str) -> str:
    """Stage the working tree and commit it. Returns the new short sha."""
    if not is_repo(tree=tree):
        raise RuntimeError(
            "not a git repository - a commit phase needs one. Run `git init` in the "
            "repo root (and make a first commit) before running an ADW that commits.")
    _git("add", "-A", tree=tree)
    if not _git("status", "--porcelain", tree=tree):
        raise RuntimeError("nothing to commit - the preceding phases changed no files")
    _git("commit", "-m", message, tree=tree)
    return _git("rev-parse", "--short", "HEAD", tree=tree)


def changed_files(tree: Path | str | None = None) -> list[str]:
    out = _git("status", "--porcelain", tree=tree)
    return [line[3:] for line in out.splitlines() if line]


# ── diff plumbing (composed into a ChangeSet by documentation.py) ────────────

def ref_exists(ref: str, tree: Path | str | None = None) -> bool:
    """True when `ref` resolves to a commit. Never raises — this is a question."""
    return _run_git(("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"),
                    tree, None).returncode == 0


def is_ancestor(ref: str, other: str, tree: Path | str | None = None) -> bool:
    """True when `ref` is an ancestor of `other` (`git merge-base --is-ancestor`).

    Never raises — like `ref_exists`, this is a question. The fallback half of
    the "merged" test (8.4): correct on a fast-forwardable branch, wrong (in
    the safe, under-report direction) after a squash merge — see
    `worktrees.is_merged_into_trunk` for the primary test.
    """
    return _run_git(("merge-base", "--is-ancestor", ref, other), tree, None).returncode == 0


def rev(ref: str = "HEAD", tree: Path | str | None = None) -> str:
    return _git("rev-parse", ref, tree=tree)


def short_sha(ref: str = "HEAD", tree: Path | str | None = None) -> str:
    return _git("rev-parse", "--short", ref, tree=tree)


def merge_base(ref: str, other: str = "HEAD", tree: Path | str | None = None) -> str:
    """The commit where `ref` and `other` diverged — the honest base of a branch.

    On the base branch itself this returns HEAD, which makes the diff exactly
    "what is not committed yet". Off it, the diff is the whole branch plus the
    working tree. One command covers both cases, so no ADW has to branch on it.
    """
    return _git("merge-base", ref, other, tree=tree)


def is_dirty(tree: Path | str | None = None) -> bool:
    return bool(_git("status", "--porcelain", tree=tree))


def untracked_files(tree: Path | str | None = None) -> list[str]:
    out = _git("ls-files", "--others", "--exclude-standard", tree=tree)
    return [line for line in out.splitlines() if line]


def diff_files(base: str, tree: Path | str | None = None) -> list[str]:
    """Tracked files that differ between `base` and the working tree."""
    out = _git("diff", "--name-only", base, tree=tree)
    return [line for line in out.splitlines() if line]


def diff_stat(base: str, tree: Path | str | None = None) -> str:
    return _git("diff", "--stat", base, tree=tree)


def diff_counts(base: str, tree: Path | str | None = None) -> tuple[int, int]:
    """(insertions, deletions) across the diff. Binary files count as neither."""
    insertions = deletions = 0
    for line in _git("diff", "--numstat", base, tree=tree).splitlines():
        added, removed, *_ = line.split("\t")
        if added.isdigit():
            insertions += int(added)
        if removed.isdigit():
            deletions += int(removed)
    return insertions, deletions


def diff_text(base: str, tree: Path | str | None = None) -> str:
    return _git("diff", base, tree=tree)


def rev_list_count(range_expr: str, tree: Path | str | None = None) -> int:
    """`git rev-list --count <range>` — e.g. `main..adw/xxx_yyy` for "ahead"."""
    out = _git("rev-list", "--count", range_expr, tree=tree)
    return int(out) if out.strip().isdigit() else 0


def merge_tree_write(base: str, other: str, tree: Path | str | None = None) -> str | None:
    """First line of `git merge-tree --write-tree <base> <other>` — the
    resulting tree oid, printed whether the merge is clean (exit 0) or
    conflicted (exit 1); verified: a genuine two-sided conflict still prints
    the (differing) tree oid on line 1, followed by conflict detail on later
    lines. Only a git invocation that fails OUTRIGHT (git < 2.38, no
    --write-tree support, or another git-level error — neither exit 0 nor 1)
    returns None, so the caller can fall back to the ancestor test (8.4).
    """
    result = _run_git(("merge-tree", "--write-tree", base, other), tree, None)
    if result.returncode not in (0, 1):
        return None
    first_line = result.stdout.split("\n", 1)[0].strip()
    return first_line or None


# ── worktree plumbing ─────────────────────────────────────────────────────────

def worktree_list(tree: Path | str | None = None) -> list[dict]:
    """Every worktree git knows about — parsed from `--porcelain`, never the
    human format (it pads with spaces; a path containing a space is
    unparseable). Blank-line-separated records; git prints forward slashes
    here even on Windows (verified).

    Each record: `{"path": str, "head": str, "branch": str | None, "bare":
    bool, "prunable": bool}`. `branch` is the SHORT form (`adw/<id>_<slug>`,
    never `refs/heads/...`), or `None` for a detached/bare worktree.
    `prunable` marks an entry whose directory no longer exists on disk — git
    keeps the registration until `git worktree prune` clears it (verified: a
    manually `rm -rf`'d worktree still lists, with a trailing `prunable
    <reason>` line).
    """
    out = _git("worktree", "list", "--porcelain", tree=tree)
    records: list[dict] = []
    current: dict = {}
    for line in out.splitlines():
        if not line:
            if current:
                records.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current = {"path": value, "head": "", "branch": None,
                      "bare": False, "prunable": False}
        elif key == "HEAD":
            current["head"] = value
        elif key == "branch":
            current["branch"] = value.removeprefix("refs/heads/")
        elif key == "bare":
            current["bare"] = True
        elif key == "detached":
            current["branch"] = None
        elif key == "prunable":
            current["prunable"] = True
    if current:
        records.append(current)
    return records


def worktree_add(path: Path | str, branch: str, *, tree: Path | str,
                 base: str | None = None) -> str:
    """`git worktree add <path> <branch>` — or, with `base`, the atomic
    `-b <branch> <path> <base>` that creates the branch AND the tree in one
    command (4.3 step 3), which is why the main checkout never moves. `tree`
    is where the command RUNS (the main checkout) — never the new path.
    """
    args = ["worktree", "add"]
    if base is not None:
        args += ["-b", branch, str(path), base]
    else:
        args += [str(path), branch]
    return _git(*args, tree=tree)


def worktree_remove(path: Path | str, *, tree: Path | str, force: bool = False) -> str:
    """`git worktree remove <path>` — NO `--force` by default (9): git refuses
    a dirty tree on its own, a safety net this factory deliberately does not
    override. `force=True` exists for a caller with its own reason (tests);
    `worktrees.prune_plan` never sets it.
    """
    args = ["worktree", "remove"]
    if force:
        args.append("--force")
    args.append(str(path))
    return _git(*args, tree=tree)


def worktree_prune(*, tree: Path | str) -> str:
    """`git worktree prune` — metadata only; it can never touch a file of
    work, only registrations for directories that no longer exist."""
    return _git("worktree", "prune", tree=tree)


def branch_delete(branch: str, *, tree: Path | str, force: bool = False) -> str:
    """`git branch -d <branch>` — never `-D` by default (9): an unmerged
    branch is refused by git itself, a third safety net."""
    return _git("branch", "-D" if force else "-d", branch, tree=tree)


def has_remote(name: str = "origin", tree: Path | str | None = None) -> bool:
    """True when `tree`'s repo has a remote named `name` configured. Never
    raises - like `is_repo`, this is a question asked before an operation
    that needs one, not an assertion."""
    result = _run_git(("remote",), tree, None)
    return result.returncode == 0 and name in result.stdout.split()


def push_branch(branch: str, *, tree: Path | str, remote: str = "origin") -> tuple[bool, str]:
    """`git push -u <remote> <branch>` - never raises, never `--force`, and
    `branch` is always the caller's own `adw/<id>_<slug>` name, never `main`.
    Returns `(True, "")` on a clean push, `(False, stderr)` on any failure
    (no network, rejected, auth, or the 300s network ceiling running out) - the
    caller decides how loud to be."""
    result = _run_git(("push", "-u", remote, branch), tree, None)
    if result.returncode != 0:
        return False, result.stderr.strip()
    return True, ""


def list_run_branches(tree: Path | str | None = None) -> list[dict]:
    """Every `adw/*` branch, with its tip sha and committer date — included
    even when no worktree holds it: a removed directory does not un-strand
    the commits sitting on its branch (8.2 source #2).
    """
    out = _git("for-each-ref", "refs/heads/adw/",
              "--format=%(refname:short)|%(objectname)|%(committerdate:iso-strict)",
              tree=tree)
    branches = []
    for line in out.splitlines():
        if not line:
            continue
        name, sha, date = line.split("|", 2)
        branches.append({"branch": name, "sha": sha, "committer_date": date})
    return branches
