#!/usr/bin/env python3
"""
selftest.py - Comprehensive self-test for all 9 gate scripts.

Creates a temporary fixture project, runs all scripts against it,
then introduces deliberate corruptions to test error detection.
"""

import subprocess
import sys
import os
import re
import shutil
import tempfile
import yaml
from datetime import date


TEST_DIR = os.path.join(tempfile.gettempdir(), 'docfactory-selftest')
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PY = f'"{sys.executable}"'   # the interpreter running this file
# Every command string quotes all three paths - the interpreter, the script, and
# --root - because any of them may sit under a user profile with a space in it.


def run_cmd(cmd, cwd=None):
    """Run command, return (returncode, stdout, stderr)."""
    result = subprocess.run(
        cmd, shell=True, cwd=cwd,
        capture_output=True, text=True
    )
    return result.returncode, result.stdout, result.stderr


def setup_fixture():
    """Create a complete valid fixture project."""
    if os.path.exists(TEST_DIR):
        shutil.rmtree(TEST_DIR)

    os.makedirs(TEST_DIR)

    # Create _docwork structure
    docwork = os.path.join(TEST_DIR, '_docwork')
    chunks_dir = os.path.join(docwork, 'chunks')
    os.makedirs(chunks_dir)

    # manifest.yaml
    manifest = {
        'project': 'Test Project',
        'mode': 'transcripts',
        'created': date.today().isoformat(),
        'lenses': ['core'],
        'scope': {'in': ['test'], 'out': []},
        'sources': [
            {
                'id': 'SRC-01',
                'path': 'exports/session-1.txt',
                'kind': 'transcript',
                'role': 'primary',
                'status': 'chunked'
            }
        ]
    }
    with open(os.path.join(docwork, 'manifest.yaml'), 'w', encoding='utf-8') as f:
        yaml.dump(manifest, f)

    # stage_state.yaml
    stage_state = {
        'current_stage': 3,
        'provisional': False,
        'completed': [{'stage': 1, 'date': date.today().isoformat(), 'gate': 'pass'}],
        'harvest_progress': {'SRC-01': 'SRC-01-C0002'}
    }
    with open(os.path.join(docwork, 'stage_state.yaml'), 'w', encoding='utf-8') as f:
        yaml.dump(stage_state, f)

    # Create chunk files
    chunk1_path = os.path.join(chunks_dir, 'SRC-01-C0001.txt')
    with open(chunk1_path, 'w', encoding='utf-8') as f:
        f.write('First chunk\nSome discussion\n')

    chunk2_path = os.path.join(chunks_dir, 'SRC-01-C0002.txt')
    with open(chunk2_path, 'w', encoding='utf-8') as f:
        f.write('Second chunk\nMore content\n')

    # SRC-01-index.yaml
    index = {
        'source': 'SRC-01',
        'chunks': [
            {'id': 'SRC-01-C0001', 'file': 'SRC-01-C0001.txt', 'start_line': 1, 'end_line': 2},
            {'id': 'SRC-01-C0002', 'file': 'SRC-01-C0002.txt', 'start_line': 3, 'end_line': 4}
        ]
    }
    with open(os.path.join(chunks_dir, 'SRC-01-index.yaml'), 'w', encoding='utf-8') as f:
        yaml.dump(index, f)

    # extractions.yaml
    extractions = {
        'extractions': [
            {
                'id': 'EXT-0001',
                'type': 'decision',
                'summary': 'Test decision',
                'quote': 'A key point',
                'cite': 'SRC-01-C0001',
                'topics': ['test'],
                'authority': 'source'
            }
        ]
    }
    with open(os.path.join(docwork, 'extractions.yaml'), 'w', encoding='utf-8') as f:
        yaml.dump(extractions, f)

    # ledger.yaml with one normal, one dead, one rider, one supersession
    ledger = {
        'ledger': [
            {
                'id': 'DEC-0001',
                'title': 'Normal decision',
                'statement': 'This is a normal decision.',
                'status': 'ratified',
                'rationale': 'It makes sense.',
                'sources': ['EXT-0001'],
                'component': 'COMP-TEST',
                'tags': [],
                'supersedes': [],
                'superseded_by': None,
                'reason': None,
                'conflict': None
            },
            {
                'id': 'DEC-0002',
                'title': 'Dead decision',
                'statement': 'This decision was killed.',
                'status': 'dead',
                'rationale': 'Changed direction.',
                'sources': ['EXT-0001'],
                'component': 'COMP-TEST',
                'tags': [],
                'supersedes': [],
                'superseded_by': None,
                'reason': 'We chose a different approach',
                'conflict': None
            },
            {
                'id': 'DEC-0003',
                'title': 'Superseded decision',
                'statement': 'Old approach.',
                'status': 'superseded',
                'rationale': 'Replaced by newer decision.',
                'sources': [],
                'component': 'COMP-TEST',
                'tags': [],
                'supersedes': [],
                'superseded_by': 'DEC-0004',
                'reason': None,
                'conflict': None,
                'authority': 'rider'
            },
            {
                'id': 'DEC-0004',
                'title': 'Newer decision',
                'statement': 'New approach.',
                'status': 'ratified',
                'rationale': 'Better.',
                'sources': ['EXT-0001'],
                'component': 'COMP-TEST',
                'tags': [],
                'supersedes': ['DEC-0003'],
                'superseded_by': None,
                'reason': None,
                'conflict': None
            }
        ]
    }
    with open(os.path.join(docwork, 'ledger.yaml'), 'w', encoding='utf-8') as f:
        yaml.dump(ledger, f)

    # gaps.yaml
    gaps = {
        'gaps': [
            {
                'id': 'GAP-0001',
                'question': 'What is the timeout budget?',
                'needed_by': ['COMP-TEST'],
                'blocking': False,
                'status': 'open',
                'answer': None
            },
            {
                'id': 'GAP-0002',
                'question': 'Critical missing info?',
                'needed_by': ['COMP-TEST'],
                'blocking': True,
                'status': 'open',
                'answer': None
            }
        ]
    }
    with open(os.path.join(docwork, 'gaps.yaml'), 'w', encoding='utf-8') as f:
        yaml.dump(gaps, f)

    # enhancements.yaml
    enhancements = {
        'enhancements': [
            {
                'id': 'ENH-0001',
                'doc': 'docs/test.md',
                'description': 'Added timeout handling',
                'rationale': 'Sources missed this',
                'status': 'ratified'
            }
        ]
    }
    with open(os.path.join(docwork, 'enhancements.yaml'), 'w', encoding='utf-8') as f:
        yaml.dump(enhancements, f)

    # feature_inventory.yaml - ordered, traced, one shipped feature
    inventory = {
        'generated': date.today().isoformat(),
        'ratified': date.today().isoformat(),
        'features': [
            {
                'id': 'FEAT-0001',
                'name': 'Record storage',
                'scope': ('Persist records for the test component: the write path, the read path '
                          'the API layer uses, and the retention rule. Excludes archival.'),
                'decisions': ['DEC-0001'],
                'components': ['COMP-STORE'],
                'blocked_by': [],
                'size': 'one-pass',
                'status': 'shipped',
                'notes': ''
            },
            {
                'id': 'FEAT-0002',
                'name': 'Record processing',
                'scope': ('The processing pipeline over stored records: retry policy, timeout '
                          'budget, and the failure modes the component spec documents.'),
                'decisions': ['DEC-0004'],
                'components': ['COMP-TEST'],
                'blocked_by': [
                    {'id': 'FEAT-0001',
                     'reason': 'processes records only the store can already persist'}
                ],
                'size': 'multi-pass',
                'status': 'planned',
                'notes': ''
            },
            {
                'id': 'FEAT-0003',
                'name': 'Public API surface',
                'scope': ('The external API over processed records: its contract, the errors it '
                          'returns to callers, and the values it reads from the registry.'),
                'decisions': ['DEC-0001', 'DEC-0004'],
                'components': ['COMP-API'],
                'blocked_by': [
                    {'id': 'FEAT-0002',
                     'reason': 'the API returns records the processing pipeline produces'}
                ],
                'size': 'one-pass',
                'status': 'planned',
                'notes': ''
            }
        ]
    }
    with open(os.path.join(docwork, 'feature_inventory.yaml'), 'w', encoding='utf-8') as f:
        yaml.dump(inventory, f)

    # Create docs structure
    docs_dir = os.path.join(TEST_DIR, 'docs')
    registry_dir = os.path.join(docs_dir, 'registry')
    arch_dir = os.path.join(docs_dir, 'architecture')
    os.makedirs(registry_dir)
    os.makedirs(arch_dir)

    # docs/registry/variables.yaml
    variables = {
        'variables': [
            {
                'name': 'timeout_ms',
                'symbol': 'T',
                'value': 5000,
                'formula': None,
                'units': 'milliseconds',
                'type': 'duration',
                'component': 'COMP-TEST',
                'decision': 'DEC-0001',
                'configurable': True,
                'notes': ''
            },
            {
                'name': 'max_retries',
                'symbol': 'R',
                'value': 3,
                'formula': None,
                'units': 'count',
                'type': 'count',
                'component': 'COMP-TEST',
                'decision': 'DEC-0001',
                'configurable': False,
                'notes': ''
            },
            {
                'name': 'buffer_size',
                'symbol': None,
                'value': None,
                'formula': None,
                'units': 'bytes',
                'type': 'count',
                'component': 'COMP-TEST',
                'decision': 'DEC-0001',
                'gap': 'GAP-0001',
                'notes': ''
            }
        ]
    }
    with open(os.path.join(registry_dir, 'variables.yaml'), 'w', encoding='utf-8') as f:
        yaml.dump(variables, f)

    # docs/architecture/dependencies.yaml
    dependencies = {
        'components': [
            {
                'id': 'COMP-TEST',
                'name': 'Test Component',
                'kind': 'service',
                'layer': 'backend',
                'depends_on': ['COMP-STORE'],
                'interfaces': [],
                'spec': 'docs/components/test.md'
            },
            {
                'id': 'COMP-STORE',
                'name': 'Data Store',
                'kind': 'store',
                'layer': 'data',
                'depends_on': [],
                'interfaces': [],
                'spec': 'docs/components/store.md'
            },
            {
                'id': 'COMP-API',
                'name': 'API Layer',
                'kind': 'service',
                'layer': 'middleware',
                'depends_on': ['COMP-TEST'],
                'interfaces': [],
                'spec': 'docs/components/api.md'
            }
        ]
    }
    with open(os.path.join(arch_dir, 'dependencies.yaml'), 'w', encoding='utf-8') as f:
        yaml.dump(dependencies, f)

    # Provenance block shared by every fixture doc (OKF fields)
    today_iso = date.today().isoformat()
    prov = (
        "sources: [SRC-01-C0001, DEC-0001]\n"
        f"generated: {today_iso}\n"
        f"verified: {today_iso}\n"
        "stale_after: 90d\n"
    )

    # Create markdown documents
    # docs/index.md
    index_md = """---
id: INDEX-001
title: Project Index
type: index
status: ratified
""" + prov + """---

Welcome to the test project.
"""
    with open(os.path.join(docs_dir, 'index.md'), 'w', encoding='utf-8') as f:
        f.write(index_md)

    # docs/AGENTS.md
    agents_md = """---
id: AGENTS-001
title: Agent Entrypoint
type: agents
status: ratified
""" + prov + """---

Agents start here.
"""
    with open(os.path.join(docs_dir, 'AGENTS.md'), 'w', encoding='utf-8') as f:
        f.write(agents_md)

    # docs/gap-report.md
    gap_report_md = """---
id: GAP-REPORT-001
title: Gap Report
type: gap-report
status: ratified
""" + prov + """---

Current gaps: GAP-0001, GAP-0002
"""
    with open(os.path.join(docs_dir, 'gap-report.md'), 'w', encoding='utf-8') as f:
        f.write(gap_report_md)

    # docs/architecture/overview.md (required at stage 8; carries its diagrams)
    overview_md = """---
id: ARCH-OVERVIEW
title: Architecture Overview
type: architecture
status: ratified
""" + prov + """---

The runtime shape, and the layer view.

```mermaid
flowchart TB
    api[API Layer] --> engine[Test Component]
    engine --> store[(Data Store)]
```
"""
    with open(os.path.join(arch_dir, 'overview.md'), 'w', encoding='utf-8') as f:
        f.write(overview_md)

    # docs/architecture/stack.md (required at stage 8; every project gets one)
    stack_md = """---
id: ARCH-STACK
title: Stack and Pipeline
type: architecture
status: ratified
""" + prov + """---

What the system is built out of, and what runs against it.
"""
    with open(os.path.join(arch_dir, 'stack.md'), 'w', encoding='utf-8') as f:
        f.write(stack_md)

    # docs/components/test.md (component-spec with mermaid)
    test_md = """---
id: COMP-TEST
title: Test Component
type: component-spec
status: ratified
component: COMP-TEST
depends_on: [COMP-STORE]
decisions: [DEC-0001]
""" + prov + """---

This is a test component.

DEC-0001 governs its behavior.

```mermaid
graph TD
  A[Input] --> B[Process]
  B --> C[Output]
```
"""
    os.makedirs(os.path.join(docs_dir, 'components'), exist_ok=True)
    with open(os.path.join(docs_dir, 'components', 'test.md'), 'w', encoding='utf-8') as f:
        f.write(test_md)

    # docs/components/store.md
    store_md = """---
id: COMP-STORE
title: Data Store
type: component-spec
status: ratified
component: COMP-STORE
depends_on: []
decisions: [DEC-0001]
""" + prov + """---

Data persistence layer.

DEC-0001 describes the approach.

<!-- no-diagram: not needed -->
"""
    with open(os.path.join(docs_dir, 'components', 'store.md'), 'w', encoding='utf-8') as f:
        f.write(store_md)

    # docs/components/api.md
    api_md = """---
id: COMP-API
title: API Layer
type: component-spec
status: ratified
component: COMP-API
depends_on: [COMP-TEST]
decisions: [DEC-0001]
""" + prov + """---

API interface.

DEC-0001 defines the contract.

<!-- no-diagram: simple API -->
"""
    with open(os.path.join(docs_dir, 'components', 'api.md'), 'w', encoding='utf-8') as f:
        f.write(api_md)

    # Create source file for chunking test
    exports_dir = os.path.join(TEST_DIR, 'exports')
    os.makedirs(exports_dir, exist_ok=True)
    with open(os.path.join(exports_dir, 'session-1.txt'), 'w', encoding='utf-8') as f:
        f.write('Session one\nLine 2\nLine 3\n')

    print(f'SETUP: Created fixture at {TEST_DIR}')


