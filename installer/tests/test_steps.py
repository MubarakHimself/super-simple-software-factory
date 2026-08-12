"""Hermetic unit tests for installer/steps.py.

`tmp_path` only - no network, no subprocess against a real tool, no model
call. Covers exactly what the spec calls out (installer-wizard.md section 1):
park/snapshot naming, JSON merge, .env merge, the forbidden-path guard, and
outcome classification. Also covers compute_exit_code and redact_text, since
both are small pure functions the rest of the wizard leans on for its exit
code and its secret-safety guarantee (acceptance A7/A9/A12).
"""

import json
import re

import pytest
import steps

TIMESTAMP_RE = re.compile(r"\.parked-\d{8}-\d{6}(-\d+)?$")


def _make_ctx(tmp_path, target="laptop"):
    """A minimal, fully-hermetic Ctx - no real ~/.pi or ~/.sdl-factory touched."""
    repo_root = tmp_path / "repo"
    (repo_root / "adws").mkdir(parents=True)
    (repo_root / "MAP.md").write_text("# MAP\n", encoding="utf-8")
    install_dir = tmp_path / "sdl-factory-home" / ".sdl-factory" / "install"
    install_dir.mkdir(parents=True)
    return steps.Ctx(
        repo_root=repo_root, target=target, home=tmp_path / "sdl-factory-home",
        yes=False, dry_run=False, verify_only=False, json_mode=False,
        run_id="testrun01", started_at="2026-08-12T00:00:00.000Z",
        install_dir=install_dir, log_path=install_dir / "test.log",
        secrets_env_path=tmp_path / "sdl-factory-home" / ".sdl-factory" / "secrets.env",
        env_path=repo_root / ".env",
    )


# ── park primitives ───────────────────────────────────────────────────────

def test_park_replace_moves_file_and_names_it_with_a_timestamp_suffix(tmp_path):
    original = tmp_path / "settings.json"
    original.write_text('{"a": 1}', encoding="utf-8")

    dest = steps.park_replace(original)

    assert dest is not None
    assert not original.exists()          # moved, not copied
    assert dest.exists()
    assert dest.read_text(encoding="utf-8") == '{"a": 1}'
    assert TIMESTAMP_RE.search(dest.name), dest.name
    assert dest.name.startswith("settings.json.parked-")


def test_park_replace_returns_none_when_path_does_not_exist(tmp_path):
    assert steps.park_replace(tmp_path / "nope.json") is None


def test_park_replace_never_deletes_content(tmp_path):
    """The whole point of park-never-delete (MAP rule 5): the bytes survive
    somewhere findable, always."""
    original = tmp_path / "auth.json"
    original.write_bytes(b"secret-shaped-but-not-a-secret-in-this-test")

    dest = steps.park_replace(original)

    assert dest.read_bytes() == b"secret-shaped-but-not-a-secret-in-this-test"
    # nothing else in the directory was removed
    assert {p.name for p in tmp_path.iterdir()} == {dest.name}


def test_snapshot_copies_and_leaves_the_original_in_place(tmp_path):
    """Merge path: snapshot is a COPY so no window exists where the config is
    missing (spec 5.1)."""
    original = tmp_path / "models.json"
    original.write_text('{"providers": {}}', encoding="utf-8")

    dest = steps.snapshot(original)

    assert dest is not None
    assert original.exists()               # still there - copy, not move
    assert original.read_text(encoding="utf-8") == '{"providers": {}}'
    assert dest.read_text(encoding="utf-8") == '{"providers": {}}'
    assert TIMESTAMP_RE.search(dest.name), dest.name


def test_snapshot_returns_none_when_path_does_not_exist(tmp_path):
    assert steps.snapshot(tmp_path / "nope.json") is None


def test_snapshot_of_a_directory_copies_the_whole_tree(tmp_path):
    original = tmp_path / "scripts"
    original.mkdir()
    (original / "a.py").write_text("print(1)\n", encoding="utf-8")

    dest = steps.snapshot(original)

    assert dest is not None and dest.is_dir()
    assert (dest / "a.py").read_text(encoding="utf-8") == "print(1)\n"
    assert original.exists()


def test_park_and_snapshot_never_collide_on_the_same_second(tmp_path):
    """Two parks of files with the SAME name in the same second must not
    silently overwrite one another - the second gets a numeric suffix."""
    first = tmp_path / "a" / "x.json"
    second = tmp_path / "b" / "x.json"
    first.parent.mkdir()
    second.parent.mkdir()
    first.write_text("first", encoding="utf-8")
    second.write_text("second", encoding="utf-8")

    dest1 = steps.park_replace(first)
    # Force a same-second collision the way a fast test run can hit it:
    # fabricate a destination in `second`'s own directory occupying the exact
    # name `park_replace` would otherwise choose.
    collide = steps._unique_park_path(second)
    collide.write_text("occupied", encoding="utf-8")
    dest2 = steps.park_replace(second)

    assert dest1 != dest2
    assert dest2.read_text(encoding="utf-8") == "second"
    assert collide.read_text(encoding="utf-8") == "occupied"   # untouched


