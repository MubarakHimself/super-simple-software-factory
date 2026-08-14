/**
 * The per-project handles map (spec 4, chunk K2a) - the one thing every other
 * `/api/app/p/:id/*` route in this chunk (and the ones after it) opens first.
 *
 * `getScope(id)` resolves a manifest project id to its repo root plus the
 * four things every scoped route needs: an open (readonly) `SssfDb` handle,
 * a `GitRepo`, the queue directory, and the config path. It is lazy - no
 * project's db is opened until the first request that needs it - and
 * non-fatal on a missing db: `scope.db` is `null` rather than a throw, so
 * every caller can degrade to the honest `{factory:"absent"}` state (spec
 * 1.3's readiness row, W3-A4) instead of a 500.
 *
 * `SssfDb` connections are cached per project id and reused (bun:sqlite's WAL
 * mode reads straight through a running ADW's inserts - spec's db.ts comment
 * - so there is no correctness reason to reopen per request). Every call
 * re-checks `existsSync` first, so a db that appears after `Initialize
 * factory` (spec 2.9) or disappears is picked up without a server restart -
 * the manifest's own rule ("nothing derivable is stored... re-derived from
 * root on every read", spec 1.4) applied to this cache too.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configPathFromRepoRoot } from "../config.ts";
import { SssfDb } from "../db.ts";
import { GitRepo } from "../gitro.ts";
import { appJson } from "./guard.ts";
import { findProject, type ManifestProject } from "./manifest.ts";

export interface ProjectScope {
  project: ManifestProject;
  root: string;
  dbPath: string;
  /** `db.sessionsDir` when the db is open, else the path it WOULD be at -
   * still useful for path-confinement checks on a factory-less project. */
  sessionsDir: string;
  queueDir: string;
  configPath: string;
  repo: GitRepo;
  /** null = no factory here yet, or the db could not be opened (locked,
   * mid-write, corrupt) - a state every route renders, never a throw. */
  db: SssfDb | null;
}

interface CachedDb {
  dbPath: string;
  db: SssfDb;
}

const dbCache = new Map<string, CachedDb>();
const repoCache = new Map<string, GitRepo>();

function scopedDb(id: string, dbPath: string): SssfDb | null {
  const cached = dbCache.get(id);

  if (!existsSync(dbPath)) {
    if (cached) {
      cached.db.close();
      dbCache.delete(id);
    }
    return null;
  }

  if (cached && cached.dbPath === dbPath) return cached.db;
  if (cached) {
    cached.db.close();
    dbCache.delete(id);
  }

  try {
    const db = new SssfDb(dbPath);
    dbCache.set(id, { dbPath, db });
    return db;
  } catch (error) {
    console.error(`[ui] app: could not open ${dbPath}: ${(error as Error).message}`);
    return null;
  }
}

/** Resolves a manifest project id to its scope, or null when the id is
 * unknown (the caller's 404 case - `getScope` itself never 404s). */
export async function getScope(id: string): Promise<ProjectScope | null> {
  const project = await findProject(id);
  if (!project) return null;

  const root = project.root;
  const dbPath = join(root, "adws", "adw_data", "sssf.db");
  const db = scopedDb(id, dbPath);

  let repo = repoCache.get(id);
  if (!repo) {
    repo = new GitRepo(root);
    repoCache.set(id, repo);
  }

  return {
    project,
    root,
    dbPath,
    sessionsDir: db?.sessionsDir ?? join(root, "adws", "adw_data", "sessions"),
    queueDir: join(root, "queue"),
    configPath: configPathFromRepoRoot(root),
    repo,
    db,
  };
}

/** The shared "no factory here" body every scoped route falls back to when
 * `scope.db` is null (spec 2.5's empty-state table: "a missing db is a
 * state, not a throw - the per-project opener returns {factory:"absent"},
 * never process.exit"). */
export function factoryAbsent(): Response {
  return appJson({ factory: "absent" as const });
}

// -- small request helpers shared by every route module in this chunk -------
// (index.ts and app/readiness.ts each define their own copies of these; this
// file cannot import from index.ts, and duplicating three one-line functions
// is cheaper than inventing a shared-helpers file this chunk was not asked
// to own.)

export function param(req: Request, key: string): string {
  return decodeURIComponent((req as Request & { params: Record<string, string> }).params[key] ?? "");
}

export function intQuery(req: Request, key: string, fallback: number): number {
  const raw = new URL(req.url).searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function strQuery(req: Request, key: string, fallback: string): string {
  const raw = new URL(req.url).searchParams.get(key);
  return raw === null || raw.trim() === "" ? fallback : raw;
}
