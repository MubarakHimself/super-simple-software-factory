#!/usr/bin/env python3
"""
coverage_report.py - Report extraction coverage per source.

Reads _docwork/extractions.yaml and chunk indexes.
Reports total chunks, cited chunks, coverage %.
Always exits 0 (review gate, not hard gate).
"""

import argparse
import sys
import os
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


def extract_chunk_id_from_cite(cite_str):
    """Extract chunk ID from citation string (e.g., 'SRC-01-C0083' from 'SRC-01-C0083')."""
    # Cite is in format SRC-XX-CXXXX
    return cite_str if cite_str else None


def main():
    parser = argparse.ArgumentParser(
        description='Report extraction coverage per source'
    )
    parser.add_argument('--root', default='.', help='Project root (default: .)')

    args = parser.parse_args()

    root = os.path.abspath(args.root)
    docwork = os.path.join(root, '_docwork')

    # Load extractions and exceptions
    extractions_path = os.path.join(docwork, 'extractions.yaml')
    extractions_data = load_yaml(extractions_path)

    exceptions_path = os.path.join(docwork, 'coverage-exceptions.yaml')
    exceptions_data = load_yaml(exceptions_path)

    # Build exception set
    excepted_chunks = set()
    if exceptions_data and isinstance(exceptions_data, list):
        for exc in exceptions_data:
            if 'chunk' in exc:
                excepted_chunks.add(exc['chunk'])

    # Collect chunk citations by source
    citations_by_source = {}
    if extractions_data and 'extractions' in extractions_data:
        for ext in extractions_data['extractions']:
            if 'cite' in ext:
                cite = ext['cite']
                # Extract source ID (e.g., 'SRC-01' from 'SRC-01-C0001')
                if cite and '-' in cite:
                    parts = cite.split('-')
                    if len(parts) >= 2:
                        src_id = f"{parts[0]}-{parts[1]}"
                        if src_id not in citations_by_source:
                            citations_by_source[src_id] = set()
                        citations_by_source[src_id].add(cite)

    # Load all chunk indexes and compute coverage
    chunks_dir = os.path.join(docwork, 'chunks')
    coverage_report = []
    total_chunks = 0
    total_cited = 0

    if os.path.isdir(chunks_dir):
        for fname in os.listdir(chunks_dir):
            if fname.endswith('-index.yaml'):
                index_path = os.path.join(chunks_dir, fname)
                index_data = load_yaml(index_path)

                if not index_data or 'chunks' not in index_data:
                    continue

                source_id = index_data.get('source')
                chunks = index_data['chunks']

                chunk_ids = [c['id'] for c in chunks if 'id' in c]
                cited_ids = citations_by_source.get(source_id, set())

                # Count excepted chunks as cited
                excepted_here = {cid for cid in chunk_ids if cid in excepted_chunks}
                effective_cited = cited_ids | excepted_here

                uncited = [cid for cid in chunk_ids if cid not in effective_cited]

                coverage = len(effective_cited) / len(chunk_ids) * 100 if chunk_ids else 0

                report_entry = {
                    'source': source_id,
                    'total': len(chunk_ids),
                    'cited': len(effective_cited),
                    'coverage': coverage,
                    'uncited': uncited,
                    'excepted': len(excepted_here)
                }
                coverage_report.append(report_entry)

                total_chunks += len(chunk_ids)
                total_cited += len(effective_cited)

    # Write report
    report_path = os.path.join(docwork, 'coverage-report.md')
    try:
        with open(report_path, 'w', encoding='utf-8') as f:
            f.write('# Coverage Report\n\n')
            f.write('| Source | Total | Cited | Coverage | Uncited |\n')
            f.write('|--------|-------|-------|----------|----------|\n')

            for entry in sorted(coverage_report, key=lambda x: x['source']):
                uncited_str = ', '.join(entry['uncited'][:3])
                if len(entry['uncited']) > 3:
                    uncited_str += f", +{len(entry['uncited']) - 3} more"
                uncited_str = uncited_str if uncited_str else 'none'

                f.write(
                    f"| {entry['source']} | {entry['total']} | {entry['cited']} | "
                    f"{entry['coverage']:.1f}% | {uncited_str} |\n"
                )

            f.write('\n')
            if coverage_report:
                overall = total_cited / total_chunks * 100 if total_chunks else 0
                f.write(f'**Total coverage: {overall:.1f}% ({total_cited}/{total_chunks} chunks)**\n')
    except Exception as e:
        print(f"ERROR {report_path}: Failed to write: {e}")
        sys.exit(1)

    # Print summary to stdout
    print(f"Coverage report written to {report_path}")
    if coverage_report:
        overall = total_cited / total_chunks * 100 if total_chunks else 0
        print(f"Total coverage: {overall:.1f}% ({total_cited}/{total_chunks} chunks)")
        for entry in sorted(coverage_report, key=lambda x: x['source']):
            print(f"  {entry['source']}: {entry['coverage']:.1f}% ({entry['cited']}/{entry['total']})")
            if entry['uncited']:
                uncited_str = ', '.join(entry['uncited'][:5])
                if len(entry['uncited']) > 5:
                    uncited_str += f", +{len(entry['uncited']) - 5} more"
                print(f"    Uncited: {uncited_str}")

    # Always exit 0 (review gate)
    sys.exit(0)


if __name__ == '__main__':
    main()