def test_park_ledger_records_one_line_with_the_documented_fields(tmp_path):
    original = tmp_path / "settings.json"
    original.write_text('{"packages": []}', encoding="utf-8")
    ledger_path = tmp_path / "park-ledger.jsonl"

    dest = steps.park_replace(original, ledger_path=ledger_path, run_id="run123",
                              step="pi-packages")

    lines = ledger_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert set(entry) == {"ts", "run_id", "step", "kind", "from", "to", "sha256"}
    assert entry["run_id"] == "run123"
    assert entry["step"] == "pi-packages"
    assert entry["kind"] == "replace"
    assert entry["from"] == str(original)
    assert entry["to"] == str(dest)
    assert entry["sha256"] == steps.sha256_file(dest)


def test_park_without_a_ledger_path_writes_no_ledger(tmp_path):
    original = tmp_path / "x.json"
    original.write_text("{}", encoding="utf-8")
    steps.park_replace(original)
    assert list(tmp_path.glob("*.jsonl")) == []


def test_identical_content_is_not_a_reason_to_park(tmp_path):
    """Idempotency (spec 7 item 2): the step layer is expected to compare
    sha256 BEFORE calling park - this test documents that the primitive
    itself has no opinion, callers own the compare-first contract."""
    src = tmp_path / "src.py"
    dst = tmp_path / "dst.py"
    src.write_text("same", encoding="utf-8")
    dst.write_text("same", encoding="utf-8")
    assert steps.sha256_file(src) == steps.sha256_file(dst)


# ── JSON / .env merge ────────────────────────────────────────────────────

def test_merge_list_union_is_order_stable_and_deduplicates():
    existing = ["npm:pi-claude-bridge"]
    additions = ["npm:pi-claude-bridge", "npm:@tintinweb/pi-subagents"]
    merged = steps.merge_list_union(existing, additions)
    assert merged == ["npm:pi-claude-bridge", "npm:@tintinweb/pi-subagents"]


def test_merge_list_union_on_empty_existing():
    assert steps.merge_list_union([], ["a", "b", "a"]) == ["a", "b"]


def test_merge_env_text_preserves_comments_blanks_and_unrelated_keys():
    text = (
        "# a comment\n"
        "\n"
        "ENGINEER_NAME=Mubarak\n"
        "OPENROUTER_API_KEY=\n"
    )
    merged = steps.merge_env_text(text, {"PI_PATH": "node C:/x/cli.js"})
    lines = merged.splitlines()
    assert "# a comment" in lines
    assert "" in lines
    assert "ENGINEER_NAME=Mubarak" in lines
    assert "OPENROUTER_API_KEY=" in lines
    assert "PI_PATH=node C:/x/cli.js" in lines   # appended, since it was missing


def test_merge_env_text_replaces_an_existing_key_in_place_not_at_the_end():
    text = "A=1\nPI_PATH=old\nB=2\n"
    merged = steps.merge_env_text(text, {"PI_PATH": "new"})
    lines = merged.splitlines()
    assert lines == ["A=1", "PI_PATH=new", "B=2"]


def test_merge_env_text_on_empty_existing_file():
    merged = steps.merge_env_text("", {"PI_PATH": "node cli.js"})
    assert merged == "PI_PATH=node cli.js\n"


def test_merge_env_text_is_idempotent():
    text = "PI_PATH=node cli.js\n"
    once = steps.merge_env_text(text, {"PI_PATH": "node cli.js"})
    twice = steps.merge_env_text(once, {"PI_PATH": "node cli.js"})
    assert once == twice == "PI_PATH=node cli.js\n"


def test_merge_pi_settings_packages_is_a_union_and_preserves_other_keys():
    existing = {"packages": ["npm:pi-claude-bridge"], "defaultProvider": "ollama-cloud"}
    merged = steps.merge_pi_settings(existing, ["npm:pi-claude-bridge",
                                                "npm:@tintinweb/pi-subagents"])
    assert merged["packages"] == ["npm:pi-claude-bridge", "npm:@tintinweb/pi-subagents"]
    assert merged["defaultProvider"] == "ollama-cloud"   # untouched sibling key


def test_merge_pi_settings_strips_an_unknown_theme():
    existing = {"packages": [], "theme": "solarized-nonexistent"}
    merged = steps.merge_pi_settings(existing, [])
    assert "theme" not in merged


