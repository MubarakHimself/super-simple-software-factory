#!/usr/bin/env python3
"""
publish_batch.py - turn a to-kanban batch manifest into queue/NNN-slug.md cards,
in one pass, and sync them.

The whole set lands together, so a card may name a card written in the same run:
numbers are assigned in manifest order (which is the inventory's shipping order),
every FEAT id is resolved to its card basename before any file is written, and a
forward reference is impossible by construction.

    python publish_batch.py <manifest.yaml> --repo <path> [--dry-run] [--no-push]

The manifest (YAML, or JSON - both parse):

    cards:
      - feature: FEAT-0001          # optional; kept in the card header
        key: FEAT-0001              # optional; defaults to feature - what needs: names
        title: Add the health endpoint
        brief: briefs/FEAT-0001.md  # relative to the manifest
        needs: []                   # keys in this batch, FEAT ids, or existing basenames
        adw: ""                     # optional; blank takes TEMPLATE.md's value
        context: ""                 # optional; passed to the card's Context:
      - feature: FEAT-0002
        title: Chart the health history
        brief: briefs/FEAT-0002.md
        needs: [FEAT-0001]
    sync:                           # repo-root-relative, committed with the cards
      - specs/health-endpoint.md
      - docs/

The card's header block is copied from the target repo's own queue/TEMPLATE.md -
its keys, in its order, with its values - so this script carries no queue contract
of its own. Requires PyYAML.

Exit 0: cards written, committed, and pushed. Every refusal names its fix, and
says in its own words how far the run got:

  - refused before the commit - nothing was published. Every card is planned
    before any is written, and anything already written is removed again if
    staging fails, so the queue is exactly as it was. Fix what the refusal
    names and run again.
  - refused at or after the commit - the cards ARE on disk and committed (the
    push is what failed). Finish that step by hand; re-running would publish a
    second copy of every card.

Read the refusal, not just the exit code: 1 means both cases.
"""

import argparse
import os
import re
import subprocess
import sys
from datetime import date

try:
    import yaml
except ImportError:  # pragma: no cover - environment problem, not a code path
    sys.stdout.write("ERROR: PyYAML is required. Install it with: pip install pyyaml\n")
    sys.exit(1)


H1_RE = re.compile(r"^#\s+(.+?)\s*$")
HEADER_LINE_RE = re.compile(r"^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$")
CHECKBOX_RE = re.compile(r"^[ \t]*-\s*\[( |x|X)\]")
STATUS_ENUM_RE = re.compile(r"Status is one of:\s*([^\n.]+)", re.IGNORECASE)
NUMBERED_RE = re.compile(r"^(\d+)-")
FEAT_RE = re.compile(r"^FEAT-\d{4}$")
BRIEF_HEADING_RE = re.compile(r"^#{1,6}\s+Agent Brief\s*$", re.IGNORECASE)
MAX_SLUG = 50

PROTECTED_BRANCHES = ("main", "master")


def say(text):
    """stdout stays ASCII - card content never decides whether a console survives."""
    sys.stdout.write(text.encode("ascii", "replace").decode("ascii") + "\n")


class Refusal(Exception):
    """A problem this script can name precisely, never a traceback."""


