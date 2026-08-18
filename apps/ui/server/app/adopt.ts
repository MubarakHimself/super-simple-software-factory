/**
 * ADOPTION — making a pre-existing project deployable, from the app, without the
 * operator running one git command.
 *
 * ── The refusal this replaces ───────────────────────────────────────────────
 * Deploying the factory onto a project that already exists used to end in a 409
 * that read: *"origin has no 'integration' branch ... 1) git add -A && git
 * commit  2) git push -u origin main  3) git switch -c integration  4) git push
 * -u origin integration - then deploy again."* Four commands, in a terminal, for
 * an operator whose whole premise is that he never opens one. The deploy was
 * technically correct and practically useless: the only component that ever
 * creates `integration` is the engine, and the deploy refuses to install the
 * engine until the branch exists.
 *
 * So the app breaks the loop itself. This module is the laptop-side phase of a
 * deploy: it looks at the checkout the operator actually has, decides where
 * `integration` should be cut from, cuts it, and pushes it - then the SSH
 * provisioning runs exactly as before against a remote that now has the branch.
 *
 * ── Lossless is law ─────────────────────────────────────────────────────────
 * Real projects arrive in every state: only `main`; no branches at all (zero
 * commits); the newest work sitting on `codex/some-feature` that another tool
 * touched months ago while `main` went stale; a dirty working tree. Every one of
 * those must survive byte-for-byte. Therefore, in this module:
 *
 *   * NEVER `checkout` or `switch`. `git branch <name> <tip>` creates a branch
 *     without touching the index or the working tree, so whatever the operator
 *     had open stays exactly as it was and HEAD keeps pointing where it pointed.
 *   * NEVER `--force`, `--force-with-lease`, `reset`, `rebase`, or a branch
 *     deletion. Nothing here rewrites or discards a commit anyone made.
 *   * Uncommitted work is COMMITTED, never stashed and never cleaned - a stash
 *     is a hiding place the operator would have to know about, and this app's
 *     premise is that he does not have to know about any of it.
 *   * The branch NAME is never handed to git in a position git could read as an
 *     option. `branch` arrives from an HTTP body; a caller who sent `"-f"` would
 *     otherwise turn `git push -u origin <branch>` into `git push -u origin -f`
 *     - a force-push of the current branch, which is exactly the byte-loss the
 *     rules above exist to make impossible. So the name is validated on the way
 *     in (`branchNameProblem`) AND every git invocation puts `--` in front of
 *     it, because one guard that has to be remembered is not a guard.
 *
 * ── Why it runs inside the deploy job, not in the HTTP handler ──────────────
 * `Bun.serve`'s 10s idleTimeout is shorter than a `git fetch` plus a `git push`
 * over a slow link, so doing this inline in `postDeploy` would drop the response
 * mid-adoption. It also SHOULD be watched: the operator reads the deploy pane,
 * and a branch being created out of `codex/feature` is precisely the decision he
 * deserves to see. So every action prints one `STEP <name> OK|FAIL <detail>`
 * line into the same stream `bootstrap.sh` writes into, and the same parser
 * turns it into the same step row.
 *
 * A failure here fails the job before one byte is uploaded: the SSH phase has
 * not started yet, so there is no half-deploy to explain.
 */

/** The result of one git invocation. `code` 124 means it was killed on a
 * timeout - the same number `timeout(1)` uses, for readers who know it. */
interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * git, with no terminal.
 *
 * `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS` for the reason
 * `bootstrap.sh` exports them: a remote this laptop has no credentials for must
 * fail immediately with "could not read Username", never sit forever on a
 * credential prompt no one can see inside a background job.
 */
async function git(root: string, argv: string[], timeoutMs = 30_000): Promise<GitRun> {
  const proc = Bun.spawn(["git", ...argv], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
  });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (killed) {
    return { code: 124, stdout, stderr: `${stderr} (git ${argv[0]} gave up after ${Math.round(timeoutMs / 1000)}s)` };
  }
  return { code, stdout, stderr };
}

/** git's own words, flattened to the one ASCII line a STEP detail may be. The
 * last lines are kept because that is where git puts the reason; the head of a
 * `push` transcript is progress noise. */
