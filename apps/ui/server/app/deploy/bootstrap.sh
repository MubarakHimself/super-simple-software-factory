#!/bin/sh
# =============================================================================
# The one-click factory deploy, server side.
#
# This file is PUSHED to a bare Ubuntu box over SFTP by
# `apps/ui/server/app/machines.ts` and then executed there with `sh`. It is the
# whole of "the server has no CLI tool, nothing" -> "the factory is set up".
#
# Contract with the laptop (machines.ts parses these, nothing else):
#   * every step prints exactly one line   STEP <name> OK <detail>
#                                     or   STEP <name> FAIL <reason>
#   * the last line of a successful run is DEPLOY COMPLETE
#   * a FAIL line is immediately followed by exit 1 - the deploy stops there.
#   Everything else on stdout/stderr is ordinary log noise the UI shows below
#   the step list. STEP lines are ASCII and single-line, always.
#
# Idempotent by construction: every step first asks "is this already true?" and
# reports `OK already ...` instead of doing the work twice. Running this script
# ten times in a row on the same box changes nothing after the first run - and
# converging never means resetting: no step destroys work the box already has
# (see step 6, which fast-forwards and refuses to move a branch backwards).
#
# POSIX sh (dash on Ubuntu), no bashisms: no [[ ]], no arrays, no `local`.
#
# Usage:  sh bootstrap.sh <repo-url> <branch> <target-dir>
# =============================================================================

set -u

REPO_URL="${1:-}"
BRANCH="${2:-integration}"
DIR="${3:-$HOME/sdl-factory}"

# ── the step protocol ────────────────────────────────────────────────────────
# `ok`/`fail` are the ONLY things that may print a STEP line. `fail` exits, so a
# step never has to remember to stop the script itself.

ok() {
  printf 'STEP %s OK %s\n' "$1" "$2"
}

fail() {
  # A reason must be one line: a multi-line command tail would break the
  # parser and, worse, would hide the first line under the last.
  printf 'STEP %s FAIL %s\n' "$1" "$(printf '%s' "$2" | tr '\n\r\t' '   ' | cut -c1-400)"
  exit 1
}

# Last 3 lines of a captured output, flattened - enough to name a failure
# without pasting a whole apt transcript into a status line.
tail_of() {
  printf '%s' "$1" | tail -n 3 | tr '\n\r\t' '   '
}

have() {
  command -v "$1" >/dev/null 2>&1
}

# ── preflight: privileges, PATH ──────────────────────────────────────────────

# uv, just and the installer all drop binaries in ~/.local/bin; a non-login
# `ssh host 'sh script'` does not source .profile, so PATH is set here once and
# exported for everything below.
PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"
export PATH
export DEBIAN_FRONTEND=noninteractive
export GIT_TERMINAL_PROMPT=0

if [ "$(id -u)" = "0" ]; then
  SUDO=no
else
  if have sudo && sudo -n true >/dev/null 2>&1; then
    SUDO=yes
  else
    fail preflight "this user is not root and has no passwordless sudo - deploy needs one of the two to install packages"
  fi
fi

# Root-privileged command runner. Written as a function rather than a `$SUDO`
# prefix variable on purpose: an empty prefix variable expands to nothing and
# `$SUDO -E sh -` silently becomes `-E sh -` when the deploy runs as root,
# which is exactly the kind of failure this script must not have.
asroot() {
  if [ "$SUDO" = yes ]; then
    sudo -n env DEBIAN_FRONTEND=noninteractive "$@"
  else
    env DEBIAN_FRONTEND=noninteractive "$@"
  fi
}

ok preflight "user=$(id -un) sudo=$SUDO target=$DIR"

if [ -z "$REPO_URL" ]; then
  fail args "no repository URL was passed - the laptop sends its own 'git remote get-url origin'"
fi

# ── 1. apt essentials ────────────────────────────────────────────────────────
# git+curl to fetch anything at all, python3/python3-venv for uv's interpreters,
# build-essential because several factory dependencies compile.

APT_PKGS="git curl ca-certificates python3 python3-venv build-essential"
MISSING=""
for pkg in $APT_PKGS; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    MISSING="$MISSING $pkg"
  fi
done

if [ -z "$MISSING" ]; then
  ok apt "already present:$(printf ' %s' $APT_PKGS)"
else
  if ! out=$(asroot apt-get update -qq 2>&1); then
    fail apt "apt-get update failed: $(tail_of "$out")"
  fi
  if ! out=$(asroot apt-get install -y -qq $MISSING 2>&1); then
    fail apt "apt-get install$MISSING failed: $(tail_of "$out")"
  fi
  ok apt "installed$MISSING"
fi

# ── 2. uv (astral installer) ─────────────────────────────────────────────────
# The whole factory is `uv run` - this is the one dependency the installer
# itself cannot install, because the installer is a uv script.

if have uv; then
  ok uv "already present: $(uv --version 2>&1 | head -n 1)"