def test_merge_pi_settings_keeps_a_known_theme():
    existing = {"packages": [], "theme": "default"}
    merged = steps.merge_pi_settings(existing, [], known_themes=frozenset({"default"}))
    assert merged["theme"] == "default"


def test_merge_ollama_provider_preserves_sibling_providers():
    existing = {"providers": {"other-provider": {"baseUrl": "https://example.com"}}}
    seed = {"baseUrl": "https://ollama.com/v1", "models": []}
    merged = steps.merge_ollama_provider(existing, seed)
    assert merged["providers"]["other-provider"] == {"baseUrl": "https://example.com"}
    assert merged["providers"]["ollama-cloud"]["baseUrl"] == "https://ollama.com/v1"


def test_merge_ollama_provider_keeps_hand_added_model_overrides():
    existing = {"providers": {"ollama-cloud": {"modelOverrides": {"x": 1}}}}
    seed = {"baseUrl": "https://ollama.com/v1", "models": []}
    merged = steps.merge_ollama_provider(existing, seed)
    assert merged["providers"]["ollama-cloud"]["modelOverrides"] == {"x": 1}
    assert merged["providers"]["ollama-cloud"]["baseUrl"] == "https://ollama.com/v1"


def test_merge_ollama_provider_on_empty_existing_document():
    merged = steps.merge_ollama_provider({}, {"baseUrl": "https://ollama.com/v1", "models": []})
    assert merged["providers"]["ollama-cloud"]["baseUrl"] == "https://ollama.com/v1"


# ── forbidden-path guard (spec 8.1, acceptance A7) ──────────────────────────

def test_guard_repo_write_raises_under_templates(tmp_path):
    ctx = _make_ctx(tmp_path)
    target = ctx.repo_root / ".claude" / "skills" / "sssf" / "templates" / "adws" / "x.py"
    with pytest.raises(steps.ForbiddenWriteError):
        steps.guard_repo_write(target, ctx)


def test_guard_repo_write_raises_under_adw_modules(tmp_path):
    ctx = _make_ctx(tmp_path)
    target = ctx.repo_root / "adws" / "adw_modules" / "tracer.py"
    with pytest.raises(steps.ForbiddenWriteError):
        steps.guard_repo_write(target, ctx)


def test_guard_repo_write_allows_the_repo_env_file(tmp_path):
    ctx = _make_ctx(tmp_path)
    steps.guard_repo_write(ctx.repo_root / ".env", ctx)   # must not raise


def test_guard_repo_write_allows_paths_entirely_outside_the_repo(tmp_path):
    ctx = _make_ctx(tmp_path)
    outside = ctx.home / ".pi" / "agent" / "settings.json"
    steps.guard_repo_write(outside, ctx)   # must not raise - not under repo_root at all


def test_write_text_raises_and_does_not_create_the_file(tmp_path):
    ctx = _make_ctx(tmp_path)
    target = ctx.repo_root / "adws" / "adw_modules" / "new_file.py"
    with pytest.raises(steps.ForbiddenWriteError):
        steps.write_text(target, "content", ctx)
    assert not target.exists()


def test_write_text_writes_utf8_for_an_allowed_path(tmp_path):
    ctx = _make_ctx(tmp_path)
    target = ctx.repo_root / ".env"
    steps.write_text(target, "PI_PATH=node cli.js\n", ctx)
    assert target.read_text(encoding="utf-8") == "PI_PATH=node cli.js\n"


# ── outcome classification (spec 6.9, fail-closed) ─────────────────────────

MSVC_FAILURE_TEXT = (
    "  x Failed to build `tree-sitter-dart-orchard==0.5.0`\n"
    "  error: Microsoft Visual C++ 14.0 or greater is required.\n"
)


def test_classify_skylos_exit_zero_is_ok():
    assert steps.classify_skylos("laptop", True, 0, "", "") == "ok"


def test_classify_skylos_windows_laptop_msvc_signature_is_expected_unavailable():
    outcome = steps.classify_skylos("laptop", True, 1, "", MSVC_FAILURE_TEXT)
    assert outcome == "expected-unavailable"


def test_classify_skylos_windows_laptop_unrecognized_failure_is_failed():
    """Fail-closed: unknown is never expected (spec 6.9)."""
    outcome = steps.classify_skylos("laptop", True, 1, "", "some other traceback entirely")
    assert outcome == "failed"


def test_classify_skylos_server_never_reads_expected_unavailable():
    """The same MSVC-shaped text on a server target is a real failure -
    expected-unavailable is a Windows-laptop-only declared rule."""
    outcome = steps.classify_skylos("server", False, 1, "", MSVC_FAILURE_TEXT)
    assert outcome == "failed"


