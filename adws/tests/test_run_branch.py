"""Branch-per-run: name construction and reuse (MAP.md standing rule 11).

`main` + short-lived `adw/<adw_id>_<slug>`, one branch per unit of work. The
branch is cut before any agent runs, so `slugify`/`run_branch_name` are pure,
deterministic functions of the prompt string — no agent, no network, no
judgement call. `find_run_branch`/`ensure_run_branch` are the reuse half:
joining an existing run (`--adw-id` naming a session that already cut a
branch) must switch to that branch instead of cutting a second one for the
same unit of work, matched on the `adw/<adw_id>_` prefix alone since a joined
run's prompt — and therefore its slug — can differ from the one that cut the
branch originally.

The name-construction tests are pure logic, no git involved. The reuse tests
exercise the real git plumbing (init/branch/checkout) inside a throwaway repo
under `tmp_path` — all local filesystem operations, no network and no remote,
which is what "no network" means here; `find_run_branch`/`ensure_run_branch`
shell out to the real `git` binary on purpose, the same way they will in a
live ADW run, so a test that mocked git away would not actually pin the
reuse behavior it claims to.
"""

import subprocess

import pytest
from adw_modules import git_helper

# ── name construction — pure logic, no git ──────────────────────────────────

def test_slugify_takes_first_few_words_lowercased_kebab():
    assert git_helper.slugify("Implement the new Login Flow for OAuth") == \
        "implement-the-new-login"


def test_slugify_strips_punctuation_and_non_alnum():
    assert git_helper.slugify("Fix bug #123: NPE in User.save()!") == \
        "fix-bug-123-npe"


def test_slugify_falls_back_to_run_when_nothing_alphanumeric():
    assert git_helper.slugify("!!! --- ...") == "run"
    assert git_helper.slugify("") == "run"


def test_slugify_caps_length_and_never_leaves_a_trailing_dash():
    slug = git_helper.slugify("a" * 100, max_words=1, max_len=40)
    assert len(slug) == 40
    assert not slug.endswith("-")


def test_slugify_respects_max_words():
    slug = git_helper.slugify("one two three four five six", max_words=2)
    assert slug == "one-two"


def test_run_branch_name_format():
    assert git_helper.run_branch_name("a1b2c3d4", "Add login flow") == \
        "adw/a1b2c3d4_add-login-flow"


def test_run_branch_name_is_deterministic():
    # Same adw_id + same prompt -> same branch name, every time — a fresh run
    # and a rerun of the same command must agree on what branch they mean.
    first = git_helper.run_branch_name("deadbeef", "Add the login flow")
    second = git_helper.run_branch_name("deadbeef", "Add the login flow")
    assert first == second


def test_run_branch_name_differs_by_adw_id_not_just_slug():
    a = git_helper.run_branch_name("aaaaaaaa", "same prompt text")
    b = git_helper.run_branch_name("bbbbbbbb", "same prompt text")
    assert a != b
    assert a.startswith("adw/aaaaaaaa_")
    assert b.startswith("adw/bbbbbbbb_")


# ── reuse logic — real (local) git plumbing in a throwaway repo ────────────

def _run(*args: str) -> str:
    result = subprocess.run(["git", *args], capture_output=True, text=True,
                            encoding="utf-8", check=False)
    assert result.returncode == 0, f"git {' '.join(args)} failed: {result.stderr}"
    return result.stdout.strip()


@pytest.fixture
def tmp_repo(tmp_path, monkeypatch):
    """A throwaway git repo, cwd'd into for the test's duration.

    git_helper shells out relative to the process cwd, so monkeypatch.chdir
    is what makes these tests exercise the real function against a real repo
    instead of mocking git away. Local commands only (init/config/commit) —
    no remote is ever added, so nothing here touches the network.
    """
    monkeypatch.chdir(tmp_path)
    _run("init", "-q")
    _run("config", "user.email", "test@example.com")
    _run("config", "user.name", "Test")
    (tmp_path / "README.md").write_text("hello\n", encoding="utf-8")
    _run("add", "-A")
    _run("commit", "-q", "-m", "init")
    return tmp_path


def test_find_run_branch_is_none_before_any_branch_is_cut(tmp_repo):
    assert git_helper.find_run_branch("deadbeef") is None


def test_ensure_run_branch_cuts_a_new_branch_from_the_prompt(tmp_repo):
    branch = git_helper.ensure_run_branch("deadbeef", "Add a login flow", tree=tmp_repo)

    assert branch == "adw/deadbeef_add-a-login-flow"
    assert git_helper.current_branch() == branch


