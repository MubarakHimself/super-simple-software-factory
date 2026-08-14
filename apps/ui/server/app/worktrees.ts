/**
 * `/api/app/p/:id/worktrees` (spec 4, chunk K2a; spec 1.3's table row, spec
 * 2.5's Worktrees strip). A straight TypeScript port of
 * `adws/adw_modules/worktrees.py`'s reconciliation half (`classify()`,
 * `_build_row`, `inventory`) and the git plumbing it leans on
 * (`git_helper.py`'s `worktree_list`, `list_run_branches`, `is_dirty`,
 * `untracked_files`, `merge_tree_write`, `rev_list_count`) - "naming parity
 * over code reuse" (spec 2.5): the words are copied byte for byte
 * (`alive`/`orphan`/`unmerged`/`merged`/`no-tree`), never re-derived.
 *
 * Deliberately does NOT call `gitro.ts` (this chunk's file list does not
 * include it, and editing it is not a permitted edit either) - the small
 * amount of porcelain-parsing plumbing this needs lives here instead of
 * being duplicated into a shared file this chunk was not asked to own.
 * `GitRepo.isAncestor` (already public) is reused for the one place this
 * file needs the ancestor fallback.
 *
 * Never shells `uv run` in the request path (spec's explicit ban) -
 * `_sync_toolchain` (worktrees.py's venv provisioning) is a lifecycle
 * concern this reconciliation-only port has no reason to touch.
 */
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { GitRepo } from "../gitro.ts";
import { appError, appJson, appSafely } from "./guard.ts";
import { getScope, param } from "./scoped.ts";

export type WorktreeState = "alive" | "orphan" | "unmerged" | "merged" | "no-tree";

export interface WorktreeItem {
  adw_id: string;
  branch: string;
  path: string;
  state: WorktreeState;
  dirty: boolean;
  /** From the run's own `branch` trace event, humanized-slug fallback, or ""
   * for a `no-tree` row - same derivation as `db.ts`'s `titlesFor` (an id
   * tells the operator nothing; MAP.md's worktree-naming ticket). */
  title: string;
  /** commits on `branch` not yet in trunk - display only. */
  ahead: number;
  /** `HOLDS WORK: ...` / `CANNOT NAME: ...` / a staleness annotation, or ""
   * - `worktrees.py`'s own `note`, verbatim. */
  note: string;
}

// -- git plumbing (mirrors git_helper.py; gitro.ts is not this chunk's file) -

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}

interface WorktreeListEntry {
  path: string;
  branch: string | null;
}

/** `git worktree list --porcelain`, parsed exactly as `git_helper.py`'s
 * `worktree_list` (never the human table format - a path with a space in it
 * is unparseable there). Git prints forward slashes even on Windows. */
async function worktreeList(root: string): Promise<WorktreeListEntry[]> {
  const { stdout } = await git(root, ["worktree", "list", "--porcelain"]);
  const records: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const line of stdout.split("\n")) {
    if (line === "") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const spaceIdx = line.indexOf(" ");
    const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const value = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);
    if (key === "worktree") current = { path: value, branch: null };
    else if (key === "branch" && current) current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
    else if (key === "detached" && current) current.branch = null;
  }
  if (current) records.push(current);
  return records;
}

interface RunBranch {
  branch: string;
}

/** Every `adw/*` branch, with or without a worktree still holding it - a
 * removed directory does not un-strand the commits on its branch. */
async function listRunBranches(root: string): Promise<RunBranch[]> {
  const { code, stdout } = await git(root, [
    "for-each-ref",
    "refs/heads/adw/",
    "--format=%(refname:short)",
  ]);
  if (code !== 0) return [];
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((branch) => ({ branch }));
}

async function isDirty(path: string): Promise<boolean> {
  const { code, stdout } = await git(path, ["status", "--porcelain"]);
  return code === 0 && stdout.trim().length > 0;
}