else
  if ! out=$(curl -LsSf https://astral.sh/uv/install.sh 2>&1 | sh 2>&1); then
    fail uv "the astral installer failed: $(tail_of "$out")"
  fi
  PATH="$HOME/.local/bin:$PATH"
  export PATH
  have uv || fail uv "the astral installer ran but uv is still not on PATH (looked in \$HOME/.local/bin)"
  ok uv "installed $(uv --version 2>&1 | head -n 1)"
fi

# ── 3. node LTS + npm (pi and its extensions are npm packages) ───────────────

NODE_MAJOR=0
if have node; then
  NODE_MAJOR=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  case "$NODE_MAJOR" in
    ''|*[!0-9]*) NODE_MAJOR=0 ;;
  esac
fi

if [ "$NODE_MAJOR" -ge 20 ] && have npm; then
  ok node "already present: node $(node --version 2>&1) npm $(npm --version 2>&1)"
else
  if ! out=$(curl -fsSL https://deb.nodesource.com/setup_lts.x 2>&1 | asroot sh - 2>&1); then
    fail node "the nodesource setup script failed: $(tail_of "$out")"
  fi
  if ! out=$(asroot apt-get install -y -qq nodejs 2>&1); then
    fail node "apt-get install nodejs failed: $(tail_of "$out")"
  fi
  have node || fail node "nodejs installed but node is not on PATH"
  ok node "installed node $(node --version 2>&1) npm $(npm --version 2>&1)"
fi

# ── 4. just (the factory's command runner) ───────────────────────────────────

if have just; then
  ok just "already present: $(just --version 2>&1 | head -n 1)"
else
  mkdir -p "$HOME/.local/bin"
  if ! out=$(curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh 2>&1 | sh -s -- --to "$HOME/.local/bin" 2>&1); then
    fail just "the just installer failed: $(tail_of "$out")"
  fi
  have just || fail just "the just installer ran but just is not on PATH (looked in \$HOME/.local/bin)"
  ok just "installed $(just --version 2>&1 | head -n 1)"
fi

# ── 5. clone the repository (only if absent) ─────────────────────────────────
# A clone that needs credentials must FAIL by name, never hang on a prompt and
# never guess at an identity: GIT_TERMINAL_PROMPT=0 plus a no-op askpass turns
# "please authenticate" into an immediate non-zero exit.

export GIT_ASKPASS=/bin/true
export GIT_SSH_COMMAND="ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new"

if [ -d "$DIR/.git" ]; then
  if ! out=$(git -C "$DIR" remote set-url origin "$REPO_URL" 2>&1); then
    fail clone "could not point the existing checkout at $REPO_URL: $(tail_of "$out")"
  fi
  if ! out=$(git -C "$DIR" fetch --prune --tags origin 2>&1); then
    fail clone "repository not reachable from the server - make it public or add a deploy key ($(tail_of "$out"))"
  fi
  ok clone "already cloned at $DIR - fetched origin"
else
  mkdir -p "$(dirname "$DIR")"
  if ! out=$(git clone --quiet "$REPO_URL" "$DIR" 2>&1); then
    fail clone "repository not reachable from the server - make it public or add a deploy key ($(tail_of "$out"))"
  fi
  ok clone "cloned $REPO_URL into $DIR"
fi

# ── 6. check out the integration branch ──────────────────────────────────────
# The engine works `integration` and nothing else. If the remote has no such
# branch the honest answer is to stop: creating one here would need a push, and
# a deploy that invents a branch on the operator's hub is not a deploy.
#
# CONVERGE, NEVER RESET. `checkout -B` was here once; it force-moves the local
# branch to the remote's commit, which DESTROYS integrated runs the engine has
# committed locally but not yet pushed - a state engine.py:push_pending calls
# normal and expected ("a failed push keeps pending_push set... the record is
# already safe in the local history, the network is just late"). Redeploy is
# exactly what an operator does during that window, so this step fast-forwards
# and nothing else: a server that is AHEAD of origin is reported as ahead and
# left alone.

if ! git -C "$DIR" rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null 2>&1; then
  fail checkout "branch '$BRANCH' does not exist on the remote - the laptop creates and pushes it when the project is initialized"
fi

if git -C "$DIR" rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null 2>&1; then
  # The branch already exists here. Get onto it (a no-op when we are on it
  # already), then fast-forward only.
  CURRENT=$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$CURRENT" != "$BRANCH" ]; then
    if ! out=$(git -C "$DIR" checkout "$BRANCH" 2>&1); then
      fail checkout "could not switch to $BRANCH (the working tree may have changes a run left behind): $(tail_of "$out")"
    fi
  fi
  AHEAD=$(git -C "$DIR" rev-list --count "origin/$BRANCH..$BRANCH" 2>/dev/null)
  case "$AHEAD" in
    ''|*[!0-9]*) AHEAD=0 ;;
  esac
  if [ "$AHEAD" -gt 0 ]; then
    ok checkout "$BRANCH at $(git -C "$DIR" rev-parse --short HEAD 2>/dev/null) - this server is $AHEAD commit(s) ahead of origin/$BRANCH, so nothing was moved; the engine pushes them when it can"
  else
    if ! out=$(git -C "$DIR" merge --ff-only "origin/$BRANCH" 2>&1); then
      fail checkout "could not fast-forward $BRANCH to origin/$BRANCH, and this deploy will not reset it: $(tail_of "$out")"
    fi
    ok checkout "$BRANCH at $(git -C "$DIR" rev-parse --short HEAD 2>/dev/null)"
  fi
