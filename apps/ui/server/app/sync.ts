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
 *
 * ── AUTO-SYNC: the same sync, kicked by a watching Board ────────────────────
 * The factory runs on a SERVER and pushes its card-status commits to GitHub;
 * the Board (`cards.ts`) truthfully reads the LAPTOP's own `queue/` folder.
 * With only the button above, that folder changes when — and only when — the
 * operator clicks, so a laptop left open watches a frozen Board.
 *
 * `maybeAutoSync()` closes that gap without adding a system: when a
 * poll-driven read arrives (the Board's `cards` poll, the Runs list's own),
 * and this project's last sync is older than `AUTO_SYNC_INTERVAL_MS`, it
 * kicks THIS FILE'S OWN sync in the background and returns immediately. No
 * timer, no scheduler, no daemon: nobody watching means nobody polling means
 * no sync, which is exactly the behaviour wanted.
 *
 * Everything the button refuses, the auto path refuses identically — it is
 * literally the same function. A dirty tree, a detached HEAD and a diverged
 * history are still named outcomes, carried back to the Board as the `sync`
 * field of the cards payload so it can print ONE muted line instead of
 * silently showing stale cards.
 */
import type { CardsSync } from "../../shared/types.ts";
import { isSafeRef } from "../gitro.ts";
import { appError, appJson, csrfGuard } from "./guard.ts";
import { getScope, param, type ProjectScope } from "./scoped.ts";

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

/** One `runSync` call's whole answer. `unreadable` is set only when this app
 * could not perform a read it needs (git's own `status` failing on a checkout
 * that IS a repo) — the route answers 500 for that, exactly as it did before
 * this function was extracted, rather than dressing a broken checkout up as a
 * sync outcome. */
export interface SyncRun {
  repo: RepoSyncResult;
  unreadable: string | null;
}

function outcome(
  status: RepoSyncStatus,
  detail: string,
  branch: string | null,
  before: string | null,
  after: string | null,
): SyncRun {
  return { repo: { status, detail, branch, before_sha: before, after_sha: after }, unreadable: null };
}

/** One sync per checkout at a time — two clicks (or a click during the
 * engine's own pull cycle, or an auto-sync a watching Board kicked) must never
 * interleave two `git` invocations in the same working tree. Held by the
 * caller, not by `runSync` itself, so the button's 409 and the auto path's
 * "one is already going, skip" read the same one set. */
const inFlight = new Set<string>();

/**
 * The sync itself, as a value rather than a Response — `postSync` wraps it for
 * the button and `maybeAutoSync` runs the very same function in the
 * background. The caller holds `inFlight`.
 */
async function runSync(scope: ProjectScope): Promise<SyncRun> {
  if (!(await scope.repo.isRepo())) {
    return outcome("not-a-repo", `${scope.root} is not a git repository`, null, null, null);
  }

  const branch = await scope.repo.currentBranch();
  const before = await scope.repo.revParse("HEAD");
  if (!branch) {
    return outcome("detached", "the checkout is on a detached HEAD — not pulled", null, before, before);
  }
  if (!isSafeRef(branch)) {
    return outcome("failed", `branch "${branch}" is not a name this app will pass to git`, branch, before, before);
  }

  const remote = await scope.repo.remoteUrl();
  if (!remote) {
    return outcome("no-remote", "no origin remote configured — nothing to pull from", branch, before, before);
  }

  // Never pull over uncommitted work — that is the operator's, not the
  // factory's, and this sync does not touch it either way.
  const status = await git(scope.root, ["status", "--porcelain"]);
  if (status.code !== 0) {
    return {
      repo: { status: "failed", detail: gitReason(status, `git status exited ${status.code}`), branch, before_sha: before, after_sha: before },
      unreadable: `could not read the working tree's status: ${gitReason(status, `git status exited ${status.code}`)}`,
    };
  }
  if (status.stdout.trim()) {
    return outcome("dirty", "uncommitted changes in the working tree — not pulled", branch, before, before);
  }

  const fetched = await git(scope.root, ["fetch", "--prune", "origin"]);
  if (fetched.code !== 0) {
    return outcome("failed", gitReason(fetched, `git fetch exited ${fetched.code}`), branch, before, before);
  }

  if (!(await scope.repo.refExists(`origin/${branch}`))) {
    return outcome("no-remote", `origin has no branch "${branch}" to pull from`, branch, before, before);
  }

  const merged = await git(scope.root, ["merge", "--ff-only", `origin/${branch}`]);
  const after = await scope.repo.revParse("HEAD");
  if (merged.code !== 0) {
    const reason = gitReason(merged, `git merge --ff-only exited ${merged.code}`);
    const diverged = /not possible to fast-forward|diverged/i.test(reason);
    return outcome(
      diverged ? "diverged" : "failed",
      diverged
        ? `local ${branch} and origin/${branch} have diverged — not pulled; this sync never forces or rebases`
        : reason,
      branch,
      before,
      after,
    );
  }

  return outcome(
    before === after ? "up-to-date" : "pulled",
    before === after
      ? `already up to date with origin/${branch}`
      : `fast-forwarded ${(before ?? "").slice(0, 7)} → ${(after ?? "").slice(0, 7)}`,
    branch,
    before,
    after,
  );
}

