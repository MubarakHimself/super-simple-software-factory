#!/usr/bin/env python3
"""
validate_registry.py - Validate docs/registry/variables.yaml and dependencies.yaml.

Checks unique names/symbols, decision/gap references, dependencies graph
(kind, layer, edges resolve, edges run downward), and spec paths.
"""

import argparse
import sys
import os
import re
import yaml


# Closed vocabularies, mirrored from references/ledger-schema.md
VALID_KINDS = ['service', 'library', 'middleware', 'store', 'ui', 'external', 'process']
VALID_LAYERS = ['ui', 'middleware', 'backend', 'data', 'external']

# Dependencies run downward: ui -> middleware -> backend -> data.
# 'external' is a sideways sink and is exempt (layer-conventions.md rule 4).
LAYER_DEPTH = {'ui': 0, 'middleware': 1, 'backend': 2, 'data': 3}


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
    """Check ID format."""
    pattern = rf"^{prefix}-\d{{4}}$"
    return bool(re.match(pattern, id_str))


def validate_comp_format(comp_id):
    """Check component ID format COMP-[A-Z0-9-]+."""
    pattern = r"^COMP-[A-Z0-9-]+$"
    return bool(re.match(pattern, comp_id))


def validate_registry(data, ledger_data):
    """Validate variables.yaml (registry)."""
    errors = []

    if not data or 'variables' not in data:
        return errors

    seen_names = set()
    seen_symbols = set()

    for idx, var in enumerate(data['variables']):
        # Check required fields
        if 'name' not in var:
            errors.append(f"variables[{idx}]: missing 'name'")
            continue

        name = var['name']

        # Check unique name
        if name in seen_names:
            errors.append(f"variables[{idx}]: duplicate name '{name}'")
        seen_names.add(name)

        # Check symbol is unique (only if not null)
        if 'symbol' in var and var['symbol']:
            symbol = var['symbol']
            if symbol in seen_symbols:
                errors.append(f"variables[{idx}] {name}: duplicate symbol '{symbol}'")
            seen_symbols.add(symbol)

        # Check required fields
        for field in ['type', 'component']:
            if field not in var:
                errors.append(f"variables[{idx}] {name}: missing '{field}'")

        # Check decision or authority
        if 'decision' not in var:
            if 'authority' not in var:
                errors.append(f"variables[{idx}] {name}: must have 'decision' or 'authority'")
        elif 'decision' in var and var['decision']:
            decision = var['decision']
            if not validate_id_format(decision, 'DEC'):
                errors.append(f"variables[{idx}] {name}: decision '{decision}' invalid format (expect DEC-NNNN)")
            elif ledger_data and 'ledger' in ledger_data:
                ledger_ids = {e['id'] for e in ledger_data['ledger'] if 'id' in e}
                if decision not in ledger_ids:
                    errors.append(f"variables[{idx}] {name}: decision '{decision}' not in ledger")

        # Check value and formula are mutually exclusive
        has_value = 'value' in var and var['value'] is not None
        has_formula = 'formula' in var and var['formula'] is not None

        if has_value and has_formula:
            errors.append(f"variables[{idx}] {name}: cannot have both value and formula")

        # Check value null requires gap
        if 'value' not in var or var['value'] is None:
            if 'gap' not in var:
                errors.append(f"variables[{idx}] {name}: value null requires 'gap'")
            elif 'gap' in var and var['gap']:
                gap = var['gap']
                if not validate_id_format(gap, 'GAP'):
                    errors.append(f"variables[{idx}] {name}: gap '{gap}' invalid format (expect GAP-NNNN)")

    return errors