def read_text(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def write_text(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def parse_header_block(text):
    """Mirror the Board's parseHeaderBlock: find the H1, skip one run of blank
    lines, then read Key: value lines until the first blank line or the first
    line that is not Key: value.

    Returns (title, [(key, value), ...]) with the keys in their original
    spelling and order, or (None, []) when there is no H1.
    """
    lines = re.split(r"\r\n|\n", text)

    h1_index = -1
    title = None
    for index, line in enumerate(lines):
        match = H1_RE.match(line)
        if match:
            h1_index = index
            title = match.group(1)
            break
    if h1_index == -1:
        return None, []

    index = h1_index + 1
    while index < len(lines) and lines[index].strip() == "":
        index += 1

    fields = []
    while index < len(lines):
        line = lines[index]
        if line.strip() == "":
            break
        match = HEADER_LINE_RE.match(line)
        if not match:
            break
        fields.append((match.group(1), match.group(2).strip()))
        index += 1

    return title, fields


def field_map(fields):
    return {key.lower(): value for key, value in fields}


def count_checkboxes(text):
    return sum(1 for line in re.split(r"\r\n|\n", text) if CHECKBOX_RE.match(line))


def slugify(title):
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    if len(slug) > MAX_SLUG:
        slug = slug[:MAX_SLUG].rstrip("-")
    return slug or "card"


def load_manifest(path):
    if not os.path.exists(path):
        raise Refusal(f"manifest not found: {path}")
    try:
        data = yaml.safe_load(read_text(path))
    except Exception as exc:
        raise Refusal(f"manifest is not parseable YAML or JSON: {exc}")
    if not isinstance(data, dict):
        raise Refusal("manifest must be a mapping with a 'cards' list")
    cards = data.get("cards")
    if not isinstance(cards, list) or not cards:
        raise Refusal("manifest 'cards' must be a non-empty list, in shipping order")
    sync = data.get("sync") or []
    if not isinstance(sync, list):
        raise Refusal("manifest 'sync' must be a list of repo-root-relative paths")
    return cards, [str(item) for item in sync]


def scan_queue(queue_dir):
    """Every card already on the board: its number width, and what FEAT it carries.

    queue/done/ counts - parked numbers stay retired, and a parked card still
    satisfies a Needs: edge.
    """
    numbers = []
    widths = []
    by_feature = {}
    basenames = set()

    for directory, parked in ((queue_dir, False), (os.path.join(queue_dir, "done"), True)):
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".md") or name == "TEMPLATE.md":
                continue
            path = os.path.join(directory, name)
            if not os.path.isfile(path):
                continue
            basenames.add(name)
            match = NUMBERED_RE.match(name)
            if match:
                numbers.append(int(match.group(1)))
                widths.append(len(match.group(1)))
            try:
                _title, fields = parse_header_block(read_text(path))
            except (OSError, UnicodeDecodeError):
                continue
            feature = field_map(fields).get("feature", "")
            if feature:
                by_feature.setdefault(feature, (name, parked))

    next_number = (max(numbers) + 1) if numbers else 1
    width = max(widths) if widths else 3
    return next_number, max(width, 3), by_feature, basenames


def template_contract(template_path):
    """The contract this run publishes against, read fresh from the target repo."""
    if not os.path.exists(template_path):
        raise Refusal(
            f"no queue/TEMPLATE.md at {template_path} - that file is the card contract, and this "
            "script will not invent one"
        )
    text = read_text(template_path)
    _title, fields = parse_header_block(text)
    if not fields:
        raise Refusal(
            "queue/TEMPLATE.md has no 'Key: value' block directly under its H1 - "
            "the Board's parser reads that block, and so does this script"
        )
    enum = None
    match = STATUS_ENUM_RE.search(text)
    if match:
        enum = [value.strip() for value in match.group(1).split("|") if value.strip()]
    return fields, enum


def brief_body(manifest_dir, rel_path, label):
    if not rel_path:
        raise Refusal(f"{label}: no 'brief' path")
    path = rel_path if os.path.isabs(rel_path) else os.path.join(manifest_dir, rel_path)
    if not os.path.exists(path):
        raise Refusal(f"{label}: brief not found at {path}")
    text = read_text(path).replace("\r\n", "\n").strip("\n")
    lines = text.split("\n")
    while lines and (BRIEF_HEADING_RE.match(lines[0]) or lines[0].strip() == ""):
        lines.pop(0)
    body = "\n".join(lines).strip("\n")
    if not body:
        raise Refusal(f"{label}: brief at {path} is empty")
    if count_checkboxes(body) == 0:
        raise Refusal(
            f"{label}: brief at {path} has no acceptance-criteria checkboxes - an agent brief "
            "without them gives the reviewer nothing to check the diff against"
        )
    return body


def plan_cards(cards, manifest_dir, next_number, width):
    """Assign every number and read every brief before a single file is written."""
    planned = []
    seen_keys = {}
    seen_features = {}

    for index, card in enumerate(cards):
        label = f"cards[{index}]"
        if not isinstance(card, dict):
            raise Refusal(f"{label}: each card must be a mapping")

        # One line each: the H1 and the header block are line-shaped, and a
        # stray newline in either would split a card the Board then calls
        # malformed.
        title = " ".join(str(card.get("title") or "").split())
        if not title:
            raise Refusal(f"{label}: no 'title'")

        feature = str(card.get("feature") or "").strip()
        if feature and not FEAT_RE.match(feature):
            raise Refusal(
                f"{label}: feature '{feature}' is not a FEAT-NNNN id as the inventory writes it"
            )

        key = str(card.get("key") or feature or "").strip()
        if key:
            if key in seen_keys:
                raise Refusal(
                    f"{label}: key '{key}' is already used by cards[{seen_keys[key]}] - a needs: entry must "
                    "name exactly one card"
                )
            seen_keys[key] = index
        if feature:
            if feature in seen_features:
                raise Refusal(
                    f"{label}: {feature} is split across two cards (cards[{seen_features[feature]}] and this one). One "
                    "feature is one card here; give each card its own 'key' and have "
                    "dependents name the one that delivers the feature."
                    
                )
            seen_features[feature] = index

        needs = card.get("needs") or []
        if isinstance(needs, str):
            needs = [needs]
        if not isinstance(needs, list):
            raise Refusal(f"{label}: 'needs' must be a list")

        number = next_number + index
        basename = f"{str(number).zfill(width)}-{slugify(title)}.md"

        planned.append(
            {
                "index": index,
                "label": label,
                "title": title,
                "feature": feature,
                "key": key,
                "needs": [str(item).strip() for item in needs if str(item).strip()],
                "adw": " ".join(str(card.get("adw") or "").split()),
                "context": " ".join(str(card.get("context") or "").split()),
                "body": brief_body(manifest_dir, card.get("brief"), label),
                "number": number,
                "basename": basename,
            }
        )

    basenames = [card["basename"] for card in planned]
    if len(set(basenames)) != len(basenames):
        raise Refusal("two cards in this batch slugify to the same filename - retitle one")

    return planned


def resolve_needs(planned, published_by_feature, existing_basenames):
    """FEAT id -> card basename, across the whole set at once."""
    by_key = {card["key"]: card for card in planned if card["key"]}

    for card in planned:
        resolved = []
        for need in card["needs"]:
            target = by_key.get(need)
            if target is not None:
                if target["index"] >= card["index"]:
                    raise Refusal(
                        "{} ({}) needs '{}', which this manifest lists later. Cards are "
                        "numbered in manifest order, so the manifest must be in the "
                        "shipping order validate_inventory.py --order printed.".format(card["label"], card["basename"], need)
                    )
                resolved.append(target["basename"])
                continue

            published = published_by_feature.get(need)
            if published is not None:
                resolved.append(published[0])
                continue

            if need in existing_basenames:
                resolved.append(need)
                continue

            if FEAT_RE.match(need):
                raise Refusal(
                    "{}: needs '{}', which is neither a card in this batch nor a card "
                    "already in queue/. Add that feature to this manifest, ahead of "
                    "this card.".format(card["label"], need)
                )
            raise Refusal(
                "{}: needs '{}', which is not a key in this batch and not a file in "
                "queue/ or queue/done/.".format(card["label"], need)
            )

        card["resolved_needs"] = resolved


def compose_card(card, template_fields, today):
    """The card, in the target repo's own header shape.

    Six keys this run fills; every other key the template declares is copied from
    the template verbatim, which is how a different repo's contract survives a
    script that has never seen it.
    """
    lines = ["# {}".format(card["title"]), ""]

    template = field_map(template_fields)
    wrote_feature = False

    for key, template_value in template_fields:
        lowered = key.lower()
        if lowered == "status":
            value = template_value
        elif lowered == "adw":
            value = card["adw"] or template_value
        elif lowered == "adw-id":
            value = ""
        elif lowered == "created":
            value = today
        elif lowered == "context":
            value = card["context"]
        elif lowered == "needs":
            value = ", ".join(card["resolved_needs"])
        elif lowered == "feature":
            value = card["feature"]
            wrote_feature = True
        else:
            value = template_value
        lines.append(f"{key}: {value}" if value else f"{key}:")

    if card["feature"] and not wrote_feature:
        lines.append("Feature: {}".format(card["feature"]))

    if "needs" not in template and card["resolved_needs"]:
        raise Refusal(
            "{} needs {}, but queue/TEMPLATE.md declares no 'Needs:' key - this repo's "
            "board has no way to hold a blocking edge".format(card["basename"], ", ".join(card["resolved_needs"]))
        )

    lines.extend(["", "## Agent Brief", "", card["body"], ""])
    return "\n".join(lines)


def validate_card(text, basename, template_fields, status_enum):
    """The same check the Board's own parser would make, before anything is committed."""
    violations = []
    title, fields = parse_header_block(text)
    if title is None:
        violations.append("no H1 title")
        return violations

    present = field_map(fields)
    for key, _value in template_fields:
        if key.lower() not in present:
            violations.append(f'missing header key "{key}:"')

    status = present.get("status")
    if status == "":
        violations.append("Status: is present but empty")
    elif status and status_enum and status not in status_enum:
        violations.append(f'Status "{status}" is not one of {status_enum}')

    if count_checkboxes(text) == 0:
        violations.append("no acceptance-criteria checkboxes")

    return [f"{basename}: {violation}" for violation in violations]


def git(repo, *args, check=True):
    result = subprocess.run(
        ["git", "-C", repo] + list(args),
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and result.returncode != 0:
        raise Refusal(
            "git {} failed: {}".format(" ".join(args), (result.stderr or result.stdout).strip())
        )
    return result


def current_branch(repo):
    result = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    return result.stdout.strip()


def unwrite_cards(repo, card_paths):
    """Take back a half-publish: unstage and delete every card THIS run wrote.

    Only the cards - never a sync path, which is the operator's own work and
    was on disk before this script ran. `git rm --cached` touches the index
    only (and works in a repo with no commit yet, where `git reset` does not),
    so what is left behind is the queue exactly as it was found.
    """
    git(repo, "rm", "--cached", "--quiet", "--ignore-unmatch", "--", *card_paths, check=False)
    for relative in card_paths:
        try:
            os.remove(os.path.join(repo, relative))
        except OSError:
            pass


def sync_and_push(repo, card_paths, sync_paths, branch, push):
    result = git(repo, "add", "--", *(card_paths + sync_paths), check=False)
    if result.returncode != 0:
        unwrite_cards(repo, card_paths)
        raise Refusal(
            "git add failed, so nothing was published - the {} card{} this run wrote "
            "{} been removed again, and the queue is as it was. git said: {}".format(
                len(card_paths),
                "" if len(card_paths) == 1 else "s",
                "has" if len(card_paths) == 1 else "have",
                (result.stderr or result.stdout).strip(),
            )
        )

    message = "queue: publish {} card{}\n\n{}\n".format(
        len(card_paths),
        "" if len(card_paths) == 1 else "s",
        "\n".join(card_paths),
    )
    # Path-scoped, like engine.py's `commit_card`: a bare `git commit` commits
    # the WHOLE index, so anything the operator had staged before invoking
    # to-kanban would be swept into "queue: publish N cards" and pushed with
    # it - invisibly, since the message lists only the cards. This runs on the
    # laptop, which is exactly where half-finished work sits staged.
    result = git(repo, "commit", "-m", message, "--", *(card_paths + sync_paths), check=False)
    if result.returncode != 0:
        raise Refusal(
            "the cards are written and staged, but the commit failed: {}\n"
            "  Do NOT re-run this script - it would publish a second copy of each. "
            "Fix what git named and commit these by hand, or remove them:\n    {}".format(
                (result.stderr or result.stdout).strip(), "\n    ".join(card_paths)
            )
        )
    say(f"committed on {branch}")

    if not push:
        say(f"not pushed (--no-push): push {branch} when ready")
        return

    remotes = git(repo, "remote").stdout.split()
    if "origin" not in remotes:
        say("no origin remote: committed locally, nothing pushed")
        return

    result = git(repo, "push", "-u", "origin", branch, check=False)
    if result.returncode != 0:
        raise Refusal(
            "committed on {}, but the push failed: {}\n"
            "  The cards ARE published locally. Do NOT re-run this script - push {} by "
            "hand once the cause is cleared.".format(
                branch, (result.stderr or result.stdout).strip(), branch
            )
        )
    say(f"pushed {branch} to origin")


def run(args):
    repo = os.path.abspath(args.repo)
    manifest_path = os.path.abspath(args.manifest)
    manifest_dir = os.path.dirname(manifest_path)

    result = subprocess.run(
        ["git", "-C", repo, "rev-parse", "--show-toplevel"],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise Refusal(f"{repo} is not a git checkout - publishing is a commit and a push")
    repo = os.path.abspath(result.stdout.strip())

    branch = current_branch(repo)
    if branch in PROTECTED_BRANCHES:
        raise Refusal(
            f"this checkout is on '{branch}'. Cards live on the working line, which the factory "
            "merges into by itself; main is the operator's, one squash per finished chunk. "
            "Switch first:  git switch integration  (or: git switch -c integration)"
        )
    if branch == "HEAD":
        raise Refusal("this checkout has a detached HEAD - check out the working line first")

    queue_dir = os.path.join(repo, "queue")
    if not os.path.isdir(queue_dir):
        raise Refusal(f"no queue/ directory in {repo} - the Board reads that directory")

    template_fields, status_enum = template_contract(os.path.join(queue_dir, "TEMPLATE.md"))
    cards, sync = load_manifest(manifest_path)
    next_number, width, published_by_feature, existing_basenames = scan_queue(queue_dir)

    planned = plan_cards(cards, manifest_dir, next_number, width)

    for card in planned:
        published = published_by_feature.get(card["feature"])
        if card["feature"] and published and not published[1]:
            raise Refusal(
                "{0} is already on the board as queue/{1}. If that card is an uncommitted "
                "leftover from a run that failed at the commit or the push, finish or undo "
                "it first (`git status`; `git rm -f queue/{1}` drops it). Otherwise drop {0} "
                "from the manifest, or give the new work its own feature id.".format(
                    card["feature"], published[0])
            )
        if card["feature"] and published and published[1]:
            say("NOTE: {} already shipped as queue/done/{} - publishing a follow-up card".format(card["feature"], published[0]))

    resolve_needs(planned, published_by_feature, existing_basenames)

    today = date.today().isoformat()
    violations = []
    for card in planned:
        card["text"] = compose_card(card, template_fields, today)
        path = os.path.join(queue_dir, card["basename"])
        if os.path.exists(path):
            raise Refusal(
                "queue/{} already exists - the numbering was computed against a queue "
                "that changed underneath this run; run it again".format(card["basename"])
            )
        violations.extend(validate_card(card["text"], card["basename"], template_fields, status_enum))
    if violations:
        for violation in violations:
            say(f"VIOLATION: {violation}")
        raise Refusal("no card was written")

    for path in sync:
        if not os.path.exists(os.path.join(repo, path)):
            raise Refusal(
                f"sync path '{path}' does not exist in {repo} - list what this journey wrote, "
                "repo-root-relative"
            )

    if args.dry_run:
        say("dry run - nothing written:")
        for card in planned:
            needs = ", ".join(card["resolved_needs"]) or "-"
            say("  queue/{}  {}  needs: {}".format(card["basename"], card["feature"] or "-", needs))
        return 0

    written = []
    for card in planned:
        write_text(os.path.join(queue_dir, card["basename"]), card["text"])
        written.append("queue/{}".format(card["basename"]))
        needs = ", ".join(card["resolved_needs"]) or "-"
        say("wrote queue/{}  {}  needs: {}".format(card["basename"], card["feature"] or "-", needs))

    sync_and_push(repo, written, sync, branch, push=not args.no_push)
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Publish a to-kanban batch manifest as queue/NNN-slug.md cards, in one pass."
    )
    parser.add_argument("manifest", help="path to the batch manifest (YAML or JSON)")
    parser.add_argument("--repo", default=".", help="target repo root (default: .)")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the plan - numbers, basenames, resolved Needs - and write nothing")
    parser.add_argument("--no-push", action="store_true",
                        help="write and commit, but leave the push for later")
    args = parser.parse_args()

    try:
        return run(args)
    except Refusal as refusal:
        say(f"ERROR: {refusal}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
