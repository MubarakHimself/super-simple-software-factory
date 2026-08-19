#!/usr/bin/env python3
"""
validate_inventory.py - Validate _docwork/feature_inventory.yaml.

Checks unique FEAT ids, that every feature traces to at least one live ledger
decision, that blocking edges resolve and are acyclic, and that a feature whose
components depend on another feature's components is blocked by it (contracts
before consumers). Reports the shipping order the spec loop consumes one feature
per pass, the waves that may run side by side, and the per-feature handoff a
spec pass carries into its spec.
"""

import argparse
import sys
import os
import re
import yaml


VALID_SIZES = ['one-pass', 'multi-pass']
VALID_STATUSES = ['planned', 'in-progress', 'shipped']
SCOPE_MIN_CHARS = 40


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
    return bool(re.match(pattern, str(id_str)))


def validate_comp_format(comp_id):
    """Check component ID format COMP-[A-Z0-9-]+."""
    pattern = r"^COMP-[A-Z0-9-]+$"
    return bool(re.match(pattern, str(comp_id)))


def index_ledger(ledger_data):
    """Map DEC id -> entry."""
    entries = {}
    if ledger_data and 'ledger' in ledger_data:
        for entry in ledger_data['ledger']:
            if isinstance(entry, dict) and 'id' in entry:
                entries[entry['id']] = entry
    return entries


def buildable_decisions(ledger_entries):
    """Ratified, component-scoped, non-law decisions - the ones features must cover."""
    buildable = set()
    for dec_id, entry in ledger_entries.items():
        if entry.get('status') != 'ratified':
            continue
        if not entry.get('component'):
            continue
        tags = entry.get('tags') or []
        if isinstance(tags, list) and 'law' in tags:
            continue
        buildable.add(dec_id)
    return buildable


def find_cycle(nodes, blocked):
    """Return one cycle as a list of ids (first == last), or [] if none."""
    node_set = set(nodes)
    state = {}
    stack = []

    def dfs(node):
        state[node] = 1
        stack.append(node)
        for blocker in sorted(set(blocked.get(node, []))):
            if blocker not in node_set:
                continue
            if state.get(blocker, 0) == 1:
                idx = stack.index(blocker)
                return stack[idx:] + [blocker]
            if state.get(blocker, 0) == 0:
                found = dfs(blocker)
                if found:
                    return found
        stack.pop()
        state[node] = 2
        return None

    for node in sorted(node_set):
        if state.get(node, 0) == 0:
            found = dfs(node)
            if found:
                return found
    return []


def normalize_blockers(raw):
    """Accept ['FEAT-0001'] or [{'id': 'FEAT-0001', 'reason': '...'}].

    Returns (ids, reasons, bad) - bad holds items of neither shape.
    """
    ids = []
    reasons = {}
    bad = []
    for item in raw:
        if isinstance(item, str):
            ids.append(item)
        elif isinstance(item, dict) and item.get('id'):
            ids.append(item['id'])
            if item.get('reason'):
                reasons[item['id']] = str(item['reason']).strip()
        else:
            bad.append(item)
    return ids, reasons, bad


def all_blockers(feat_id, blocked):
    """Every feature that must ship before feat_id, following edges transitively."""
    upstream = set()
    stack = list(blocked.get(feat_id, []))
    while stack:
        blocker = stack.pop()
        if blocker in upstream:
            continue
        upstream.add(blocker)
        stack.extend(blocked.get(blocker, []))
    return upstream


