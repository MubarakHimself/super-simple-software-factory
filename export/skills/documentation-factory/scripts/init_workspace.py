#!/usr/bin/env python3
"""
init_workspace.py - Initialize or validate documentation workspace.

Creates _docwork/ with manifest.yaml and stage_state.yaml per schema.
Validates existing structures with --check mode.
"""

import argparse
import sys
import os
from datetime import date
import yaml


# Kinds whose reading is proved by a chunk index (structural reading, not a glance)
CHUNK_REQUIRED_KINDS = ('transcript', 'design')


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


def save_yaml(path, data):
    """Save data as YAML."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(path, 'w', encoding='utf-8') as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)
    except Exception as e:
        print(f"ERROR {path}: Failed to write YAML: {e}")
        sys.exit(2)


def validate_source_entry(source, root):
    """Validate a single source entry in manifest."""
    errors = []

    required_fields = ['id', 'path', 'kind', 'role', 'status']
    for field in required_fields:
        if field not in source:
            errors.append(f"missing field '{field}'")

    if 'kind' in source:
        valid_kinds = ['transcript', 'code', 'doc', 'design', 'rider', 'data']
        if source['kind'] not in valid_kinds:
            errors.append(f"kind '{source['kind']}' not in {valid_kinds}")

    if 'role' in source:
        valid_roles = ['primary', 'baseline']
        if source['role'] not in valid_roles:
            errors.append(f"role '{source['role']}' not in {valid_roles}")

    if 'status' in source:
        valid_statuses = ['pending', 'chunked', 'harvested']
        if source['status'] not in valid_statuses:
            errors.append(f"status '{source['status']}' not in {valid_statuses}")

    # Check path exists if kind is transcript/code/doc/design (a design packet is a folder)
    if 'path' in source and source.get('kind') in ['transcript', 'code', 'doc', 'design']:
        full_path = os.path.join(root, source['path'])
        if not os.path.exists(full_path):
            errors.append(f"path '{source['path']}' does not exist")

    return errors


def validate_manifest_schema(manifest, root):
    """Validate manifest.yaml structure per schema."""
    errors = []

    required_fields = ['project', 'mode', 'created', 'lenses', 'scope', 'sources']
    for field in required_fields:
        if field not in manifest:
            errors.append(f"manifest missing required field '{field}'")

    if 'mode' in manifest:
        valid_modes = ['transcripts', 'codebase', 'enhance']
        if manifest['mode'] not in valid_modes:
            errors.append(f"mode '{manifest['mode']}' not in {valid_modes}")

    if 'lenses' in manifest:
        if not isinstance(manifest['lenses'], list):
            errors.append("lenses must be a list")
        elif 'core' not in manifest['lenses']:
            errors.append("lenses must include 'core'")

    if 'sources' in manifest:
        if not isinstance(manifest['sources'], list):
            errors.append("sources must be a list")
        else:
            for idx, source in enumerate(manifest['sources']):
                src_errors = validate_source_entry(source, root)
                for err in src_errors:
                    errors.append(f"sources[{idx}]: {err}")

    return errors


def validate_chunk_exists(source_id, root):
    """Check if a chunk index exists for a source."""
    index_path = os.path.join(root, '_docwork', 'chunks', f'{source_id}-index.yaml')
    if not os.path.exists(index_path):
        return False

    try:
        with open(index_path, 'r', encoding='utf-8') as f:
            index = yaml.safe_load(f)

        if not index or 'chunks' not in index:
            return False

        return len(index['chunks']) > 0
    except:
        return False


def cmd_check(args):
    """Validate existing workspace."""
    root = os.path.abspath(args.root)
    docwork = os.path.join(root, '_docwork')

    if not os.path.isdir(docwork):
        print(f"ERROR _docwork: directory does not exist")
        sys.exit(1)

    errors = []

    # Validate manifest.yaml
    manifest_path = os.path.join(docwork, 'manifest.yaml')
    manifest = load_yaml(manifest_path)
    if manifest is None:
        errors.append(f"_docwork/manifest.yaml: missing")
    elif manifest is False:
        errors.append(f"_docwork/manifest.yaml: parse error (see above)")
    else:
        manifest_errors = validate_manifest_schema(manifest, root)
        for err in manifest_errors:
            errors.append(f"_docwork/manifest.yaml: {err}")

    # Validate stage_state.yaml parses
    stage_path = os.path.join(docwork, 'stage_state.yaml')
    stage = load_yaml(stage_path)
    if stage is None:
        errors.append(f"_docwork/stage_state.yaml: missing")
    elif stage is False:
        errors.append(f"_docwork/stage_state.yaml: parse error (see above)")

    # A source that has been read must show its work: a chunk index proves the
    # structured files were opened. A design packet with nothing but screenshots
    # says so in the manifest with `no_chunks: <reason>` (stages/01-intake.md).
    if manifest and isinstance(manifest, dict) and 'sources' in manifest:
        for source in manifest['sources']:
            if source.get('kind') in CHUNK_REQUIRED_KINDS and source.get('status') != 'pending':
                if source.get('no_chunks'):
                    continue
                src_id = source.get('id')
                if not validate_chunk_exists(src_id, root):
                    errors.append(
                        f"chunks: index missing for {src_id} "
                        f"(kind={source.get('kind')}, status={source.get('status')}); "
                        f"chunk its structured files, or record 'no_chunks: <reason>'"
                    )

    if errors:
        for err in errors:
            print(f"ERROR {err}")
        sys.exit(1)
    else:
        print("OK: workspace valid")
        sys.exit(0)


def cmd_init(args):
    """Initialize new workspace."""
    root = os.path.abspath(args.root)
    docwork = os.path.join(root, '_docwork')
    chunks_dir = os.path.join(docwork, 'chunks')

    # Check if files already exist
    manifest_path = os.path.join(docwork, 'manifest.yaml')
    stage_path = os.path.join(docwork, 'stage_state.yaml')

    if os.path.exists(manifest_path) or os.path.exists(stage_path):
        print(f"ERROR _docwork: manifest.yaml or stage_state.yaml already exist; refusing to overwrite")
        sys.exit(1)

    # Create directories
    os.makedirs(chunks_dir, exist_ok=True)

    # Create manifest.yaml
    manifest = {
        'project': args.project,
        'mode': args.mode,
        'created': date.today().isoformat(),
        'lenses': ['core'],
        'scope': {'in': [], 'out': []},
        'sources': []
    }
    save_yaml(manifest_path, manifest)

    # Create stage_state.yaml
    stage_state = {
        'current_stage': 1,
        'provisional': args.provisional,
        'completed': [],
        'harvest_progress': {}
    }
    save_yaml(stage_path, stage_state)

    print(f"OK: initialized workspace at {docwork}")
    sys.exit(0)


def main():
    parser = argparse.ArgumentParser(
        description='Initialize or validate documentation workspace'
    )
    subparsers = parser.add_subparsers(dest='command', help='Command')

    # init command
    init_parser = subparsers.add_parser('init', help='Initialize new workspace')
    init_parser.add_argument('--project', required=True, help='Project name')
    init_parser.add_argument('--mode', required=True,
                           choices=['transcripts', 'codebase', 'enhance'],
                           help='Documentation mode')
    init_parser.add_argument('--root', default='.', help='Project root (default: .)')
    init_parser.add_argument('--provisional', action='store_true',
                           help='Mark workspace as provisional')

    # check command
    check_parser = subparsers.add_parser('check', help='Validate existing workspace')
    check_parser.add_argument('--root', default='.', help='Project root (default: .)')

    args = parser.parse_args()

    if args.command == 'init':
        cmd_init(args)
    elif args.command == 'check':
        cmd_check(args)
    else:
        parser.print_help()
        sys.exit(2)


if __name__ == '__main__':
    main()
