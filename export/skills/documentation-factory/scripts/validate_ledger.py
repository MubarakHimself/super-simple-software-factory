#!/usr/bin/env python3
"""
validate_ledger.py - Validate ledger.yaml, extractions.yaml, gaps.yaml.

Enforces schema: unique IDs, valid formats, required fields, status vocabularies,
source references, supersession chains, and authority-rider logic.
"""

import argparse
import sys
import os
import re
import yaml


def load_yaml(path):
    """Load YAML file, return None if missing."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
    except Exception as e:
        print(f"ERROR {path}: Failed to parse YAML: {e}")
        return False


def validate_id_format(id_str, prefix):
    """Check ID format is PREFIX-NNNN."""
    pattern = rf"^{prefix}-\d{{4}}$"
    return bool(re.match(pattern, id_str))


def validate_extractions(data):
    """Validate extractions.yaml structure."""
    errors = []

    if not data or 'extractions' not in data:
        return errors

    seen_ids = set()
    for idx, entry in enumerate(data['extractions']):
        # Check ID
        if 'id' not in entry:
            errors.append(f"extractions[{idx}]: missing id")
            continue

        ext_id = entry['id']
        if not validate_id_format(ext_id, 'EXT'):
            errors.append(f"extractions[{idx}]: invalid id format '{ext_id}' (expect EXT-NNNN)")
        if ext_id in seen_ids:
            errors.append(f"extractions[{idx}]: duplicate id '{ext_id}'")
        seen_ids.add(ext_id)

        # Check required fields
        for field in ['type', 'summary', 'cite']:
            if field not in entry:
                errors.append(f"extractions[{idx}] {ext_id}: missing '{field}'")

        # Check type
        if 'type' in entry:
            valid_types = ['decision', 'correction', 'death', 'constraint', 'value', 'open', 'context']
            if entry['type'] not in valid_types:
                errors.append(f"extractions[{idx}] {ext_id}: type '{entry['type']}' not in {valid_types}")

        # Check authority
        if 'authority' in entry:
            if entry['authority'] not in ['source', 'rider']:
                errors.append(f"extractions[{idx}] {ext_id}: authority '{entry['authority']}' not in ['source', 'rider']")

    return errors


def validate_gaps(data):
    """Validate gaps.yaml structure."""
    errors = []
    warnings = []

    if data is None:
        return errors, warnings

    if not data or 'gaps' not in data:
        return errors, warnings

    seen_ids = set()
    for idx, entry in enumerate(data['gaps']):
        if 'id' not in entry:
            errors.append(f"gaps[{idx}]: missing id")
            continue

        gap_id = entry['id']
        if not validate_id_format(gap_id, 'GAP'):
            errors.append(f"gaps[{idx}]: invalid id format '{gap_id}' (expect GAP-NNNN)")
        if gap_id in seen_ids:
            errors.append(f"gaps[{idx}]: duplicate id '{gap_id}'")
        seen_ids.add(gap_id)

        # Check required fields
        for field in ['question']:
            if field not in entry:
                errors.append(f"gaps[{idx}] {gap_id}: missing '{field}'")

        # Check status
        if 'status' in entry:
            valid_statuses = ['open', 'answered', 'deferred', 'out-of-scope']
            if entry['status'] not in valid_statuses:
                errors.append(f"gaps[{idx}] {gap_id}: status '{entry['status']}' not in {valid_statuses}")

    return errors, warnings


def validate_ledger(data, extractions_data):
    """Validate ledger.yaml structure."""
    errors = []

    if not data or 'ledger' not in data:
        return errors

    # Build set of valid EXT IDs
    ext_ids = set()
    if extractions_data and 'extractions' in extractions_data:
        for ext in extractions_data['extractions']:
            if 'id' in ext:
                ext_ids.add(ext['id'])

    seen_ids = set()
    supersession_map = {}  # Maps DEC id to superseded_by

    for idx, entry in enumerate(data['ledger']):
        if 'id' not in entry:
            errors.append(f"ledger[{idx}]: missing id")
            continue

        dec_id = entry['id']
        if not validate_id_format(dec_id, 'DEC'):
            errors.append(f"ledger[{idx}]: invalid id format '{dec_id}' (expect DEC-NNNN)")
        if dec_id in seen_ids:
            errors.append(f"ledger[{idx}]: duplicate id '{dec_id}'")
        seen_ids.add(dec_id)

        # Check required fields
        for field in ['title', 'statement']:
            if field not in entry:
                errors.append(f"ledger[{idx}] {dec_id}: missing '{field}'")

        # Check status
        if 'status' in entry:
            valid_statuses = ['ratified', 'provisional', 'superseded', 'dead', 'conflict', 'open', 'out-of-scope']
            if entry['status'] not in valid_statuses:
                errors.append(f"ledger[{idx}] {dec_id}: status '{entry['status']}' not in {valid_statuses}")

        # Check status-specific requirements
        status = entry.get('status')
        if status == 'dead':
            if not entry.get('reason'):
                errors.append(f"ledger[{idx}] {dec_id}: status dead requires non-empty reason")

        if status == 'conflict':
            if not entry.get('conflict'):
                errors.append(f"ledger[{idx}] {dec_id}: status conflict requires non-empty conflict")

        if status == 'superseded':
            if 'superseded_by' not in entry or not entry['superseded_by']:
                errors.append(f"ledger[{idx}] {dec_id}: status superseded requires superseded_by")
            else:
                supersession_map[dec_id] = entry['superseded_by']

        # Check sources OR authority:rider
        has_authority_rider = False
        if 'authority' in entry and entry['authority'] == 'rider':
            has_authority_rider = True

        if 'sources' in entry:
            for src_id in entry['sources']:
                if src_id not in ext_ids:
                    errors.append(f"ledger[{idx}] {dec_id}: source '{src_id}' not found in extractions")
        elif not has_authority_rider:
            # Check if any cited extraction has authority:rider
            has_rider_ext = False
            if extractions_data and 'extractions' in extractions_data:
                for ext in extractions_data['extractions']:
                    if ext.get('authority') == 'rider':
                        has_rider_ext = True
                        break
            if not has_rider_ext:
                errors.append(f"ledger[{idx}] {dec_id}: no sources and no authority:rider")

    # Check supersession chains for cycles
    visited = set()
    rec_stack = set()

    def has_cycle(node):
        if node in visited:
            return False
        if node in rec_stack:
            return True

        rec_stack.add(node)
        next_node = supersession_map.get(node)
        if next_node and has_cycle(next_node):
            return True
        rec_stack.remove(node)
        visited.add(node)
        return False

    for dec_id in supersession_map:
        if has_cycle(dec_id):
            errors.append(f"ledger: supersession cycle detected involving {dec_id}")

    # Check superseded_by resolution
    for dec_id, superseded_by in supersession_map.items():
        if superseded_by not in seen_ids:
            errors.append(f"ledger: {dec_id} superseded_by '{superseded_by}' not found")

    # Check supersedes resolution
    for entry in data['ledger']:
        if 'supersedes' in entry and entry['supersedes']:
            for supersedes_id in entry['supersedes']:
                if supersedes_id not in seen_ids:
                    errors.append(f"ledger {entry['id']}: supersedes '{supersedes_id}' not found")

    return errors


def main():
    parser = argparse.ArgumentParser(
        description='Validate ledger.yaml, extractions.yaml, and gaps.yaml'
    )
    parser.add_argument('--root', default='.', help='Project root (default: .)')

    args = parser.parse_args()

    root = os.path.abspath(args.root)
    docwork = os.path.join(root, '_docwork')

    ledger_path = os.path.join(docwork, 'ledger.yaml')
    extractions_path = os.path.join(docwork, 'extractions.yaml')
    gaps_path = os.path.join(docwork, 'gaps.yaml')

    errors = []

    # Load files
    ledger_data = load_yaml(ledger_path)
    if ledger_data is False:
        errors.append(f"_docwork/ledger.yaml: parse error (see above)")
    elif ledger_data is None:
        errors.append(f"_docwork/ledger.yaml: missing")

    extractions_data = load_yaml(extractions_path)
    if extractions_data is False:
        errors.append(f"_docwork/extractions.yaml: parse error (see above)")
    elif extractions_data is None:
        print("WARN _docwork/extractions.yaml: missing")
        extractions_data = {}

    gaps_data = load_yaml(gaps_path)
    if gaps_data is False:
        errors.append(f"_docwork/gaps.yaml: parse error (see above)")
    elif gaps_data is None:
        print("WARN _docwork/gaps.yaml: missing")
        gaps_data = {}

    # Validate each file
    if extractions_data:
        ext_errors = validate_extractions(extractions_data)
        errors.extend(ext_errors)

    gaps_errors, gaps_warnings = validate_gaps(gaps_data)
    errors.extend(gaps_errors)

    if ledger_data and ledger_data is not False:
        ledger_errors = validate_ledger(ledger_data, extractions_data)
        errors.extend(ledger_errors)

    if errors:
        for err in errors:
            print(f"ERROR {err}")
        sys.exit(1)
    else:
        print("OK: ledger valid")
        sys.exit(0)


if __name__ == '__main__':
    main()