def test_init_workspace():
    """Test init_workspace --check on valid fixture."""
    print('\nTEST: init_workspace --check (valid)')
    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/init_workspace.py" check --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    if code == 0 and 'OK' in out:
        print('  PASS: valid workspace detected')
        return True
    else:
        print(f'  FAIL: expected exit 0, got {code}')
        print(f'  stdout: {out}')
        return False


def test_chunk_transcript():
    """Test chunk_transcript on a source file."""
    print('\nTEST: chunk_transcript')
    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/chunk_transcript.py" exports/session-1.txt '
        f'--source-id SRC-02 --out _docwork/chunks --max-lines 1 --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    if code == 0:
        # Check that index was created
        index_path = os.path.join(TEST_DIR, '_docwork', 'chunks', 'SRC-02-index.yaml')
        if os.path.exists(index_path):
            print('  PASS: chunked and created index')
            return True
    print(f'  FAIL: exit {code}')
    return False


def test_validate_ledger():
    """Test validate_ledger on valid fixture."""
    print('\nTEST: validate_ledger (valid)')
    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/validate_ledger.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    if code == 0 and 'OK' in out:
        print('  PASS: ledger valid')
        return True
    else:
        print(f'  FAIL: exit {code}')
        return False


def test_validate_registry():
    """Test validate_registry on valid fixture."""
    print('\nTEST: validate_registry (valid)')
    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/validate_registry.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    if code == 0 and 'OK' in out:
        print('  PASS: registry valid')
        return True
    else:
        print(f'  FAIL: exit {code}')
        return False


