/**
 * Gate: eligibility, diff summary, compare-url derivation (spec 5.4), plus the
 * diff-scoping logic shared with Trace's per-phase diff tab (spec 5.2.1) - both
 * surfaces show the same "Whole run | NN commit_x" selector over the same
 * commit shas, so the range math lives in one place.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommitLogEntry, SssfDb } from "./db.ts";
import { githubCompareUrl, isSafeSegment, type GitRepo } from "./gitro.ts";
import type { DiffFile, DiffResponse, DiffScope, GateItem, GateResult } from "../shared/types.ts";

/** git's magic empty-tree hash - diffing against it shows "everything in the
 * commit" for a root commit with no parent. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_DIFF_LINES = 2000;

export function availableScopes(commits: CommitLogEntry[]): DiffScope[] {
  const scopes: DiffScope[] = [{ id: "run", label: "Whole run", sha: null }];
  for (const c of commits) {
    const seq = c.seq !== null ? String(c.seq).padStart(2, "0") : "??";
    scopes.push({ id: c.phase_id, label: `${seq} ${c.name ?? c.phase_id}`, sha: c.sha });
  }
  return scopes;
}

function emptyDiff(base: string): DiffResponse {
  return { base, files: [], added: 0, deleted: 0, patch: "", truncated: false, empty: true };
}

/** Parse a unified diff's own text for a per-file +/- breakdown - the only way
 * to recover file-level counts from a `changes.diff` capture, since that
 * working-tree state no longer exists once we read it back later. */
function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      if (current) files.push(current);
      current = { path: header[2] ?? header[1] ?? "?", added: 0, deleted: 0 };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.deleted++;
  }
  if (current) files.push(current);
  return files;
}

async function diffFromCapturedFile(sessionDir: string): Promise<DiffResponse | null> {
  const path = join(sessionDir, "context_handoff", "changes.diff");
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf-8");
  const sinceLine = /^# changes since (.+)$/m.exec(text);
  const reasonLine = text.split("\n")[1] ?? "";
  const countsLine = /^# \+(\d+) -(\d+) across (\d+) tracked file/m.exec(text);
  const diffIdx = text.indexOf("\n## diff\n");
  const patch = diffIdx >= 0 ? text.slice(diffIdx + "\n## diff\n".length) : "";
  const files = parseUnifiedDiff(patch);
  const base = sinceLine ? `${sinceLine[1]} - ${reasonLine.replace(/^#\s*/, "")}` : "captured diff";
  return {
    base,
    files,
    added: countsLine ? Number.parseInt(countsLine[1] ?? "0", 10) : files.reduce((s, f) => s + f.added, 0),
    deleted: countsLine ? Number.parseInt(countsLine[2] ?? "0", 10) : files.reduce((s, f) => s + f.deleted, 0),
    patch: patch.trim(),
    truncated: patch.includes("[truncated at"),
    empty: files.length === 0 && patch.trim().length === 0,
  };
}

export interface ResolveDiffInput {
  repo: GitRepo;
  sessionDir: string;
  commits: CommitLogEntry[]; // db.commitLog(adwId), already in phase order
  scope: string; // "run" | a phase_id from `commits`
}

/**
 * Resolve one diff scope. A commit phase diffs `<previous sha>..<sha>`; the
 * whole run diffs `<first commit's parent>..<last sha>`, or falls back to the
 * captured `context_handoff/changes.diff` when the run made no commits.
 */
