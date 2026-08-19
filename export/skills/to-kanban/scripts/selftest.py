#!/usr/bin/env python3
"""
selftest.py - fixture tests for publish_batch.py.

Builds a throwaway git repo with a queue/ and a TEMPLATE.md, publishes real
manifests against it, and checks what landed - including that a refusal leaves
the queue exactly as it found it.

    python selftest.py

No arguments, no network, no repo of the operator's touched: every fixture lives
in a fresh temporary directory that is removed afterwards. Exit 0 when every case
passes, 1 otherwise.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "publish_batch.py")

RESULTS = []


def say(text):
    sys.stdout.write(text.encode("ascii", "replace").decode("ascii") + "\n")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def read(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", repo] + list(args),
        capture_output=True, encoding="utf-8", errors="replace",
    )


def publish(repo, manifest, *extra):
    return subprocess.run(
        [sys.executable, SCRIPT, manifest, "--repo", repo] + list(extra),
        capture_output=True, encoding="utf-8", errors="replace",
    )


TEMPLATE = """# Title of the change

Status: ready-for-agent
Adw: simple-sdlc
Adw-Id:
Created: 2026-08-12
Context:
Needs:

## Agent Brief

**Category:** enhancement
**Summary:** one line
**Acceptance criteria:**
- [ ] first observable, testable condition

<!--
Status is one of: ready-for-agent | running | blocked | done.
-->
"""

EXISTING_CARD = """# Land the auth model

Status: ready-for-agent
Adw: simple-sdlc
Adw-Id:
Created: 2026-08-14
Context:
Needs:
Feature: FEAT-0009

## Agent Brief

**Category:** enhancement
**Summary:** the auth model
**Acceptance criteria:**
- [ ] it exists
"""

PARKED_CARD = """# Park this one

Status: done
Adw: simple-sdlc
Adw-Id: aabbccdd
Created: 2026-08-13
Context:
Needs:

## Agent Brief