def test_check_citations():
    """Test check_citations on valid fixture."""
    print('\nTEST: check_citations (valid)')
    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/check_citations.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    if code == 0 and 'OK' in out:
        print('  PASS: citations valid')
        return True
    else:
        print(f'  FAIL: exit {code}')
        return False


def test_lint_docs():
    """Test lint_docs on valid fixture."""
    print('\nTEST: lint_docs (valid)')
    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/lint_docs.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    if code == 0 and 'OK' in out:
        print('  PASS: docs lint clean')
        return True
    else:
        print(f'  FAIL: exit {code}')
        return False


def test_coverage_report():
    """Test coverage_report (always exits 0)."""
    print('\nTEST: coverage_report')
    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/coverage_report.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    if code == 0:
        report_path = os.path.join(TEST_DIR, '_docwork', 'coverage-report.md')
        if os.path.exists(report_path):
            print('  PASS: coverage report generated')
            return True
    print(f'  FAIL: exit {code}')
    return False


def test_blast_radius():
    """Test blast_radius for a component."""
    print('\nTEST: blast_radius')
    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/blast_radius.py" COMP-TEST --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    if code == 0 and 'COMP-API' in out:
        print('  PASS: blast radius computed')
        return True
    else:
        print(f'  FAIL: exit {code}')
        return False


