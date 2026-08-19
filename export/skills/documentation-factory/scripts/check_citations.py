#!/usr/bin/env python3
"""
check_citations.py - Check all .md docs for valid ID references.

Scans docs/ for DEC, GAP, ENH, EXT, SCN, ADR, COMP references.
Validates they exist in ledger, gaps, enhancements, or dependencies.
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
        return None


def extract_frontmatter(content):
    """Extract YAML frontmatter from markdown."""
    if not content.startswith('---'):
        return None

    lines = content.split('\n')
    end_idx = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == '---':
            end_idx = idx
            break

    if end_idx is None:
        return None

    fm_text = '\n'.join(lines[1:end_idx])
    try:
        return yaml.safe_load(fm_text)
    except:
        return None


def find_references(content):
    """Find all ID references in content."""
    # Patterns for different ID types
    patterns = {
        'DEC': r'\bDEC-\d{4}\b',
        'GAP': r'\bGAP-\d{4}\b',
        'ENH': r'\bENH-\d{4}\b',
        'EXT': r'\bEXT-\d{4}\b',
        'SCN': r'\bSCN-\d{4}\b',
        'ADR': r'\bADR-\d{4}\b',
        'COMP': r'\bCOMP-[A-Z0-9-]+\b'
    }

    refs = {}
    for id_type, pattern in patterns.items():
        refs[id_type] = set(re.findall(pattern, content))

    return refs


def check_dead_decision_contradictions(doc_path, content, ledger_data):
    """Warn if dead decision is cited without keywords like 'dead', 'killed', etc."""
    if not ledger_data or 'ledger' not in ledger_data:
        return []

    warnings = []
    dead_decs = {}
    for entry in ledger_data['ledger']:
        if entry.get('status') == 'dead':
            dead_decs[entry['id']] = entry

    # Find lines with dead decision references
    lines = content.split('\n')
    for line_num, line in enumerate(lines, 1):
        for dead_id in dead_decs:
            if dead_id in line:
                # Check if context mentions dead/killed/rejected/superseded
                context_start = max(0, line_num - 3)
                context_end = min(len(lines), line_num + 2)
                context = ' '.join(lines[context_start:context_end]).lower()

                if not any(word in context for word in ['dead', 'killed', 'rejected', 'superseded']):
                    warnings.append(
                        f"{os.path.basename(doc_path)}:{line_num}: citing dead decision {dead_id} "
                        f"without 'dead'/'killed'/'rejected'/'superseded' nearby"
                    )

    return warnings


def main():
    parser = argparse.ArgumentParser(
        description='Validate citations in markdown documents'
    )
    parser.add_argument('--root', default='.', help='Project root (default: .)')

    args = parser.parse_args()

    root = os.path.abspath(args.root)
    docs_dir = os.path.join(root, 'docs')

    if not os.path.isdir(docs_dir):
        print(f"ERROR docs: directory does not exist")
        sys.exit(1)

    # Load reference data
    ledger_path = os.path.join(root, '_docwork', 'ledger.yaml')
    gaps_path = os.path.join(root, '_docwork', 'gaps.yaml')
    enhancements_path = os.path.join(root, '_docwork', 'enhancements.yaml')
    deps_path = os.path.join(root, 'docs', 'architecture', 'dependencies.yaml')

    ledger_data = load_yaml(ledger_path)
    gaps_data = load_yaml(gaps_path)
    enhancements_data = load_yaml(enhancements_path)
    deps_data = load_yaml(deps_path)

    # Build sets of valid IDs
    dec_ids = set()
    if ledger_data and 'ledger' in ledger_data:
        for entry in ledger_data['ledger']:
            if 'id' in entry:
                dec_ids.add(entry['id'])

    gap_ids = set()
    if gaps_data and 'gaps' in gaps_data:
        for entry in gaps_data['gaps']:
            if 'id' in entry:
                gap_ids.add(entry['id'])

    enh_ids = set()
    if enhancements_data and 'enhancements' in enhancements_data:
        for entry in enhancements_data['enhancements']:
            if 'id' in entry:
                enh_ids.add(entry['id'])

    comp_ids = set()
    if deps_data and 'components' in deps_data:
        for entry in deps_data['components']:
            if 'id' in entry:
                comp_ids.add(entry['id'])

    # Scan all .md files
    errors = []
    warnings = []

    for root_dir, dirs, files in os.walk(docs_dir):
        for file in files:
            if not file.endswith('.md'):
                continue

            file_path = os.path.join(root_dir, file)
            rel_path = os.path.relpath(file_path, root)

            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
            except Exception as e:
                errors.append(f"{rel_path}: Failed to read: {e}")
                continue

            # Extract frontmatter
            frontmatter = extract_frontmatter(content)

            # Find references
            refs = find_references(content)

            # Check DEC references
            for dec_ref in refs['DEC']:
                if dec_ref not in dec_ids:
                    errors.append(f"{rel_path}: DEC reference '{dec_ref}' not in ledger")

            # Check GAP references
            for gap_ref in refs['GAP']:
                if gap_ref not in gap_ids:
                    errors.append(f"{rel_path}: GAP reference '{gap_ref}' not in gaps")

            # Check ENH references
            for enh_ref in refs['ENH']:
                if enh_ref not in enh_ids:
                    errors.append(f"{rel_path}: ENH reference '{enh_ref}' not in enhancements")

            # Check COMP references (warn only)
            for comp_ref in refs['COMP']:
                if comp_ref not in comp_ids:
                    warnings.append(f"{rel_path}: COMP reference '{comp_ref}' not in dependencies")

            # Check claim-bearing docs without DEC references
            if frontmatter:
                doc_type = frontmatter.get('type')
                if doc_type in ['component-spec', 'constitution', 'contract']:
                    if not refs['DEC']:
                        errors.append(
                            f"{rel_path}: claim-bearing doc (type={doc_type}) must cite >=1 DEC"
                        )

            # Check dead decision contradictions
            dead_warns = check_dead_decision_contradictions(file_path, content, ledger_data)
            warnings.extend(dead_warns)

    # Print warnings first
    for warn in warnings:
        print(f"WARN {warn}")

    # Then errors
    if errors:
        for err in errors:
            print(f"ERROR {err}")
        sys.exit(1)
    else:
        print("OK: citations valid")
        sys.exit(0)


if __name__ == '__main__':
    main()