def test_classify_skylos_container_never_reads_expected_unavailable():
    outcome = steps.classify_skylos("container", False, 1, "", MSVC_FAILURE_TEXT)
    assert outcome == "failed"


# ── exit code (spec 2.2) ─────────────────────────────────────────────────

def _step(step_id="x", required=True):
    return steps.Step(step_id, step_id, steps.ALL, required,
                      lambda ctx: steps.Detected(True), lambda ctx: steps.Result("ok", ""),
                      lambda ctx: steps.Result("ok", ""))


def test_compute_exit_code_zero_when_everything_ok():
    step_results = [(_step("a"), steps.Result("ok", "")),
                    (_step("b"), steps.Result("installed", ""))]
    verify_results = [("V1", steps.Result("ok", ""))]
    assert steps.compute_exit_code(step_results, verify_results) == 0


def test_compute_exit_code_one_when_a_required_step_failed():
    step_results = [(_step("a", required=True), steps.Result("failed", "boom"))]
    assert steps.compute_exit_code(step_results, []) == 1


def test_compute_exit_code_one_when_a_verify_check_failed():
    verify_results = [("V2", steps.Result("failed", "no tokens"))]
    assert steps.compute_exit_code([], verify_results) == 1


def test_compute_exit_code_two_when_needs_operator_and_nothing_failed():
    step_results = [(_step("a"), steps.Result("needs-operator", "auth me"))]
    assert steps.compute_exit_code(step_results, []) == 2


def test_compute_exit_code_non_required_failure_does_not_force_exit_one():
    """required=False => a failure downgrades to a warning (spec 3.1's Step
    contract) - it must not gate the run's exit code the way a required
    failure does."""
    step_results = [(_step("optional", required=False), steps.Result("failed", "meh"))]
    assert steps.compute_exit_code(step_results, []) == 0


def test_compute_exit_code_failed_wins_over_needs_operator():
    step_results = [(_step("a", required=True), steps.Result("failed", "boom")),
                    (_step("b", required=False), steps.Result("needs-operator", "auth me"))]
    assert steps.compute_exit_code(step_results, []) == 1


# ── secret redaction (acceptance A12) ───────────────────────────────────

def test_redact_text_replaces_every_occurrence():
    text = "token=abc123 seen twice: abc123"
    redacted = steps.redact_text(text, {"abc123"})
    assert redacted == "token=[redacted] seen twice: [redacted]"
    assert "abc123" not in redacted


def test_redact_text_with_no_secrets_is_a_no_op():
    assert steps.redact_text("hello world", set()) == "hello world"


def test_secret_values_picks_up_token_key_secret_named_env_vars():
    env = {"CLAUDE_CODE_OAUTH_TOKEN": "s3cr3t", "OPENAI_API_KEY": "k3y",
           "MY_SECRET_THING": "hush", "PATH": "/usr/bin", "HOME": "/home/x"}
    found = steps._secret_values(env, set())
    assert found == {"s3cr3t", "k3y", "hush"}


# ── repo root resolution ────────────────────────────────────────────────

def test_find_repo_root_succeeds_for_a_real_looking_repo(tmp_path):
    (tmp_path / "MAP.md").write_text("# MAP\n", encoding="utf-8")
    (tmp_path / "adws").mkdir()
    script_path = tmp_path / "installer" / "install.py"
    script_path.parent.mkdir()
    assert steps.find_repo_root(script_path) == tmp_path


def test_find_repo_root_raises_when_map_and_adws_are_missing(tmp_path):
    script_path = tmp_path / "installer" / "install.py"
    script_path.parent.mkdir()
    with pytest.raises(steps.RepoNotFoundError):
        steps.find_repo_root(script_path)


# ── quoted .env values (BLOCKER 1) ──────────────────────────────────────
# just 1.58.0's `set dotenv-load` cannot parse an unquoted value with a
# space (verified against the real binary: `just --evaluate` failed with
# "Error parsing line" on an unquoted `PI_PATH=node <path>`, and succeeded
# once the value was wrapped in quotes - see steps.py:quote_env_value).

def test_quote_env_value_wraps_in_double_quotes():
    assert steps.quote_env_value("node C:/x/cli.js") == '"node C:/x/cli.js"'


def test_quote_env_value_escapes_an_embedded_backslash_and_quote():
    assert steps.quote_env_value('a"b\\c') == '"a\\"b\\\\c"'


def test_unquote_env_value_strips_a_matching_outer_pair():
    assert steps.unquote_env_value('"node C:/x/cli.js"') == "node C:/x/cli.js"