def contract_order_findings(features, blocked, deps_edges):
    """Contracts before consumers: a feature that consumes another's component is blocked by it.

    Silent until `components` are filled and dependencies.yaml exists (stage 5+).
    """
    if not deps_edges:
        return []

    owner = {}
    for feat in features:
        if not isinstance(feat, dict) or 'id' not in feat:
            continue
        for comp_id in feat.get('components') or []:
            owner.setdefault(comp_id, set()).add(feat['id'])

    findings = []
    for feat in features:
        if not isinstance(feat, dict) or 'id' not in feat:
            continue
        feat_id = feat['id']
        upstream = all_blockers(feat_id, blocked)
        for comp_id in feat.get('components') or []:
            for dep_id in deps_edges.get(comp_id) or []:
                providers = owner.get(dep_id, set()) - {feat_id}
                if not providers or providers & upstream:
                    continue  # a feature delivering that component already ships first
                for provider in sorted(providers):
                    findings.append(
                        f"feature_inventory: {feat_id} touches {comp_id}, which depends on "
                        f"{dep_id} delivered by {provider} - {feat_id} must be blocked_by "
                        f"{provider} (contracts before consumers), or the edge belongs elsewhere"
                    )
    return list(dict.fromkeys(findings))


def compute_waves(order, blocked):
    """Wave 1 starts immediately; wave N starts when wave N-1 has shipped."""
    wave = {}
    for feat_id in order:
        depths = [wave[b] for b in blocked.get(feat_id, []) if b in wave]
        wave[feat_id] = 1 + max(depths, default=0)
    return wave


def wave_conflicts(features, wave):
    """Same-wave features sharing a component: parallel by the graph, serial in the files."""
    comps = {}
    for feat in features:
        if isinstance(feat, dict) and 'id' in feat:
            comps[feat['id']] = set(feat.get('components') or [])
    conflicts = []
    ids = sorted(wave)
    for position, first in enumerate(ids):
        for second in ids[position + 1:]:
            if wave[first] != wave[second]:
                continue
            shared = sorted(comps.get(first, set()) & comps.get(second, set()))
            if shared:
                conflicts.append((first, second, shared))
    return conflicts


def topological_order(feat_ids, blocked):
    """Kahn order (blockers first, ties by id). Returns (order, cycle)."""
    known = set(feat_ids)
    # Unresolvable blockers are reported separately; they must not break the ordering.
    edges = {fid: sorted({b for b in blocked.get(fid, []) if b in known}) for fid in feat_ids}
    indegree = {fid: len(edges[fid]) for fid in feat_ids}
    dependents = {fid: [] for fid in feat_ids}
    for fid in feat_ids:
        for blocker in edges[fid]:
            dependents[blocker].append(fid)

    ready = sorted([fid for fid in feat_ids if indegree[fid] == 0])
    order = []
    while ready:
        current = ready.pop(0)
        order.append(current)
        for dependent in sorted(dependents[current]):
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                ready.append(dependent)
        ready.sort()

    if len(order) < len(feat_ids):
        remaining = [fid for fid in feat_ids if fid not in order]
        return order, find_cycle(remaining, blocked)
    return order, []