def test_ensure_run_branch_reuses_the_branch_for_a_joined_run(tmp_repo):
    # First call: a fresh run, no branch yet -> cuts one.
    first = git_helper.ensure_run_branch("deadbeef", "Add a login flow", tree=tmp_repo)

    # A joined run passes a DIFFERENT prompt (e.g. the next phase's own ask,
    # or a fix-loop re-prompt) but the SAME adw_id — it must land on the same
    # branch, not cut a second one whose slug matches the new prompt instead.
    second = git_helper.ensure_run_branch("deadbeef", "now write the tests", tree=tmp_repo)

    assert second == first
    assert git_helper.current_branch() == first
    # Exactly one branch exists for this adw_id — no second branch was cut.
    matches = _run("branch", "--list", "adw/deadbeef_*", "--format=%(refname:short)")
    assert matches.splitlines() == [first]


def test_ensure_run_branch_switches_back_when_joined_from_elsewhere(tmp_repo):
    default_branch = git_helper.current_branch()
    branch = git_helper.ensure_run_branch("deadbeef", "Add a login flow", tree=tmp_repo)
    assert git_helper.current_branch() == branch

    # Simulate the operator (or another tool) leaving the run's branch between
    # phases run as separate CLI invocations.
    _run("checkout", default_branch)
    assert git_helper.current_branch() == default_branch

    # Joining the run again must switch back to its branch, not cut a new one
    # off wherever HEAD happens to be sitting now.
    rejoined = git_helper.ensure_run_branch("deadbeef", "Add a login flow", tree=tmp_repo)

    assert rejoined == branch
    assert git_helper.current_branch() == branch


def test_ensure_run_branch_keeps_different_runs_on_different_branches(tmp_repo):
    one = git_helper.ensure_run_branch("aaaaaaaa", "first unit of work", tree=tmp_repo)
    _run("checkout", "-b", "scratch")  # not the default branch, just elsewhere
    _run("checkout", one)              # back onto the first run's branch
    two = git_helper.ensure_run_branch("bbbbbbbb", "second unit of work", tree=tmp_repo)

    assert one != two
    assert git_helper.find_run_branch("aaaaaaaa") == one
    assert git_helper.find_run_branch("bbbbbbbb") == two


# ── derive_title: the one title rule, pure logic ────────────────────────────
# MAP.md's worktree-naming ticket: "the card's H1 when dispatched (extract
# the first line), else the first ~8 words of the request" - one function,
# no caller-side branching on which case it is.

def test_derive_title_dispatched_prompt_recovers_the_card_h1_verbatim():
    # dispatch.py's request_prompt() shape: "{title}\n\n{body}".
    prompt = "Add a health endpoint\n\n## Agent Brief\n**Category:** enhancement\n..."
    assert git_helper.derive_title(prompt) == "Add a health endpoint"


def test_derive_title_direct_prompt_caps_at_max_words():
    prompt = "Add a health endpoint returning 200 OK with current uptime info please"
    assert git_helper.derive_title(prompt) == "Add a health endpoint returning 200 OK with"


def test_derive_title_short_direct_prompt_is_returned_whole():
    assert git_helper.derive_title("Fix the login bug") == "Fix the login bug"


def test_derive_title_strips_a_leading_markdown_heading():
    # prompt.md itself starting with an H1 - dispatch.py's own H1 parser
    # strips the same "#\s+" prefix.
    assert git_helper.derive_title("# Add the login flow\n\nbody text") == "Add the login flow"


def test_derive_title_skips_leading_blank_lines():
    assert git_helper.derive_title("\n\n  Add a login flow  \n\nbody") == "Add a login flow"


def test_derive_title_empty_prompt_is_empty_string():
    assert git_helper.derive_title("") == ""
    assert git_helper.derive_title("   \n  \n") == ""


def test_derive_title_respects_a_custom_max_words():
    assert git_helper.derive_title("one two three four five", max_words=2) == "one two"


# ── humanize_slug: the fallback when no trace title was recorded ───────────

def test_humanize_slug_dashes_to_spaces_sentence_case():
    assert git_helper.humanize_slug("add-a-clamp-helper") == "Add a clamp helper"


def test_humanize_slug_single_word():
    assert git_helper.humanize_slug("run") == "Run"


def test_humanize_slug_empty_slug_is_returned_unchanged():
    assert git_helper.humanize_slug("") == ""
