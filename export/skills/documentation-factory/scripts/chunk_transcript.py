#!/usr/bin/env python3
"""
chunk_transcript.py - Split transcript files into chunks with index.

Supports .txt, .md, .jsonl input. Creates chunk files and index.yaml.
Idempotent: overwrites previous output for the same source ID.
"""

import argparse
import sys
import os
import json
import yaml


def extract_text_from_jsonl_record(record):
    """Extract readable text from a JSON record (best effort)."""
    if not isinstance(record, dict):
        return None

    # Check for direct text/content/message fields
    for key in ['text', 'content', 'message']:
        if key in record and isinstance(record[key], str):
            val = record[key]
            if val.strip():
                role = record.get('role', record.get('sender', ''))
                if role:
                    return f"[{role}] {val}"
                return val

    # Recursively collect string values from likely keys
    text_parts = []
    def collect_strings(obj, depth=0):
        if depth > 3:  # Limit recursion
            return
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k.lower() in ['text', 'content', 'message', 'body']:
                    if isinstance(v, str) and v.strip():
                        text_parts.append(v)
                elif isinstance(v, (dict, list)):
                    collect_strings(v, depth + 1)
        elif isinstance(obj, list):
            for item in obj:
                collect_strings(item, depth + 1)

    collect_strings(record)
    if text_parts:
        return ' '.join(text_parts)

    return None


def find_break_point(lines, start_idx, max_lines):
    """Find a good break point near the boundary to avoid mid-thought splits."""
    if start_idx + max_lines >= len(lines):
        return len(lines)

    end_idx = min(start_idx + max_lines, len(lines))
    search_start = max(start_idx + max_lines - 15, start_idx)

    # Look for blank lines in the range [search_start, end_idx]
    for i in range(end_idx - 1, search_start - 1, -1):
        if not lines[i].strip():
            return i + 1

    return end_idx


def chunk_text_file(file_path, max_lines):
    """Split a .txt or .md file into chunks."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except Exception as e:
        print(f"ERROR {file_path}: Failed to read file: {e}")
        sys.exit(1)

    chunks = []
    chunk_idx = 1
    start_idx = 0

    while start_idx < len(lines):
        end_idx = find_break_point(lines, start_idx, max_lines)
        if end_idx <= start_idx:
            end_idx = min(start_idx + max_lines, len(lines))

        chunk_lines = lines[start_idx:end_idx]
        chunks.append({
            'lines': chunk_lines,
            'start_line': start_idx + 1,
            'end_line': end_idx
        })

        start_idx = end_idx
        chunk_idx += 1

    return chunks


def chunk_jsonl_file(file_path, max_lines):
    """Split a .jsonl file into chunks, treating each line as a record."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            raw_lines = f.readlines()
    except Exception as e:
        print(f"ERROR {file_path}: Failed to read file: {e}")
        sys.exit(1)

    processed_lines = []
    for idx, line in enumerate(raw_lines):
        if not line.strip():
            processed_lines.append('')
            continue

        try:
            record = json.loads(line)
            text = extract_text_from_jsonl_record(record)
            if text:
                processed_lines.append(text)
            else:
                processed_lines.append(line.rstrip())
        except json.JSONDecodeError:
            # Fall back to raw line
            processed_lines.append(line.rstrip())

    chunks = []
    chunk_idx = 1
    start_idx = 0

    while start_idx < len(processed_lines):
        end_idx = find_break_point(processed_lines, start_idx, max_lines)
        if end_idx <= start_idx:
            end_idx = min(start_idx + max_lines, len(processed_lines))

        chunk_lines = [processed_lines[i] + '\n' for i in range(start_idx, end_idx)]
        chunks.append({
            'lines': chunk_lines,
            'start_line': start_idx + 1,
            'end_line': end_idx
        })

        start_idx = end_idx
        chunk_idx += 1

    return chunks


def main():
    parser = argparse.ArgumentParser(
        description='Split transcript into chunks with index'
    )
    parser.add_argument('source_file', help='Input transcript file (.txt, .md, .jsonl)')
    parser.add_argument('--source-id', required=True, help='Source ID (e.g., SRC-01)')
    parser.add_argument('--out', required=True, help='Output directory for chunks and index')
    parser.add_argument('--max-lines', type=int, default=120, help='Max lines per chunk (default: 120)')
    parser.add_argument('--root', default='.', help='Project root (default: .)')

    args = parser.parse_args()

    # Resolve paths
    root = os.path.abspath(args.root)
    source_file = os.path.join(root, args.source_file)
    out_dir = os.path.join(root, args.out)

    if not os.path.exists(source_file):
        print(f"ERROR {args.source_file}: file not found")
        sys.exit(1)

    # Determine file type and chunk
    if source_file.endswith('.jsonl'):
        chunks = chunk_jsonl_file(source_file, args.max_lines)
    else:  # .txt or .md
        chunks = chunk_text_file(source_file, args.max_lines)

    if not chunks:
        print(f"ERROR {args.source_file}: no content to chunk")
        sys.exit(1)

    # Write chunk files
    os.makedirs(out_dir, exist_ok=True)

    chunk_index = []
    for idx, chunk in enumerate(chunks, 1):
        chunk_id = f"{args.source_id}-C{idx:04d}"
        chunk_file = f"{chunk_id}.txt"
        chunk_path = os.path.join(out_dir, chunk_file)

        try:
            with open(chunk_path, 'w', encoding='utf-8') as f:
                f.writelines(chunk['lines'])
        except Exception as e:
            print(f"ERROR {chunk_path}: Failed to write: {e}")
            sys.exit(1)

        chunk_index.append({
            'id': chunk_id,
            'file': chunk_file,
            'start_line': chunk['start_line'],
            'end_line': chunk['end_line']
        })

    # Write index
    index_data = {
        'source': args.source_id,
        'chunks': chunk_index
    }

    index_path = os.path.join(out_dir, f"{args.source_id}-index.yaml")
    try:
        with open(index_path, 'w', encoding='utf-8') as f:
            yaml.dump(index_data, f, default_flow_style=False, sort_keys=False)
    except Exception as e:
        print(f"ERROR {index_path}: Failed to write index: {e}")
        sys.exit(1)

    print(f"OK: chunked {len(chunks)} chunks from {os.path.basename(source_file)} into {out_dir}")
    sys.exit(0)


if __name__ == '__main__':
    main()