def validate_inventory(data, ledger_entries, comp_ids, deps_edges=None, strict=False):
    """Validate feature_inventory.yaml. Returns (errors, warnings, blocked_map, reasons)."""
    errors = []
    warnings = []
    blocked = {}
    reasons = {}

    if not isinstance(data, dict) or 'features' not in data:
        errors.append("_docwork/feature_inventory.yaml: missing 'features' key")
        return errors, warnings, blocked, reasons

    features = data['features']
    if not isinstance(features, list) or not features:
        errors.append("_docwork/feature_inventory.yaml: 'features' must be a non-empty list")
        return errors, warnings, blocked, reasons

    if 'generated' in data and data['generated'] is not None:
        if not re.match(r'^\d{4}-\d{2}-\d{2}$', str(data['generated'])):
            errors.append(f"feature_inventory: generated '{data['generated']}' is not an ISO date")

    seen_ids = set()
    covered_decisions = set()

    for idx, feat in enumerate(features):
        if not isinstance(feat, dict) or 'id' not in feat:
            errors.append(f"features[{idx}]: missing id")
            continue

        feat_id = feat['id']
        if not validate_id_format(feat_id, 'FEAT'):
            errors.append(f"features[{idx}]: invalid id format '{feat_id}' (expect FEAT-NNNN)")
        if feat_id in seen_ids:
            errors.append(f"features[{idx}]: duplicate id '{feat_id}'")
        seen_ids.add(feat_id)

        # Required fields
        for field in ['name', 'scope', 'size']:
            if not feat.get(field):
                errors.append(f"features[{idx}] {feat_id}: missing '{field}'")

        scope = feat.get('scope')
        if scope and len(str(scope).strip()) < SCOPE_MIN_CHARS:
            warnings.append(
                f"features[{idx}] {feat_id}: scope is {len(str(scope).strip())} chars; "
                f"a feature needs a paragraph a spec pass can act on"
            )

        size = feat.get('size')
        if size and size not in VALID_SIZES:
            errors.append(f"features[{idx}] {feat_id}: size '{size}' not in {VALID_SIZES}")

        status = feat.get('status', 'planned')
        if status not in VALID_STATUSES:
            errors.append(f"features[{idx}] {feat_id}: status '{status}' not in {VALID_STATUSES}")

        # Ledger trace: at least one, all resolvable, none dead
        decisions = feat.get('decisions') or []
        if not isinstance(decisions, list):
            errors.append(f"features[{idx}] {feat_id}: decisions must be a list")
            decisions = []
        if not decisions:
            errors.append(
                f"features[{idx}] {feat_id}: must trace to at least one ledger decision"
            )
        for dec_id in decisions:
            if not validate_id_format(dec_id, 'DEC'):
                errors.append(
                    f"features[{idx}] {feat_id}: decision '{dec_id}' invalid format (expect DEC-NNNN)"
                )
                continue
            entry = ledger_entries.get(dec_id)
            if entry is None:
                errors.append(f"features[{idx}] {feat_id}: decision '{dec_id}' not in ledger")
                continue
            covered_decisions.add(dec_id)
            if entry.get('status') == 'dead':
                errors.append(
                    f"features[{idx}] {feat_id}: decision '{dec_id}' has status dead "
                    f"(reason: {entry.get('reason')}) - a feature may not resurrect it"
                )
            elif entry.get('status') == 'superseded':
                warnings.append(
                    f"features[{idx}] {feat_id}: decision '{dec_id}' is superseded by "
                    f"'{entry.get('superseded_by')}' - trace the successor instead"
                )

        # Components resolve when the dependency manifest exists (stage 5+)
        components = feat.get('components') or []
        if components and not isinstance(components, list):
            errors.append(f"features[{idx}] {feat_id}: components must be a list")
        elif components:
            for comp_id in components:
                if not validate_comp_format(comp_id):
                    errors.append(
                        f"features[{idx}] {feat_id}: component '{comp_id}' invalid format "
                        f"(expect COMP-[A-Z0-9-]+)"
                    )
                elif comp_ids and comp_id not in comp_ids:
                    errors.append(
                        f"features[{idx}] {feat_id}: component '{comp_id}' not in dependencies"
                    )

        # Blocking edges - ids, each carrying the reason a spec pass repeats downstream
        blocked_by = feat.get('blocked_by') or []
        if not isinstance(blocked_by, list):
            errors.append(f"features[{idx}] {feat_id}: blocked_by must be a list")
            blocked_by = []
        blocker_ids, blocker_reasons, bad_items = normalize_blockers(blocked_by)
        for item in bad_items:
            errors.append(
                f"features[{idx}] {feat_id}: blocked_by entry {item!r} must be a FEAT id "
                f"or a mapping with 'id' and 'reason'"
            )
        if feat_id in blocker_ids:
            errors.append(f"features[{idx}] {feat_id}: self-edge in blocked_by")
        blocked[feat_id] = [b for b in blocker_ids if b != feat_id]
        reasons[feat_id] = blocker_reasons
        for blocker in blocked[feat_id]:
            if not blocker_reasons.get(blocker):
                msg = (f"features[{idx}] {feat_id}: blocked_by '{blocker}' carries no reason - "
                       f"name the thing that must exist first (a contract, a store, an auth "
                       f"boundary); the spec pass carries the reason, not the id")
                if strict:
                    errors.append(msg)
                else:
                    warnings.append(msg)

    # Second pass: blocking edges resolve
    for feat_id, blockers in blocked.items():
        for blocker in blockers:
            if blocker not in seen_ids:
                errors.append(f"features {feat_id}: blocked_by '{blocker}' not found")

    # Blocking edges acyclic
    order, cycle = topological_order(sorted(seen_ids), blocked)
    if cycle:
        errors.append("feature_inventory: blocking cycle " + " -> ".join(cycle))

    # Contracts before consumers (checkable once components and dependencies.yaml exist)
    for finding in contract_order_findings(features, blocked, deps_edges):
        if strict:
            errors.append(finding)
        else:
            warnings.append(finding)

    # Coverage: every buildable ledger decision lands in some feature
    uncovered = sorted(buildable_decisions(ledger_entries) - covered_decisions)
    if uncovered:
        shown = ', '.join(uncovered[:10])
        if len(uncovered) > 10:
            shown += f", ... (+{len(uncovered) - 10} more)"
        msg = (f"feature_inventory: {len(uncovered)} ratified component-scoped decision(s) "
               f"belong to no feature: {shown}")
        if strict:
            errors.append(msg)
        else:
            warnings.append(msg)

    return errors, warnings, blocked, reasons


