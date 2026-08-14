/**
 * `POST /api/app/p/:id/gate/:adw_id/merge` - the one write Gate owns.
 *
 * The factory's contract (adws/dispatch.py's own docstring, `specs/dispatch.md`
 * 6, `specs/ui.md` 5.4): dispatch NEVER moves a card into `queue/done/` -
 * "that is the MERGE event, and Gate owns it". So merging here is two things
 * or nothing:
 *
 *   1. `git merge --ff-only <the run's branch>` in the MAIN checkout, and
 *   2. the run's `queue/NNN-slug.md` moved into `queue/done/`.
 *
 * Either one alone leaves the Board lying about the repo, so this handler
 * pre-checks every condition it can before touching anything, does the card
 * move first (a rename is the only step with a rollback that cannot itself
 * destroy work), then merges, and renames the card back if git refuses. A
 * `git reset --hard` rollback was deliberately not chosen: it would discard
 * unrelated uncommitted work in the operator's own checkout.
 *
 * **Never forces.** `--ff-only` is the whole policy: if `main` is not an
 * ancestor of the branch, the request is refused with that sentence and no
 * command runs. No `-X`, no `--no-ff`, no `--strategy`, no push, no `gh`.
 *
 * The mechanism is ported from T3 Code's source-control plane (studied in
 * `docs/research/t3code-codebase-study.md` section 9 and the clone's
 * `apps/server/src/vcs/GitVcsDriverCore.ts` +
 * `packages/client-runtime/src/state/gitActions.ts`), not its code:
 *
 *   - every precondition is answered BEFORE the command runs, and the answer
 *     is a sentence, not a boolean (T3's `getGitActionDisabledReason` /
 *     `pullCurrentBranch`, which fails with "Current branch has no upstream
 *     configured" rather than letting git say it);
 *   - one `executeGit` seam with argv arrays, a timeout, and a
 *     `fallbackErrorDetail` used only when git itself said nothing (T3's
 *     `executeGit` + `GitCommandError.detail`);
 *   - git's own stderr is the reason the operator reads, verbatim (T3's
 *     `failVcsActionState`: `error.message`, never a friendlier sentence);
 *   - a per-checkout lock so two clicks cannot both run (T3's per-thread
 *     `Semaphore(1)` around its mutating git actions).
 */
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { isSafeRef, isSafeSegment } from "../gitro.ts";
import { readQueue } from "../queue.ts";
import { appError, appJson, csrfGuard } from "./guard.ts";
import { getScope, param } from "./scoped.ts";

/** The branch every gate item is measured against (`gate.ts` uses the same
 * literal for its "already an ancestor of main" eligibility rule). */
const MAIN = "main";

const MERGE_TIMEOUT_MS = 30_000;

export interface MergeResult {
  merged: true;
  branch: string;
  /** `main`'s new short sha - the run's own tip, since this was a fast-forward. */
  main_sha: string;
  /** `queue/NNN-slug.md`, the path the card had. */
  card_from: string;
  /** `queue/done/NNN-slug.md`, where it now is. */
  card_to: string;
}

/** One merge per checkout at a time. Two clicks on the same card (or two
 * cards in the same repo) must never interleave a rename with a merge. */
const inFlight = new Set<string>();

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** The one seam that runs a WRITING git command. `gitro.ts` stays what its
 * header says it is - allowlisted, read-only - so the single mutating call in
 * the whole app plane lives here, in the file that owns the action, with argv
 * arrays only and nothing from a request interpolated into a shell string. */
async function git(root: string, args: string[]): Promise<GitRun> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // Keep git's messages parseable/quotable regardless of the operator's
    // locale (T3 does the same with LC_ALL=C for its "stable diagnostics").
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), MERGE_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** git's own words for what went wrong, trimmed to the lines that carry them.
 * `fallback` is used only when git said nothing at all - the operator never
 * reads a sentence this app invented over one git actually wrote. */
function gitReason(result: GitRun, fallback: string): string {
  const said = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return said.length > 0 ? said.slice(0, 4).join(" ") : fallback;
}

/** `queue/NNN-slug.md` -> `NNN-slug.md`, or null when the path is not the
 * flat `queue/<file>.md` shape `readQueue` produces (nothing from disk is
 * trusted to be a plain filename before it is joined onto a directory). */
function queueFileName(cardPath: string): string | null {
  const name = cardPath.startsWith("queue/") ? cardPath.slice("queue/".length) : null;
  if (!name || name.includes("/") || name.includes("\\")) return null;
  if (name === "." || name === ".." || !name.toLowerCase().endsWith(".md")) return null;
  return name;
}

/**
 * The handler. Every refusal is a 409 with the reason as its `error` string -
 * the UI prints it verbatim, so this file is the only place the words exist.
 */