def test_unquote_env_value_leaves_already_unquoted_text_alone():
    assert steps.unquote_env_value("node C:/x/cli.js") == "node C:/x/cli.js"


def test_unquote_env_value_leaves_mismatched_quotes_alone():
    assert steps.unquote_env_value("'unterminated") == "'unterminated"


def test_merge_env_text_is_idempotent_with_a_quoted_value_containing_a_space():
    """The exact shape apply_pi writes: PI_PATH="node <path with a space>"."""
    value = steps.quote_env_value("node C:/Users/x y/cli.js")
    once = steps.merge_env_text("", {"PI_PATH": value})
    twice = steps.merge_env_text(once, {"PI_PATH": value})
    assert once == twice == f"PI_PATH={value}\n"


def test_pi_path_line_round_trips_true_for_a_quoted_value_pointing_at_a_real_file(tmp_path):
    """Spec 6.6 item 5's landmine assertion, now through the quoting fix:
    dotenv-style unquote, then shlex.split(posix=True), still yields
    ['node', '<path>'] once quotes are stripped."""
    cli_js = tmp_path / "cli.js"
    cli_js.write_text("// cli\n", encoding="utf-8")
    value = steps.quote_env_value(f"node {cli_js.as_posix()}")
    found, ok = steps.pi_path_line_round_trips(f"PI_PATH={value}\n")
    assert found and ok


def test_pi_path_line_round_trips_false_when_the_file_does_not_exist():
    found, ok = steps.pi_path_line_round_trips('PI_PATH="node C:/nope/cli.js"\n')
    assert found and not ok


def test_pi_path_line_round_trips_reports_not_found_when_no_pi_path_line_exists():
    found, ok = steps.pi_path_line_round_trips("OTHER=1\n")
    assert not found and not ok


# ── idempotency: compare-before-write at the pure merge layer (BLOCKER 2) ──

def test_merge_pi_settings_is_unchanged_when_packages_already_present():
    existing = {"packages": list(steps.PI_PACKAGES), "defaultProvider": "ollama-cloud"}
    merged = steps.merge_pi_settings(existing, list(steps.PI_PACKAGES))
    assert merged == existing


def test_merge_ollama_provider_is_unchanged_when_seed_already_matches():
    seed = {"baseUrl": "https://ollama.com/v1", "models": ["kimi-k2.7-code"]}
    existing = {"providers": {"ollama-cloud": seed}}
    merged = steps.merge_ollama_provider(existing, seed)
    assert merged == existing


# ── idempotency: the apply_* orchestrators themselves (BLOCKER 2) ─────────
# Each test monkeypatches `steps.run` to blow up on any call it does not
# expect, so a regression back to "snapshot+rewrite unconditionally" is
# caught two ways at once: an unexpected subprocess call, or a park file
# appearing where zero were expected.

def test_apply_pi_is_a_full_no_op_when_env_already_has_the_quoted_values(tmp_path, monkeypatch):
    ctx = _make_ctx(tmp_path)
    npm_root = tmp_path / "npmroot"
    cli_js = npm_root / "@earendil-works" / "pi-coding-agent" / "dist" / "cli.js"
    cli_js.parent.mkdir(parents=True)
    cli_js.write_text("// pi cli\n", encoding="utf-8")

    def fake_run(argv, **kwargs):
        if argv[:3] == ["npm", "root", "-g"]:
            return steps.RunResult(argv, 0, str(npm_root), "", 0.01)
        raise AssertionError(f"apply_pi must not shell out beyond `npm root -g` when the "
                              f".env is already correct - got {argv}")
    monkeypatch.setattr(steps, "run", fake_run)

    pi_path_value = f"node {cli_js.as_posix()}"
    models_path_value = (ctx.home / ".pi" / "agent" / "models.json").as_posix()
    seed_env = steps.merge_env_text("", {
        "PI_PATH": steps.quote_env_value(pi_path_value),
        "PI_MODELS_PATH": steps.quote_env_value(models_path_value),
    })
    ctx.env_path.write_text(seed_env, encoding="utf-8")

    result = steps.apply_pi(ctx)

    assert result.outcome == "ok"
    assert ctx.env_path.read_text(encoding="utf-8") == seed_env       # untouched
    assert list(ctx.repo_root.glob(".env.parked-*")) == []            # no park (spec 7.2)