def run_inventory(extra=''):
    """Run validate_inventory.py against the fixture."""
    cmd = f'{PY} "{SCRIPT_DIR}/validate_inventory.py" --root "{TEST_DIR}" {extra}'.strip()
    return run_cmd(cmd, cwd=TEST_DIR)


def expect_inventory_error(title, mutate, needle, extra=''):
    """Corrupt the inventory, expect non-zero exit mentioning needle, then restore."""
    print(f'\nTEST: validate_inventory ({title} - ERROR expected)')
    path = os.path.join(TEST_DIR, '_docwork', 'feature_inventory.yaml')

    with open(path, 'r', encoding='utf-8') as f:
        original = f.read()

    inventory = yaml.safe_load(original)
    mutate(inventory)
    with open(path, 'w', encoding='utf-8') as f:
        yaml.dump(inventory, f)

    code, out, err = run_inventory(extra)

    # Restore
    with open(path, 'w', encoding='utf-8') as f:
        f.write(original)

    if code != 0 and needle in out:
        print('  PASS: error detected correctly')
        return True
    else:
        print(f'  FAIL: expected error containing "{needle}", got exit {code}')
        print(f'  stdout: {out}')
        return False


def test_validate_inventory():
    """Test validate_inventory on valid fixture."""
    print('\nTEST: validate_inventory (valid)')
    code, out, err = run_inventory()
    if code == 0 and 'OK' in out:
        print('  PASS: feature inventory valid')
        return True
    else:
        print(f'  FAIL: exit {code}')
        print(f'  stdout: {out}')
        return False


