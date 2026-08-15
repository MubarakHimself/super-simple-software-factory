/**
 * The app manifest: `~/.sdl-factory/config.json` (spec 1.4).
 *
 * Machine-scoped, invisible to the factory, never inside a repo. Nothing
 * derivable is stored here - db path, queue dir, config path, git state are
 * re-derived from `root` on every read (readiness.ts), so the manifest can
 * never go stale. This file owns exactly the read/write/upsert/remove of that
 * one JSON file, plus the read-only probe the Add-project modal's detection
 * rows are built from.
 *
 * ── THE PHANTOM PROJECT (fixed here, 2026-08-15) ───────────────────────────
 * Spec 1.4 used to say: "When the server boots the legacy way (--db <path>,
 * as `just ui` does), that repo root is seeded as project #1." Every launch
 * path passes --db <sdl-factory>/adws/adw_data/sssf.db - `just ui3`, `just
 * app3`, and electron/main.ts's own spawn - so that rule meant the server
 * auto-registered ITS OWN repo, on every boot, forever: an "SDL Factory"
 * project nobody added, that reappeared after any hand-edit of the manifest,
 * and that made the first-run state unreachable. `seedBootProject()` no
 * longer writes. It is kept (routes.ts still calls it) and can be brought
 * back for one process with SDL_SEED_BOOT_PROJECT=1, which is a deliberate
 * act, not a side effect of naming a db.
 *
 * The manifest's home is `~/.sdl-factory` unless SDL_FACTORY_HOME names
 * another directory - the one seam the tests use so they never touch the
 * operator's own project list.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { configPathFromRepoRoot } from "../config.ts";
import { GitRepo, repoRootFromDbPath } from "../gitro.ts";
import { resolveDbPath } from "../db.ts";

export interface ManifestProject {
  id: string;
  name: string;
  root: string;
  added_at: string;
  last_opened_at: string | null;
}

export interface Manifest {
  version: number;
  active: string | null;
  projects: ManifestProject[];
  ui: Record<string, unknown>;
}

const CURRENT_VERSION = 1;

function emptyManifest(): Manifest {
  return { version: CURRENT_VERSION, active: null, projects: [], ui: {} };
}

export function appHome(): string {
  const override = (process.env.SDL_FACTORY_HOME ?? "").trim();
  return override ? resolve(override) : join(homedir(), ".sdl-factory");
}

export function manifestPath(): string {
  return join(appHome(), "config.json");
}

/** Case-insensitive on Windows (the only platform this app ships on today),
 * so `C:\repo` and `c:\repo\` upsert to the same project instead of two. */
function normalizeRoot(root: string): string {
  const abs = resolve(root);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** Stable, content-derived id - re-seeding the same root on every boot (or
 * the operator re-adding a path they already added) upserts the same entry
 * rather than growing a duplicate with a fresh random id each time. */
function idForRoot(root: string): string {
  return createHash("sha256").update(normalizeRoot(root)).digest("hex").slice(0, 12);
}

export async function readManifest(): Promise<Manifest> {
  const path = manifestPath();
  if (!existsSync(path)) return emptyManifest();
  try {
    const text = await readFile(path, "utf-8");
    const parsed = JSON.parse(text) as Partial<Manifest>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : CURRENT_VERSION,
      active: typeof parsed.active === "string" ? parsed.active : null,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      ui: typeof parsed.ui === "object" && parsed.ui !== null ? parsed.ui : {},
    };
  } catch (error) {
    // A hand-edited or half-written manifest should not take the app plane
    // down - it degrades to "no projects known yet", the same honest empty
    // state as a manifest that was never created.
    console.error(`[ui] app: could not read ${path}: ${(error as Error).message}`);
    return emptyManifest();
  }
}