def test_apply_pi_parks_and_rewrites_only_when_the_env_value_actually_changed(tmp_path, monkeypatch):
    ctx = _make_ctx(tmp_path)
    npm_root = tmp_path / "npmroot"
    cli_js = npm_root / "@earendil-works" / "pi-coding-agent" / "dist" / "cli.js"
    cli_js.parent.mkdir(parents=True)
    cli_js.write_text("// pi cli\n", encoding="utf-8")

    def fake_run(argv, **kwargs):
        if argv[:3] == ["npm", "root", "-g"]:
            return steps.RunResult(argv, 0, str(npm_root), "", 0.01)
        raise AssertionError(f"unexpected run() call: {argv}")
    monkeypatch.setattr(steps, "run", fake_run)

    ctx.env_path.write_text("PI_PATH=node C:/stale/cli.js\n", encoding="utf-8")

    result = steps.apply_pi(ctx)

    assert result.outcome == "installed"     # pi already present, but .env changed
    parked = list(ctx.repo_root.glob(".env.parked-*"))
    assert len(parked) == 1
    assert parked[0].read_text(encoding="utf-8") == "PI_PATH=node C:/stale/cli.js\n"
    new_text = ctx.env_path.read_text(encoding="utf-8")
    assert f'PI_PATH="node {cli_js.as_posix()}"' in new_text          # quoted (BLOCKER 1)
    found, ok = steps.pi_path_line_round_trips(new_text)
    assert found and ok


