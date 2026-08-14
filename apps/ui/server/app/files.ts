/**
 * `/api/app/files?project=&q=&limit=80` (spec 1.3 row 121, W1-B5, spec 4
 * chunk K2b) - the composer's `@`-mention file popover data source.
 * Project-scoped path search over every file in the project (not markdown
 * only - `/api/app/p/:id/docs/search` already covers that narrower case),
 * using the same directory exclusion list as docs.ts. The 120ms debounce
 * spec row 121 names is the client's job, not this endpoint's.
 *
 * Route wiring into `app/routes.ts` is deliberately NOT done here - see the
 * note at the top of docs.ts for why.
 */
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
import { appError, appJson } from "./guard.ts";
import { findProject } from "./manifest.ts";

const EXCLUDED_DIR_NAMES = new Set([".git", "node_modules", ".venv", ".claude", "_docwork"]);
/** The rest of spec row 117's exclusion list, which row 121 binds this endpoint
 * to as well ("same exclusion list as docs"). docs.ts gets `adws/adw_data` for
 * free - it only ever recurses into `docs/ specs/ queue/ app_docs/` - but this
 * walker descends the whole project, so the exclusion has to be spelled out
 * here or a run's session data (one `agent_map.json` per session directory,
 * and friends) buries the real files in the `@`-mention popover. Matched on
 * the posix path relative to the project root, because the exclusion is a
 * location, not a directory name. */
const EXCLUDED_REL_DIRS = new Set(["adws/adw_data"]);
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;
/** Safety valve against a pathological tree hanging the request - this is a
 * loopback single-operator app (spec 3.4), not a service that needs to
 * finish indexing a million-file monorepo to answer one keystroke. */
const MAX_FILES_SCANNED = 20_000;

export interface FileEntry {
  path: string; // posix-style (forward slashes), relative to project root
  name: string;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function isLinkedWorktree(dirAbsPath: string): boolean {
  const gitPath = join(dirAbsPath, ".git");
  try {
    return existsSync(gitPath) && statSync(gitPath).isFile();
  } catch {
    return false;
  }
}

function intQuery(req: Request, key: string, fallback: number): number {
  const raw = new URL(req.url).searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function collectAllFiles(root: string, dirAbs: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES_SCANNED) return;
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return; // missing/unreadable directory is an honest empty contribution, never a throw
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES_SCANNED) return;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      const childAbs = join(dirAbs, entry.name);
      if (EXCLUDED_REL_DIRS.has(toPosix(relative(root, childAbs)))) continue;
      if (isLinkedWorktree(childAbs)) continue;
      await collectAllFiles(root, childAbs, out);
    } else if (entry.isFile()) {
      out.push(join(dirAbs, entry.name));
    }
  }
}

export async function getFiles(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("project") ?? "";
  if (!projectId) return appError("project is required");
  const project = await findProject(projectId);
  if (!project) return appError(`no project ${projectId}`, 404);

  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const limit = Math.min(MAX_LIMIT, Math.max(1, intQuery(req, "limit", DEFAULT_LIMIT)));

  const absPaths: string[] = [];
  await collectAllFiles(project.root, project.root, absPaths);

  const allEntries: FileEntry[] = absPaths.map((abs) => {
    const rel = toPosix(relative(project.root, abs));
    return { path: rel, name: rel.split("/").pop() ?? rel };
  });

  const filtered = q ? allEntries.filter((e) => e.path.toLowerCase().includes(q)) : allEntries;

  // Rank: basename starts-with the query first, then basename contains it,
  // then a path-only match trails - each group alphabetical by path.
  const rank = (e: FileEntry): number => {
    if (!q) return 0;
    const name = e.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return 2;
  };
  filtered.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));

  return appJson(filtered.slice(0, limit) satisfies FileEntry[]);
}