def print_handoff(feat_id, features, blocked, reasons, order, wave):
    """The ordering context a spec pass carries into its spec. Returns 0 or 1."""
    by_id = {f['id']: f for f in features if isinstance(f, dict) and 'id' in f}
    feat = by_id.get(feat_id)
    if feat is None:
        print(f"ERROR {feat_id}: not in the feature inventory")
        return 1

    print(f"{feat_id}  {feat.get('name', '')}  [{feat.get('size', '?')}] "
          f"[{feat.get('status', 'planned')}]  wave {wave.get(feat_id, '?')}")
    print(f"scope: {str(feat.get('scope', '')).strip()}")

    edges = blocked.get(feat_id, [])
    if edges:
        print("blocked by (must already exist - say so in the spec):")
        for blocker in edges:
            why = reasons.get(feat_id, {}).get(blocker) or 'reason not recorded'
            print(f"  - {blocker} [{by_id.get(blocker, {}).get('status', '?')}]: {why}")
    else:
        print("blocked by: nothing - can start immediately")

    waiting = [f for f in order if feat_id in blocked.get(f, [])]
    if waiting:
        print("delivers for (keep its contract stable):")
        for dependent in waiting:
            why = reasons.get(dependent, {}).get(feat_id) or 'reason not recorded'
            print(f"  - {dependent}: {why}")

    alongside = [f for f in order
                 if f != feat_id and wave.get(f) == wave.get(feat_id)
                 and by_id.get(f, {}).get('status') != 'shipped']
    if alongside:
        print(f"may run alongside: {', '.join(alongside)}")

    components = feat.get('components') or []
    if components:
        print(f"components: {', '.join(components)}")
    print(f"decisions: {', '.join(feat.get('decisions') or [])}")
    return 0


def next_feature(features, order):
    """First feature in shipping order that is not shipped; its blockers are all shipped."""
    status_by_id = {}
    for feat in features:
        if isinstance(feat, dict) and 'id' in feat:
            status_by_id[feat['id']] = feat.get('status', 'planned')
    for feat_id in order:
        if status_by_id.get(feat_id) != 'shipped':
            return feat_id
    return None


