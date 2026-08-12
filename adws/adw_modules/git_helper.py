"""Low-level git operations for code phases. All low-level logic lives in adw_modules."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


def _git(*args: str) -> str:
    result = subprocess.run(["git", *args], capture_output=True, text=True,
                            encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def current_branch() -> str:
    return _git("rev-parse", "--abbrev-ref", "HEAD")


def create_branch(name: str) -> str:
    _git("checkout", "-b", name)
    return name


# ── branch-per-run (MAP.md standing rule 11) ─────────────────────────────────
#
# `main` + short-lived `adw/<adw_id>_<slug>`, one branch per unit of work. The
# branch is cut before any agent runs, so the slug has to come from something
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


def find_run_branch(adw_id: str) -> str | None:
    """The branch already cut for `adw_id`, if a prior phase cut one.

    Matched by the `adw/<adw_id>_` prefix alone, not the full name — a joined
    run's prompt (and therefore its slug) can differ from the one that cut the
    branch originally, so the adw_id is the only stable key. Never raises:
    this is a question, like `ref_exists`. If more than one somehow matches
    (should not happen — one branch per adw_id), the lexicographically first
    is returned, which is at least deterministic.
    """
    result = subprocess.run(
        ["git", "branch", "--list", f"adw/{adw_id}_*", "--format=%(refname:short)"],
        capture_output=True, text=True, encoding="utf-8", check=False)
    if result.returncode != 0:
        return None
    branches = sorted(line for line in result.stdout.splitlines() if line)
    return branches[0] if branches else None


def ensure_run_branch(adw_id: str, prompt: str) -> str:
    """Cut or join this run's branch. Returns the branch now checked out.

    A fresh `adw_id` cuts `adw/<adw_id>_<slug>` off the current HEAD. Joining
    an existing run — `--adw-id` naming a session that already cut a branch,
    in this process or an earlier one — switches to that branch instead of
    cutting a second one for the same unit of work.
    """
    existing = find_run_branch(adw_id)
    if existing:
        _git("checkout", existing)
        return existing
    return create_branch(run_branch_name(adw_id, prompt))


def is_repo() -> bool:
    result = subprocess.run(["git", "rev-parse", "--git-dir"],
                            capture_output=True, text=True, encoding="utf-8")
    return result.returncode == 0


def repo_root() -> Path:
    """Absolute root of the codebase — where agents are spawned to work.

    The git toplevel when there is one, else the process cwd (ADWs run fine in a
    non-git dir; only a commit phase requires a repo). Always absolute, so it is
    safe to hand to a subprocess regardless of where the ADW was launched from.
    """
    if is_repo():
        return Path(_git("rev-parse", "--show-toplevel")).resolve()
    return Path.cwd().resolve()


def commit_all(message: str) -> str:
    """Stage the working tree and commit it. Returns the new short sha."""
    if not is_repo():
        raise RuntimeError(
            "not a git repository - a commit phase needs one. Run `git init` in the "
            "repo root (and make a first commit) before running an ADW that commits.")
    _git("add", "-A")
    if not _git("status", "--porcelain"):
        raise RuntimeError("nothing to commit - the preceding phases changed no files")
    _git("commit", "-m", message)
    return _git("rev-parse", "--short", "HEAD")


def changed_files() -> list[str]:
    out = _git("status", "--porcelain")
    return [line[3:] for line in out.splitlines() if line]


# ── diff plumbing (composed into a ChangeSet by documentation.py) ────────────

def ref_exists(ref: str) -> bool:
    """True when `ref` resolves to a commit. Never raises — this is a question."""
    result = subprocess.run(["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
                            capture_output=True, text=True, encoding="utf-8")
    return result.returncode == 0


def rev(ref: str = "HEAD") -> str:
    return _git("rev-parse", ref)


def short_sha(ref: str = "HEAD") -> str:
    return _git("rev-parse", "--short", ref)


def merge_base(ref: str, other: str = "HEAD") -> str:
    """The commit where `ref` and `other` diverged — the honest base of a branch.

    On the base branch itself this returns HEAD, which makes the diff exactly
    "what is not committed yet". Off it, the diff is the whole branch plus the
    working tree. One command covers both cases, so no ADW has to branch on it.
    """
    return _git("merge-base", ref, other)


def is_dirty() -> bool:
    return bool(_git("status", "--porcelain"))


def untracked_files() -> list[str]:
    out = _git("ls-files", "--others", "--exclude-standard")
    return [line for line in out.splitlines() if line]


def diff_files(base: str) -> list[str]:
    """Tracked files that differ between `base` and the working tree."""
    out = _git("diff", "--name-only", base)
    return [line for line in out.splitlines() if line]


def diff_stat(base: str) -> str:
    return _git("diff", "--stat", base)


def diff_counts(base: str) -> tuple[int, int]:
    """(insertions, deletions) across the diff. Binary files count as neither."""
    insertions = deletions = 0
    for line in _git("diff", "--numstat", base).splitlines():
        added, removed, *_ = line.split("\t")
        if added.isdigit():
            insertions += int(added)
        if removed.isdigit():
            deletions += int(removed)
    return insertions, deletions


def diff_text(base: str) -> str:
    return _git("diff", base)
