"""How individual pass/fail/incomplete checks combine into a QualityResult, and
how that result is handed to the builder.

Two properties are pinned here, both load-bearing for the "Skylos is
fail-closed" rule:

  1. `QualityResult.passed` is strict — True only when every check passed.
     An incomplete-only result (skylos could not run, everything else did)
     must still read `passed=False`, never a silent green.
  2. `QualityResult.failures` (what `as_envelope` turns into the builder's
     repair spec) excludes incomplete checks. A tool that never ran is not a
     code defect, and routing it to the builder anyway burns a real repair
     turn on something no amount of code changes can fix.

These are tested against `run_quality()` itself (with the four blocks
monkeypatched to canned results, so no subprocess or real Run object is
needed) rather than only against the classifier, because the split between
`failures` and `incomplete` — and the strictness of `passed` — lives in the
aggregation, not in any single check.
"""

from types import SimpleNamespace

from adw_modules import quality
from adw_modules.data_types import QualityCheckResult, QualityResult, QualityStatus


def _check(name: str, status: QualityStatus, returncode: int = 0,
          tail: str = "") -> QualityCheckResult:
    return QualityCheckResult(
        name=name, area="repo", operation="scan" if name == "ai_defects" else "lint",
        command=f"uv run --group dev {name}", returncode=returncode, status=status,
        passed=(status == "pass"), duration_seconds=0.1,
        output_artifact=f"/tmp/{name}.log", output_tail=tail)


def _fake_run():
    """The pieces run_quality/_run's callers touch: nothing more."""
    return SimpleNamespace(console=SimpleNamespace(note=lambda *a, **k: None))


def _patch_blocks(monkeypatch, *, lint="pass", typecheck="pass", ai_defects="pass", test="pass",
                  ai_defects_tail=""):
    monkeypatch.setattr(quality, "lint", lambda run: _check("lint", lint))
    monkeypatch.setattr(quality, "typecheck", lambda run: _check("typecheck", typecheck))
    monkeypatch.setattr(quality, "ai_defects",
                        lambda run: _check("ai_defects", ai_defects, returncode=1,
                                           tail=ai_defects_tail))
    monkeypatch.setattr(quality, "test", lambda run: _check("test", test))


# ── run_quality: the three-way split ─────────────────────────────────────────

def test_all_checks_passing_is_a_clean_green(monkeypatch):
    _patch_blocks(monkeypatch)
    result = quality.run_quality(_fake_run())
    assert result.passed is True
    assert result.failures == []
    assert result.incomplete == []
    assert len(result.checks) == 4


def test_a_real_failure_is_not_passed_and_lands_in_failures(monkeypatch):
    _patch_blocks(monkeypatch, lint="fail")
    result = quality.run_quality(_fake_run())
    assert result.passed is False
    assert len(result.failures) == 1
    assert "lint" in result.failures[0]
    assert result.incomplete == []


def test_skylos_incomplete_alone_never_reads_green(monkeypatch):
    # The exact scenario this whole slice exists for: everything else is
    # clean, skylos could not be provisioned. The run must not read green.
    _patch_blocks(monkeypatch, ai_defects="incomplete",
                  ai_defects_tail="error: Microsoft Visual C++ 14.0 or greater is required.")
    result = quality.run_quality(_fake_run())
    assert result.passed is False           # never pass
    assert result.failures == []            # but never blamed on the code either
    assert len(result.incomplete) == 1
    assert "ai_defects" in result.incomplete[0]


def test_incomplete_and_a_real_failure_both_surface_in_their_own_lane(monkeypatch):
    _patch_blocks(monkeypatch, typecheck="fail", ai_defects="incomplete")
    result = quality.run_quality(_fake_run())
    assert result.passed is False
    assert len(result.failures) == 1 and "typecheck" in result.failures[0]
    assert len(result.incomplete) == 1 and "ai_defects" in result.incomplete[0]


# ── as_envelope: what the builder is actually told ──────────────────────────

def test_envelope_for_a_real_failure_asks_the_builder_to_fix_it():
    result = QualityResult(passed=False, checks=[_check("lint", "fail")],
                           failures=["lint: exited 1\nboom"], incomplete=[])
    envelope = quality.as_envelope(result, "verification")
    assert envelope.status == "fail"
    assert envelope.passed is False
    assert envelope.failures == ["lint: exited 1\nboom"]
    assert "fix" in envelope.notes_for_next_agent.lower()


def test_envelope_for_incomplete_only_does_not_blame_the_builder():
    result = QualityResult(passed=False,   # strict aggregate: still not "passed"
                           checks=[_check("lint", "pass"),
                                   _check("ai_defects", "incomplete", returncode=1)],
                           failures=[], incomplete=["ai_defects: tool unavailable"])
    envelope = quality.as_envelope(result, "verification")
    # Nothing for the builder to act on: no failures, no "go fix this" note.
    assert envelope.failures == []
    assert envelope.notes_for_next_agent == ""
    assert envelope.passed is True
    # But the handoff still says something was not verified, honestly.
    assert "unavailable" in envelope.summary


def test_envelope_for_a_full_pass_says_so_plainly():
    result = QualityResult(passed=True, checks=[_check("lint", "pass"), _check("test", "pass")],
                           failures=[], incomplete=[])
    envelope = quality.as_envelope(result, "verification")
    assert envelope.status == "success"
    assert envelope.passed is True
    assert envelope.notes_for_next_agent == ""


# ── run_tests: the single-block wrapper used outside run_quality ────────────

def test_run_tests_wraps_a_passing_check(monkeypatch):
    monkeypatch.setattr(quality, "test", lambda run: _check("test", "pass"))
    result = quality.run_tests(_fake_run())
    assert result.passed is True
    assert result.failures == []


def test_run_tests_wraps_a_failing_check(monkeypatch):
    monkeypatch.setattr(quality, "test", lambda run: _check("test", "fail", returncode=1,
                                                             tail="1 failed"))
    result = quality.run_tests(_fake_run())
    assert result.passed is False
    assert len(result.failures) == 1
    assert "test" in result.failures[0]