function why(run: GitRun): string {
  const said = `${run.stderr}\n${run.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const tail = said.slice(-3).join(" / ");
  return (tail || `git exited ${run.code}`).slice(0, 400);
}

async function hasRef(root: string, ref: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "--verify", "--quiet", ref])).code === 0;
}

/** short sha + committer date (`abc1234`, `2026-06-14`) for a ref, or null when
 * the ref resolves to nothing. */
async function tipOf(root: string, ref: string): Promise<{ sha: string; date: string } | null> {
  const run = await git(root, ["log", "-1", "--date=short", "--format=%h|%cd", ref]);
  if (run.code !== 0) return null;
  const [sha, date] = run.stdout.trim().split("|");
  return sha ? { sha, date: date ?? "" } : null;
}

/**
 * `refs/heads/x` -> `x`, `refs/remotes/origin/codex/feature` ->
 * `origin/codex/feature`. What the operator would call the branch himself.
 */
function friendlyRef(refname: string): string {
  if (refname.startsWith("refs/heads/")) return refname.slice("refs/heads/".length);
  if (refname.startsWith("refs/remotes/")) return refname.slice("refs/remotes/".length);
  return refname;
}

/**
 * Is this a name git would accept as a branch, and this module would be safe
 * handing to git? Returns the reason it is not, or null when it is fine.
 *
 * WHY THIS EXISTS AT ALL: `branch` reaches here from the JSON body of
 * `POST /api/app/machines/:machine_id/deploy`. Sent as `"-f"` it would land in
 * an option slot - `git push -u origin -f` is a FORCE PUSH of the current branch
 * with no refspec, and `git branch -f <ref>` exits 0 rather than erroring, so
 * nothing downstream would notice before origin's history was overwritten. The
 * `--` in every invocation below already stops that; this check stops it a
 * second time and, unlike `--`, can say out loud why the name was refused.
 *
 * The rules are `git check-ref-format`'s, applied here rather than by spawning
 * it: a validator that needs a subprocess to answer would itself be passing an
 * untrusted string to a command line.
 */
export function branchNameProblem(branch: string): string | null {
  if (branch === "") return "a branch name cannot be empty";
  if (branch.length > 255) return "that branch name is too long";
  if (branch.startsWith("-")) return `'${branch}' cannot be a branch name - git would read a leading '-' as an option`;
  // Control characters, DEL and space, plus the characters git reserves for its
  // own ref syntax (`~` `^` `:` `?` `*` `[` `\`).
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(branch)) {
    return `'${branch}' is not a valid branch name - git forbids a space and any of ~ ^ : ? * [ \\`;
  }
  if (branch.includes("..") || branch.includes("@{")) return `'${branch}' is not a valid branch name - '..' and '@{' are reserved`;
  if (branch === "@") return "'@' is not a valid branch name";
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) {
    return `'${branch}' is not a valid branch name - a '/' may not start, end or double up`;
  }
  if (branch.endsWith(".") || branch.endsWith(".lock")) return `'${branch}' is not a valid branch name`;
  for (const part of branch.split("/")) {
    if (part.startsWith(".") || part.endsWith(".lock")) return `'${branch}' is not a valid branch name`;
  }
  return null;
}

/**
 * The branch HEAD is on, or null when HEAD is detached. `symbolic-ref` rather
 * than `rev-parse --abbrev-ref`, because it still answers `main` in a repo with
 * ZERO commits - which is exactly the repo this module has to handle.
 */
async function currentBranch(root: string): Promise<string | null> {
  const run = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (run.code !== 0) return null;
  return run.stdout.trim() || null;
}

/**
 * The `-c` arguments the stamp commit needs, and only the ones it needs.
 *
 * A laptop with no `user.email` configured anywhere cannot commit at all ("please
 * tell me who you are"), and a deploy that died there would be the old refusal
 * wearing a new hat. So a commit made with no identity configured borrows one -
 * for THAT COMMIT ONLY, via `git -c`, which writes nothing to any config file.
 *
 * The operator's own identity always wins when he has one, and the two halves are
 * judged SEPARATELY: a laptop with `user.name` set and no `user.email` is a real
 * state, and borrowing the whole synthetic identity there would sign his commit
 * with a name that is not his when only the address was missing.
 */
async function identityArgs(root: string): Promise<string[]> {
  const name = await git(root, ["config", "--get", "user.name"]);
  const email = await git(root, ["config", "--get", "user.email"]);
  const args: string[] = [];
  if (!(name.code === 0 && name.stdout.trim() !== "")) args.push("-c", "user.name=SDL Factory");
  if (!(email.code === 0 && email.stdout.trim() !== "")) args.push("-c", "user.email=factory@sdl.local");
  return args;
}

/**
 * Every local head and every `origin/*` remote-tracking ref, newest committer
 * date first. `origin/HEAD` is dropped: it is a symbolic alias for another entry
 * in this very list, and cutting `integration` from an alias would print a
 * decision the operator cannot act on.
 */
async function newestTip(root: string): Promise<{ refname: string; date: string } | null> {
  const run = await git(root, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname) %(committerdate:short)",
    "refs/heads",
    "refs/remotes/origin",
  ]);
  if (run.code !== 0) return null;
  for (const line of run.stdout.split(/\r?\n/)) {
    const [refname, date] = line.trim().split(" ");
    if (!refname) continue;
    if (refname === "refs/remotes/origin/HEAD") continue;
    return { refname, date: date ?? "" };
  }
  return null;
}

/**
 * Does the project's own origin carry `branch`, asked from the laptop?
 *
 * THREE ANSWERS, not two. `true`/`false` are only returned when git actually
 * answered; `null` means the question could not be asked (offline, a private
 * remote with no credentials on this laptop, no git). `null` is never read as
 * "not there" - a guess in that direction would have this module create a branch
 * that already exists on the hub and then be rejected on the push.
 *
 * `GIT_TERMINAL_PROMPT=0` for the reason above: an unauthenticated remote must
 * fail immediately, never sit on a credential prompt.
 */
export async function remoteHasBranch(root: string, branch: string): Promise<boolean | null> {
  if (branchNameProblem(branch)) return null; // a name git would refuse cannot be on any remote
  try {
    const run = await git(root, ["ls-remote", "--heads", "origin", "--", branch], 15_000);
    if (run.code !== 0) return null; // could not ask - not the same as "not there"
    return run.stdout.split("\n").some((line) => line.trim().endsWith(`refs/heads/${branch}`));
  } catch {
    return null;
  }
}

export type AdoptAction =
  /** origin already had the branch: this module did nothing at all */
  | "already-on-remote"
  /** the branch existed here but had never been pushed: pushed, tip untouched */
  | "pushed-local-branch"
  /** the branch was cut from the newest work and pushed */
  | "created-from-tip"
  /** the operator pressed Cancel and this stopped BEFORE touching origin */
  | "cancelled"
  | "failed";

export interface AdoptOutcome {
  ok: boolean;
  action: AdoptAction;
  /** the ref `integration` was cut from, in the operator's words (`codex/feature`) */
  base: string | null;
  /** the stamp commit this adoption made on the operator's own branch, if any */
  stamped: string | null;
  error: string | null;
  /** did a `push` to origin actually complete? The one fact a cancel, a
   * failure or a retry all have to be honest about. */
  pushed: boolean;
}

/**
 * Give `root`'s origin a `branch` to deploy from, losslessly, saying out loud
 * what it decided. Called by the deploy job before it opens an SSH connection.
 *
 * THE DECISION TABLE, in order - the first row that matches wins:
 *
 *   1. origin already has `branch`            -> nothing to adopt
 *   2. `branch` exists here but not on origin -> `push -u`, never recreated
 *   3. the working tree is dirty              -> commit it where HEAD already
 *                                                is, then cut from HEAD
 *   4. otherwise                              -> cut from the newest committer
 *                                                date across local heads and
 *                                                `origin/*` (stale `main` plus a
 *                                                newer `codex/feature` means
 *                                                `codex/feature` wins)
 *   5. no commits and nothing to commit       -> honest failure
 *
 * `emit` receives finished STEP lines; it is the deploy job's own `append`, so
 * the operator watches this happen in the same pane as everything else.
 *
 * `stopped` is asked between steps and returns the operator's cancel reason once
 * he has pressed Cancel. A git subprocess already in flight cannot be taken
 * back - but the checks are placed so that a cancel arriving during the long
 * `fetch` stops this BEFORE any push, which is the only moment at which the
 * promise "nothing on origin was touched" is still true and worth making. Once
 * a push has completed, `pushed` says so and the caller must not pretend
 * otherwise.
 */
export async function adoptIntegrationBranch(
  root: string,
  branch: string,
  emit: (line: string) => void,
  stopped?: () => string | null,
): Promise<AdoptOutcome> {
  let stamped: string | null = null;
  let pushed = false;
  const fail = (step: string, reason: string): AdoptOutcome => {
    emit(`STEP ${step} FAIL ${reason}`);
    return { ok: false, action: "failed", base: null, stamped, error: reason, pushed };
  };
  /** the operator pressed Cancel: stop here, before the next thing that would
   * reach the network, and say exactly how far this got. */
  const halt = (step: string): AdoptOutcome | null => {
    const reason = stopped?.() ?? null;
    if (!reason) return null;
    emit(`STEP ${step} FAIL ${reason} - stopped before '${branch}' was pushed, origin was not touched`);
    return { ok: false, action: "cancelled", base: null, stamped, error: reason, pushed };
  };

  // The name is checked before git ever sees it. A caller-supplied `-f` would
  // otherwise be read by git as an OPTION rather than a branch: see
  // `branchNameProblem`. Every invocation below also puts `--` in front of it.
  const badName = branchNameProblem(branch);
  if (badName) return fail("adopt", badName);

  const repo = await git(root, ["rev-parse", "--git-dir"]);
  if (repo.code !== 0) return fail("adopt", `${root} is not a git repository: ${why(repo)}`);

  // ── 1. see what origin really has now ─────────────────────────────────────
  // A fetch that fails is NOT fatal: the operator may be on a train, and the
  // push at the end is the honest test of the network anyway. But it is said
  // out loud, because every decision below is then made on older knowledge.
  const fetched = await git(root, ["fetch", "--prune", "origin"], 180_000);
  if (fetched.code === 0) {
    emit(`STEP adopt-fetch OK read origin's branches`);
  } else {
    emit(
      `STEP adopt-fetch OK could not reach origin (${why(fetched)}) - going on with what this checkout already knows; ` +
        `the push at the end is the real test of the network`,
    );
  }

  // The fetch is the long one (up to 180s), so it is the step a cancel most
  // often lands in the middle of. Asking here means the commit, the branch and
  // the push below never start at all - the checkout is exactly as he left it.
  const stopAfterFetch = halt("adopt");
  if (stopAfterFetch) return stopAfterFetch;

  // Post-fetch, the remote-tracking ref IS the answer and costs nothing. When
  // the fetch failed, ask the remote directly (a different code path, which can
  // still succeed), and only then fall back to what may be stale local memory.
  let remoteHas = await hasRef(root, `refs/remotes/origin/${branch}`);
  if (!remoteHas && fetched.code !== 0) remoteHas = (await remoteHasBranch(root, branch)) === true;

  if (remoteHas) {
    const tip = await tipOf(root, `refs/remotes/origin/${branch}`);
    emit(
      `STEP adopt OK origin already has '${branch}'${tip ? ` (${tip.sha}, ${tip.date})` : ""} - nothing to adopt`,
    );
    return { ok: true, action: "already-on-remote", base: null, stamped: null, error: null, pushed: false };
  }

  // ── 2. the branch exists here and has simply never been pushed ────────────
  // Push it as it stands. Recreating it from anywhere else would move a branch
  // the operator (or an earlier engine run) built, which is not this module's
  // business.
  if (await hasRef(root, `refs/heads/${branch}`)) {
    // The last moment at which stopping still means origin is untouched.
    const stop = halt("adopt-push");
    if (stop) return stop;
    const tip = await tipOf(root, `refs/heads/${branch}`);
    // `--` and not a bare `branch`: in the 4th argv slot a name like `-f` is
    // read by git as `--force` and the push becomes a force-push of the CURRENT
    // branch with no refspec at all.
    const push = await git(root, ["push", "-u", "origin", "--", branch], 180_000);
    if (push.code !== 0) {
      return fail(
        "adopt-push",
        `'${branch}' already exists in this checkout${tip ? ` at ${tip.sha}` : ""} but origin refused the push: ${why(push)}`,
      );
    }
    pushed = true;
    emit(
      `STEP adopt-push OK pushed this checkout's existing '${branch}'${tip ? ` (${tip.sha})` : ""} to origin - its tip was not moved`,
    );
    return { ok: true, action: "pushed-local-branch", base: branch, stamped: null, error: null, pushed };
  }

  // ── 3. dirty working tree: commit it before anything is cut from it ───────
  // `--porcelain` lists tracked changes AND untracked non-ignored files, which
  // is the whole definition of "work that would otherwise not reach the server".
  const status = await git(root, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.code !== 0) return fail("adopt", `could not read the working tree state: ${why(status)}`);
  const pending = status.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");

  let baseRef: string;
  let baseLabel: string;
  /** the parenthetical that tells the operator WHY this ref was the one chosen */
  let baseNote: string;

  if (pending.length > 0) {
    const head = await currentBranch(root);
    const added = await git(root, ["add", "-A"]);
    if (added.code !== 0) return fail("adopt-commit", `could not stage your changes (git add -A): ${why(added)}`);
    const commit = await git(root, [...(await identityArgs(root)), "commit", "-m", "stamp the factory"]);
    if (commit.code !== 0) {
      // Everything present is ignored by .gitignore, so `add -A` staged nothing.
      // In a repo with commits that is harmless (fall through to the newest tip);
      // in a repo with none there is genuinely nothing to deploy.
      if (!(await hasRef(root, "HEAD"))) {
        return fail(
          "adopt-commit",
          `nothing to adopt - ${root} has no commits and nothing git can track (everything in it is ignored): ${why(commit)}`,
        );
      }
      return fail("adopt-commit", `could not commit your changes: ${why(commit)}`);
    }
    const tip = await tipOf(root, "HEAD");
    stamped = tip?.sha ?? null;
    baseRef = "HEAD";
    baseLabel = head ?? `the detached HEAD (${tip?.sha ?? "HEAD"})`;
    baseNote = `the work just committed, ${tip?.date || "today"}`;
    emit(
      `STEP adopt-commit OK committed ${pending.length} pending change(s) on ${baseLabel} as ${tip?.sha ?? "a new commit"} ` +
        `- your working tree keeps every file, nothing was stashed or discarded`,
    );
  } else {
    // ── 4. clean tree: the newest work wins, wherever it lives ──────────────
    const newest = await newestTip(root);
    if (!newest) {
      // No refs and nothing staged - but "no files" and "files git refuses to
      // see" are two different rooms to be stuck in, and only one of them is
      // fixed by writing some code. `--ignored` is the only way to tell them
      // apart: plain `--porcelain` omits ignored paths entirely, so a project
      // whose whole tree is inside `node_modules/` looks empty here.
      const ignored = await git(root, ["status", "--porcelain", "--ignored", "--untracked-files=normal"]);
      const ignoredOnly =
        ignored.code === 0 && ignored.stdout.split(/\r?\n/).some((line) => line.startsWith("!!"));
      return fail(
        "adopt",
        ignoredOnly
          ? `nothing to adopt - ${root} has no commits, and git is ignoring every file in it (check .gitignore), ` +
              `so there is nothing for the server to clone`
          : `nothing to adopt - ${root} has no commits and no files to commit, so there is no code for the server to run`,
      );
    }
    baseRef = newest.refname;
    baseLabel = friendlyRef(newest.refname);
    baseNote = `newest work, ${newest.date || "date unknown"}`;
  }

  // ── 5. cut the branch WITHOUT touching the working tree ───────────────────
  // `git branch` and not `switch -c`: HEAD stays where it is, the index stays
  // where it is, and the operator's open files are byte-identical afterwards.
  // `--` in front of both positionals: `git branch -f <ref>` does NOT error - it
  // exits 0 having force-created a nested ref - so a name in an option slot here
  // would sail past this check and reach the push below.
  const created = await git(root, ["branch", "--", branch, baseRef]);
  if (created.code !== 0) return fail("adopt-branch", `could not create '${branch}' from ${baseLabel}: ${why(created)}`);
  const cut = await tipOf(root, `refs/heads/${branch}`);
  emit(
    `STEP adopt-branch OK ${branch} created from ${baseLabel} (${baseNote})` +
      `${cut ? ` at ${cut.sha}` : ""} - nothing was checked out, this checkout still sits where it did`,
  );

  // The last moment at which stopping still means origin is untouched: the
  // branch above is local, the push below is not.
  const stop = halt("adopt-push");
  if (stop) return stop;
  const push = await git(root, ["push", "-u", "origin", "--", branch], 180_000);
  if (push.code !== 0) {
    return fail(
      "adopt-push",
      `'${branch}' was created here from ${baseLabel} but origin refused the push: ${why(push)} ` +
        `- nothing was lost, the branch is in this checkout`,
    );
  }
  pushed = true;
  emit(`STEP adopt-push OK pushed ${branch} to origin - the server has something to clone`);

  return { ok: true, action: "created-from-tip", base: baseLabel, stamped, error: null, pushed };
}