def main():
    parser = argparse.ArgumentParser(
        description='Validate the feature inventory the spec loop consumes one feature per pass'
    )
    parser.add_argument('--root', default='.', help='Project root (default: .)')
    parser.add_argument('--strict', action='store_true',
                        help='Promote warnings to errors: uncovered ratified decisions, '
                             'blocking edges with no reason, consumers not blocked by their provider')
    parser.add_argument('--order', action='store_true',
                        help='Print the shipping order (blockers first) after validating')
    parser.add_argument('--waves', action='store_true',
                        help='Print the waves: which features may run side by side, and which share a component')
    parser.add_argument('--next', dest='next_only', action='store_true',
                        help='Print only the next feature id to spec (or NONE), for the spec loop')
    parser.add_argument('--handoff', metavar='FEAT-NNNN',
                        help="Print one feature's scope, blockers with reasons, dependents "
                             "and wave-mates, for the spec pass to carry into its spec")

    args = parser.parse_args()

    root = os.path.abspath(args.root)
    inventory_path = os.path.join(root, '_docwork', 'feature_inventory.yaml')
    ledger_path = os.path.join(root, '_docwork', 'ledger.yaml')
    deps_path = os.path.join(root, 'docs', 'architecture', 'dependencies.yaml')

    errors = []
    warnings = []

    inventory_data = load_yaml(inventory_path)
    if inventory_data is False:
        errors.append("_docwork/feature_inventory.yaml: parse error (see above)")
    elif inventory_data is None:
        errors.append("_docwork/feature_inventory.yaml: missing")

    ledger_data = load_yaml(ledger_path)
    if ledger_data is False:
        errors.append("_docwork/ledger.yaml: parse error (see above)")
        ledger_data = {}
    elif ledger_data is None:
        errors.append("_docwork/ledger.yaml: missing - feature traces cannot be verified")
        ledger_data = {}

    # dependencies.yaml does not exist before stage 5; absence is not a finding
    deps_data = load_yaml(deps_path)
    comp_ids = set()
    deps_edges = {}
    if deps_data and deps_data is not False and 'components' in deps_data:
        comp_ids = {c['id'] for c in deps_data['components'] if isinstance(c, dict) and 'id' in c}
        for comp in deps_data['components']:
            if isinstance(comp, dict) and 'id' in comp:
                edges = comp.get('depends_on') or []
                deps_edges[comp['id']] = edges if isinstance(edges, list) else []

    order = []
    features = []
    blocked = {}
    reasons = {}
    if inventory_data and inventory_data is not False:
        ledger_entries = index_ledger(ledger_data)
        inv_errors, inv_warnings, blocked, reasons = validate_inventory(
            inventory_data, ledger_entries, comp_ids, deps_edges, args.strict
        )
        errors.extend(inv_errors)
        warnings.extend(inv_warnings)
        features = inventory_data.get('features') or []
        if not inv_errors:
            order, _cycle = topological_order(sorted(blocked.keys()), blocked)

    quiet = args.next_only or args.handoff

    if errors:
        if not quiet:
            for warn in warnings:
                print(f"WARN {warn}")
        for err in errors:
            print(f"ERROR {err}")
        sys.exit(1)

    if args.next_only:
        nxt = next_feature(features, order)
        print(nxt if nxt else 'NONE')
        sys.exit(0)

    wave = compute_waves(order, blocked)

    if args.handoff:
        sys.exit(print_handoff(args.handoff, features, blocked, reasons, order, wave))

    for warn in warnings:
        print(f"WARN {warn}")

    by_id = {f['id']: f for f in features if isinstance(f, dict) and 'id' in f}

    if args.order:
        print("Shipping order (blockers first):")
        for position, feat_id in enumerate(order, 1):
            feat = by_id.get(feat_id, {})
            print(f"  {position}. {feat_id} [wave {wave.get(feat_id, '?')}] "
                  f"[{feat.get('size', '?')}] [{feat.get('status', 'planned')}] "
                  f"{feat.get('name', '')}")

    if args.waves:
        print("Waves (same wave = no blocking edge between them):")
        for depth in sorted(set(wave.values())):
            members = [f for f in order if wave[f] == depth]
            names = ', '.join(f"{m} ({by_id.get(m, {}).get('status', 'planned')})" for m in members)
            when = 'start now' if depth == 1 else f'after wave {depth - 1} ships'
            print(f"  wave {depth} ({when}): {names}")
        for first, second, shared in wave_conflicts(features, wave):
            print(f"  serialize {first} and {second}: both touch {', '.join(shared)}")

    noun = 'feature' if len(order) == 1 else 'features'
    nxt = next_feature(features, order)
    print(f"OK: feature inventory valid ({len(order)} {noun}, "
          f"next: {nxt if nxt else 'none - all shipped'})")
    sys.exit(0)


if __name__ == '__main__':
    main()