async function revListCount(root: string, rangeExpr: string): Promise<number> {
  const { code, stdout } = await git(root, ["rev-list", "--count", rangeExpr]);
  if (code !== 0) return 0;
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** First line of `git merge-tree --write-tree base other` - printed whether
 * the merge is clean (0) or conflicted (1); null only on a git-level failure
 * (git < 2.38, no `--write-tree` support). */
async function mergeTreeWrite(root: string, base: string, other: string): Promise<string | null> {
  const { code, stdout } = await git(root, ["merge-tree", "--write-tree", base, other]);
  if (code !== 0 && code !== 1) return null;
  const firstLine = (stdout.split("\n")[0] ?? "").trim();
  return firstLine || null;
}

async function revParse(root: string, ref: string): Promise<string | null> {
  const { code, stdout } = await git(root, ["rev-parse", ref]);
  return code === 0 ? stdout.trim() : null;
}

/** "Would merging `branch` into `trunk` change anything?" - exact and
 * correct across squash/rebase/cherry-pick, unlike a bare ancestor test.
 * Falls back to `repo.isAncestor` (the safe, under-report direction) when
 * this git is too old for `--write-tree`. */
async function isMergedIntoTrunk(root: string, trunk: string, branch: string, repo: GitRepo): Promise<boolean> {
  const treeSha = await mergeTreeWrite(root, trunk, branch);
  if (treeSha !== null) {
    const trunkTree = await revParse(root, `${trunk}^{tree}`);
    return trunkTree !== null && treeSha === trunkTree;
  }
  return (await repo.isAncestor(branch, trunk)) === true;
}

function humanizeSlug(slug: string): string {
  const words = slug.split("-").filter(Boolean);
  if (words.length === 0) return slug;
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function adwIdOf(branch: string): string {
  const short = branch.startsWith("adw/") ? branch.slice(4) : branch;
  const idx = short.indexOf("_");
  return idx === -1 ? short : short.slice(0, idx);
}

function minutesSince(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (Date.now() - then) / 60_000;
}

// -- classify (mirrors worktrees.py's classify(), verbatim ordering) --------

interface ClassifyInput {
  adwId: string;
  dirty: boolean;
  hasSession: boolean;
  sessionStatus: string;
  liveProcesses: number;
  latestEventAgeMinutes: number | null;
  mergedIntoTrunk: boolean;
  ahead: number;
  trunk: string;
  staleAfterMinutes: number;
}

/** Order is the safety property (worktrees.py's own comment): alive, then
 * orphan ("you cannot decide anything about a tree you cannot name"), then
 * unmerged, then merged last. */
function classify(input: ClassifyInput): { state: WorktreeState; note: string } {
  const { adwId, dirty, hasSession, sessionStatus, liveProcesses, latestEventAgeMinutes, mergedIntoTrunk, ahead, trunk, staleAfterMinutes } = input;

  if (sessionStatus === "running" || liveProcesses > 0) {
    if (latestEventAgeMinutes !== null && latestEventAgeMinutes > staleAfterMinutes) {
      const hours = latestEventAgeMinutes / 60;
      return { state: "alive", note: `alive (stale ${hours.toFixed(1)}h)` };
    }
    return { state: "alive", note: "" };
  }

  const evidence = `${ahead} commit(s) not in ${trunk}, tree ${dirty ? "dirty" : "clean"}`;

  if (!hasSession) return { state: "orphan", note: `CANNOT NAME: ${evidence} - no session row for adw_id ${adwId}` };
  if (dirty || !mergedIntoTrunk) return { state: "unmerged", note: `HOLDS WORK: ${evidence}, session ${JSON.stringify(sessionStatus || "unknown")}` };
  return { state: "merged", note: "" };
}

// -- inventory ----------------------------------------------------------------

interface SessionFacts {
  status: string;
  request: string;
  liveProcesses: number;
  latestEvent: string | null;
  title: string;
}

/** `stale_after_minutes` (and `trunk`) from `sssf.config.yaml`'s `worktrees:`
 * section - read directly (not through `config.ts`, whose `readConfig`
 * deliberately does not carry this section) since parsing one small yaml
 * block again is cheaper than this chunk reaching into a file it does not
 * own to add a field. Missing file / missing section -> the same defaults
 * `data_types.py`'s `WorktreesConfig` ships (`stale_after_minutes: 30`,
 * `trunk: "main"`). */
async function readWorktreesConfig(configPath: string): Promise<{ trunk: string; staleAfterMinutes: number }> {
  try {
    const text = await readFile(configPath, "utf-8");
    const raw = (parseYaml(text) ?? {}) as { worktrees?: { trunk?: string; stale_after_minutes?: number } };
    const w = raw.worktrees ?? {};
    return {
      trunk: typeof w.trunk === "string" && w.trunk ? w.trunk : "main",
      staleAfterMinutes: typeof w.stale_after_minutes === "number" ? w.stale_after_minutes : 30,
    };
  } catch {
    return { trunk: "main", staleAfterMinutes: 30 };
  }
}

async function inventory(
  root: string,
  repo: GitRepo,
  sessionsByAdwId: Map<string, SessionFacts>,
  cfg: { trunk: string; staleAfterMinutes: number },
): Promise<WorktreeItem[]> {
  const worktrees = await worktreeList(root);
  const branches = await listRunBranches(root);

  const wtByAdwId = new Map<string, WorktreeListEntry>();
  for (const w of worktrees) {
    if (!w.branch || !w.branch.startsWith("adw/")) continue;
    const id = adwIdOf(w.branch);
    if (!wtByAdwId.has(id)) wtByAdwId.set(id, w);
  }
  const brByAdwId = new Map<string, RunBranch>();
  for (const b of branches) {
    const id = adwIdOf(b.branch);
    if (!brByAdwId.has(id)) brByAdwId.set(id, b);
  }

  const allIds = new Set<string>([...wtByAdwId.keys(), ...brByAdwId.keys(), ...sessionsByAdwId.keys()]);

  const items: WorktreeItem[] = [];
  for (const adwId of Array.from(allIds).sort()) {
    const wt = wtByAdwId.get(adwId) ?? null;
    const br = brByAdwId.get(adwId) ?? null;
    const session = sessionsByAdwId.get(adwId) ?? null;

    // A session that never cut a tree is the `--all`-only fifth row type
    // (`worktrees.py:103`: `rows if args.all else [r for r in rows if r.state
    // != "no-tree"]`). The strip is "one line per tree" (spec 2.5), and this
    // endpoint has no `--all`, so the CLI's own default is the default here:
    // the row is skipped, never emitted with an empty branch (which would also
    // leave the strip labelling it by `adw_id`, which the spec forbids).
    if (!wt && !br) continue;

    const branchName = wt?.branch ?? br?.branch ?? "";
    const path = wt?.path ?? "";

    let title = session?.title ?? "";
    if (!title && branchName.includes("_")) {
      title = humanizeSlug(branchName.slice(branchName.indexOf("_") + 1));
    }

    const dirty = wt ? await isDirty(path) : false;

    let ahead = 0;
    if (branchName) {
      const trunkExists = (await revParse(root, cfg.trunk)) !== null;
      if (trunkExists) ahead = await revListCount(root, `${cfg.trunk}..${branchName}`);
    }

    let merged = false;
    if (branchName && !dirty) merged = await isMergedIntoTrunk(root, cfg.trunk, branchName, repo);

    const ageMinutes = session?.latestEvent ? minutesSince(session.latestEvent) : null;

    const { state, note } = classify({
      adwId,
      dirty,
      hasSession: session !== null,
      sessionStatus: session?.status ?? "",
      liveProcesses: session?.liveProcesses ?? 0,
      latestEventAgeMinutes: ageMinutes,
      mergedIntoTrunk: merged,
      ahead,
      trunk: cfg.trunk,
      staleAfterMinutes: cfg.staleAfterMinutes,
    });

    items.push({ adw_id: adwId, branch: branchName, path, state, dirty, title, ahead, note });
  }

  return items;
}

const STATE_ORDER: Record<WorktreeState, number> = { alive: 0, unmerged: 1, orphan: 2, merged: 3, "no-tree": 4 };

async function getWorktrees(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);

  const isRepo = await scope.repo.isRepo();
  if (!isRepo) return appJson([] satisfies WorktreeItem[]);

  const cfg = await readWorktreesConfig(scope.configPath);

  const sessionsByAdwId = new Map<string, SessionFacts>();
  if (scope.db) {
    for (const s of scope.db.allSessions()) {
      const processes = scope.db.processes(s.adw_id);
      const liveProcesses = processes.filter((p) => p.ended_at === null).length;
      const events = scope.db.events(s.adw_id, 0, 1000).events;
      const latestEvent = events.length > 0 ? events[events.length - 1]!.started_at : null;
      const branchEvent = [...events].reverse().find((e) => e.type === "log" && (e.name === "branch" || e.name === "worktree"));
      let title = "";
      if (branchEvent?.payload_json) {
        try {
          const payload = JSON.parse(branchEvent.payload_json) as { title?: string };
          title = typeof payload.title === "string" ? payload.title : "";
        } catch {
          /* malformed payload -> no title from trace, falls back to slug */
        }
      }
      sessionsByAdwId.set(s.adw_id, {
        status: s.status ?? "",
        request: s.request ?? "",
        liveProcesses,
        latestEvent,
        title,
      });
    }
  }

  const items = await inventory(scope.root, scope.repo, sessionsByAdwId, cfg);
  items.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.adw_id.localeCompare(b.adw_id));
  return appJson(items);
}

export const worktreesRoutes = {
  "/api/app/p/:id/worktrees": appSafely(getWorktrees),
};
