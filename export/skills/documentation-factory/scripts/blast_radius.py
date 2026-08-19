#!/usr/bin/env python3
"""
blast_radius.py - Compute transitive dependents of a component.

Reads dependencies.yaml, builds reverse dependency graph,
prints tree of components that depend on the given component.
Also scans docs/ for docs that declare dependencies.
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


def build_reverse_deps(components):
    """Build reverse dependency graph from components list."""
    # Forward deps: comp_id -> [depends_on]
    forward = {}
    comp_map = {}

    for comp in components:
        comp_id = comp['id']
        comp_map[comp_id] = comp
        forward[comp_id] = comp.get('depends_on', [])

    # Reverse: comp_id -> [components that depend on it]
    reverse = {comp_id: [] for comp_id in forward}
    for comp_id, deps in forward.items():
        for dep in deps:
            if dep not in reverse:
                reverse[dep] = []
            reverse[dep].append(comp_id)

    return reverse, comp_map


def get_transitive_dependents(comp_id, reverse):
    """Get all components that transitively depend on comp_id."""
    visited = set()
    queue = [comp_id]
    dependents = set()

    while queue:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)

        direct_deps = reverse.get(current, [])
        for dep in direct_deps:
            if dep not in dependents:
                dependents.add(dep)
                queue.append(dep)

    return dependents


def print_tree(comp_id, reverse, comp_map, prefix='', is_last=True):
    """Print dependency tree."""
    connector = '`-- ' if is_last else '|-- '
    print(f"{prefix}{connector}{comp_id}")

    next_prefix = prefix + ('    ' if is_last else '|   ')
    direct_deps = reverse.get(comp_id, [])

    for idx, dep in enumerate(sorted(direct_deps)):
        is_last_dep = (idx == len(direct_deps) - 1)
        print_tree(dep, reverse, comp_map, next_prefix, is_last_dep)


def main():
    parser = argparse.ArgumentParser(
        description='Compute and display blast radius (transitive dependents) of a component'
    )
    parser.add_argument('component', help='Component ID (e.g., COMP-TREASURY)')
    parser.add_argument('--root', default='.', help='Project root (default: .)')

    args = parser.parse_args()

    root = os.path.abspath(args.root)
    deps_path = os.path.join(root, 'docs', 'architecture', 'dependencies.yaml')
    docs_dir = os.path.join(root, 'docs')

    # Load dependencies
    deps_data = load_yaml(deps_path)

    if not deps_data or 'components' not in deps_data:
        print(f"ERROR dependencies.yaml: not found or invalid")
        sys.exit(1)

    components = deps_data['components']
    comp_ids = {c['id'] for c in components}

    # Check if component exists
    if args.component not in comp_ids:
        print(f"ERROR {args.component}: component not found in dependencies")
        sys.exit(1)

    # Build reverse graph
    reverse, comp_map = build_reverse_deps(components)

    # Get transitive dependents
    dependents = get_transitive_dependents(args.component, reverse)

    # Print tree
    print(f"Blast radius for {args.component}:")
    print()
    print(args.component)
    direct = reverse.get(args.component, [])
    for idx, dep in enumerate(sorted(direct)):
        is_last = (idx == len(direct) - 1)
        print_tree(dep, reverse, comp_map, '', is_last)

    # Scan docs for docs that depend on this component
    print()
    print(f"Documents declaring dependency on {args.component}:")

    docs_with_deps = []

    if os.path.isdir(docs_dir):
        for root_dir, dirs, files in os.walk(docs_dir):
            for file in files:
                if not file.endswith('.md'):
                    continue

                file_path = os.path.join(root_dir, file)
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                except:
                    continue

                frontmatter = extract_frontmatter(content)
                if not frontmatter:
                    continue

                depends_on = frontmatter.get('depends_on', [])
                if isinstance(depends_on, list):
                    if args.component in depends_on or any(d in dependents for d in depends_on):
                        rel_path = os.path.relpath(file_path, root)
                        doc_id = frontmatter.get('id', 'UNKNOWN')
                        docs_with_deps.append((rel_path, doc_id))

    # Also check for the component's own spec
    for comp in components:
        if comp['id'] == args.component and 'spec' in comp:
            spec_path = comp['spec']
            full_spec = os.path.join(root, spec_path)
            if os.path.exists(full_spec):
                docs_with_deps.append((spec_path, f"[spec of {args.component}]"))

    if docs_with_deps:
        for doc_path, doc_id in sorted(docs_with_deps):
            print(f"  {doc_path} ({doc_id})")
    else:
        print("  None found")

    sys.exit(0)


if __name__ == '__main__':
    main()