export async function postSync(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);

  if (inFlight.has(scope.root)) {
    return appError("a sync is already running for this project", 409);
  }
  inFlight.add(scope.root);
  try {
    const run = await runSync(scope);
    if (run.unreadable !== null) return appError(run.unreadable, 500);
    return appJson({ repo: run.repo, checked_at: new Date().toISOString() } satisfies SyncResponse);
  } finally {
    inFlight.delete(scope.root);
  }
}

/* ── auto-sync ─────────────────────────────────────────────────────────────
   The Board polls; the checkout follows. See this file's header for why this
   lives here and not in a scheduler. */

/**
 * How stale a project's last sync may get before a poll-driven read kicks a
 * new one.
 *
 * A CONSTANT, deliberately — not a setting. One minute is slower than the
 * Board's own 2s poll by design: a `git fetch` costs a network round trip and
 * a process, and the operator is watching a factory whose runs take minutes,
 * not a chat window. Nobody has ever asked for a knob here, and a knob would
 * be one more thing to explain, get wrong, and support.
 */
const AUTO_SYNC_INTERVAL_MS = 60_000;

interface AutoSyncEntry {
  /** epoch ms the last auto-sync was KICKED (not when it finished) — so a
   * long fetch does not earn itself an immediate second one, and a finished
   * one is retried a full interval after it started. */
  startedAt: number;
  /** the last outcome this process recorded, or null before the first one
   * lands. This is what a read hands back. */
  last: CardsSync | null;
}

const autoSyncState = new Map<string, AutoSyncEntry>();

/** What actually runs in the background. Production is always `runSync`; the
 * one seam exists because "the read returned while the sync was still going"
 * cannot otherwise be observed without a real network that hangs. Only
 * `sync.test.ts` ever calls the setter, and the BUTTON never goes through it. */
type SyncRunner = (scope: ProjectScope) => Promise<SyncRun>;
let autoSyncRunner: SyncRunner = runSync;

export function setAutoSyncRunner(runner: SyncRunner | null): void {
  autoSyncRunner = runner ?? runSync;
}

function record(root: string, repo: RepoSyncResult): void {
  const entry = autoSyncState.get(root);
  autoSyncState.set(root, {
    startedAt: entry?.startedAt ?? Date.now(),
    last: { state: repo.status, detail: repo.detail, at: new Date().toISOString() },
  });
}

function failure(detail: string): RepoSyncResult {
  return { status: "failed", detail, branch: null, before_sha: null, after_sha: null };
}

/**
 * Called by every poll-driven read that means "somebody is watching this
 * project" (`cards.ts`'s Board read, `live.ts`'s Runs list).
 *
 * SYNCHRONOUS on purpose: there is no `await` here for a caller to block on,
 * so a read can never wait for a `git fetch` no matter what the network does.
 * It returns the LAST recorded outcome (null before the first one) and, when
 * this project's last sync is older than `AUTO_SYNC_INTERVAL_MS`, kicks the
 * next one into the background. The read answers from disk as it always did;
 * whatever the sync lands is picked up by the next poll.
 */
export function maybeAutoSync(scope: ProjectScope): CardsSync | null {
  const entry = autoSyncState.get(scope.root);
  const last = entry?.last ?? null;

  const stale = entry === undefined || Date.now() - entry.startedAt >= AUTO_SYNC_INTERVAL_MS;
  // `inFlight` is this file's own per-checkout lock, shared with the button:
  // a burst of concurrent polls kicks exactly one sync, and an auto-sync never
  // interleaves git calls with a click.
  if (!stale || inFlight.has(scope.root)) return last;

  autoSyncState.set(scope.root, { startedAt: Date.now(), last });
  inFlight.add(scope.root);
  void (async () => {
    try {
      const run = await autoSyncRunner(scope);
      record(scope.root, run.unreadable !== null ? failure(run.unreadable) : run.repo);
    } catch (error) {
      record(scope.root, failure(`auto-sync could not run: ${(error as Error).message}`));
    } finally {
      inFlight.delete(scope.root);
    }
  })();

  return last;
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
