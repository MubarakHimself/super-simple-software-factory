/**
 * `POST /api/app/p/:id/sync` — the one real write behind the topbar's Sync
 * button (L6). The operator's own words on what that button should be:
 * "that button does a lot - providers, machines, kanban, docs... it's like a
 * status update." This route is the "status update" half — the repo — and it
 * is honest about being only that half: `board`/`docs` freshness is the
 * client re-reading its own mounted panels (see `lib/poll.ts`'s Sync bus),
 * and `machines`/`providers` freshness lives entirely in their own panes,
 * which this route does not touch.
 *
 * ── The one thing this route does ──────────────────────────────────────────
 * `git fetch` then `git merge --ff-only origin/<branch>` in the project's
 * checkout. **Never pushes, never forces, never rebases.** A dirty working
 * tree or a diverged history is reported as a first-class, named outcome —
 * never silently skipped and never forced through. This is the same policy
 * `merge.ts` (Gate's own write) already enforces for the ff-only merge; this
 * route borrows its shape (a local `git()` argv-array runner, git's own
 * stderr as the reason, a per-checkout in-flight lock) rather than adding a
 * second mutating method to `gitro.ts`, which documents itself as
 * allowlisted and read-only.
 *
 * ── Why not `git pull` ─────────────────────────────────────────────────────
 * `pull` folds a fetch and a merge (or rebase, depending on the operator's
 * own git config) into one command whose exact behaviour depends on config
 * this app does not control. `fetch` + an explicit `merge --ff-only
 * origin/<branch>` is the one behaviour this route promises, spelled out.
 */
import { isSafeRef } from "../gitro.ts";
import { appError, appJson, csrfGuard } from "./guard.ts";
import { getScope, param } from "./scoped.ts";

const SYNC_TIMEOUT_MS = 30_000;

export type RepoSyncStatus =
  | "pulled"
  | "up-to-date"
  | "dirty"
  | "diverged"
  | "detached"
  | "no-remote"
  | "not-a-repo"
  | "failed";

export interface RepoSyncResult {
  status: RepoSyncStatus;
  /** The one sentence the topbar popover prints verbatim. */
  detail: string;
  branch: string | null;
  before_sha: string | null;
  after_sha: string | null;
}

export interface SyncResponse {
  repo: RepoSyncResult;
  checked_at: string;
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** The one mutating git call this route makes, argv-array only — nothing
 * from a request is ever interpolated into a shell string (same policy as
 * `merge.ts`'s own `git()`). */
async function git(root: string, args: string[]): Promise<GitRun> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), SYNC_TIMEOUT_MS);
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

/** git's own words, trimmed to the lines that carry them — the operator
 * never reads a sentence this app invented over one git actually wrote.
 *
 * A refused `merge --ff-only` prints several `hint:` lines (how to `--no-ff`
 * or `rebase`) BEFORE the one line that says what actually happened
 * (`fatal: Not possible to fast-forward, aborting.`); the first four lines
 * of raw output would be nothing but hints. So `fatal:`/`error:` lines are
 * preferred when git printed any — the sentence this app surfaces is the one
 * git meant as the answer, not the ones it meant as friendly advice. */
function gitReason(result: GitRun, fallback: string): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const notable = lines.filter((line) => /^(fatal|error):/i.test(line));
  const chosen = notable.length > 0 ? notable : lines;
  return chosen.length > 0 ? chosen.slice(0, 4).join(" ") : fallback;
}

function result(
  status: RepoSyncStatus,
  detail: string,
  branch: string | null,
  before: string | null,
  after: string | null,
): Response {
  return appJson({
    repo: { status, detail, branch, before_sha: before, after_sha: after },
    checked_at: new Date().toISOString(),
  } satisfies SyncResponse);
}

/** One sync per checkout at a time — two clicks (or a click during the
 * engine's own pull cycle) must never interleave two `git` invocations in the
 * same working tree. */
const inFlight = new Set<string>();

export async function postSync(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);

  if (inFlight.has(scope.root)) {
    return appError("a sync is already running for this project", 409);
  }
  inFlight.add(scope.root);
  try {
    if (!(await scope.repo.isRepo())) {
      return result("not-a-repo", `${scope.root} is not a git repository`, null, null, null);
    }

    const branch = await scope.repo.currentBranch();
    const before = await scope.repo.revParse("HEAD");
    if (!branch) {
      return result("detached", "the checkout is on a detached HEAD — not pulled", null, before, before);
    }
    if (!isSafeRef(branch)) {
      return result("failed", `branch "${branch}" is not a name this app will pass to git`, branch, before, before);
    }

    const remote = await scope.repo.remoteUrl();
    if (!remote) {
      return result("no-remote", "no origin remote configured — nothing to pull from", branch, before, before);
    }

    // Never pull over uncommitted work — that is the operator's, not the
    // factory's, and this button does not touch it either way.
    const status = await git(scope.root, ["status", "--porcelain"]);
    if (status.code !== 0) {
      return appError(`could not read the working tree's status: ${gitReason(status, `git status exited ${status.code}`)}`, 500);
    }
    if (status.stdout.trim()) {
      return result("dirty", "uncommitted changes in the working tree — not pulled", branch, before, before);
    }

    const fetched = await git(scope.root, ["fetch", "--prune", "origin"]);
    if (fetched.code !== 0) {
      return result("failed", gitReason(fetched, `git fetch exited ${fetched.code}`), branch, before, before);
    }

    if (!(await scope.repo.refExists(`origin/${branch}`))) {
      return result("no-remote", `origin has no branch "${branch}" to pull from`, branch, before, before);
    }

    const merged = await git(scope.root, ["merge", "--ff-only", `origin/${branch}`]);
    const after = await scope.repo.revParse("HEAD");
    if (merged.code !== 0) {
      const reason = gitReason(merged, `git merge --ff-only exited ${merged.code}`);
      const diverged = /not possible to fast-forward|diverged/i.test(reason);
      return result(
        diverged ? "diverged" : "failed",
        diverged
          ? `local ${branch} and origin/${branch} have diverged — not pulled; this button never forces or rebases`
          : reason,
        branch,
        before,
        after,
      );
    }

    return result(
      before === after ? "up-to-date" : "pulled",
      before === after
        ? `already up to date with origin/${branch}`
        : `fast-forwarded ${(before ?? "").slice(0, 7)} → ${(after ?? "").slice(0, 7)}`,
      branch,
      before,
      after,
    );
  } finally {
    inFlight.delete(scope.root);
  }
}

/** Mounted from `routes.ts`, the app plane's one seam. POST only, behind the
 * same origin + `X-App-Token` guard every other write on this plane uses. */
export function syncRoutes(token: string, selfOrigins: ReadonlySet<string>) {
  return {
    "/api/app/p/:id/sync": {
      POST: csrfGuard(token, selfOrigins, postSync),
    },
  };
}