def test_apply_pi_packages_is_a_full_no_op_when_already_wired(tmp_path, monkeypatch):
    ctx = _make_ctx(tmp_path)
    settings_path = ctx.home / ".pi" / "agent" / "settings.json"
    settings_path.parent.mkdir(parents=True)
    settings_path.write_text(
        json.dumps({"packages": list(steps.PI_PACKAGES)}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8")
    npm_dir = ctx.home / ".pi" / "agent" / "npm" / "node_modules"
    for name in steps.PI_PACKAGE_DIRS:
        (npm_dir / name).mkdir(parents=True)

    def fake_run(argv, **kwargs):
        raise AssertionError(f"apply_pi_packages must not shell out (no `pi install`, no "
                              f"snapshot) when already fully wired - got {argv}")
    monkeypatch.setattr(steps, "run", fake_run)

    result = steps.apply_pi_packages(ctx)

    assert result.outcome == "ok"
    assert list(settings_path.parent.glob("settings.json.parked-*")) == []


def test_apply_ollama_provider_is_a_full_no_op_when_already_wired(tmp_path, monkeypatch):
    ctx = _make_ctx(tmp_path)
    models_path = ctx.home / ".pi" / "agent" / "models.json"
    models_path.parent.mkdir(parents=True)
    models_path.write_text(
        json.dumps({"providers": {"ollama-cloud": {"models": ["kimi-k2.7-code"]}}}),
        encoding="utf-8")

    def fake_run(argv, **kwargs):
        raise AssertionError(f"apply_ollama_provider must not shell out (key script or sync "
                              f"script) when the provider block already has models - got {argv}")
    monkeypatch.setattr(steps, "run", fake_run)

    result = steps.apply_ollama_provider(ctx)

    assert result.outcome == "ok"
    assert list(models_path.parent.glob("models.json.parked-*")) == []


def test_apply_ollama_provider_never_writes_models_json_when_the_key_script_is_unprovable(
        tmp_path, monkeypatch):
    """DIVERGENCE (a): the apiKey command must be proven BEFORE anything that
    references it is written - reordered so a truly-unprovable key script
    (neither interpreter gives a clean result) leaves models.json untouched,
    never partially written with a command the wizard never executed."""
    ctx = _make_ctx(tmp_path)
    monkeypatch.setattr(steps, "_try_key_script", lambda ctx: (False, "none"))

    def fake_run(argv, **kwargs):
        raise AssertionError(f"must not shell out once the key script is unprovable - "
                              f"got {argv}")
    monkeypatch.setattr(steps, "run", fake_run)

    result = steps.apply_ollama_provider(ctx)

    assert result.outcome == "failed"
    assert not (ctx.home / ".pi" / "agent" / "models.json").exists()


# ── BLOCKER 3: a fresh `just` install not yet on PATH in this process ─────

def test_verify_just_tolerates_a_fresh_install_not_yet_on_path(tmp_path, monkeypatch):
    ctx = _make_ctx(tmp_path)
    ctx.just_needs_new_terminal = True
    monkeypatch.setattr(steps, "which", lambda cmd: None)

    result = steps.verify_just(ctx)

    assert result.outcome == "ok"


def test_verify_just_still_fails_when_just_was_never_installed_at_all(tmp_path, monkeypatch):
    ctx = _make_ctx(tmp_path)   # just_needs_new_terminal defaults False
    monkeypatch.setattr(steps, "which", lambda cmd: None)

    result = steps.verify_just(ctx)

    assert result.outcome == "failed"


# ── finding 2: `just doctor` closes the "just --evaluate doesn't execute a
# recipe" probe gap - verify_just must actually run it, not just --list/--evaluate.

def _fake_just_run(list_rc=0, eval_rc=0, doctor_rc=0, doctor_stdout="doctor ok\n"):
    def fake_run(argv, **kwargs):
        if argv[1:] == ["--list"]:
            return steps.RunResult(argv, list_rc, "Available recipes:\n    demo\n", "", 0.01)
        if argv[1:] == ["--evaluate"]:
            return steps.RunResult(argv, eval_rc, "", "", 0.01)
        if argv[1:] == ["doctor"]:
            return steps.RunResult(argv, doctor_rc, doctor_stdout, "", 0.01)
        raise AssertionError(f"unexpected just invocation: {argv}")
    return fake_run


def test_verify_just_runs_doctor_for_real_and_passes_when_all_three_succeed(tmp_path, monkeypatch):
    ctx = _make_ctx(tmp_path)
    monkeypatch.setattr(steps, "which", lambda cmd: "C:/tools/just.exe")
    monkeypatch.setattr(steps, "run", _fake_just_run())

    result = steps.verify_just(ctx)

    assert result.outcome == "ok"
    assert "doctor" in result.message


def test_verify_just_fails_when_doctor_exits_nonzero_even_though_list_and_evaluate_pass(
        tmp_path, monkeypatch):
    """The exact gap finding 2 closes: a justfile that parses AND evaluates
    clean but cannot actually run a recipe (the "could not find the shell
    `sh`" shape) must fail here, not read `ok`."""
    ctx = _make_ctx(tmp_path)
    monkeypatch.setattr(steps, "which", lambda cmd: "C:/tools/just.exe")
    monkeypatch.setattr(steps, "run", _fake_just_run(doctor_rc=1, doctor_stdout=""))

    result = steps.verify_just(ctx)

    assert result.outcome == "failed"


def test_verify_just_fails_when_doctor_exits_zero_but_prints_no_proof(tmp_path, monkeypatch):
    """Exit 0 alone is not proof the recipe body actually ran - the stdout
    must carry the token-free marker `just doctor` itself prints."""
    ctx = _make_ctx(tmp_path)
    monkeypatch.setattr(steps, "which", lambda cmd: "C:/tools/just.exe")
    monkeypatch.setattr(steps, "run", _fake_just_run(doctor_rc=0, doctor_stdout="something else\n"))

    result = steps.verify_just(ctx)

    assert result.outcome == "failed"


# ── finding 1: winget's "already installed" exit code is not a failure ────
# Real value observed on this laptop: -1978335189 (unsigned 2316632107),
# winget's own "Found an existing package already installed... No available
# upgrade found." A REQUIRED step must never map this to `failed` on a host
# where just IS installed.

def _fake_which_only_winget(cmd):
    return "C:/Windows/System32/winget.exe" if cmd == "winget" else None


def test_apply_just_maps_winget_already_installed_to_installed_when_found_via_links_dir(
        tmp_path, monkeypatch):
    ctx = _make_ctx(tmp_path)
    monkeypatch.setattr(steps, "which", _fake_which_only_winget)

    local_appdata = tmp_path / "localappdata"
    links_dir = local_appdata / "Microsoft" / "WinGet" / "Links"
    links_dir.mkdir(parents=True)
    just_exe = links_dir / "just.exe"
    just_exe.write_bytes(b"stub")
    monkeypatch.setenv("LOCALAPPDATA", str(local_appdata))

    def fake_run(argv, **kwargs):
        assert argv[0] == "winget"
        return steps.RunResult(argv, -1978335189, "",
                                "Found an existing package already installed... "
                                "No available upgrade found.", 0.05)
    monkeypatch.setattr(steps, "run", fake_run)

    result = steps.apply_just(ctx)

    assert result.outcome == "installed"      # never "failed" - just IS on the host
    assert ctx.just_needs_new_terminal is True
    assert str(just_exe) in result.message


def test_apply_just_maps_winget_already_installed_unsigned_code_via_packages_dir(
        tmp_path, monkeypatch):
    """The unsigned 32-bit form (2316632107) resolves to the same bit pattern
    as -1978335189 and must be treated identically. Also exercises the
    Packages/<id>_<source>_<hash>/**/just.exe glob, not just the Links dir."""
    ctx = _make_ctx(tmp_path)
    monkeypatch.setattr(steps, "which", _fake_which_only_winget)

    local_appdata = tmp_path / "localappdata"
    pkg_dir = (local_appdata / "Microsoft" / "WinGet" / "Packages"
               / "Casey.Just_Microsoft.Winget.Source_8wekyb3d8bbwe")
    pkg_dir.mkdir(parents=True)
    just_exe = pkg_dir / "just.exe"
    just_exe.write_bytes(b"stub")
    monkeypatch.setenv("LOCALAPPDATA", str(local_appdata))

    def fake_run(argv, **kwargs):
        assert argv[0] == "winget"
        return steps.RunResult(argv, 2316632107, "", "already installed", 0.05)
    monkeypatch.setattr(steps, "run", fake_run)

    result = steps.apply_just(ctx)

    assert result.outcome == "installed"
    assert ctx.just_needs_new_terminal is True
    assert str(just_exe) in result.message


def test_apply_just_needs_operator_when_winget_claims_already_installed_but_nothing_is_findable(
        tmp_path, monkeypatch):
    """No PATH hit, no Links dir, no Packages dir - the contradiction between
    winget's claim and the wizard's own filesystem check goes to a human,
    never silently to `failed` (this is still a REQUIRED step) and never
    silently to `installed` on unproven evidence."""
    ctx = _make_ctx(tmp_path)
    monkeypatch.setattr(steps, "which", _fake_which_only_winget)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "empty-localappdata"))

    def fake_run(argv, **kwargs):
        assert argv[0] == "winget"
        return steps.RunResult(argv, -1978335189, "", "already installed", 0.05)
    monkeypatch.setattr(steps, "run", fake_run)

    result = steps.apply_just(ctx)

    assert result.outcome == "needs-operator"