export async function writeManifest(manifest: Manifest): Promise<void> {
  const path = manifestPath();
  await mkdir(appHome(), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/** `~`-expansion + absolute resolution, shared by the write (upsertProject)
 * and the read-only probe (describePath) so the path the detection rows
 * report is byte-for-byte the path Add would register. */
function resolveCandidate(rawPath: string): string {
  const trimmed = rawPath.trim();
  const expanded =
    trimmed === "~" || trimmed.startsWith(`~${sep}`) || trimmed.startsWith("~/")
      ? join(homedir(), trimmed.slice(1))
      : trimmed;
  return resolve(expanded);
}

export interface UpsertResult {
  ok: true;
  project: ManifestProject;
}
export interface UpsertError {
  ok: false;
  error: string;
}

/** Validates `path` exists and is a directory, then upserts it into the
 * manifest keyed by normalized root (spec's `/api/app/projects` POST:
 * "validates exists+isDirectory, returns project or one-line error"). Does
 * NOT touch git or the factory - a bare folder is a valid project (W1-B4
 * Greenfield). */
export async function upsertProject(rawPath: string): Promise<UpsertResult | UpsertError> {
  const trimmed = rawPath.trim();
  if (!trimmed) return { ok: false, error: "path is required" };

  const root = resolveCandidate(trimmed);

  if (!existsSync(root)) return { ok: false, error: `no such directory: ${root}` };
  if (!statSync(root).isDirectory()) return { ok: false, error: `not a directory: ${root}` };

  const manifest = await readManifest();
  const key = normalizeRoot(root);
  const existing = manifest.projects.find((p) => normalizeRoot(p.root) === key);
  if (existing) return { ok: true, project: existing };

  const project: ManifestProject = {
    id: idForRoot(root),
    name: basename(root) || root,
    root,
    added_at: new Date().toISOString(),
    last_opened_at: null,
  };
  manifest.projects.push(project);
  if (manifest.active === null) manifest.active = project.id;
  await writeManifest(manifest);
  return { ok: true, project };
}

/** Removes one registration from this machine's project list. Nothing inside
 * the folder is touched - a project is a line in a json file here, so
 * "remove" can only ever mean "stop listing it". */
export async function removeProject(id: string): Promise<UpsertResult | UpsertError> {
  if (!id.trim()) return { ok: false, error: "id is required" };
  const manifest = await readManifest();
  const index = manifest.projects.findIndex((p) => p.id === id);
  if (index === -1) return { ok: false, error: `no project ${id}` };
  const [removed] = manifest.projects.splice(index, 1);
  if (manifest.active === id) manifest.active = manifest.projects[0]?.id ?? null;
  await writeManifest(manifest);
  return { ok: true, project: removed! };
}

/**
 * What the Add-project modal's detection rows are built from: everything the
 * app can say about a path WITHOUT registering it.
 *
 * This exists because the settings modal's "probe" had to POST the path first
 * (readiness is keyed by a registered project id), so every mistyped-but-real
 * directory the operator probed landed permanently in the project list. A
 * probe that writes is not a probe.
 *
 * `problem` is the one line Add would refuse with, or null when Add would
 * succeed. Everything else is a fact read off the disk - never a
 * recommendation, never a blocker: a bare folder is a valid project, it just
 * has no git and no factory yet, and the rows say so.
 */
export interface PathProbe {
  /** absolute, `~`-expanded - the exact path Add would register */
  path: string;
  /** the folder name the project would take */
  name: string;
  exists: boolean;
  is_directory: boolean;
  is_git_repo: boolean;
  git_branch: string | null;
  factory_initialized: boolean;
  /** already in this machine's list -> Add would open it, not duplicate it */
  registered_id: string | null;
  problem: string | null;
}

export async function describePath(rawPath: string): Promise<PathProbe | UpsertError> {
  const trimmed = rawPath.trim();
  if (!trimmed) return { ok: false, error: "path is required" };
  const root = resolveCandidate(trimmed);
  const name = basename(root) || root;

  const exists = existsSync(root);
  const isDirectory = exists && statSync(root).isDirectory();

  const manifest = await readManifest();
  const key = normalizeRoot(root);
  const registered = manifest.projects.find((p) => normalizeRoot(p.root) === key) ?? null;

  if (!exists || !isDirectory) {
    return {
      path: root,
      name,
      exists,
      is_directory: isDirectory,
      is_git_repo: false,
      git_branch: null,
      factory_initialized: false,
      registered_id: registered?.id ?? null,
      problem: exists ? `not a directory: ${root}` : `no such directory: ${root}`,
    };
  }

  const repo = new GitRepo(root);
  const isRepo = await repo.isRepo();
  return {
    path: root,
    name,
    exists: true,
    is_directory: true,
    is_git_repo: isRepo,
    git_branch: isRepo ? await repo.currentBranch() : null,
    factory_initialized: existsSync(configPathFromRepoRoot(root)),
    registered_id: registered?.id ?? null,
    problem: null,
  };
}

/**
 * The legacy `--db <path>` seeding, now OFF by default (see this file's
 * header: it is where the phantom "SDL Factory" project came from). Set
 * SDL_SEED_BOOT_PROJECT=1 to bring it back for one process.
 *
 * Deliberately swallows every failure: if `--db` is missing or malformed,
 * `index.ts`'s own `resolveDbPath()` call (right after this module's import
 * resolves) surfaces the real error and exits the process - this function
 * must never be the one to crash the server, and must never print a second,
 * confusing copy of that error.
 */
export async function seedBootProject(): Promise<ManifestProject | null> {
  if ((process.env.SDL_SEED_BOOT_PROJECT ?? "") !== "1") return null;
  let dbPath: string;
  try {
    dbPath = resolveDbPath();
  } catch {
    return null;
  }
  try {
    const root = repoRootFromDbPath(dbPath);
    const result = await upsertProject(root);
    return result.ok ? result.project : null;
  } catch (error) {
    console.error(`[ui] app: boot project seeding failed: ${(error as Error).message}`);
    return null;
  }
}

export async function findProject(id: string): Promise<ManifestProject | null> {
  const manifest = await readManifest();
  return manifest.projects.find((p) => p.id === id) ?? null;
}
