/**
 * Allowlisted read-only git, via `Bun.spawn` with argv arrays only - nothing
 * from a request is ever interpolated into a shell string (spec section 4).
 *
 * Every function here is a query: branch existence, ancestry, diffs, remote
 * URL. Nothing writes, fetches, pushes or checks out. Git is a subprocess
 * because bun:sqlite has no equivalent and re-implementing diff/merge-base
 * would be its own defect surface.
 */
import { dirname, resolve } from "node:path";

export interface DiffFileStat {
  path: string;
  added: number;
  deleted: number;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
/** adw_id, agent names, and phase ids - the same pattern the API layer uses
 * to validate anything from a request before it touches disk or a shell. */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function isSafeSegment(value: string): boolean {
  return SEGMENT_RE.test(value) && value !== "." && value !== "..";
}

export function isSafeSha(value: string): boolean {
  return SHA_RE.test(value);
}

export function isSafeRef(value: string): boolean {
  return REF_RE.test(value) && !value.startsWith("-") && !value.includes("..");
}

/** The repo root, derived from the db path: `<root>/adws/adw_data/sssf.db`. */
export function repoRootFromDbPath(dbPath: string): string {
  return resolve(dirname(dbPath), "..", "..");
}

async function run(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export class GitRepo {
  constructor(readonly root: string) {}

  async isRepo(): Promise<boolean> {
    const { code } = await run(this.root, ["rev-parse", "--git-dir"]);
    return code === 0;
  }

  async currentBranch(): Promise<string | null> {
    const { code, stdout } = await run(this.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (code !== 0) return null;
    const branch = stdout.trim();
    return branch === "HEAD" ? null : branch; // detached HEAD
  }

  async remoteUrl(name = "origin"): Promise<string | null> {
    const { code, stdout } = await run(this.root, ["remote", "get-url", name]);
    return code === 0 ? stdout.trim() || null : null;
  }

  /** Every local branch matching `adw/<adw_id>_*`, for Gate eligibility. */
  async branchesMatching(prefix: string): Promise<string[]> {
    const { code, stdout } = await run(this.root, [
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/${prefix}`,
    ]);
    if (code !== 0) return [];
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  async refExists(ref: string): Promise<boolean> {
    if (!isSafeRef(ref)) return false;
    const { code } = await run(this.root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return code === 0;
  }

  /** True/false, or null when the ref itself does not resolve (unknown, not "no"). */
  async isAncestor(ancestor: string, of: string): Promise<boolean | null> {
    if (!isSafeRef(ancestor) || !isSafeRef(of)) return null;
    if (!(await this.refExists(ancestor)) || !(await this.refExists(of))) return null;
    const { code } = await run(this.root, ["merge-base", "--is-ancestor", ancestor, of]);
    if (code === 0) return true;
    if (code === 1) return false;
    return null; // exit >1: one of the refs is invalid to git after all
  }

  async revParse(ref: string): Promise<string | null> {
    if (!isSafeRef(ref) && !isSafeSha(ref)) return null;
    const { code, stdout } = await run(this.root, ["rev-parse", ref]);
    return code === 0 ? stdout.trim() : null;
  }

  /** The parent of `sha` - used to build the "first-parent..last" whole-run
   * diff range described in spec 5.2.1. Null on a root commit (no parent),
   * an unsafe/unresolvable sha, or a git failure.
   *
   * Deliberately does NOT go through `revParse(`${sha}^`)`: SHA_RE/REF_RE
   * both reject a trailing "^" (it is neither a bare hex sha nor a bare
   * ref), so that path always returned null and every whole-run diff fell
   * back to EMPTY_TREE - Gate reporting the entire repo as added. Fixed by
   * resolving the parent through a form that needs no new grammar: `git
   * rev-list --parents` takes the already-validated sha as its only ref
   * argument (no "^" suffix involved) and prints "<sha> [parent...]" on one
   * line, so SHA_RE/REF_RE stay exactly as strict as they were. */
  async parentOf(sha: string): Promise<string | null> {
    if (!isSafeSha(sha) && !isSafeRef(sha)) return null;
    const { code, stdout } = await run(this.root, ["rev-list", "--parents", "-n", "1", sha]);
    if (code !== 0) return null;
    const parts = stdout.trim().split(/\s+/).filter(Boolean);
    return parts[1] ?? null; // parts[0] is sha itself; no second token = root commit
  }

  async shortSha(sha: string): Promise<string> {
    const { code, stdout } = await run(this.root, ["rev-parse", "--short", sha]);
    return code === 0 ? stdout.trim() : sha.slice(0, 7);
  }

  async diffFiles(from: string, to: string): Promise<DiffFileStat[]> {
    const { code, stdout } = await run(this.root, ["diff", "--numstat", `${from}..${to}`]);
    if (code !== 0) return [];
    const files: DiffFileStat[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      if (!path) continue;
      files.push({
        path,
        added: addedRaw === "-" ? 0 : Number.parseInt(addedRaw ?? "0", 10) || 0,
        deleted: deletedRaw === "-" ? 0 : Number.parseInt(deletedRaw ?? "0", 10) || 0,
      });
    }
    return files;
  }

  async diffText(from: string, to: string, maxLines = 2000): Promise<{ patch: string; truncated: boolean }> {
    const { code, stdout } = await run(this.root, ["diff", `${from}..${to}`]);
    if (code !== 0) return { patch: "", truncated: false };
    const lines = stdout.split("\n");
    if (lines.length <= maxLines) return { patch: stdout, truncated: false };
    const truncated =
      lines.slice(0, maxLines).join("\n") +
      `\n\n[truncated at ${maxLines} lines of ${lines.length} - open a terminal for the rest]`;
    return { patch: truncated, truncated: true };
  }
}

/**
 * Normalize an `origin` remote URL to a GitHub compare URL, or null when the
 * remote is not GitHub (spec 5.4: "No remote, or a non-GitHub remote: the
 * button is replaced by the branch name and the push command").
 * Handles `git@github.com:o/r.git` and `https://github.com/o/r(.git)`.
 */
export function githubCompareUrl(remoteUrl: string | null, branch: string): string | null {
  if (!remoteUrl) return null;
  let ownerRepo: string | null = null;
  const ssh = remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  const https = remoteUrl.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (ssh) ownerRepo = ssh[1] ?? null;
  else if (https) ownerRepo = https[1] ?? null;
  if (!ownerRepo) return null;
  return `https://github.com/${ownerRepo}/compare/main...${encodeURIComponent(branch)}?expand=1`;
}