export async function resolveDiff(input: ResolveDiffInput): Promise<DiffResponse | null> {
  const { repo, sessionDir, commits, scope } = input;

  let from: string | null = null;
  let to: string | null = null;
  let label = "";

  if (scope === "run") {
    if (commits.length === 0) return diffFromCapturedFile(sessionDir);
    const first = commits[0]!;
    const last = commits[commits.length - 1]!;
    from = (await repo.parentOf(first.sha)) ?? EMPTY_TREE;
    to = last.sha;
    label = `${commits.length} commit(s), ${await repo.shortSha(first.sha)}..${await repo.shortSha(last.sha)}`;
  } else {
    const idx = commits.findIndex((c) => c.phase_id === scope);
    if (idx === -1) return null; // not a known scope
    const entry = commits[idx]!;
    const prev = idx > 0 ? commits[idx - 1]!.sha : ((await repo.parentOf(entry.sha)) ?? EMPTY_TREE);
    from = prev;
    to = entry.sha;
    label = `${entry.name ?? entry.phase_id} @ ${await repo.shortSha(entry.sha)}`;
  }

  const [files, text] = await Promise.all([repo.diffFiles(from, to), repo.diffText(from, to, MAX_DIFF_LINES)]);
  const added = files.reduce((s, f) => s + f.added, 0);
  const deleted = files.reduce((s, f) => s + f.deleted, 0);
  return {
    base: label,
    files,
    added,
    deleted,
    patch: text.patch,
    truncated: text.truncated,
    empty: files.length === 0,
  };
}

// -- eligibility (spec 5.4) ---------------------------------------------------

export interface GateBuildDeps {
  db: SssfDb;
  repo: GitRepo;
}

async function reviewerSummary(db: SssfDb, adwId: string): Promise<string | null> {
  const envelopes = db.envelopes(adwId).filter((e) => e.agent === "reviewer" && e.valid === 1);
  const latest = envelopes[envelopes.length - 1];
  if (!latest?.payload_json) return null;
  try {
    const payload = JSON.parse(latest.payload_json) as { summary?: unknown };
    return typeof payload.summary === "string" ? payload.summary : null;
  } catch {
    return null;
  }
}

/**
 * Runs that succeeded, cut an `adw/<id>_<slug>` branch, and are not yet an
 * ancestor of main - ordered by `ended_at` desc (spec 5.4). A failed run is
 * trace work, not gate work, and is skipped here entirely.
 */
export async function computeGateItems({ db, repo }: GateBuildDeps, sessionsDir: string): Promise<GateItem[]> {
  const sessions = db.allSessions().filter((s) => s.status === "success" && isSafeSegment(s.adw_id));
  const remoteUrl = await repo.remoteUrl("origin");
  const items: GateItem[] = [];

  for (const s of sessions) {
    const branches = await repo.branchesMatching(`adw/${s.adw_id}_*`);
    if (branches.length === 0) continue;
    const branch = branches[0]!;
    const ancestor = await repo.isAncestor(branch, "main");
    if (ancestor !== false) continue; // true = already merged, null = can't tell -> skip, don't guess

    const commits = db.commitLog(s.adw_id);
    const sessionDir = join(sessionsDir, s.adw_id);
    const diff = (await resolveDiff({ repo, sessionDir, commits, scope: "run" })) ?? emptyDiff("no diff available");
    const diffScopes = availableScopes(commits);

    const phases = db.phases(s.adw_id);
    const qualityPhase = phases.find((p) => p.name === "quality");
    const gates = db.gates(s.adw_id);
    const quality: GateResult | null = qualityPhase
      ? {
          id: -1,
          adw_id: s.adw_id,
          phase_id: qualityPhase.phase_id,
          attempt: qualityPhase.attempt,
          gate: "quality",
          passed: qualityPhase.status === "success" ? 1 : 0,
          violations_json: qualityPhase.error ? JSON.stringify([qualityPhase.error]) : "[]",
          checks_json: null,
          created_at: qualityPhase.ended_at,
        }
      : null;

    const compareUrl = githubCompareUrl(remoteUrl, branch);
    items.push({
      adw_id: s.adw_id,
      adw_name: s.adw_name,
      request: s.request,
      branch,
      ended_at: s.ended_at,
      diff,
      diff_scopes: diffScopes,
      quality,
      gates,
      reviewer_summary: await reviewerSummary(db, s.adw_id),
      compare_url: compareUrl,
      push_command: compareUrl ? null : `git push -u origin ${branch}`,
      remote_kind: !remoteUrl ? "none" : compareUrl ? "github" : "other",
    });
  }

  items.sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""));
  return items;
}
