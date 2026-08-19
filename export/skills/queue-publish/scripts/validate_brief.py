#!/usr/bin/env python3
"""
validate_brief.py - Validate a queue/NNN-slug.md file against its own repo's
queue/TEMPLATE.md contract, using the exact same "contiguous Key: value block
directly under the H1" rule the Board's parser uses.

Stdlib only, no dependencies. Generic on purpose: it never hardcodes a header
key name or a Status vocabulary - both are read from the target repo's own
TEMPLATE.md, so this script works unmodified against any queue/ that follows
the same convention.

Usage:
    python validate_brief.py <path/to/queue/NNN-slug.md> [--template <path/to/TEMPLATE.md>]

If --template is omitted, looks for TEMPLATE.md next to the brief file.
Missing template degrades to a minimal generic check (still requires a
parseable header block, a non-empty Status, and at least one acceptance
checkbox) rather than failing outright.

Exit 0: no violations. Exit 1: one or more violations, each printed.
"""

import argparse
import os
import re
import sys

H1_RE = re.compile(r"^#\s+(.+?)\s*$")
HEADER_LINE_RE = re.compile(r"^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$")
CHECKBOX_RE = re.compile(r"^[ \t]*-\s*\[( |x|X)\]")
STATUS_ENUM_RE = re.compile(r"Status is one of:\s*([^\n.]+)", re.IGNORECASE)


def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def parse_header_block(text):
    """Mirror apps/ui/server/queue.ts's parseHeaderBlock exactly: find the H1,
    skip one run of blank lines, then read Key: value lines until the first
    blank line or the first line that isn't Key: value. Returns
    (title, {lowercased_key: value}) or (None, None) if there's no H1."""
    lines = re.split(r"\r\n|\n", text)

    h1_index = -1
    title = None
    for i, line in enumerate(lines):
        m = H1_RE.match(line)
        if m:
            h1_index = i
            title = m.group(1)
            break
    if h1_index == -1:
        return None, None

    i = h1_index + 1
    while i < len(lines) and lines[i].strip() == "":
        i += 1

    fields = {}
    while i < len(lines):
        line = lines[i]
        if line.strip() == "":
            break
        m = HEADER_LINE_RE.match(line)
        if not m:
            break
        fields[m.group(1).lower()] = m.group(2).strip()
        i += 1

    return title, fields


def count_checkboxes(text):
    return sum(1 for line in re.split(r"\r\n|\n", text) if CHECKBOX_RE.match(line))


def required_keys_and_enum(template_text):
    """Derive the contract from the template itself: required key names (in
    the order the template declares them) and, if documented, the valid
    Status values. Never hardcoded - a different repo's TEMPLATE.md yields a
    different contract."""
    _, fields = parse_header_block(template_text)
    keys = list(fields.keys()) if fields else []

    enum = None
    m = STATUS_ENUM_RE.search(template_text)
    if m:
        enum = [v.strip() for v in m.group(1).split("|") if v.strip()]

    return keys, enum


def validate(brief_path, template_path):
    violations = []

    brief_text = read_text(brief_path)
    title, fields = parse_header_block(brief_text)

    if title is None:
        violations.append(
            'no H1 title found (expected "# Title" on its own line, header block directly beneath it)'
        )
        return violations  # nothing else is checkable without a header block

    required_keys = ["status"]
    status_enum = None

    if template_path and os.path.exists(template_path):
        template_text = read_text(template_path)
        tmpl_keys, tmpl_enum = required_keys_and_enum(template_text)
        if tmpl_keys:
            required_keys = tmpl_keys
        if tmpl_enum:
            status_enum = tmpl_enum
    elif template_path:
        violations.append(f"template not found at {template_path} - checked against a minimal fallback contract only")

    for key in required_keys:
        if key not in fields:
            violations.append(f'missing required header key "{key.title()}:" (from the template contract)')

    status = fields.get("status")
    if status is None:
        pass  # already reported above via required_keys
    elif status == "":
        violations.append('Status: is present but empty')
    elif status_enum and status not in status_enum:
        violations.append(f'Status "{status}" is not one of {status_enum} (from TEMPLATE.md)')

    checkbox_count = count_checkboxes(brief_text)
    if checkbox_count == 0:
        violations.append("no acceptance-criteria checkboxes found (expected at least one \"- [ ]\" line)")

    return violations


def main():
    parser = argparse.ArgumentParser(description="Validate a queue brief against its repo's TEMPLATE.md contract.")
    parser.add_argument("brief", help="path to the queue/NNN-slug.md file to validate")
    parser.add_argument(
        "--template",
        default=None,
        help="path to TEMPLATE.md (default: TEMPLATE.md next to the brief file)",
    )
    args = parser.parse_args()

    if not os.path.exists(args.brief):
        print(f"ERROR: brief not found: {args.brief}")
        sys.exit(1)

    template_path = args.template
    if template_path is None:
        candidate = os.path.join(os.path.dirname(os.path.abspath(args.brief)), "TEMPLATE.md")
        template_path = candidate if os.path.exists(candidate) else None

    violations = validate(args.brief, template_path)

    if violations:
        for v in violations:
            print(f"VIOLATION: {v}")
        sys.exit(1)

    print(f"OK: {args.brief} is a valid queue brief")
    sys.exit(0)


if __name__ == "__main__":
    main()
