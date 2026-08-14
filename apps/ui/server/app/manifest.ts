/**
 * The app manifest: `~/.sdl-factory/config.json` (spec 1.4).
 *
 * Machine-scoped, invisible to the factory, never inside a repo. Nothing
 * derivable is stored here - db path, queue dir, config path, git state are
 * re-derived from `root` on every read (readiness.ts), so the manifest can
 * never go stale. This file owns exactly the read/write/upsert of that one
 * JSON file plus the one-time seeding spec 1.4 describes: "When the server
 * boots the legacy way (--db <path>, as `just ui` does), that repo root is
 * seeded as project #1 - the flag becomes manifest seeding and nothing more."
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { repoRootFromDbPath } from "../gitro.ts";
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
  return join(homedir(), ".sdl-factory");
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

  const expanded =
    trimmed === "~" || trimmed.startsWith(`~${sep}`) || trimmed.startsWith("~/")
      ? join(homedir(), trimmed.slice(1))
      : trimmed;
  const root = resolve(expanded);

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

/**
 * Seeds the boot project from `--db <path>` (as `just ui`/`just app` pass).
 * Deliberately swallows every failure: if `--db` is missing or malformed,
 * `index.ts`'s own `resolveDbPath()` call (right after this module's import
 * resolves) surfaces the real error and exits the process - this function
 * must never be the one to crash the server, and must never print a second,
 * confusing copy of that error.
 */
export async function seedBootProject(): Promise<ManifestProject | null> {
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