def test_inventory_order():
    """Test the shipping order puts blockers first."""
    print('\nTEST: validate_inventory --order (blockers first)')
    code, out, err = run_inventory('--order')
    if code == 0 and all(f in out for f in ('FEAT-0001', 'FEAT-0002', 'FEAT-0003')):
        if out.index('FEAT-0001') < out.index('FEAT-0002') < out.index('FEAT-0003'):
            print('  PASS: order is topological')
            return True
    print(f'  FAIL: exit {code}')
    print(f'  stdout: {out}')
    return False


def test_inventory_next():
    """Test --next names the one feature the spec loop takes now."""
    print('\nTEST: validate_inventory --next (one feature, no re-prompting)')
    code, out, err = run_inventory('--next')
    if code == 0 and out.strip() == 'FEAT-0002':
        print('  PASS: next unshipped feature returned')
        return True
    else:
        print(f'  FAIL: expected FEAT-0002, got exit {code} / {out.strip()!r}')
        return False


def test_inventory_duplicate_id():
    """Test detection of duplicate FEAT id."""
    def mutate(inv):
        inv['features'][1]['id'] = 'FEAT-0001'
    return expect_inventory_error('duplicate id', mutate, 'duplicate id')


def test_inventory_untraced_feature():
    """Test detection of a feature that traces to no ledger decision."""
    def mutate(inv):
        inv['features'][1]['decisions'] = []
    return expect_inventory_error(
        'feature with no ledger trace', mutate, 'at least one ledger decision')


def test_inventory_dangling_decision():
    """Test detection of a feature tracing a DEC that is not in the ledger."""
    def mutate(inv):
        inv['features'][0]['decisions'] = ['DEC-9999']
    return expect_inventory_error('dangling DEC trace', mutate, "'DEC-9999' not in ledger")


def test_inventory_dead_decision():
    """Test detection of a feature built on a dead decision (zombie)."""
    def mutate(inv):
        inv['features'][0]['decisions'] = ['DEC-0002']
    return expect_inventory_error('feature on a dead decision', mutate, 'status dead')


def test_inventory_cycle():
    """Test detection of a cycle in blocking edges."""
    def mutate(inv):
        inv['features'][0]['blocked_by'] = ['FEAT-0003']
    return expect_inventory_error('blocking cycle', mutate, 'blocking cycle')


def test_inventory_dangling_blocker():
    """Test detection of an unresolvable blocking edge."""
    def mutate(inv):
        inv['features'][2]['blocked_by'] = ['FEAT-9999']
    return expect_inventory_error(
        'dangling blocked_by', mutate, "blocked_by 'FEAT-9999' not found")


def test_inventory_contract_order():
    """Test a consumer feature that dropped its edge to the provider feature."""
    def mutate(inv):
        inv['features'][2]['blocked_by'] = []
    return expect_inventory_error(
        'consumer not blocked by provider', mutate,
        'contracts before consumers', extra='--strict')


def test_inventory_waves():
    """Test the waves output separates what must wait from what may run alongside."""
    print('\nTEST: validate_inventory --waves (parallel vs sequential)')
    code, out, err = run_inventory('--waves')
    if code == 0 and 'wave 1' in out and 'wave 3' in out:
        print('  PASS: waves reported')
        return True
    print(f'  FAIL: exit {code}')
    print(f'  stdout: {out}')
    return False


def test_inventory_handoff():
    """Test the handoff carries the blocking reason a spec pass repeats."""
    print('\nTEST: validate_inventory --handoff (ordering context for the spec pass)')
    code, out, err = run_inventory('--handoff FEAT-0003')
    if code == 0 and 'FEAT-0002' in out and 'processing pipeline produces' in out:
        print('  PASS: handoff carries blockers with reasons')
        return True
    print(f'  FAIL: exit {code}')
    print(f'  stdout: {out}')
    return False


def test_inventory_coverage_strict():
    """Test uncovered ratified decisions warn by default and fail under --strict."""
    print('\nTEST: validate_inventory (uncovered decision - WARN, then --strict ERROR)')
    path = os.path.join(TEST_DIR, '_docwork', 'feature_inventory.yaml')

    with open(path, 'r', encoding='utf-8') as f:
        original = f.read()

    inventory = yaml.safe_load(original)
    inventory['features'][1]['decisions'] = ['DEC-0001']
    inventory['features'][2]['decisions'] = ['DEC-0001']
    with open(path, 'w', encoding='utf-8') as f:
        yaml.dump(inventory, f)

    loose_code, loose_out, _ = run_inventory()
    strict_code, strict_out, _ = run_inventory('--strict')

    # Restore
    with open(path, 'w', encoding='utf-8') as f:
        f.write(original)

    if (loose_code == 0 and 'WARN' in loose_out and 'DEC-0004' in loose_out
            and strict_code != 0 and 'DEC-0004' in strict_out):
        print('  PASS: warns by default, blocks under --strict')
        return True
    else:
        print(f'  FAIL: got exit {loose_code} (loose) / {strict_code} (strict)')
        print(f'  stdout: {loose_out}{strict_out}')
        return False


