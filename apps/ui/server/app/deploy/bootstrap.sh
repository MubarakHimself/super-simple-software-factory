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
# (see the checkout step, which fast-forwards and refuses to move a branch
# backwards).
#
# NOBODY IS WATCHING. The deploy runs over one non-interactive ssh exec with no
# tty, so a command that asks a question does not "wait for the operator" - it
# hangs until a timeout or dies on a lock. That failure is what this script was
# rewritten for: a fresh Ubuntu box was still running its boot-time
# `apt-daily`/`unattended-upgrades` when the deploy landed, and apt-get quit
# with "Could not get lock /var/lib/dpkg/lock-frontend". Every external command
# below therefore carries its own humanless guard (see `the humanless
# environment` and the per-step comments): stdin is /dev/null for the whole
# process tree, apt waits for the lock instead of failing, dpkg answers its own
# config prompts, git refuses to ask for a password, npm never opens a prompt,
# and ssh is never invoked at all.
#
# SELF-CONTAINED. `installer/install.py` is the factory's own convergence pass,
# but DEPLOY TARGETS ARE STAMPED PROJECT REPOS - a project the sssf skill
# stamped carries `adws/`, a roster and a justfile, and no `installer/` at all.
# Only the sdl-factory repo itself has one. So the installer is a PREFERENCE,
# not a requirement: when `$DIR/installer/install.py` exists it runs exactly as
# before, and when it does not, the steps between `uv-sync` and `engine`
# converge the same host in POSIX sh - pi + its two extensions, the claude and
# codex CLIs, PI_PATH/PI_BRIDGE_PATH in `.env`, a repo-local committer identity
# and the sdl-engine systemd unit. Those steps mirror `installer/steps.py`
# function by function; each one names what it mirrors.
#
# What that path CANNOT mirror is what steps.py copies out of
# `installer/assets/`: the ollama-cloud scripts, the provider block they wire
# into `~/.pi/agent/models.json`, its credential, and skylos. Step 14b says so
# on an OK line naming the consequence, because the installer path has a
# needs-operator channel (`exit 2` -> "something needs you") and the inline path
# must not be the one that reports DEPLOY COMPLETE on a box that cannot make a
# model call.
#
# POSIX sh (dash on Ubuntu), no bashisms: no [[ ]], no arrays, no `local`.
#
# Usage:  sh bootstrap.sh <repo-url> <branch> <target-dir>
# =============================================================================

set -u

REPO_URL="${1:-}"
BRANCH="${2:-integration}"
DIR="${3:-$HOME/sdl-factory}"

# No human is attached to this run, so nothing may ever read from a terminal:
# every child of this script inherits /dev/null on stdin and gets EOF the
# instant it tries to prompt, instead of blocking the deploy forever. This is
# the backstop under all the per-command flags below - a tool nobody thought to
# audit still cannot ask a question.
exec </dev/null

# ── the step protocol ────────────────────────────────────────────────────────
# `ok`/`fail` are the ONLY things that may print a STEP line. `fail` exits, so a
# step never has to remember to stop the script itself.

# A STEP line is ONE line, ALWAYS - and that is enforced here, once, rather
# than trusted to thirty call sites. machines.ts parses per line, so a detail
# carrying a newline splits the step in two: the parser keeps the truncated
# first half and the remainder silently becomes log noise below the step list.
# Details are interpolated command output, and command output is not under this
# script's control - `npm --version` prepends a config warning on some boxes, a
# python heredoc prepends a DeprecationWarning on others. No caller may be
# trusted to have passed a single line, so neither `ok` nor `fail` assumes it.
flatten() {
  printf '%s' "$1" | tr '\n\r\t' '   '
}

ok() {
  printf 'STEP %s OK %s\n' "$1" "$(flatten "$2")"
}