**Category:** enhancement
**Summary:** parked
**Acceptance criteria:**
- [ ] it shipped
"""


def brief(summary):
    return (
        "**Category:** enhancement\n"
        f"**Summary:** {summary}\n\n"
        "**Current behavior:**\nNothing does this today.\n\n"
        "**Desired behavior:**\nIt does this.\n\n"
        "**Key interfaces:**\n- `Thing` - gains a field\n\n"
        "**Acceptance criteria:**\n- [ ] the thing happens\n- [ ] it is tested\n\n"
        "**Out of scope:**\n- everything else\n"
    )


def make_repo(root, branch="integration"):
    """A git checkout with a queue, one live card, one parked card, and a spec."""
    repo = os.path.join(root, "repo")
    os.makedirs(repo)
    write(os.path.join(repo, "queue", "TEMPLATE.md"), TEMPLATE)
    write(os.path.join(repo, "queue", "001-land-the-auth-model.md"), EXISTING_CARD)
    write(os.path.join(repo, "queue", "done", "002-park-this-one.md"), PARKED_CARD)
    write(os.path.join(repo, "specs", "existing.md"), "# existing\n")
    write(os.path.join(repo, "README.md"), "# fixture\n")

    git(repo, "init")
    git(repo, "config", "user.email", "selftest@example.invalid")
    git(repo, "config", "user.name", "selftest")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "fixture")
    git(repo, "checkout", "-b", branch)
    return repo


def make_work(root, manifest_text, briefs):
    work = os.path.join(root, "work")
    os.makedirs(os.path.join(work, "briefs"), exist_ok=True)
    for name, text in briefs.items():
        write(os.path.join(work, "briefs", name), text)
    manifest = os.path.join(work, "batch.yaml")
    write(manifest, manifest_text)
    return manifest


def queue_files(repo):
    return sorted(
        name for name in os.listdir(os.path.join(repo, "queue"))
        if name.endswith(".md") and name != "TEMPLATE.md"
    )


def check(name, condition, detail=""):
    RESULTS.append((name, bool(condition), detail))
    say(("PASS  " if condition else "FAIL  ") + name + (("  <- " + detail) if not condition and detail else ""))


def case_happy_path(root):
    repo = make_repo(root)
    manifest = make_work(
        root,
        "cards:\n"
        "  - feature: FEAT-0001\n"
        "    title: Add the health endpoint\n"
        "    brief: briefs/one.md\n"
        "    needs: []\n"
        "  - feature: FEAT-0002\n"
        "    title: Chart the health history\n"
        "    brief: briefs/two.md\n"
        "    needs: [FEAT-0001]\n"
        "  - feature: FEAT-0003\n"
        "    title: Alert on the health history\n"
        "    brief: briefs/three.md\n"
        "    needs: [FEAT-0002, FEAT-0009]\n"
        "sync:\n"
        "  - specs/existing.md\n",
        {"one.md": brief("endpoint"), "two.md": brief("chart"), "three.md": brief("alert")},
    )
    result = publish(repo, manifest)

    check("happy path exits 0", result.returncode == 0, result.stdout + result.stderr)
    names = queue_files(repo)
    check("numbering continues past queue/done/",
          names == ["001-land-the-auth-model.md", "003-add-the-health-endpoint.md",
                    "004-chart-the-health-history.md", "005-alert-on-the-health-history.md"],
          str(names))

    second = read(os.path.join(repo, "queue", "004-chart-the-health-history.md"))
    check("FEAT id resolves to the card written in the same run",
          "Needs: 003-add-the-health-endpoint.md" in second, second)
    check("Feature: is kept in the header", "Feature: FEAT-0002" in second, second)
    check("header keys keep the template's order",
          re.search(r"# Chart the health history\n\nStatus: ready-for-agent\nAdw: simple-sdlc\n"
                    r"Adw-Id:\nCreated: \d{4}-\d{2}-\d{2}\nContext:\nNeeds: 003-add-the-health-endpoint.md\n"
                    r"Feature: FEAT-0002\n\n## Agent Brief\n", second) is not None, second)
    check("brief body survives verbatim", "- [ ] the thing happens" in second, second)

    third = read(os.path.join(repo, "queue", "005-alert-on-the-health-history.md"))
    check("a FEAT already on the board resolves to its published card",
          "Needs: 004-chart-the-health-history.md, 001-land-the-auth-model.md" in third, third)

    log = git(repo, "log", "--name-only", "--pretty=format:%s").stdout
    check("cards and sync paths land in one commit",
          "queue/005-alert-on-the-health-history.md" in log and "specs/existing.md" in log, log)
    check("no origin means committed, not pushed", "nothing pushed" in result.stdout, result.stdout)
    check("working tree is clean after publishing",
          git(repo, "status", "--porcelain").stdout.strip() == "",
          git(repo, "status", "--porcelain").stdout)


def case_dry_run(root):
    repo = make_repo(root)
    manifest = make_work(
        root,
        "cards:\n  - feature: FEAT-0001\n    title: A dry card\n    brief: briefs/one.md\n",
        {"one.md": brief("dry")},
    )
    result = publish(repo, manifest, "--dry-run")
    check("dry run exits 0", result.returncode == 0, result.stdout + result.stderr)
    check("dry run writes nothing", queue_files(repo) == ["001-land-the-auth-model.md"],
          str(queue_files(repo)))
    check("dry run shows the plan", "003-a-dry-card.md" in result.stdout, result.stdout)


def case_no_push(root):
    repo = make_repo(root)
    manifest = make_work(
        root,
        "cards:\n  - feature: FEAT-0001\n    title: Held back\n    brief: briefs/one.md\n",
        {"one.md": brief("held")},
    )
    result = publish(repo, manifest, "--no-push")
    check("--no-push commits and says so",
          result.returncode == 0 and "not pushed" in result.stdout, result.stdout + result.stderr)


def case_protected_branch(root):
    repo = make_repo(root, branch="main")
    manifest = make_work(
        root,
        "cards:\n  - feature: FEAT-0001\n    title: On main\n    brief: briefs/one.md\n",
        {"one.md": brief("main")},
    )
    result = publish(repo, manifest)
    check("publishing on main is refused", result.returncode == 1, result.stdout)
    check("the refusal names the fix", "git switch" in result.stdout, result.stdout)
    check("main refusal writes nothing", queue_files(repo) == ["001-land-the-auth-model.md"],
          str(queue_files(repo)))


def case_unresolvable_need(root):
    repo = make_repo(root)
    manifest = make_work(
        root,
        "cards:\n"
        "  - feature: FEAT-0001\n    title: Needs a ghost\n    brief: briefs/one.md\n"
        "    needs: [FEAT-4242]\n",
        {"one.md": brief("ghost")},
    )
    result = publish(repo, manifest)
    check("an unresolvable need is refused", result.returncode == 1, result.stdout)
    check("nothing is written on refusal", queue_files(repo) == ["001-land-the-auth-model.md"],
          str(queue_files(repo)))


def case_out_of_order(root):
    repo = make_repo(root)
    manifest = make_work(
        root,
        "cards:\n"
        "  - feature: FEAT-0001\n    title: First but blocked\n    brief: briefs/one.md\n"
        "    needs: [FEAT-0002]\n"
        "  - feature: FEAT-0002\n    title: Second but blocking\n    brief: briefs/two.md\n",
        {"one.md": brief("first"), "two.md": brief("second")},
    )
    result = publish(repo, manifest)
    check("a manifest out of shipping order is refused", result.returncode == 1, result.stdout)
    check("the refusal names --order", "--order" in result.stdout, result.stdout)


def case_split_feature(root):
    repo = make_repo(root)
    manifest = make_work(
        root,
        "cards:\n"
        "  - feature: FEAT-0001\n    title: Half one\n    brief: briefs/one.md\n"
        "  - feature: FEAT-0001\n    title: Half two\n    brief: briefs/two.md\n",
        {"one.md": brief("half one"), "two.md": brief("half two")},
    )
    result = publish(repo, manifest)
    check("one feature across two cards is refused", result.returncode == 1, result.stdout)


def case_already_published(root):
    repo = make_repo(root)
    manifest = make_work(
        root,
        "cards:\n  - feature: FEAT-0009\n    title: Again\n    brief: briefs/one.md\n",
        {"one.md": brief("again")},
    )
    result = publish(repo, manifest)
    check("a feature already on the board is refused", result.returncode == 1, result.stdout)
    check("the refusal names the existing card",
          "001-land-the-auth-model.md" in result.stdout, result.stdout)


def case_brief_without_checkboxes(root):
    repo = make_repo(root)
    manifest = make_work(
        root,
        "cards:\n  - feature: FEAT-0001\n    title: No criteria\n    brief: briefs/one.md\n",
        {"one.md": "**Category:** enhancement\n**Summary:** nothing checkable\n"},
    )
    result = publish(repo, manifest)
    check("a brief with no acceptance checkboxes is refused", result.returncode == 1, result.stdout)
    check("checkbox refusal writes nothing", queue_files(repo) == ["001-land-the-auth-model.md"],
          str(queue_files(repo)))


def case_missing_template(root):
    repo = make_repo(root)
    os.remove(os.path.join(repo, "queue", "TEMPLATE.md"))
    manifest = make_work(
        root,
        "cards:\n  - feature: FEAT-0001\n    title: No contract\n    brief: briefs/one.md\n",
        {"one.md": brief("no contract")},
    )
    result = publish(repo, manifest)
    check("a queue with no TEMPLATE.md is refused", result.returncode == 1, result.stdout)


def case_missing_sync_path(root):
    repo = make_repo(root)
    manifest = make_work(
        root,
        "cards:\n  - feature: FEAT-0001\n    title: Bad sync\n    brief: briefs/one.md\n"
        "sync:\n  - specs/never-written.md\n",
        {"one.md": brief("bad sync")},
    )
    result = publish(repo, manifest)
    check("a sync path that does not exist is refused", result.returncode == 1, result.stdout)
    check("sync refusal writes nothing", queue_files(repo) == ["001-land-the-auth-model.md"],
          str(queue_files(repo)))


def case_basename_need(root):
    repo = make_repo(root)
    manifest = make_work(
        root,
        "cards:\n  - title: A single feature, no inventory\n    brief: briefs/one.md\n"
        "    needs: [001-land-the-auth-model.md]\n",
        {"one.md": brief("single")},
    )
    result = publish(repo, manifest)
    check("a single card may name an existing basename", result.returncode == 0,
          result.stdout + result.stderr)
    card = read(os.path.join(repo, "queue", "003-a-single-feature-no-inventory.md"))
    check("the basename lands in Needs:", "Needs: 001-land-the-auth-model.md" in card, card)
    check("no feature means no Feature: line", "Feature:" not in card, card)


def case_multiline_values(root):
    repo = make_repo(root)
    manifest = make_work(
        root,
        "cards:\n"
        "  - feature: FEAT-0001\n"
        "    title: |\n      A title that wandered\n      onto two lines\n"
        "    context: |\n      one\n      two\n"
        "    brief: briefs/one.md\n",
        {"one.md": brief("wandering")},
    )
    result = publish(repo, manifest)
    check("a multi-line title still publishes", result.returncode == 0,
          result.stdout + result.stderr)
    card = read(os.path.join(repo, "queue", "003-a-title-that-wandered-onto-two-lines.md"))
    check("the H1 is one line", card.startswith("# A title that wandered onto two lines\n"), card)
    check("the header block stays one line per key", "Context: one two\n" in card, card)


CASES = [
    ("happy path", case_happy_path),
    ("dry run", case_dry_run),
    ("no push", case_no_push),
    ("protected branch", case_protected_branch),
    ("unresolvable need", case_unresolvable_need),
    ("out of order", case_out_of_order),
    ("split feature", case_split_feature),
    ("already published", case_already_published),
    ("brief without checkboxes", case_brief_without_checkboxes),
    ("missing template", case_missing_template),
    ("missing sync path", case_missing_sync_path),
    ("basename need", case_basename_need),
    ("multi-line values", case_multiline_values),
]


def main():
    if subprocess.run(["git", "--version"], capture_output=True).returncode != 0:
        say("ERROR: git is not on PATH - these fixtures publish into real checkouts")
        return 1

    for name, case in CASES:
        say("")
        say(f"-- {name}")
        root = tempfile.mkdtemp(prefix="to-kanban-selftest-")
        try:
            case(root)
        except Exception as exc:  # a crashed case is a failed case, never a traceback
            check(f"{name} did not crash", False, f"{type(exc).__name__}: {exc}")
        finally:
            shutil.rmtree(root, ignore_errors=True)

    failed = [name for name, passed, _ in RESULTS if not passed]
    say("")
    say(f"{len(RESULTS)} checks, {len(failed)} failed")
    for name in failed:
        say(f"  FAILED: {name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
