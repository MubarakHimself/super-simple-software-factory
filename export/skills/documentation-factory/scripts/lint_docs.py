#!/usr/bin/env python3
"""
lint_docs.py - Lint all .md docs for frontmatter, style anti-patterns, and structural rules.

Checks: frontmatter present, required fields, valid types/status, provenance fields
(sources/generated/verified/stale_after) and staleness, style anti-patterns,
TODO/TBD/FIXME without GAP, component-spec mermaid/no-diagram, overview mermaid,
strict mode checks.
"""

import argparse
import datetime
import sys
import os
import re
import yaml


ISO_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
DURATION_RE = re.compile(r'^(\d+)([dwmy])$')
DURATION_DAYS = {'d': 1, 'w': 7, 'm': 30, 'y': 365}


def load_yaml(path):
    """Load YAML file. None if missing, False if unreadable - a gate that cannot
    read its input must not pass, so the failure is reported, never swallowed."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
    except Exception as e:
        print(f"ERROR {path}: Failed to read YAML: {e}")
        return False


def extract_frontmatter(content):
    """Extract YAML frontmatter and return (frontmatter, line_num, rest_of_content)."""
    if not content.startswith('---'):
        return None, 0, content

    lines = content.split('\n')
    end_idx = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == '---':
            end_idx = idx
            break

    if end_idx is None:
        return None, 0, content

    fm_text = '\n'.join(lines[1:end_idx])
    body = '\n'.join(lines[end_idx + 1:])

    try:
        fm = yaml.safe_load(fm_text)
        return fm, end_idx + 1, body
    except:
        return None, end_idx + 1, body


def check_frontmatter(frontmatter, doc_path):
    """Validate frontmatter structure."""
    errors = []

    if frontmatter is None:
        errors.append(f"{os.path.basename(doc_path)}: missing YAML frontmatter")
        return errors

    required_fields = ['id', 'title', 'type', 'status']
    for field in required_fields:
        if field not in frontmatter:
            errors.append(f"{os.path.basename(doc_path)}: frontmatter missing '{field}'")

    # Check type is in taxonomy
    type_taxonomy = [
        'constitution', 'component-spec', 'adr', 'scenario', 'knowledge',
        'index', 'agents', 'glossary', 'changelog', 'gap-report',
        'architecture', 'contract', 'lens', 'runbook'
    ]
    if 'type' in frontmatter and frontmatter['type'] not in type_taxonomy:
        errors.append(
            f"{os.path.basename(doc_path)}: type '{frontmatter['type']}' not in taxonomy"
        )

    # Check status is valid
    status_vocab = ['draft', 'reviewed', 'ratified', 'provisional']
    if 'status' in frontmatter and frontmatter['status'] not in status_vocab:
        errors.append(
            f"{os.path.basename(doc_path)}: status '{frontmatter['status']}' not in {status_vocab}"
        )

    return errors


def as_date(value):
    """Coerce a frontmatter value to a date, or None if it is not an ISO date."""
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    if isinstance(value, str) and ISO_DATE_RE.match(value.strip()):
        try:
            return datetime.date.fromisoformat(value.strip())
        except ValueError:
            return None
    return None


def check_provenance(frontmatter, doc_path, strict, today):
    """Validate provenance fields (sources, generated, verified, stale_after) and staleness.

    'verified' is canonical; 'last_verified' is the deprecated alias, still accepted.
    Returns (errors, warnings). Staleness warns normally and fails under --strict.
    """
    errors = []
    warnings = []

    if frontmatter is None:
        return errors, warnings

    name = os.path.basename(doc_path)

    if 'verified' in frontmatter:
        verified_field = 'verified'
    elif 'last_verified' in frontmatter:
        verified_field = 'last_verified'
    else:
        verified_field = None
        errors.append(f"{name}: frontmatter missing 'verified' (or deprecated 'last_verified')")

    verified_date = None
    if verified_field:
        verified_date = as_date(frontmatter.get(verified_field))
        if verified_date is None:
            errors.append(
                f"{name}: frontmatter '{verified_field}' must be an ISO date (YYYY-MM-DD)"
            )

    if 'generated' in frontmatter and as_date(frontmatter['generated']) is None:
        errors.append(f"{name}: frontmatter 'generated' must be an ISO date (YYYY-MM-DD)")

    if 'sources' in frontmatter and not isinstance(frontmatter['sources'], list):
        errors.append(f"{name}: frontmatter 'sources' must be a list of ids or paths")

    stale_after = frontmatter.get('stale_after')
    expiry = None
    if stale_after is not None:
        explicit = as_date(stale_after)
        if explicit is not None:
            expiry = explicit
        else:
            match = DURATION_RE.match(str(stale_after).strip())
            if match:
                if verified_date is not None:
                    days = int(match.group(1)) * DURATION_DAYS[match.group(2)]
                    expiry = verified_date + datetime.timedelta(days=days)
            else:
                errors.append(
                    f"{name}: frontmatter 'stale_after' must be a duration "
                    f"(30d | 12w | 6m | 1y) or an ISO date"
                )

    if strict:
        for field in ('sources', 'generated', 'stale_after'):
            if field not in frontmatter:
                errors.append(
                    f"{name}: frontmatter missing '{field}' (required in --strict mode)"
                )
        sources = frontmatter.get('sources')
        if isinstance(sources, list) and not sources:
            errors.append(
                f"{name}: frontmatter 'sources' is empty (provenance required in --strict mode)"
            )

    if expiry is not None and expiry < today:
        message = (
            f"{name}: stale - verified {verified_date}, expired {expiry} "
            f"(stale_after: {stale_after})"
        )
        if strict:
            errors.append(message)
        else:
            warnings.append(message)

    return errors, warnings


def check_style_antipatterns(body, doc_path, frontmatter):
    """Check for style anti-patterns (reference docs only)."""
    errors = []

    # Style checks only apply to reference doc types
    if not frontmatter:
        return errors

    doc_type = frontmatter.get('type')
    reference_types = ['constitution', 'component-spec', 'contract', 'architecture', 'glossary']

    if doc_type not in reference_types:
        return errors

    # Anti-pattern regexes
    patterns = [
        (r'\b(as (discussed|mentioned) (above|earlier|previously)|the aforementioned|see previous section)\b', 'relative reference'),
        (r'\b(probably|typically|more or less)\b', 'hedge in reference doc'),
        (r'\b(we used to|originally we|we decided)\b', 'history/first-person'),
    ]

    lines = body.split('\n')
    for line_num, line in enumerate(lines, 1):
        for pattern, desc in patterns:
            if re.search(pattern, line, re.IGNORECASE):
                errors.append(
                    f"{os.path.basename(doc_path)}:{line_num}: {desc}: {line.strip()}"
                )

    return errors


def check_todos_and_gaps(body, doc_path):
    """Check TODO/TBD/FIXME markers without GAP references."""
    errors = []

    lines = body.split('\n')
    for line_num, line in enumerate(lines, 1):
        if re.search(r'\b(TODO|TBD|FIXME)\b', line, re.IGNORECASE):
            if not re.search(r'\bGAP-\d{4}\b', line):
                errors.append(
                    f"{os.path.basename(doc_path)}:{line_num}: TODO/TBD/FIXME without GAP id"
                )

    return errors


def check_component_spec_mermaid(body, doc_path, frontmatter):
    """Check component-spec docs have mermaid or no-diagram comment."""
    errors = []

    if not frontmatter or frontmatter.get('type') != 'component-spec':
        return errors

    # Check for mermaid block
    if '```mermaid' in body:
        return errors

    # Check for no-diagram comment
    if re.search(r'<!--\s*no-diagram:', body):
        return errors

    errors.append(
        f"{os.path.basename(doc_path)}: component-spec must contain mermaid block or <!-- no-diagram: ... --> comment"
    )

    return errors


def check_overview_mermaid(root, body, doc_path):
    """Check docs/architecture/overview.md carries at least one mermaid block.

    Which diagrams it must carry (Level 1, Level 2, layer view) is a Stage 7
    reading; that at least one is drawn is mechanical, so it is checked here.
    """
    errors = []

    overview_path = os.path.join(root, 'docs', 'architecture', 'overview.md')
    if os.path.abspath(doc_path) != os.path.abspath(overview_path):
        return errors

    if '```mermaid' not in body:
        errors.append(
            f"{os.path.basename(doc_path)}: architecture overview must contain a mermaid block "
            f"(Level 1, Level 2, and the layer view; see references/diagram-conventions.md)"
        )

    return errors


def check_strict_mode(root, frontmatter, doc_path, body):
    """Strict mode checks."""
    errors = []

    if not frontmatter:
        return errors

    # Check for provisional status
    if frontmatter.get('status') == 'provisional':
        errors.append(
            f"{os.path.basename(doc_path)}: status 'provisional' not allowed in --strict mode"
        )

    # Check for ENHANCEMENT markers
    if '<!-- ENHANCEMENT ENH-' in body:
        errors.append(
            f"{os.path.basename(doc_path)}: ENHANCEMENT marker not allowed in --strict mode"
        )

    return errors


def check_required_docs(root, strict):
    """Check for required docs in strict mode."""
    errors = []

    if not strict:
        return errors

    required = [
        'docs/index.md',
        'docs/AGENTS.md',
        'docs/gap-report.md',
        'docs/architecture/overview.md',
        'docs/architecture/stack.md'
    ]

    for req_path in required:
        full_path = os.path.join(root, req_path)
        if not os.path.exists(full_path):
            errors.append(f"{req_path}: missing required document")

    return errors


def check_pending_enhancements(root):
    """Check for pending enhancements in strict mode."""
    errors = []

    enh_path = os.path.join(root, '_docwork', 'enhancements.yaml')
    enh_data = load_yaml(enh_path)

    if enh_data is False:
        return ["_docwork/enhancements.yaml: unreadable (see above); "
                "the pending-enhancement check cannot run"]

    if enh_data and 'enhancements' in enh_data:
        for enh in enh_data['enhancements']:
            if enh.get('status') == 'pending':
                errors.append(
                    f"_docwork/enhancements.yaml: ENH {enh['id']} has status 'pending' "
                    f"(not allowed in --strict mode)"
                )

    return errors


def load_blocking_gaps(root):
    """Read gaps.yaml once; return (set of blocking gap ids, errors)."""
    gaps_path = os.path.join(root, '_docwork', 'gaps.yaml')
    gaps_data = load_yaml(gaps_path)

    if gaps_data is False:
        return set(), ["_docwork/gaps.yaml: unreadable (see above); "
                       "the blocking-gap check cannot run"]

    if not gaps_data or 'gaps' not in gaps_data:
        return set(), []

    return {gap['id'] for gap in gaps_data['gaps'] if gap.get('blocking')}, []


def check_blocking_gaps(blocking_gaps, body, doc_path):
    """Check for inline GAP markers with blocking:true."""
    errors = []

    if not blocking_gaps:
        return errors

    # Find GAP references in body
    lines = body.split('\n')
    for line_num, line in enumerate(lines, 1):
        for gap_id in blocking_gaps:
            if gap_id in line:
                errors.append(
                    f"{os.path.basename(doc_path)}:{line_num}: GAP {gap_id} has blocking:true"
                )

    return errors


def main():
    parser = argparse.ArgumentParser(
        description='Lint markdown documents'
    )
    parser.add_argument('--root', default='.', help='Project root (default: .)')
    parser.add_argument('--strict', action='store_true',
                       help='Enable strict mode checks')

    args = parser.parse_args()

    root = os.path.abspath(args.root)
    docs_dir = os.path.join(root, 'docs')

    if not os.path.isdir(docs_dir):
        print(f"ERROR docs: directory does not exist")
        sys.exit(1)

    errors = []
    warnings = []
    today = datetime.date.today()

    # Strict mode: check required docs and pending enhancements
    blocking_gaps = set()
    if args.strict:
        errors.extend(check_required_docs(root, args.strict))
        errors.extend(check_pending_enhancements(root))
        blocking_gaps, gap_errors = load_blocking_gaps(root)
        errors.extend(gap_errors)

    # Scan all .md files
    for root_dir, dirs, files in os.walk(docs_dir):
        for file in files:
            if not file.endswith('.md'):
                continue

            file_path = os.path.join(root_dir, file)

            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
            except Exception as e:
                errors.append(f"{os.path.relpath(file_path, root)}: Failed to read: {e}")
                continue

            # Extract frontmatter
            frontmatter, fm_end, body = extract_frontmatter(content)

            # Check frontmatter
            errors.extend(check_frontmatter(frontmatter, file_path))

            # Check provenance fields and staleness
            prov_errors, prov_warnings = check_provenance(
                frontmatter, file_path, args.strict, today
            )
            errors.extend(prov_errors)
            warnings.extend(prov_warnings)

            # Check style anti-patterns
            errors.extend(check_style_antipatterns(body, file_path, frontmatter))

            # Check TODO/TBD/FIXME
            errors.extend(check_todos_and_gaps(body, file_path))

            # Check component-spec mermaid
            errors.extend(check_component_spec_mermaid(body, file_path, frontmatter))

            # Check the architecture overview carries its diagrams
            errors.extend(check_overview_mermaid(root, body, file_path))

            # Strict mode checks
            if args.strict:
                errors.extend(check_strict_mode(root, frontmatter, file_path, body))
                errors.extend(check_blocking_gaps(blocking_gaps, body, file_path))

    for warn in warnings:
        print(f"WARN {warn}")

    if errors:
        for err in errors:
            print(f"ERROR {err}")
        sys.exit(1)
    else:
        print("OK: docs lint clean")
        sys.exit(0)


if __name__ == '__main__':
    main()