fail() {
  # A reason is additionally capped: a whole apt transcript in a status line
  # would hide the first line under the last.
  printf 'STEP %s FAIL %s\n' "$1" "$(flatten "$2" | cut -c1-400)"
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

# ── the humanless environment ────────────────────────────────────────────────
# uv, just and the installer all drop binaries in ~/.local/bin; a non-login
# `ssh host 'sh script'` does not source .profile, so PATH is set here once and
# exported for everything below.
PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"
export PATH

# apt/dpkg: never a debconf dialog, never a "which version of this config file
# do you want" question (the per-call -o flags add the same two answers, so the
# guard survives even where this environment does not reach).
export DEBIAN_FRONTEND=noninteractive
export DEBCONF_NONINTERACTIVE_SEEN=true
# Ubuntu 22.04+ runs `needrestart` after every apt transaction and, on a tty,
# asks which services to restart. `a` is its own "answer everything
# automatically" mode.
export NEEDRESTART_MODE=a

# git: no credential prompt, no ssh password prompt, no host-key question, and
# no pager. A private repo must FAIL BY NAME (see the clone step), never hang.
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/true
export GIT_SSH_COMMAND="ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new"
export GIT_PAGER=cat

# pagers in general: `systemctl status`, `journalctl` and friends page by
# default and a pager with nowhere to page to is a hang.
export PAGER=cat
export SYSTEMD_PAGER=cat
export SYSTEMD_COLORS=0

# npm: `--yes` for anything that would confirm, and no funding/audit/notifier
# chatter that only exists for a human reader.
export npm_config_yes=true
export npm_config_fund=false
export npm_config_audit=false
export npm_config_progress=false
export npm_config_update_notifier=false

# Every apt-get call this script makes carries these: wait up to 10 minutes for
# whoever holds the dpkg lock (the boot-time apt-daily timer, typically) rather
# than exiting 100 on it, and answer dpkg's config-file question with "keep
# what is installed" the way an unattended box must.
APT_OPTS="-o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"

# ── preflight: privileges, PATH, an absolute target ──────────────────────────

if [ "$(id -u)" = "0" ]; then
  SUDO=no
else
  if have sudo && sudo -n true >/dev/null 2>&1; then
    SUDO=yes
  else
    fail preflight "this user is not root and has no passwordless sudo - deploy needs one of the two to install packages"
  fi
fi

# A systemd unit's WorkingDirectory must be absolute, and so must the path the
# engine's own logs name. The app always sends an absolute directory; a
# hand-passed relative one is resolved here rather than half-working later.
case "$DIR" in
  /*) ;;
  *) DIR="$(pwd)/$DIR" ;;
esac

# Root-privileged command runner. Written as a function rather than a `$SUDO`
# prefix variable on purpose: an empty prefix variable expands to nothing and
# `$SUDO -E sh -` silently becomes `-E sh -` when the deploy runs as root,
# which is exactly the kind of failure this script must not have.
#
# `sudo` resets the environment (env_reset), so every humanless variable a
# root-side command needs is re-stated here - otherwise `sudo apt-get` would
# run WITHOUT DEBIAN_FRONTEND and the first config prompt would hang the box.
asroot() {
  if [ "$SUDO" = yes ]; then
    sudo -n env DEBIAN_FRONTEND=noninteractive DEBCONF_NONINTERACTIVE_SEEN=true \
      NEEDRESTART_MODE=a GIT_TERMINAL_PROMPT=0 npm_config_yes=true \
      npm_config_fund=false npm_config_audit=false npm_config_progress=false \
      npm_config_update_notifier=false "$@"
  else
    env DEBIAN_FRONTEND=noninteractive DEBCONF_NONINTERACTIVE_SEEN=true \
      NEEDRESTART_MODE=a GIT_TERMINAL_PROMPT=0 npm_config_yes=true \
      npm_config_fund=false npm_config_audit=false npm_config_progress=false \
      npm_config_update_notifier=false "$@"
  fi
}

ok preflight "user=$(id -un) sudo=$SUDO target=$DIR"

if [ -z "$REPO_URL" ]; then
  fail args "no repository URL was passed - the laptop sends its own 'git remote get-url origin'"
fi

# ── 1. apt essentials ────────────────────────────────────────────────────────
# git+curl to fetch anything at all, python3/python3-venv for uv's interpreters,
# build-essential because several factory dependencies compile.
#
# THE FIELD FAILURE: a box that finished booting ninety seconds ago is still
# running `apt-daily`/`unattended-upgrades`, and apt-get without a lock timeout
# quits immediately with "Could not get lock /var/lib/dpkg/lock-frontend. It is
# held by process NNNN". Three guards, in order of who catches it first:
#   1. `apt_wait` below waits (silently - a step prints ONE line, and the wait
#      is reported in that line's detail) for up to ten minutes for every apt,
#      dpkg and unattended-upgrade process on the box to finish.
#   2. `-o DPkg::Lock::Timeout=600` makes apt itself block on the lock instead
#      of failing, for the case where a timer fires in the seconds between the
#      wait ending and apt starting.
#   3. the apt.conf.d drop-in gives the SAME two guards to apt calls this
#      script does not make - above all the nodesource setup script, which runs
#      its own `apt-get update && apt-get install` inside.

apt_busy() {
  # FIELD LESSON (2026-08-17): the process-name scan is a trap. Ubuntu runs
  # `unattended-upgrade-shutdown --wait-for-signal` PERMANENTLY - its comm is
  # `unattended-upgr`, so a name scan reads "busy" forever and every wait
  # burns its full bound with the lock free. The truth is the LOCK, so probe
  # it: a non-blocking flock on dpkg's frontend lock (python3 ships on every
  # Debian/Ubuntu cloud image; if it is somehow absent the probe errors ->
  # "not busy" and guard 2, APT_OPTS's DPkg::Lock::Timeout, carries alone).
  python3 -c '
import fcntl, sys
try:
    f = open("/var/lib/dpkg/lock-frontend", "ab")
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    fcntl.flock(f, fcntl.LOCK_UN)
    sys.exit(1)   # lock acquired freely: apt is NOT busy
except SystemExit:
    raise
except Exception:
    sys.exit(0)   # lock held (or unreadable): busy
' 2>/dev/null
}

# Silent by contract: a step prints ONE line, so the waiting happens inside the
# step and the seconds are reported in that step's detail. APT_WAITED is a
# running total across the whole deploy (two steps use apt), which is why
# `waited_note` says "in total" - a per-call reset would let a long wait in the
# apt step vanish from the node step's line.
APT_WAITED=0
apt_wait() {
  waited_here=0
  while [ "$waited_here" -lt 600 ]; do
    apt_busy || return 0
    # A plain (non-STEP) heartbeat every 30s: the pane streams raw lines too,
    # so a long lock wait is visible instead of reading as a hung deploy.
    if [ $((waited_here % 30)) -eq 0 ] && [ "$waited_here" -gt 0 ]; then
      printf 'waiting for the system apt to release the package lock (%ss)...
' "$waited_here"
    fi
    sleep 5
    waited_here=$((waited_here + 5))
    APT_WAITED=$((APT_WAITED + 5))
  done
  # Bounded, and never fatal: ten minutes is far past a normal boot-time
  # transaction, and apt's own lock timeout is still there to lean on.
  return 0
}

waited_note() {
  if [ "$APT_WAITED" -gt 0 ]; then
    printf ' (waited %ss in total for the boot-time apt lock)' "$APT_WAITED"
  fi
}

have apt-get || fail apt "this box has no apt-get - the one-click deploy targets Debian/Ubuntu"

# The drop-in: the same two answers, for every apt on this box including the
# ones inside other people's install scripts. Written only when it differs, so
# a redeploy touches nothing.
APT_CONF=/etc/apt/apt.conf.d/99sdl-factory-noninteractive
APT_CONF_BODY='// written by the SDL Factory deploy - this box is never watched by a human.
DPkg::Lock::Timeout "600";
Dpkg::Options { "--force-confdef"; "--force-confold"; };'
APT_CONF_NOTE=""
if [ -d /etc/apt/apt.conf.d ]; then
  if [ "$(cat "$APT_CONF" 2>/dev/null)" = "$APT_CONF_BODY" ]; then
    APT_CONF_NOTE=" (apt already non-interactive by config)"
  else
    if printf '%s\n' "$APT_CONF_BODY" | asroot tee "$APT_CONF" >/dev/null 2>&1; then
      APT_CONF_NOTE=" (wrote $APT_CONF so every apt on this box waits for the lock and keeps existing configs)"
    else
      APT_CONF_NOTE=" (could not write $APT_CONF - the per-call -o flags still apply)"
    fi
  fi
fi

APT_PKGS="git curl ca-certificates python3 python3-venv build-essential"
MISSING=""
for pkg in $APT_PKGS; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    MISSING="$MISSING $pkg"
  fi
done

if [ -z "$MISSING" ]; then
  ok apt "already present:$(printf ' %s' $APT_PKGS)$APT_CONF_NOTE"
else
  apt_wait
  if ! out=$(asroot apt-get $APT_OPTS update -qq 2>&1); then
    fail apt "apt-get update failed: $(tail_of "$out")"
  fi
  if ! out=$(asroot apt-get $APT_OPTS install -y -qq $MISSING 2>&1); then
    fail apt "apt-get install$MISSING failed: $(tail_of "$out")"
  fi
  ok apt "installed$MISSING$(waited_note)$APT_CONF_NOTE"
fi

# ── 2. sqlite (mirrors installer/steps.py detect_sqlite/apply_sqlite) ─────────
# Not a package to install: `adws/adw_modules/tracer.py` imports the stdlib
# module, so a python3 built without sqlite support means every run's trace
# dies mid-flight. The installer checks exactly this and never installs a CLI.

if python3 -c 'import sqlite3' >/dev/null 2>&1; then
  if have sqlite3; then
    ok sqlite "sqlite3 stdlib module present; sqlite3 CLI also present"
  else
    ok sqlite "sqlite3 stdlib module present; CLI absent (optional, never installed)"
  fi
else
  fail sqlite "the sqlite3 stdlib module is missing - adws/adw_modules/tracer.py imports it and the whole trace depends on it. Reinstall python3 with sqlite support."
fi

# ── 3. uv (astral installer) ─────────────────────────────────────────────────
# The whole factory is `uv run` - this is the one dependency the installer
# itself cannot install, because the installer is a uv script.
#
# `curl -LsSf` is the installer's own documented silent form (fail on HTTP
# error, no progress meter) and the shell it runs in never prompts.
#
# FETCHED TO A FILE, THEN RUN - never `curl | sh`. POSIX sh has no pipefail, so
# a pipeline reports only the last command's status: a DNS or HTTP failure used
# to arrive as the shell trying to EXECUTE curl's own error text ("curl: (6)
# Could not resolve host: ..." -> exit 127), and the deploy reported a
# not-found error instead of a fetch failure. Two commands, two honest exit
# codes. Same shape in the node and just steps below.

if have uv; then
  ok uv "already present: $(uv --version 2>&1 | head -n 1)"
else
  UV_SETUP=$(mktemp 2>/dev/null) || UV_SETUP="/tmp/uv-install.$$"
  if ! out=$(curl -LsSf --retry 3 -o "$UV_SETUP" https://astral.sh/uv/install.sh 2>&1); then
    rm -f "$UV_SETUP"
    fail uv "could not fetch https://astral.sh/uv/install.sh: $(tail_of "$out")"
  fi
  if ! out=$(sh "$UV_SETUP" 2>&1); then
    rm -f "$UV_SETUP"
    fail uv "the astral installer failed: $(tail_of "$out")"
  fi
  rm -f "$UV_SETUP"
  PATH="$HOME/.local/bin:$PATH"
  export PATH
  have uv || fail uv "the astral installer ran but uv is still not on PATH (looked in \$HOME/.local/bin)"
  ok uv "installed $(uv --version 2>&1 | head -n 1)"
fi

# ── 4. node + npm (pi and its extensions are npm packages) ──────────────────
# Mirrors installer/steps.py `_nodesource_command` - and MIRRORS means the same
# two things it does, not merely something like them:
#   * the SAME PINNED script, `setup_20.x`. `setup_lts.x` was here and it is a
#     moving target: it reads NODE_VERSION="24.x" today, so the installer path
#     (the sdl-factory box) got node 20 and the inline path (every stamped
#     project box) got node 24 - one factory, two runtimes, decided by whether
#     installer/ happened to exist.
#   * fed to BASH. The upstream script is `#!/bin/bash` and NodeSource's own
#     instruction - and steps.py's command - is `| bash -`. dash parses today's
#     revision by luck; one upstream `[[ ]]`, array or `local -a` would break
#     the node step on every fresh box and read as a NodeSource outage.
# Floor node 20, the same floor steps.py checks.
#
# The setup script runs apt itself, which is why `apt_wait` runs first and why
# the drop-in above exists - its internal apt-get inherits neither of this
# script's -o flags.
NODE_SETUP_URL="https://deb.nodesource.com/setup_20.x"

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
  have bash ||
    fail node "this box has no bash - the nodesource setup script is a bash script (installer/steps.py pipes it to bash too), so node cannot be installed here"
  apt_wait
  NODE_SETUP=$(mktemp 2>/dev/null) || NODE_SETUP="/tmp/nodesource-setup.$$"
  if ! out=$(curl -fsSL --retry 3 -o "$NODE_SETUP" "$NODE_SETUP_URL" 2>&1); then
    rm -f "$NODE_SETUP"
    fail node "could not fetch $NODE_SETUP_URL: $(tail_of "$out")"
  fi
  if ! out=$(asroot bash "$NODE_SETUP" 2>&1); then
    rm -f "$NODE_SETUP"
    fail node "the nodesource setup script failed: $(tail_of "$out")"
  fi
  rm -f "$NODE_SETUP"
  apt_wait
  if ! out=$(asroot apt-get $APT_OPTS install -y -qq nodejs 2>&1); then
    fail node "apt-get install nodejs failed: $(tail_of "$out")"
  fi
  have node || fail node "nodejs installed but node is not on PATH"
  ok node "installed node $(node --version 2>&1) npm $(npm --version 2>&1)$(waited_note)"
fi

# ── 5. just (the factory's command runner) ───────────────────────────────────

if have just; then
  ok just "already present: $(just --version 2>&1 | head -n 1)"
else
  have bash ||
    fail just "this box has no bash - the just installer is a bash script, so just cannot be installed here"
  mkdir -p "$HOME/.local/bin"
  JUST_SETUP=$(mktemp 2>/dev/null) || JUST_SETUP="/tmp/just-install.$$"
  if ! out=$(curl --proto '=https' --tlsv1.2 -sSf --retry 3 -o "$JUST_SETUP" https://just.systems/install.sh 2>&1); then
    rm -f "$JUST_SETUP"
    fail just "could not fetch https://just.systems/install.sh: $(tail_of "$out")"
  fi
  if ! out=$(bash "$JUST_SETUP" --to "$HOME/.local/bin" 2>&1); then
    rm -f "$JUST_SETUP"
    fail just "the just installer failed: $(tail_of "$out")"
  fi
  rm -f "$JUST_SETUP"
  have just || fail just "the just installer ran but just is not on PATH (looked in \$HOME/.local/bin)"
  ok just "installed $(just --version 2>&1 | head -n 1)"
fi

# ── 6. clone the repository (only if absent) ─────────────────────────────────
# A clone that needs credentials must FAIL by name, never hang on a prompt and
# never guess at an identity: GIT_TERMINAL_PROMPT=0 plus a no-op askpass turns
# "please authenticate" into an immediate non-zero exit, and the ssh form is
# forced into BatchMode so a deploy-key URL fails the same honest way instead
# of sitting on a passphrase prompt. Both are exported at the top of the file,
# so every git call below - not just this one - is covered.

# AN EXISTING `origin` IS NEVER REWRITTEN. `remote set-url origin "$REPO_URL"`
# ran here unconditionally, before anything checked the checkout was even the
# same repository, and it destroyed state the box already had two ways:
#   * it undid this step's own prescribed remedy. When the clone fails the
#     message below says "add a deploy key", and a deploy key means an SSH
#     remote (git@github.com:owner/repo.git). The next redeploy replaced it
#     with whatever the laptop's `git remote get-url origin` says (machines.ts
#     `originUrl`), the server's push path died, and the step still printed OK.
#   * it wrote before it validated identity. The target directory defaults to
#     the repo BASENAME under /root or /home/<user>, so two projects whose
#     origins end in the same basename land in the same directory - and the
#     colliding checkout came back pointing at the wrong repository.
# So: compare, report, and leave it alone. Nothing here rewrites a remote; the
# checkout step below refuses to move a branch it cannot fast-forward, which is
# where a genuinely different repository stops.

if [ -d "$DIR/.git" ]; then
  CURRENT_ORIGIN=$(git -C "$DIR" remote get-url origin 2>/dev/null) || CURRENT_ORIGIN=""
  ORIGIN_NOTE=""
  if [ -z "$CURRENT_ORIGIN" ]; then
    # No origin at all is the one case with nothing to lose: add it.
    if ! out=$(git -C "$DIR" remote add origin "$REPO_URL" 2>&1); then
      fail clone "the checkout at $DIR has no 'origin' remote and one could not be added: $(tail_of "$out")"
    fi
    ORIGIN_NOTE=" - added the missing origin $REPO_URL"
  elif [ "$CURRENT_ORIGIN" != "$REPO_URL" ]; then
    ORIGIN_NOTE=" - LEFT ALONE: its origin is '$CURRENT_ORIGIN', not the '$REPO_URL' this deploy was given (a deploy key, or another project of the same basename). Nothing was rewritten; if this is the wrong checkout, deploy with an explicit directory"
  fi
  if ! out=$(git -C "$DIR" fetch --prune --tags origin 2>&1); then
    fail clone "repository not reachable from the server - make it public or add a deploy key ($(tail_of "$out"))"
  fi
  ok clone "already cloned at $DIR - fetched origin$ORIGIN_NOTE"
else
  mkdir -p "$(dirname "$DIR")"
  if ! out=$(git clone --quiet "$REPO_URL" "$DIR" 2>&1); then
    fail clone "repository not reachable from the server - make it public or add a deploy key ($(tail_of "$out"))"
  fi
  ok clone "cloned $REPO_URL into $DIR"
fi

# ── 7. check out the integration branch ──────────────────────────────────────
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

# THIS IS A BACKSTOP AND SHOULD NOW BE UNREACHABLE FROM THE APP. The app's own
# deploy runs a laptop-side adoption phase first (apps/ui/server/app/adopt.ts):
# it commits whatever is uncommitted, cuts `$BRANCH` from the newest work in the
# checkout, and pushes it - so by the time this script runs, origin has the
# branch. Reaching this line therefore means the deploy was started OUTSIDE the
# app (this script run by hand, or against a remote nobody adopted). The message
# says exactly that, and prints what the remote DOES have, because that list is
# the difference between "the wrong branch name was passed" and "an empty hub".
if ! git -C "$DIR" rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null 2>&1; then
  # `grep -vx HEAD` rather than an anchored end-of-line pattern: a dollar sign
  # immediately followed by a single quote is an ANSI-C quote, a bashism this
  # file's own dash-compatibility guard rejects by name. `-x` is the POSIX way
  # to say "match the whole line" and spells none of it.
  REMOTE_HEADS=$(git -C "$DIR" for-each-ref --format='%(refname:strip=3)' refs/remotes/origin 2>/dev/null | grep -vx HEAD | tr '\n' ' ')
  [ -n "$REMOTE_HEADS" ] || REMOTE_HEADS="(none - the remote has no branches at all yet)"
  fail checkout "branch '$BRANCH' does not exist on the remote. origin has: $REMOTE_HEADS. The app's Deploy creates and pushes this branch for you before it ever connects here, so this state means the deploy was started outside the app - run Deploy from the app against this project and it will adopt the repository first"
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

# ── 8. is this checkout a factory at all? ────────────────────────────────────
# The precondition for everything below. `adws/engine.py` is what the systemd
# unit runs; a project stamped by an older sssf skill has `adws/adw_*.py` and
# no engine at all, and provisioning a service around a file that does not
# exist would hand the operator a green deploy and a box that ships nothing.
# The fix is on the laptop, not here, so the message says so and stops.

if [ ! -f "$DIR/adws/engine.py" ]; then
  fail stamp "$DIR/adws/engine.py is missing - this project was stamped by an older sssf skill - re-run Initialize factory on the laptop, push, and redeploy"
fi
if [ ! -d "$DIR/adws/adw_modules" ]; then
  fail stamp "$DIR/adws/adw_modules is missing - this project was stamped by an older sssf skill - re-run Initialize factory on the laptop, push, and redeploy"
fi

# ...and the same question asked of the engine's MERGE GATE, which is the half
# that was missing. `engine.py`'s `quality_commands` shells out to
#   uv run --project <tree> --group dev ruff check .
#   uv run --project <tree> --group dev mypy adws
#   uv run --project <tree> --group dev pytest -q adws/tests
# before it merges anything, and `quality_is_green` is FAIL-CLOSED: a command
# that could not run at all reads RED. A checkout with no pyproject.toml gets
# "warning: --group dev has no effect when used outside of a project" followed
# by "Failed to spawn: ruff - program not found", which is not in quality.py's
# TOOL_UNAVAILABLE_SIGNATURES either, so it is a hard red. Every finished run
# then lands `Status: blocked` forever while `systemctl is-active` says
# `active` - a green deploy on a box that ships nothing, which is exactly what
# this step exists to refuse.

if [ ! -f "$DIR/pyproject.toml" ]; then
  fail stamp "$DIR/pyproject.toml is missing - adws/engine.py's merge gate runs 'uv run --project . --group dev ruff/mypy/pytest' and is fail-closed, so without it every card this box finishes is blocked, forever - re-run Initialize factory on the laptop (it stamps one), push, and redeploy"
fi
# THE REMEDIATION HAS TO BE COMPLETE. This line used to name four packages -
# ruff, pytest, mypy, types-PyYAML - and a checkout that followed it verbatim
# STILL red the gate, on `ModuleNotFoundError: No module named 'yaml'`:
# adws/tests imports adw_modules, which imports pydantic, yaml, dotenv and rich,
# and a project that arrived with its own pyproject.toml has none of them in a
# `[project] dependencies` the stamp is not allowed to edit. So the list named
# here is the self-sufficient one the skill's own template now carries.
if ! tr -d ' \t' <"$DIR/pyproject.toml" | grep -q '^dev='; then
  fail stamp "$DIR/pyproject.toml declares no 'dev' dependency group - the merge gate resolves ruff, mypy and pytest through it and is fail-closed, so every card this box finishes would be blocked - add [dependency-groups] with dev = [\"ruff\", \"pytest\", \"mypy\", \"types-PyYAML\", \"pydantic\", \"python-dotenv\", \"pyyaml\", \"rich\"] (the last four are what adws/tests needs importable - a dev group with only the tools reds the gate on ModuleNotFoundError: yaml), push, and redeploy"
fi
if [ -z "$(ls "$DIR"/adws/tests/test_*.py 2>/dev/null)" ]; then
  fail stamp "$DIR/adws/tests holds no test_*.py - the merge gate runs 'pytest -q adws/tests', pytest exits 5 on a directory with nothing to collect, and the gate reads 5 as RED - re-run Initialize factory on the laptop (it stamps a starter suite), push, and redeploy"
fi
ok stamp "adws/engine.py, adws/adw_modules, pyproject.toml (dev group) and adws/tests present - this checkout can run the engine AND pass its own merge gate"

# ── 9. uv sync (the toolchain the merge gate resolves through) ───────────────
# The stamp step above refuses a checkout with no pyproject.toml, so there is
# always one here. Syncing it on the DEPLOY is the point: otherwise the
# engine's first merge gate downloads ruff, mypy and pytest from inside a
# systemd unit, and a network hiccup there reads as a red gate on the
# operator's card rather than as what it is.
#
# Nothing an ADW runs needs this: every adws/*.py carries PEP 723 inline
# dependencies and `uv run <script>` resolves those, skipping the project
# entirely. This is for `uv run --project <tree> --group dev ...` and the engine
# warm below, and nothing else.

if ! out=$(cd "$DIR" && uv sync 2>&1); then
  fail uv-sync "uv sync failed in $DIR: $(tail_of "$out")"
fi
ok uv-sync "environment synced from $DIR/pyproject.toml - the merge gate's ruff/mypy/pytest resolve here"

# ── 10. the installer, when this repo has one ────────────────────────────────
# `installer/install.py --target server` is the factory's own convergence pass:
# pi + extensions + providers + the sdl-engine systemd unit + its git identity +
# PI_BRIDGE_PATH. It is idempotent by its own design, so re-deploying repairs
# drift instead of duplicating anything.
#
# Its exit codes are a three-way answer, not a boolean (installer/install.py):
#   0 everything converged   1 a required step failed   2 done, but a human is
#   needed for something (a provider sign-in, typically). 2 is reported as OK
#   with the reason attached - the box IS deployed, one credential is not.
#
# ONLY the sdl-factory repo carries installer/. A stamped project repo never
# does, and that is the normal case - so its absence is not a failure, it
# selects the inline path below, which converges the same things in sh.

USED_INSTALLER=no
if [ -f "$DIR/installer/install.py" ]; then
  USED_INSTALLER=yes
  INSTALLER_LOG="$DIR/.sdl-deploy-installer.log"
  (cd "$DIR" && uv run installer/install.py --target server --yes) >"$INSTALLER_LOG" 2>&1
  INSTALLER_CODE=$?
  sed -n '1,400p' "$INSTALLER_LOG"

  # Exit 2 names WHAT needs a human. When the installer's own markers are not
  # in the log (an older installer, a truncated run), the last lines of the log
  # are said instead - "something needs you:" followed by nothing is the one
  # answer this step is not allowed to give.
  INSTALLER_NOTE=$(tail_of "$(grep -E '^\[!!\]|^\[\?\?\]|needs-operator' "$INSTALLER_LOG" | tail -n 3)")
  if [ -z "$INSTALLER_NOTE" ]; then
    INSTALLER_NOTE="$(tail_of "$(cat "$INSTALLER_LOG")") (no [!!]/[??] marker in $INSTALLER_LOG)"
  fi

  case "$INSTALLER_CODE" in
    0) ok installer "installer/install.py --target server converged everything" ;;
    2) ok installer "converged, but something needs you: $INSTALLER_NOTE" ;;
    *) fail installer "installer/install.py --target server exited $INSTALLER_CODE: $(tail_of "$(cat "$INSTALLER_LOG")")" ;;
  esac
fi

# =============================================================================
# The inline path: everything installer/steps.py does for --target server,
# in sh, for the boxes where installer/ does not exist. Skipped entirely when
# the installer above already ran.
# =============================================================================

# ── 10b. the service user has to BE this user ────────────────────────────────
# Everything the inline path installs below is HOME-shaped, and every bit of it
# belongs to the user running this script:
#   * the pi packages land in $HOME/.pi (step 12 installs them as THIS user, on
#     purpose - never through sudo),
#   * PI_MODELS_PATH and PI_BRIDGE_PATH in $DIR/.env are derived from $HOME,
#   * the engine warm in step 17 fills THIS user's ~/.cache/uv.
# But the unit's `User=` is the OWNER OF THE CHECKOUT (step 17), which the
# script goes to real trouble to look up precisely because it need not be the
# same person - `body.dir` is caller-supplied (machines.ts).
#
# When the two differ, every one of those values describes somebody else: the
# service user has no pi packages, reads a models.json and a bridge path inside
# a home Ubuntu creates mode 750, and starts `uv run` with a cold cache under
# Restart=always - the exact silent crash loop the warm step exists to prevent,
# and invisible to this deploy because the warm ran as the user for whom the
# paths ARE correct. So it is refused by name here, before a single HOME-shaped
# value is written, rather than converged into a green deploy and a dead box.

SERVICE_USER=""
if [ "$USED_INSTALLER" = no ]; then
  # The checkout's owner is git's own test for "whose repo is this", and the
  # same lookup step 17 renders into the unit.
  SERVICE_USER=$(stat -c %U "$DIR" 2>/dev/null) || SERVICE_USER=""
  case "$SERVICE_USER" in
    ''|UNKNOWN) SERVICE_USER="${SUDO_USER:-$(id -un)}" ;;
  esac
  DEPLOY_USER=$(id -un)
  if [ "$SERVICE_USER" != "$DEPLOY_USER" ]; then
    fail service-user "$DIR is owned by '$SERVICE_USER' but this deploy runs as '$DEPLOY_USER' - the systemd unit would run the engine as '$SERVICE_USER' while the pi packages, the PI_BRIDGE_PATH/PI_MODELS_PATH in $DIR/.env and the warmed uv cache all belong to '$DEPLOY_USER', so the service would crash-loop behind Restart=always. Deploy as '$SERVICE_USER', or pass a directory this user owns"
  fi
  ok service-user "$DIR is owned by $SERVICE_USER, the user this deploy runs as - the pi packages, the .env paths and the warmed uv cache will all belong to the user systemd runs the engine as"
fi

# ── 11. pi + PI_PATH/PI_MODELS_PATH/PI_BRIDGE_PATH ───────────────────────────
# Mirrors steps.py detect_pi/apply_pi (spec 6.6). pi is `npm:
# @earendil-works/pi-coding-agent`, installed globally with --ignore-scripts,
# and it is used through `node <npm root -g>/.../dist/cli.js` - never through a
# `pi` on PATH, exactly as steps.py does it.
#
# The three .env values are DERIVED per host and merged into $DIR/.env, never
# baked into anything tracked: sssf.shipping.config.yaml writes
# `${PI_BRIDGE_PATH}/src/index.ts` and agents.py expands it at run time.

PI_CLI=""
pi_cli_path() {
  npm_root=$(npm root -g 2>/dev/null) || return 1
  [ -n "$npm_root" ] || return 1
  pi_candidate="$npm_root/@earendil-works/pi-coding-agent/dist/cli.js"
  [ -f "$pi_candidate" ] || return 1
  printf '%s' "$pi_candidate"
}

if [ "$USED_INSTALLER" = no ]; then
  PI_CLI=$(pi_cli_path) || PI_CLI=""
  PI_NOTE="already present"
  if [ -z "$PI_CLI" ]; then
    if ! out=$(asroot npm install -g --ignore-scripts --no-fund --no-audit --loglevel=error @earendil-works/pi-coding-agent 2>&1); then
      fail pi "npm install -g @earendil-works/pi-coding-agent failed: $(tail_of "$out")"
    fi
    PI_CLI=$(pi_cli_path) || PI_CLI=""
    [ -n "$PI_CLI" ] || fail pi "npm install reported success but cli.js is still not under $(npm root -g 2>/dev/null) - the global npm prefix root sees is not the one this user reads"
    PI_NOTE="installed"
  fi

  # The same three values steps.py writes, derived the same way.
  SDL_PI_PATH="node $PI_CLI"
  SDL_PI_MODELS_PATH="$HOME/.pi/agent/models.json"
  SDL_PI_BRIDGE_PATH="$HOME/.pi/agent/npm/node_modules/pi-claude-bridge"
  SDL_ENV_PATH="$DIR/.env"
  SDL_ENV_SAMPLE="$DIR/.env.sample"
  export SDL_PI_PATH SDL_PI_MODELS_PATH SDL_PI_BRIDGE_PATH SDL_ENV_PATH SDL_ENV_SAMPLE

  # python3 does the merge because python3 is what reads the file afterwards:
  # this is steps.py's merge_env_text + quote_env_value line for line - every
  # comment, blank and unrelated key preserved in place, values double-quoted
  # so `just`'s dotenv-load can parse `PI_PATH=node /path/cli.js` (a value with
  # a space), and a file whose content would not change is left untouched.
  # Every value arrives through the environment, so nothing is ever pasted into
  # a shell or a python literal.
  if ! ENV_RESULT=$(python3 - <<'PY' 2>&1
import os

def quoted(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

def merged_text(text, updates):
    out = []
    seen = set()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            out.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            out.append(key + "=" + updates[key])
            seen.add(key)
        else:
            out.append(line)
    for key, value in updates.items():
        if key not in seen:
            out.append(key + "=" + value)
    return "\n".join(out) + "\n"

env_path = os.environ["SDL_ENV_PATH"]
sample = os.environ.get("SDL_ENV_SAMPLE", "")
existed = os.path.exists(env_path)
if existed:
    with open(env_path, encoding="utf-8") as handle:
        text = handle.read()
elif sample and os.path.exists(sample):
    with open(sample, encoding="utf-8") as handle:
        text = handle.read()
else:
    text = ""

updates = {
    "PI_PATH": quoted(os.environ["SDL_PI_PATH"]),
    "PI_MODELS_PATH": quoted(os.environ["SDL_PI_MODELS_PATH"]),
    "PI_BRIDGE_PATH": quoted(os.environ["SDL_PI_BRIDGE_PATH"]),
}
result = merged_text(text, updates)
if existed and result == text:
    print("unchanged")
else:
    with open(env_path, "w", encoding="utf-8") as handle:
        handle.write(result)
    print("written")
PY
  ); then
    fail pi "could not merge PI_PATH/PI_MODELS_PATH/PI_BRIDGE_PATH into $DIR/.env: $(tail_of "$ENV_RESULT")"
  fi
  ok pi "$PI_NOTE - PI_PATH='node $PI_CLI', PI_BRIDGE_PATH='$SDL_PI_BRIDGE_PATH' ($ENV_RESULT in $DIR/.env)"
fi

# ── 12. pi packages: the bridge and the subagents ────────────────────────────
# Mirrors steps.py detect_pi_packages/apply_pi_packages (spec 6.7). Two names,
# taken from steps.py's PI_PACKAGES, never guessed: `npm:pi-claude-bridge` and
# `npm:@tintinweb/pi-subagents`. Both halves matter - the names are merged into
# ~/.pi/agent/settings.json (a set union that touches no other key) AND each is
# installed with pi's own installer so the directory exists on disk.
#
# Run as THIS user, never through sudo: the packages land in $HOME/.pi, which
# is the home PI_BRIDGE_PATH above points at.

if [ "$USED_INSTALLER" = no ]; then
  PI_SETTINGS="$HOME/.pi/agent/settings.json"
  PI_NPM_DIR="$HOME/.pi/agent/npm/node_modules"
  PKGS_ON_DISK=yes
  [ -d "$PI_NPM_DIR/pi-claude-bridge" ] || PKGS_ON_DISK=no
  [ -d "$PI_NPM_DIR/@tintinweb/pi-subagents" ] || PKGS_ON_DISK=no
  PKGS_IN_SETTINGS=no
  if grep -q 'npm:pi-claude-bridge' "$PI_SETTINGS" 2>/dev/null &&
     grep -q 'npm:@tintinweb/pi-subagents' "$PI_SETTINGS" 2>/dev/null; then
    PKGS_IN_SETTINGS=yes
  fi

  if [ "$PKGS_ON_DISK" = yes ] && [ "$PKGS_IN_SETTINGS" = yes ]; then
    ok pi-packages "already merged into settings.json and installed under $PI_NPM_DIR"
  else
    SDL_PI_SETTINGS="$PI_SETTINGS"
    SDL_PI_PACKAGES="npm:pi-claude-bridge npm:@tintinweb/pi-subagents"
    export SDL_PI_SETTINGS SDL_PI_PACKAGES
    # steps.py merge_pi_settings, line for line: `packages` is an order-stable
    # set union, every other key is left alone, and a `theme` naming a theme
    # that is not installed is dropped because it errors on every pi launch.
    if ! SETTINGS_RESULT=$(python3 - <<'PY' 2>&1
import json, os

path = os.environ["SDL_PI_SETTINGS"]
wanted = os.environ["SDL_PI_PACKAGES"].split()
existing = {}
try:
    with open(path, encoding="utf-8") as handle:
        loaded = json.load(handle)
    if isinstance(loaded, dict):
        existing = loaded
except (OSError, ValueError):
    existing = {}

merged = dict(existing)
packages = list(existing.get("packages", []))
seen = set(packages)
for name in wanted:
    if name not in seen:
        packages.append(name)
        seen.add(name)
merged["packages"] = packages
if "theme" in merged and str(merged["theme"]) != "default":
    del merged["theme"]

text = json.dumps(merged, indent=2, sort_keys=True) + "\n"
current = ""
if os.path.exists(path):
    with open(path, encoding="utf-8") as handle:
        current = handle.read()
if text == current:
    print("settings.json already listed both")
else:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    print("merged both names into settings.json")
PY
    ); then
      fail pi-packages "could not merge the package names into $PI_SETTINGS: $(tail_of "$SETTINGS_RESULT")"
    fi

    [ -n "$PI_CLI" ] || PI_CLI=$(pi_cli_path) || PI_CLI=""
    [ -n "$PI_CLI" ] || fail pi-packages "pi cli.js not found - the pi step must run (and succeed) before this one"
    for pkg in npm:pi-claude-bridge npm:@tintinweb/pi-subagents; do
      if ! out=$(node "$PI_CLI" install "$pkg" 2>&1); then
        fail pi-packages "pi install $pkg failed: $(tail_of "$out")"
      fi
    done
    for dir_name in pi-claude-bridge @tintinweb/pi-subagents; do
      [ -d "$PI_NPM_DIR/$dir_name" ] ||
        fail pi-packages "pi install reported success but $PI_NPM_DIR/$dir_name is not on disk"
    done
    ok pi-packages "$SETTINGS_RESULT; both installed under $PI_NPM_DIR"
  fi
fi

# ── 13. the Claude Code CLI ──────────────────────────────────────────────────
# Mirrors steps.py apply_claude_cli: on a server the wizard installs
# `@anthropic-ai/claude-code` itself. pi is the harness, but the
# pi-claude-bridge extension SHELLS OUT to this CLI - without it that lane is
# dead on arrival even though pi starts fine.
#
# Not required, exactly as steps.py marks it: a network hiccup here must not
# stop a deploy that is otherwise a working factory, so the failure is reported
# on an OK line that names the consequence instead of ending the run.

if [ "$USED_INSTALLER" = no ]; then
  if have claude; then
    ok claude-cli "already present: $(claude --version 2>&1 | head -n 1)"
  else
    if out=$(asroot npm install -g --no-fund --no-audit --loglevel=error @anthropic-ai/claude-code 2>&1); then
      if have claude; then
        ok claude-cli "installed $(claude --version 2>&1 | head -n 1)"
      else
        ok claude-cli "npm installed @anthropic-ai/claude-code but 'claude' is not on PATH - the pi-claude-bridge lane cannot run until it is"
      fi
    else
      ok claude-cli "NOT installed: npm install -g @anthropic-ai/claude-code failed ($(tail_of "$out")) - the pi-claude-bridge lane cannot run until it is"
    fi
  fi
fi

# ── 14. the Codex CLI ────────────────────────────────────────────────────────
# Mirrors steps.py apply_codex_cli, same package and same non-required
# treatment: `@openai/codex` is what the codex lane in the roster invokes.

if [ "$USED_INSTALLER" = no ]; then
  if have codex; then
    ok codex-cli "already present: $(codex --version 2>&1 | head -n 1)"
  else
    if out=$(asroot npm install -g --no-fund --no-audit --loglevel=error @openai/codex 2>&1); then
      if have codex; then
        ok codex-cli "installed $(codex --version 2>&1 | head -n 1)"
      else
        ok codex-cli "npm installed @openai/codex but 'codex' is not on PATH - the codex lane cannot run until it is"
      fi
    else
      ok codex-cli "NOT installed: npm install -g @openai/codex failed ($(tail_of "$out")) - the codex lane cannot run until it is"
    fi
  fi
fi

# ── 14a. Grok Build (the xAI CLI): installed by xAI's own installer ──────────
# The app's Providers pane puts the Grok row FIRST, "because it is first in the
# operator's morning" - and on a bare Ubuntu box that click used to end in exit
# 127, because nothing installed the CLI. An earlier revision of this step
# refused to guess an install URL; the guess is no longer needed. The command
# below is the one xAI publishes on the Grok Build page itself
# (grok.com, read by the operator 2026-08-18):
#
#     curl -fsSL https://x.ai/cli/install.sh | bash
#
# The product is called Grok Build; the binary it installs is still `grok`, a
# self-updating native binary that lands in `~/.grok/bin/grok` (`installer =
# "internal"` in its own config.toml). Same non-required treatment as steps 13
# and 14: a failed install is reported with its consequence, never a dead
# deploy - a box with no Grok Build is still a working factory for every other
# lane.
#
# NOT SKIPPED on the installer path: installer/steps.py does not install this
# CLI either, so the question is the same on both kinds of box.

grok_on_path_note="A non-login 'ssh <host> <command>' sources no .profile, so the app runs its logins with $HOME/.grok/bin, $HOME/.local/bin and /usr/local/bin prepended - that covers the app's own Grok row. Anything else you run over ssh needs $HOME/.grok/bin on PATH itself"
if have grok; then
  ok grok-cli "already present: $(command -v grok) ($(grok --version 2>&1 | head -n 1)) - the app's Grok row can run 'grok login --device-auth' here"
elif [ -x "$HOME/.grok/bin/grok" ]; then
  ok grok-cli "Grok Build is at $HOME/.grok/bin/grok but not on this box's PATH. $grok_on_path_note"
else
  if out=$(curl -fsSL https://x.ai/cli/install.sh | bash 2>&1); then
    if have grok; then
      ok grok-cli "installed Grok Build via x.ai/cli/install.sh ($(grok --version 2>&1 | head -n 1)) - the app's Grok row can run 'grok login --device-auth' here"
    elif [ -x "$HOME/.grok/bin/grok" ]; then
      ok grok-cli "installed Grok Build via x.ai/cli/install.sh into $HOME/.grok/bin. $grok_on_path_note"
    else
      ok grok-cli "NEEDS YOU: x.ai/cli/install.sh ran but left no grok binary at $HOME/.grok/bin or on PATH ($(tail_of "$out")) - install it on the box yourself, then click the Grok row again"
    fi
  else
    ok grok-cli "NOT installed: 'curl -fsSL https://x.ai/cli/install.sh | bash' failed ($(tail_of "$out")) - the app's Grok sign-in row exits 127 here until it is installed. Note also that the roster's xai lane runs through pi, whose own xai credential is filled by 'pi' -> '/login xai' on the box, not by Grok Build"
  fi
fi

# ── 14b. what this path does NOT converge, said out loud ─────────────────────
# The inline path implements pi, pi-packages, claude-cli, codex-cli,
# git-identity and engine-service. Against installer/steps.py's STEPS table it
# omits three the installer marks required - `ollama-scripts`, `ollama-cloud`
# (the provider block merged into ~/.pi/agent/models.json plus the proven
# apiKey command) and `skylos` - plus the `auth` pass. It omits them because
# they are files: steps.py copies them out of installer/assets/, and a stamped
# project has no installer/ to copy from.
#
# The omission is a scoping choice. Reporting nothing about it was the defect.
# The installer path HAS a needs-operator channel - exit 2 becomes "converged,
# but something needs you: <marker>", which is how the operator learns a
# credential is missing - and the inline path had none: every step printed OK
# or killed the run, so a stamped-project deploy ended in DEPLOY COMPLETE and a
# finished green deploy in the UI on a box that could not make ONE model call.
# Steps 13 and 14 already show the right shape; this is the same, for the gap
# that actually stops cards.

if [ "$USED_INSTALLER" = no ]; then
  SDL_MODELS_PATH="$HOME/.pi/agent/models.json"
  export SDL_MODELS_PATH
  PROVIDERS=$(python3 - <<'PY' 2>/dev/null
import json, os

try:
    with open(os.environ["SDL_MODELS_PATH"], encoding="utf-8") as handle:
        loaded = json.load(handle)
except (OSError, ValueError):
    loaded = {}
providers = loaded.get("providers") if isinstance(loaded, dict) else None
named = []
if isinstance(providers, dict):
    for name, block in sorted(providers.items()):
        models = block.get("models") if isinstance(block, dict) else None
        count = len(models) if isinstance(models, (list, dict)) else 0
        if count:
            named.append("%s(%d models)" % (name, count))
print(" ".join(named))
PY
  ) || PROVIDERS=""

  if [ -z "$PROVIDERS" ]; then
    ok providers "NEEDS YOU: no provider with models is registered in $SDL_MODELS_PATH, so pi cannot make a single model call and every card this box picks up dies at its first agent turn. This path cannot converge it - installer/steps.py does it from installer/assets/, which a stamped project does not carry. Register the provider your roster names (adws/adw_sssf_config/sssf.config.yaml, defaults.model) in that file and place its key on this box. skylos is not installed by this path either, so the AI-defect scan reads 'incomplete', never a pass"
  else
    ok providers "$SDL_MODELS_PATH registers $PROVIDERS - confirm they cover the roster's defaults.model in adws/adw_sssf_config/sssf.config.yaml. skylos is not installed by this path, so the AI-defect scan reads 'incomplete', never a pass"
  fi
fi

# ── 15. the engine's committer identity ──────────────────────────────────────
# Mirrors steps.py ensure_engine_git_identity, including its two safety rules:
#   * `git var GIT_COMMITTER_IDENT` decides - that is git's OWN resolution of
#     the question (config, environment and auto-detection folded in), so a
#     host that already knows who it is is left completely alone.
#   * the write is `git config --local`, INSIDE the checkout: it changes this
#     repo and nothing else on the machine.
# Every record the engine keeps is a commit. On a fresh VPS with no ~/.gitconfig
# git dies with "unable to auto-detect email address", the engine logs "commit
# failed, will retry next cycle" once a minute forever, and `systemctl
# is-active` reports `active` the whole time.

ENGINE_GIT_NAME="sdl-factory engine"
ENGINE_GIT_EMAIL="engine@sdl-factory.local"

if [ "$USED_INSTALLER" = no ]; then
  IDENT=$(git -C "$DIR" var GIT_COMMITTER_IDENT 2>/dev/null) || IDENT=""
  if [ -n "$IDENT" ]; then
    ok git-identity "this host already names a committer: $IDENT"
  else
    if git -C "$DIR" config --local user.name "$ENGINE_GIT_NAME" 2>/dev/null &&
       git -C "$DIR" config --local user.email "$ENGINE_GIT_EMAIL" 2>/dev/null; then
      ok git-identity "set repo-local identity $ENGINE_GIT_NAME <$ENGINE_GIT_EMAIL> - this host could not auto-detect one and the engine commits every card write-back"
    else
      ok git-identity "NEEDS YOU: could not set git user.name/user.email in $DIR - the engine will refuse to run cycles until it is set by hand"
    fi
  fi
fi

# ── 16. strip planning skills ────────────────────────────────────────────────
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

# ── 17. the sdl-engine systemd unit ──────────────────────────────────────────
# Mirrors steps.py render_engine_unit/apply_engine_service byte for byte
# (specs/engine.md section 7), including why each line is there:
#   * ExecStart uses the ABSOLUTE uv path - a unit gets no login shell, so a
#     bare `uv` fails every time systemd itself starts the service.
#   * User= is the OWNER OF THE CHECKOUT, not whoever ran the deploy. Without
#     it systemd runs the engine as root and every git call dies with "detected
#     dubious ownership in repository at ...", while is-active says `active`.
#   * Environment=SSSF_CONFIG names the roster out loud. Without it the
#     always-on server ships every card on whatever engine.py defaults to.
# Last on purpose: the whole factory is converged by the time a live service
# starts pulling, dispatching and pushing against it.

if [ "$USED_INSTALLER" = no ]; then
  have systemctl ||
    fail engine-service "no systemctl on this box - the sdl-engine service cannot be installed (a container without systemd runs the engine in the foreground instead)"

  UV_BIN=$(command -v uv 2>/dev/null) || UV_BIN=""
  [ -n "$UV_BIN" ] || fail engine-service "uv is not on PATH - the uv step must run (and succeed) before this one"

  # SERVICE_USER - the checkout's owner - was resolved in step 10b, which also
  # refused the case where it is not the user this deploy runs as.

  # THE SAME TWO ANSWERS installer/steps.py gives, and no third. steps.py:
  # `engine_config = os.environ.get("SSSF_CONFIG") or DEFAULT_ENGINE_CONFIG`,
  # full stop. A "when the checkout carries a shipping roster, ship on it"
  # preference lived here and was drift, both ways:
  #   * it never fired where it was meant to. The only repo carrying a shipping
  #     roster is sdl-factory, which is also the only repo carrying installer/ -
  #     so it always takes the installer path above, and the always-on service
  #     was pinned to the file whose own first lines read "TEST LANE ONLY".
  #   * it fired where it must not. sssf.shipping.config.yaml's header states it
  #     is NOT the running default and must be selected per run via SSSF_CONFIG;
  #     this promoted it to the permanent default of an always-on service on any
  #     checkout that merely carried the file.
  # And `detect_engine_service` compares its own rendering byte for byte, so the
  # installer parks any unit this script writes on a different roster.
  # "The server ships" is a deliberate choice, made the one supported way:
  # SSSF_CONFIG=<path> on the deploy, which BOTH writers then honour.
  ENGINE_CONFIG="${SSSF_CONFIG:-adws/adw_sssf_config/sssf.config.yaml}"
  [ -f "$DIR/$ENGINE_CONFIG" ] ||
    fail engine-service "$DIR/$ENGINE_CONFIG does not exist - the engine has no roster to ship on; re-run Initialize factory on the laptop, push, and redeploy"

  # Warm the per-script PEP 723 environment BEFORE systemd starts the service.
  # A cold `uv run` resolving pydantic/pyyaml/rich inside a unit with
  # Restart=always turns a dependency failure into a silent crash loop that
  # `systemctl is-active` is happy to call `activating`; here it is one honest
  # failure line naming the reason.
  warm_engine() {
    if have timeout; then
      (cd "$DIR" && timeout 600 uv run adws/engine.py --help 2>&1)
    else
      (cd "$DIR" && uv run adws/engine.py --help 2>&1)
    fi
  }
  if ! ENGINE_WARM=$(warm_engine); then
    fail engine-service "uv run adws/engine.py --help failed, so the service would crash-loop instead of shipping: $(tail_of "$ENGINE_WARM")"
  fi

  # The one place the unit path is named, overridable ONLY so this script can
  # be rehearsed end to end off a systemd host - the same seam and the same
  # reason as steps.py's `Ctx.engine_unit_path` ("this wizard runs its unit
  # tests on a Windows laptop, where that path is not even valid"). Nothing
  # sets it on a real deploy: machines.ts runs `sh bootstrap.sh` over a bare
  # ssh exec with no environment of its own.
  UNIT_PATH="${SDL_ENGINE_UNIT_PATH:-/etc/systemd/system/sdl-engine.service}"
  UNIT_TMP=$(mktemp 2>/dev/null) || UNIT_TMP="/tmp/sdl-engine.service.$$"
  cat >"$UNIT_TMP" <<UNIT
[Unit]
Description=SDL factory engine - runs the Kanban
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$DIR
Environment=SSSF_CONFIG=$ENGINE_CONFIG
ExecStart=$UV_BIN run adws/engine.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

  UNIT_STATE=unchanged
  if [ "$(cat "$UNIT_TMP")" != "$(cat "$UNIT_PATH" 2>/dev/null)" ]; then
    if ! out=$(asroot cp "$UNIT_TMP" "$UNIT_PATH" 2>&1); then
      fail engine-service "could not write $UNIT_PATH: $(tail_of "$out")"
    fi
    asroot chmod 0644 "$UNIT_PATH" >/dev/null 2>&1
    UNIT_STATE=written
  fi
  rm -f "$UNIT_TMP"

  if ! out=$(asroot systemctl daemon-reload 2>&1); then
    fail engine-service "systemctl daemon-reload failed: $(tail_of "$out")"
  fi
  if ! out=$(asroot systemctl enable --now sdl-engine 2>&1); then
    fail engine-service "systemctl enable --now sdl-engine failed: $(tail_of "$out")"
  fi

  # A CHANGED UNIT HAS TO TAKE EFFECT. `daemon-reload` re-reads unit FILES and
  # `start` on an already-active unit is a satisfied job - a no-op - so on the
  # second run, when the rendering changed, this step used to report the new
  # ExecStart/User/SSSF_CONFIG while the live process still ran the old one, and
  # Restart=always kept that stale process healthy indefinitely. The step
  # converged the file, not the service.
  # `try-restart`, not `restart`: a unit that is not running is left alone
  # rather than double-started right after `enable --now` did it.
  RESTART_NOTE=""
  if [ "$UNIT_STATE" = written ]; then
    if out=$(asroot systemctl try-restart sdl-engine 2>&1); then
      RESTART_NOTE=", try-restart'd so the running process is the unit just written"
    else
      RESTART_NOTE=", but systemctl try-restart failed ($(tail_of "$out")) - the RUNNING process may still be the previous unit"
    fi
  fi
  ok engine-service "$UNIT_PATH $UNIT_STATE (User=$SERVICE_USER, WorkingDirectory=$DIR, SSSF_CONFIG=$ENGINE_CONFIG, ExecStart=$UV_BIN run adws/engine.py), daemon-reload'd, enabled --now$RESTART_NOTE"
fi

# ── 18. the engine is actually running ───────────────────────────────────────
# The one check that answers "is this box a factory now?" - and it is asked
# after a short settle, because a unit that dies two seconds in still reads
# `active` the instant systemd forks it.

if ! have systemctl; then
  fail engine "no systemctl on this box - the sdl-engine service cannot be checked (a container without systemd needs --target container instead)"
fi

sleep 3
ENGINE_STATE=$(systemctl is-active sdl-engine 2>&1)
if [ "$ENGINE_STATE" = "active" ]; then
  ENGINE_SINCE=$(systemctl show sdl-engine --property=ActiveEnterTimestamp --value 2>/dev/null)
  ok engine "sdl-engine is active since ${ENGINE_SINCE:-unknown}"
else
  fail engine "sdl-engine is '$ENGINE_STATE' - $(tail_of "$(systemctl status sdl-engine --no-pager --lines=5 2>&1)")"
fi

echo "DEPLOY COMPLETE"