else
  # First deploy into this checkout: there is no local branch and nothing local
  # to lose, so creating it from the remote is safe.
  if ! out=$(git -C "$DIR" checkout -b "$BRANCH" --track "origin/$BRANCH" 2>&1); then
    fail checkout "could not check out $BRANCH: $(tail_of "$out")"
  fi
  ok checkout "$BRANCH at $(git -C "$DIR" rev-parse --short HEAD 2>/dev/null)"
fi

# ── 7. uv sync (the python environment the factory runs in) ──────────────────

if [ -f "$DIR/pyproject.toml" ]; then
  if ! out=$(cd "$DIR" && uv sync 2>&1); then
    fail uv-sync "uv sync failed in $DIR: $(tail_of "$out")"
  fi
  ok uv-sync "environment synced from $DIR/pyproject.toml"
else
  ok uv-sync "no pyproject.toml in $DIR - nothing to sync"
fi

# ── 8. the installer, server target ──────────────────────────────────────────
# `installer/install.py --target server` is the factory's own convergence pass:
# pi + extensions + providers + the sdl-engine systemd unit + its git identity +
# PI_BRIDGE_PATH. It is idempotent by its own design, so re-deploying repairs
# drift instead of duplicating anything.
#
# Its exit codes are a three-way answer, not a boolean (installer/install.py):
#   0 everything converged   1 a required step failed   2 done, but a human is
#   needed for something (a provider sign-in, typically). 2 is reported as OK
#   with the reason attached - the box IS deployed, one credential is not.

if [ ! -f "$DIR/installer/install.py" ]; then
  fail installer "no installer/install.py in $DIR - this checkout is not an SDL Factory repository"
fi

INSTALLER_LOG="$DIR/.sdl-deploy-installer.log"
(cd "$DIR" && uv run installer/install.py --target server --yes) >"$INSTALLER_LOG" 2>&1
INSTALLER_CODE=$?
sed -n '1,400p' "$INSTALLER_LOG"

case "$INSTALLER_CODE" in
  0) ok installer "installer/install.py --target server converged everything" ;;
  2) ok installer "converged, but something needs you: $(tail_of "$(grep -E '^\[!!\]|needs-operator' "$INSTALLER_LOG" | tail -n 3)")" ;;
  *) fail installer "installer/install.py --target server exited $INSTALLER_CODE: $(tail_of "$(cat "$INSTALLER_LOG")")" ;;
esac

# ── 9. strip planning skills ─────────────────────────────────────────────────
# The operator's standing ruling: the server EXECUTES, it does not plan. Every
# skill under ~/.claude/skills goes, except the factory's own `sssf` skill,
# which is how an ADW run finds its own scripts. What was removed is echoed by
# name - a deploy that silently deletes things is not honest.

SKILLS_DIR="$HOME/.claude/skills"
if [ -d "$SKILLS_DIR" ]; then
  REMOVED=""
  for entry in "$SKILLS_DIR"/*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    [ "$name" = "sssf" ] && continue
    rm -rf "$entry" && REMOVED="$REMOVED $name"
  done
  if [ -z "$REMOVED" ]; then
    ok skills "no planning skills to remove from $SKILLS_DIR (sssf kept)"
  else
    ok skills "removed$REMOVED from $SKILLS_DIR (sssf kept)"
  fi
else
  ok skills "no $SKILLS_DIR on this box - nothing to strip"
fi

# ── 10. the engine service ───────────────────────────────────────────────────

if ! have systemctl; then
  fail engine "no systemctl on this box - the sdl-engine service cannot be checked (a container without systemd needs --target container instead)"
fi

ENGINE_STATE=$(systemctl is-active sdl-engine 2>&1)
if [ "$ENGINE_STATE" = "active" ]; then
  ENGINE_SINCE=$(systemctl show sdl-engine --property=ActiveEnterTimestamp --value 2>/dev/null)
  ok engine "sdl-engine is active since ${ENGINE_SINCE:-unknown}"
else
  fail engine "sdl-engine is '$ENGINE_STATE' after the installer ran - $(tail_of "$(systemctl status sdl-engine --no-pager --lines=5 2>&1)")"
fi

echo "DEPLOY COMPLETE"