def test_dead_without_reason():
    """Test detection of dead decision without reason."""
    print('\nTEST: validate_ledger (dead without reason - ERROR expected)')

    ledger_path = os.path.join(TEST_DIR, '_docwork', 'ledger.yaml')
    with open(ledger_path, 'r', encoding='utf-8') as f:
        ledger = yaml.safe_load(f)

    ledger['ledger'][1]['reason'] = None

    with open(ledger_path, 'w', encoding='utf-8') as f:
        yaml.dump(ledger, f)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/validate_ledger.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    # Restore
    ledger['ledger'][1]['reason'] = 'We chose a different approach'
    with open(ledger_path, 'w', encoding='utf-8') as f:
        yaml.dump(ledger, f)

    if code != 0 and 'dead requires non-empty reason' in out:
        print('  PASS: error detected correctly')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def test_dangling_superseded_by():
    """Test detection of dangling superseded_by reference."""
    print('\nTEST: validate_ledger (dangling superseded_by - ERROR expected)')

    ledger_path = os.path.join(TEST_DIR, '_docwork', 'ledger.yaml')
    with open(ledger_path, 'r', encoding='utf-8') as f:
        ledger = yaml.safe_load(f)

    ledger['ledger'][2]['superseded_by'] = 'DEC-9999'

    with open(ledger_path, 'w', encoding='utf-8') as f:
        yaml.dump(ledger, f)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/validate_ledger.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    # Restore
    ledger['ledger'][2]['superseded_by'] = 'DEC-0004'
    with open(ledger_path, 'w', encoding='utf-8') as f:
        yaml.dump(ledger, f)

    if code != 0 and "not found" in out:
        print('  PASS: dangling reference detected')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def test_duplicate_registry_name():
    """Test detection of duplicate registry name."""
    print('\nTEST: validate_registry (duplicate name - ERROR expected)')

    registry_path = os.path.join(TEST_DIR, 'docs', 'registry', 'variables.yaml')
    with open(registry_path, 'r', encoding='utf-8') as f:
        registry = yaml.safe_load(f)

    registry['variables'][1]['name'] = 'timeout_ms'

    with open(registry_path, 'w', encoding='utf-8') as f:
        yaml.dump(registry, f)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/validate_registry.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    # Restore
    registry['variables'][1]['name'] = 'max_retries'
    with open(registry_path, 'w', encoding='utf-8') as f:
        yaml.dump(registry, f)

    if code != 0 and 'duplicate name' in out:
        print('  PASS: duplicate detected')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def _mutate_component(field, value):
    """Set (or, with value=None, delete) a field on COMP-TEST; return the restore callable."""
    deps_path = os.path.join(TEST_DIR, 'docs', 'architecture', 'dependencies.yaml')
    with open(deps_path, 'r', encoding='utf-8') as f:
        deps = yaml.safe_load(f)

    original = deps['components'][0][field]
    if value is None:
        del deps['components'][0][field]
    else:
        deps['components'][0][field] = value

    with open(deps_path, 'w', encoding='utf-8') as f:
        yaml.dump(deps, f)

    def restore():
        deps['components'][0][field] = original
        with open(deps_path, 'w', encoding='utf-8') as f:
            yaml.dump(deps, f)

    return restore


def test_component_kind_off_enum():
    """Test detection of a component kind outside the documented enum."""
    print('\nTEST: validate_registry (component kind off-enum - ERROR expected)')

    restore = _mutate_component('kind', 'microservice')
    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/validate_registry.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    restore()

    if code != 0 and "kind 'microservice' not in" in out:
        print('  PASS: off-enum kind detected')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def test_component_missing_layer():
    """Test that a component without a declared layer is rejected."""
    print('\nTEST: validate_registry (component missing layer - ERROR expected)')

    restore = _mutate_component('layer', None)
    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/validate_registry.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    restore()

    if code != 0 and "missing 'layer'" in out:
        print('  PASS: undeclared layer detected')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def test_registry_no_false_warn():
    """Test that a valid fixture produces no WARN (spec paths resolve against --root)."""
    print('\nTEST: validate_registry (valid fixture emits no WARN)')

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/validate_registry.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    if code == 0 and 'WARN' not in out:
        print('  PASS: no false warnings')
        return True
    else:
        print(f'  FAIL: exit {code}, output: {out.strip()}')
        return False