export async function postMerge(req: Request): Promise<Response> {
  const id = param(req, "id");
  const adwId = param(req, "adw_id");
  if (!isSafeSegment(adwId)) return appError("invalid adw_id", 400);

  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!scope.db) return appError("no factory in this project - nothing to merge", 409);

  const session = scope.db.session(adwId);
  if (!session) return appError(`no run ${adwId}`, 404);
  if (session.status !== "success") {
    return appError(
      `run ${adwId} ended ${session.status ?? "unknown"}, not success - a failed run is trace work, not merge work`,
      409,
    );
  }

  // The branch is the repo's own answer, never the request's - `adw/<id>_*`
  // is the factory's `git_helper.run_branch_name` convention (specs/ui.md 5.4).
  const branches = await scope.repo.branchesMatching(`adw/${adwId}_*`);
  if (branches.length === 0) return appError(`no adw/${adwId}_* branch in this repository`, 409);
  if (branches.length > 1) {
    return appError(`${branches.length} branches match adw/${adwId}_* (${branches.join(", ")}) - resolve by hand`, 409);
  }
  const branch = branches[0]!;
  if (!isSafeRef(branch)) return appError(`branch ${branch} is not a name this app will pass to git`, 409);

  const current = await scope.repo.currentBranch();
  if (current === null) {
    return appError(`the checkout at ${scope.root} is on a detached HEAD - check out ${MAIN} first`, 409);
  }
  if (current !== MAIN) {
    return appError(`the checkout at ${scope.root} is on ${current}, not ${MAIN} - the merge runs in the main checkout`, 409);
  }

  const alreadyIn = await scope.repo.isAncestor(branch, MAIN);
  if (alreadyIn === null) return appError(`could not compare ${branch} with ${MAIN}`, 409);
  if (alreadyIn) return appError(`${branch} is already in ${MAIN}`, 409);

  // The whole policy, checked before anything moves: a fast-forward is
  // possible only when `main` is an ancestor of the branch. Anything else is
  // refused with that sentence - this button never forces and never merges a
  // second parent.
  const fastForwardable = await scope.repo.isAncestor(MAIN, branch);
  if (fastForwardable === null) return appError(`could not compare ${MAIN} with ${branch}`, 409);
  if (!fastForwardable) {
    return appError(
      `not fast-forwardable: ${MAIN} has commits ${branch} does not contain - rebase the branch or merge it by hand; this button never forces`,
      409,
    );
  }

  // The card. Its move into `queue/done/` IS the merge event, so a run with
  // no card cannot be merged from here - refused, rather than half-done.
  const queue = await readQueue(scope.queueDir);
  const card = queue.items.find((item) => item.adw_id === adwId);
  if (!card) {
    return appError(
      `no queue card carries Adw-Id: ${adwId} - moving that card into queue/done/ is the merge event, so this merge cannot be recorded here`,
      409,
    );
  }
  const fileName = queueFileName(card.path);
  if (!fileName) return appError(`${card.path} is not a queue/<file>.md path this app will move`, 409);

  const from = join(scope.queueDir, fileName);
  const doneDir = join(scope.queueDir, "done");
  const to = join(doneDir, fileName);
  if (!existsSync(from)) return appError(`${card.path} is gone from disk`, 409);
  if (existsSync(to)) return appError(`queue/done/${fileName} already exists - move it aside first`, 409);

  if (inFlight.has(scope.root)) return appError(`a merge is already running in ${scope.root}`, 409);
  inFlight.add(scope.root);
  try {
    try {
      await mkdir(doneDir, { recursive: true });
      await rename(from, to);
    } catch (error) {
      return appError(`could not move ${card.path} into queue/done/: ${(error as Error).message}`, 409);
    }

    const merged = await git(scope.root, ["merge", "--ff-only", branch]);
    if (merged.code !== 0) {
      // Nothing merged, so nothing may stay moved. The rename back is the
      // only rollback that cannot itself lose work.
      let rolledBack = true;
      try {
        await rename(to, from);
      } catch {
        rolledBack = false;
      }
      const reason = gitReason(merged, `git merge --ff-only ${branch} exited ${merged.code}`);
      return appError(
        rolledBack
          ? `merge refused: ${reason}`
          : `merge refused: ${reason} - and ${card.path} could not be moved back out of queue/done/, move it by hand`,
        409,
      );
    }

    const sha = await scope.repo.shortSha(MAIN);
    return appJson({
      merged: true,
      branch,
      main_sha: sha,
      card_from: card.path,
      card_to: `queue/done/${fileName}`,
    } satisfies MergeResult);
  } finally {
    inFlight.delete(scope.root);
  }
}

/** Mounted from `routes.ts`, the app plane's one seam. POST only, and behind
 * the same origin + `X-App-Token` guard every other write on this plane uses
 * (spec 1.2) - this is the only route in the app that changes the repo. */
export function mergeRoutes(token: string, selfOrigins: ReadonlySet<string>) {
  return {
    "/api/app/p/:id/gate/:adw_id/merge": {
      POST: csrfGuard(token, selfOrigins, postMerge),
    },
  };
}