# ── honesty residual 3(a): V6 surfaces needs-operator, never swallows it ──

def test_v6_toolchain_surfaces_a_needs_operator_subcheck_without_failing(tmp_path, monkeypatch):
    """The only sub-check allowed to legitimately read needs-operator here is
    no-mistakes (spec 6.10's declared Windows gap, required: False on its own
    Step) - V6 stays `ok` (spec 9: "all exit 0" reads as "no sub-check is
    `failed`"), but the needs-operator fact must be visible in the message,
    not silently dropped."""
    ctx = _make_ctx(tmp_path)
    ok = steps.Result("ok", "fine")
    monkeypatch.setattr(steps, "verify_uv", lambda ctx: ok)
    monkeypatch.setattr(steps, "verify_just", lambda ctx: ok)
    monkeypatch.setattr(steps, "verify_node", lambda ctx: ok)
    monkeypatch.setattr(steps, "verify_no_mistakes",
                         lambda ctx: steps.Result("needs-operator", "no confirmed Windows installer"))
    monkeypatch.setattr(steps, "verify_codegraph", lambda ctx: ok)
    monkeypatch.setattr(steps, "verify_sqlite", lambda ctx: ok)

    result = steps.verify_v6_toolchain(ctx)

    assert result.outcome == "ok"
    assert "[!] no-mistakes" in result.message
    assert "no confirmed Windows installer" in result.message


def test_v6_toolchain_still_fails_on_a_genuine_failure(tmp_path, monkeypatch):
    ctx = _make_ctx(tmp_path)
    ok = steps.Result("ok", "fine")
    monkeypatch.setattr(steps, "verify_uv", lambda ctx: ok)
    monkeypatch.setattr(steps, "verify_just", lambda ctx: steps.Result("failed", "just broke"))
    monkeypatch.setattr(steps, "verify_node", lambda ctx: ok)
    monkeypatch.setattr(steps, "verify_no_mistakes", lambda ctx: ok)
    monkeypatch.setattr(steps, "verify_codegraph", lambda ctx: ok)
    monkeypatch.setattr(steps, "verify_sqlite", lambda ctx: ok)

    result = steps.verify_v6_toolchain(ctx)

    assert result.outcome == "failed"


# ── DIVERGENCE (b): V7 checks only its own condition ───────────────────────

def test_v7_no_mistakes_not_wired_ignores_a_missing_optional_binary(tmp_path, monkeypatch):
    ctx = _make_ctx(tmp_path)
    monkeypatch.setattr(steps, "which", lambda cmd: None)

    def fake_run(argv, **kwargs):
        assert argv[:2] == ["git", "remote"]
        return steps.RunResult(argv, 0, "", "", 0.01)
    monkeypatch.setattr(steps, "run", fake_run)

    assert steps.detect_no_mistakes(ctx).present is False   # binary genuinely absent
    result = steps.verify_v7_no_mistakes_not_wired(ctx)
    assert result.outcome == "ok"


def test_v7_no_mistakes_not_wired_fails_when_a_no_mistakes_remote_exists(tmp_path, monkeypatch):
    ctx = _make_ctx(tmp_path)

    def fake_run(argv, **kwargs):
        return steps.RunResult(argv, 0, "origin\nno-mistakes\n", "", 0.01)
    monkeypatch.setattr(steps, "run", fake_run)

    result = steps.verify_v7_no_mistakes_not_wired(ctx)

    assert result.outcome == "failed"