def test_upward_dependency_edge():
    """Test detection of a dependency pointing up the layer stack."""
    print('\nTEST: validate_registry (upward depends_on - ERROR expected)')

    # COMP-TEST is backend; COMP-API is middleware, so this edge runs upward
    restore = _mutate_component('depends_on', ['COMP-STORE', 'COMP-API'])
    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/validate_registry.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    restore()

    if code != 0 and 'upward depends_on' in out:
        print('  PASS: upward edge detected')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def test_design_source_without_chunks():
    """Test that a harvested design packet must show a chunk index or say why not."""
    print('\nTEST: init_workspace --check (design packet without chunks - ERROR expected)')

    manifest_path = os.path.join(TEST_DIR, '_docwork', 'manifest.yaml')
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = yaml.safe_load(f)

    os.makedirs(os.path.join(TEST_DIR, 'design'), exist_ok=True)
    original_sources = list(manifest['sources'])
    design_source = {
        'id': 'SRC-DESIGN',
        'path': 'design',
        'kind': 'design',
        'role': 'primary',
        'status': 'harvested'
    }
    manifest['sources'] = original_sources + [design_source]
    with open(manifest_path, 'w', encoding='utf-8') as f:
        yaml.dump(manifest, f)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/init_workspace.py" check --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    detected = code != 0 and 'index missing for SRC-DESIGN' in out

    # An explicit no_chunks reason is the documented escape hatch
    manifest['sources'][-1]['no_chunks'] = 'screenshots only; structure is GAP-0002'
    with open(manifest_path, 'w', encoding='utf-8') as f:
        yaml.dump(manifest, f)

    code2, out2, err2 = run_cmd(
        f'{PY} "{SCRIPT_DIR}/init_workspace.py" check --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )
    excused = code2 == 0

    # Restore
    manifest['sources'] = original_sources
    with open(manifest_path, 'w', encoding='utf-8') as f:
        yaml.dump(manifest, f)
    shutil.rmtree(os.path.join(TEST_DIR, 'design'))

    if detected and excused:
        print('  PASS: unchunked design packet blocked, no_chunks reason accepted')
        return True
    else:
        print(f'  FAIL: detected={detected} (exit {code}), excused={excused} (exit {code2})')
        return False


def test_lint_missing_required_doc_strict():
    """Test that a missing docs/architecture/stack.md fails the ship gate."""
    print('\nTEST: lint_docs --strict (missing stack.md - ERROR expected)')

    stack_path = os.path.join(TEST_DIR, 'docs', 'architecture', 'stack.md')
    with open(stack_path, 'r', encoding='utf-8') as f:
        content = f.read()
    os.remove(stack_path)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/lint_docs.py" --strict --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    # Restore
    with open(stack_path, 'w', encoding='utf-8') as f:
        f.write(content)

    if code != 0 and 'docs/architecture/stack.md: missing required document' in out:
        print('  PASS: missing required doc detected')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def test_lint_overview_missing_diagram():
    """Test that an architecture overview without a diagram is caught."""
    print('\nTEST: lint_docs (overview without mermaid - ERROR expected)')

    overview_path = os.path.join(TEST_DIR, 'docs', 'architecture', 'overview.md')
    with open(overview_path, 'r', encoding='utf-8') as f:
        content = f.read()

    stripped = content.split('```mermaid')[0]
    with open(overview_path, 'w', encoding='utf-8') as f:
        f.write(stripped)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/lint_docs.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    # Restore
    with open(overview_path, 'w', encoding='utf-8') as f:
        f.write(content)

    if code != 0 and 'must contain a mermaid block' in out:
        print('  PASS: undrawn overview detected')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def test_doc_citing_missing_dec():
    """Test detection of doc citing non-existent DEC."""
    print('\nTEST: check_citations (missing DEC reference - ERROR expected)')

    test_md_path = os.path.join(TEST_DIR, 'docs', 'components', 'api.md')
    with open(test_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    content = content.replace('DEC-0001', 'DEC-9999')

    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/check_citations.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    # Restore
    with open(test_md_path, 'r', encoding='utf-8') as f:
        content = f.read()
    content = content.replace('DEC-9999', 'DEC-0001')
    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    if code != 0 and 'DEC-9999' in out:
        print('  PASS: missing DEC detected')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def test_lint_antipattern():
    """Test detection of style anti-pattern."""
    print('\nTEST: lint_docs (anti-pattern - ERROR expected)')

    test_md_path = os.path.join(TEST_DIR, 'docs', 'components', 'test.md')
    with open(test_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    content = content.replace('This is a test component.', 'This is a test component. As discussed above, it is important.')

    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/lint_docs.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    # Restore
    with open(test_md_path, 'r', encoding='utf-8') as f:
        content = f.read()
    content = content.replace('As discussed above, it is important.', '')
    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    if code != 0 and ('above' in out.lower() or 'relative' in out.lower()):
        print('  PASS: anti-pattern detected')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def test_lint_provisional_strict():
    """Test strict mode rejects provisional status."""
    print('\nTEST: lint_docs --strict (provisional status - ERROR expected)')

    test_md_path = os.path.join(TEST_DIR, 'docs', 'components', 'test.md')
    with open(test_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    content = content.replace('status: ratified', 'status: provisional')

    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/lint_docs.py" --strict --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    # Restore
    with open(test_md_path, 'r', encoding='utf-8') as f:
        content = f.read()
    content = content.replace('status: provisional', 'status: ratified')
    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    if code != 0 and 'provisional' in out.lower():
        print('  PASS: provisional rejected in strict mode')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def test_lint_stale_doc():
    """Test staleness detection: warns in normal mode, does not block drafting."""
    print('\nTEST: lint_docs (stale doc - WARN expected, exit 0)')

    test_md_path = os.path.join(TEST_DIR, 'docs', 'components', 'store.md')
    with open(test_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    stale = re.sub(r'^verified: .*$', 'verified: 2020-01-01', content, flags=re.M)
    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(stale)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/lint_docs.py" --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    # Restore
    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    if code == 0 and 'WARN' in out and 'stale' in out.lower():
        print('  PASS: staleness warned without blocking')
        return True
    else:
        print(f'  FAIL: expected exit 0 with WARN, got {code}')
        print(f'  stdout: {out}')
        return False


def test_lint_stale_strict():
    """Test strict mode fails on a stale doc."""
    print('\nTEST: lint_docs --strict (stale doc - ERROR expected)')

    test_md_path = os.path.join(TEST_DIR, 'docs', 'components', 'store.md')
    with open(test_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    stale = re.sub(r'^verified: .*$', 'verified: 2020-01-01', content, flags=re.M)
    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(stale)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/lint_docs.py" --strict --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    # Restore
    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    if code != 0 and 'stale' in out.lower():
        print('  PASS: stale doc rejected in strict mode')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def test_lint_missing_provenance_strict():
    """Test strict mode requires provenance fields."""
    print('\nTEST: lint_docs --strict (missing sources - ERROR expected)')

    test_md_path = os.path.join(TEST_DIR, 'docs', 'components', 'store.md')
    with open(test_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    stripped = re.sub(r'^sources: .*\n', '', content, flags=re.M)
    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(stripped)

    code, out, err = run_cmd(
        f'{PY} "{SCRIPT_DIR}/lint_docs.py" --strict --root "{TEST_DIR}"',
        cwd=TEST_DIR
    )

    # Restore
    with open(test_md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    if code != 0 and "missing 'sources'" in out:
        print('  PASS: missing provenance detected')
        return True
    else:
        print(f'  FAIL: expected error, got exit {code}')
        return False


def main():
    """Run all tests."""
    print('='*60)
    print('DOCUMENTATION FACTORY SELF-TEST')
    print('='*60)

    try:
        setup_fixture()

        tests = [
            test_init_workspace,
            test_chunk_transcript,
            test_validate_ledger,
            test_validate_registry,
            test_check_citations,
            test_lint_docs,
            test_coverage_report,
            test_blast_radius,
            test_validate_inventory,
            test_inventory_order,
            test_inventory_next,
            test_dead_without_reason,
            test_dangling_superseded_by,
            test_duplicate_registry_name,
            test_component_kind_off_enum,
            test_component_missing_layer,
            test_registry_no_false_warn,
            test_upward_dependency_edge,
            test_design_source_without_chunks,
            test_lint_missing_required_doc_strict,
            test_lint_overview_missing_diagram,
            test_doc_citing_missing_dec,
            test_lint_antipattern,
            test_lint_provisional_strict,
            test_lint_stale_doc,
            test_lint_stale_strict,
            test_lint_missing_provenance_strict,
            test_inventory_duplicate_id,
            test_inventory_untraced_feature,
            test_inventory_dangling_decision,
            test_inventory_dead_decision,
            test_inventory_cycle,
            test_inventory_dangling_blocker,
            test_inventory_contract_order,
            test_inventory_waves,
            test_inventory_handoff,
            test_inventory_coverage_strict,
        ]

        results = []
        for test_func in tests:
            try:
                result = test_func()
                results.append(result)
            except Exception as e:
                print(f'  EXCEPTION: {e}')
                results.append(False)

        print('\n' + '='*60)
        passed = sum(results)
        total = len(results)
        print(f'RESULTS: {passed}/{total} tests passed')
        print('='*60)

        if passed == total:
            print('ALL TESTS PASSED')
            return 0
        else:
            print('SOME TESTS FAILED')
            return 1

    finally:
        if os.path.exists(TEST_DIR):
            shutil.rmtree(TEST_DIR)


if __name__ == '__main__':
    sys.exit(main())
