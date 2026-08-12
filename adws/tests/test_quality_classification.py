"""The quality-block classification logic: pass / fail / incomplete.

`_classify_exit_code` is the default for test/lint/typecheck: those tools are
always installed by the time they run (`uv sync --group dev` succeeds on every
platform this factory targets), so a non-zero exit is always a real failure.

`_classify_ai_defects` is the fail-closed classifier for skylos, which does
NOT always install (no MSVC on Windows — see pyproject.toml's `scan` group).
It has to tell apart two things that both exit non-zero: uv failing to
PROVISION the tool at all (the tool never ran — "incomplete"), and skylos
running fine and reporting real defects ("fail"). Getting this wrong in either
direction is dangerous:
  - a false NEGATIVE (a provisioning failure read as "fail") hands the builder
    an unfixable toolchain error as its repair spec and burns a turn on an
    unwinnable round;
  - a false POSITIVE (a real finding read as "incomplete") hides an actual
    defect from the builder, which is the silently-green failure this
    classifier exists to prevent.

The exact provisioning-failure text below is not invented: it is what
`uv run --group scan skylos --version` printed on this Windows laptop,
verbatim, when this test file was written.
"""

from adw_modules.quality import (
    TOOL_UNAVAILABLE_SIGNATURES,
    _classify_ai_defects,
    _classify_exit_code,
)

REAL_MSVC_FAILURE = (
    "   Building tree-sitter-dart-orchard==0.5.0\n"
    "  × Failed to build `tree-sitter-dart-orchard==0.5.0`\n"
    "  ├─▶ The build backend returned an error\n"
    "  ╰─▶ Call to `setuptools.build_meta.build_wheel` failed (exit code: 1)\n"
    "      ...\n"
    "      error: Microsoft Visual C++ 14.0 or greater is\n"
    "      required. Get it with \"Microsoft C++ Build Tools\":\n"
    "      https://visualstudio.microsoft.com/visual-cpp-build-tools/\n"
    "\n"
    "hint: `tree-sitter-dart-orchard` (v0.5.0) was included because "
    "`sdl-factory:scan` (v0.1.0) depends on `skylos` (v4.33.2) which depends "
    "on `tree-sitter-dart-orchard`\n"
)


# ── the default classifier (test / lint / typecheck) ────────────────────────

def test_default_classifier_exit_zero_is_pass():
    assert _classify_exit_code(0, "all good", "") == "pass"


def test_default_classifier_any_nonzero_is_fail():
    assert _classify_exit_code(1, "", "2 errors") == "fail"
    assert _classify_exit_code(5, "", "no tests collected") == "fail"


def test_default_classifier_never_returns_incomplete():
    # lint/typecheck/test have no "tool unavailable" concept: they are always
    # installed by the time they run, so nothing here should ever read
    # incomplete even on a wall of unrelated-looking output.
    assert _classify_exit_code(1, "", REAL_MSVC_FAILURE) == "fail"


# ── skylos: the fail-closed classifier ───────────────────────────────────────

def test_a_clean_scan_is_pass():
    assert _classify_ai_defects(0, "0 findings", "") == "pass"


def test_missing_binary_is_incomplete():
    # _run's OSError branch always reports this as returncode 127.
    assert _classify_ai_defects(127, "", "No such file or directory: 'uv'") == "incomplete"


def test_timeout_is_incomplete():
    # _run's TimeoutExpired branch always reports this as returncode 124.
    assert _classify_ai_defects(124, "", "Timed out after 300s.") == "incomplete"


def test_real_uv_provisioning_failure_is_incomplete_despite_exiting_1():
    # The exact case this classifier exists for: uv's build failure and
    # skylos's own "I found violations" both exit 1.
    assert _classify_ai_defects(1, REAL_MSVC_FAILURE, "") == "incomplete"
    # The signature can land in stderr instead of stdout too.
    assert _classify_ai_defects(1, "", REAL_MSVC_FAILURE) == "incomplete"


def test_unresolvable_dependency_is_incomplete():
    assert _classify_ai_defects(1, "No solution found when resolving dependencies", "") \
        == "incomplete"


def test_no_virtual_environment_is_incomplete():
    assert _classify_ai_defects(1, "error: No virtual environment found", "") == "incomplete"


def test_classification_is_case_insensitive():
    assert _classify_ai_defects(1, "FAILED TO BUILD `thing`", "") == "incomplete"
    assert _classify_ai_defects(1, "", "ERROR: MICROSOFT VISUAL C++ 14.0 REQUIRED") == "incomplete"


def test_real_findings_are_fail_and_must_reach_the_builder():
    tail = ("adws/thing.py:12 missing guard before dereference\n"
            "adws/thing.py:40 invented package API: requests.get_json\n"
            "2 issues found")
    assert _classify_ai_defects(1, tail, "") == "fail"


def test_a_finding_that_merely_mentions_build_does_not_trip_the_signature():
    # "build" alone must not match — only uv's exact provisioning vocabulary
    # ("failed to build ..."). A defect report that happens to name a function
    # called build_release() must still reach the builder as a real failure.
    tail = "adws/ci.py:3 unfinished stub in build_release()\n1 issue found"
    assert _classify_ai_defects(1, tail, "") == "fail"


def test_signature_list_is_the_single_source_of_truth():
    # Every documented signature actually trips the classifier — catches the
    # list and the function silently drifting apart.
    for signature in TOOL_UNAVAILABLE_SIGNATURES:
        assert _classify_ai_defects(1, signature, "") == "incomplete", signature