def validate_dependencies(data, root, strict=False):
    """Validate dependencies.yaml. Spec paths resolve against the project root."""
    errors = []
    warnings = []

    if not data or 'components' not in data:
        return errors, warnings

    seen_ids = set()
    comp_specs = {}
    comp_layers = {}

    for idx, comp in enumerate(data['components']):
        # Check required fields
        if 'id' not in comp:
            errors.append(f"components[{idx}]: missing 'id'")
            continue

        comp_id = comp['id']

        # Check ID format
        if not validate_comp_format(comp_id):
            errors.append(f"components[{idx}]: invalid id format '{comp_id}' (expect COMP-[A-Z0-9-]+)")

        # Check unique ID
        if comp_id in seen_ids:
            errors.append(f"components[{idx}]: duplicate id '{comp_id}'")
        seen_ids.add(comp_id)

        # Check required fields
        if 'name' not in comp:
            errors.append(f"components[{idx}] {comp_id}: missing 'name'")

        # Check kind against the documented enum
        if 'kind' not in comp:
            errors.append(f"components[{idx}] {comp_id}: missing 'kind' (one of {VALID_KINDS})")
        elif comp['kind'] not in VALID_KINDS:
            errors.append(f"components[{idx}] {comp_id}: kind '{comp['kind']}' not in {VALID_KINDS}")

        # Check layer against the documented enum - every component declares its layer
        if 'layer' not in comp:
            errors.append(f"components[{idx}] {comp_id}: missing 'layer' (one of {VALID_LAYERS}); see references/layer-conventions.md")
        elif comp['layer'] not in VALID_LAYERS:
            errors.append(f"components[{idx}] {comp_id}: layer '{comp['layer']}' not in {VALID_LAYERS}")
        else:
            comp_layers[comp_id] = comp['layer']

        # Track spec path for later validation
        if 'spec' in comp:
            comp_specs[comp_id] = comp['spec']

        # Check depends_on edges resolve
        if 'depends_on' in comp:
            if isinstance(comp['depends_on'], list):
                for dep_id in comp['depends_on']:
                    # Can't check resolution yet, will do second pass
                    pass

        # Self-edge check
        if 'depends_on' in comp and isinstance(comp['depends_on'], list):
            if comp_id in comp['depends_on']:
                errors.append(f"components[{idx}] {comp_id}: self-edge in depends_on")

    # Second pass: check dependency resolution and direction
    for comp in data['components']:
        if 'depends_on' in comp and isinstance(comp['depends_on'], list):
            for dep_id in comp['depends_on']:
                if dep_id not in seen_ids:
                    errors.append(f"components {comp['id']}: depends_on '{dep_id}' not found")
                    continue
                # Dependencies run downward; an upward edge is a line-drawing defect
                from_depth = LAYER_DEPTH.get(comp_layers.get(comp['id']))
                to_depth = LAYER_DEPTH.get(comp_layers.get(dep_id))
                if from_depth is not None and to_depth is not None and from_depth > to_depth:
                    errors.append(
                        f"components {comp['id']} ({comp_layers[comp['id']]}): "
                        f"upward depends_on '{dep_id}' ({comp_layers[dep_id]}); "
                        f"dependencies run downward - the shared thing is a contract, "
                        f"not a dependency (references/layer-conventions.md rule 4)"
                    )

    # Check spec paths exist
    for comp_id, spec_path in comp_specs.items():
        full_path = os.path.join(root, spec_path)
        if not os.path.exists(full_path):
            msg = f"components {comp_id}: spec path '{spec_path}' not found"
            if strict:
                errors.append(msg)
            else:
                warnings.append(msg)

    return errors, warnings


def main():
    parser = argparse.ArgumentParser(
        description='Validate registry and dependencies'
    )
    parser.add_argument('--root', default='.', help='Project root (default: .)')
    parser.add_argument('--strict', action='store_true',
                       help='Missing spec paths cause error instead of warning')

    args = parser.parse_args()

    root = os.path.abspath(args.root)
    registry_path = os.path.join(root, 'docs', 'registry', 'variables.yaml')
    deps_path = os.path.join(root, 'docs', 'architecture', 'dependencies.yaml')
    ledger_path = os.path.join(root, '_docwork', 'ledger.yaml')

    errors = []

    # Load files
    registry_data = load_yaml(registry_path)
    if registry_data is False:
        errors.append(f"docs/registry/variables.yaml: parse error (see above)")
    elif registry_data is None:
        print("WARN docs/registry/variables.yaml: missing")
        registry_data = {}

    deps_data = load_yaml(deps_path)
    if deps_data is False:
        errors.append(f"docs/architecture/dependencies.yaml: parse error (see above)")
    elif deps_data is None:
        print("WARN docs/architecture/dependencies.yaml: missing")
        deps_data = {}

    ledger_data = load_yaml(ledger_path)
    if ledger_data is False:
        pass  # Already reported by validate_ledger
    elif ledger_data is None:
        ledger_data = {}

    # Validate
    if registry_data:
        reg_errors = validate_registry(registry_data, ledger_data)
        errors.extend(reg_errors)

    if deps_data:
        deps_errors, deps_warnings = validate_dependencies(deps_data, root, args.strict)
        errors.extend(deps_errors)
        for warn in deps_warnings:
            print(f"WARN {warn}")

    if errors:
        for err in errors:
            print(f"ERROR {err}")
        sys.exit(1)
    else:
        print("OK: registry valid")
        sys.exit(0)


if __name__ == '__main__':
    main()
