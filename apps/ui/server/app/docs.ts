/**
 * Docs surface: tree, file reader, search (spec 1.3 rows 118-120, W3-B1/B3/B4,
 * spec 4 chunk K2b).
 *
 * Roots: repo root at depth 1 (`*.md`, non-recursive) plus `docs/ specs/
 * queue/ app_docs/` walked recursively. Excludes `.git node_modules .venv
 * .claude _docwork` (`adws/adw_data` is covered separately - see the note on
 * EXCLUDED_DIR_NAMES below) and any directory that is itself a linked git
 * worktree, detected the generic way a linked worktree always leaves a mark:
 * `git worktree add` writes a `.git` *file* (not a directory) at the
 * worktree's root, pointing at the real gitdir - so this walker skips it
 * regardless of where a given project's `worktrees.root` config points,
 * without reading that config (this file has no per-project config access).
 *
 * Route wiring into `app/routes.ts` is deliberately NOT done here - K2b's
 * file list is exactly `server/app/{docs,skills,files,providers}.ts`, and
 * routes.ts is a shared seam no two parallel chunks may both edit. These
 * handlers are written to the same `(req: Request) => Promise<Response>`
 * shape `readiness.ts`'s `getReadiness` uses, ready for whoever wires
 * `app/routes.ts` next to mount them with `appSafely(...)`.
 */
import { existsSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { appError, appJson } from "./guard.ts";
import { findProject } from "./manifest.ts";

/** `adws/adw_data` is excluded structurally: it is never one of the four
 * recursive roots and the repo-root walk is depth-1 only, so it is never
 * descended into in the first place - named here only so a reader looking
 * for it in one place finds this comment instead of a second exclusion
 * check that would be dead code. */
const EXCLUDED_DIR_NAMES = new Set([".git", "node_modules", ".venv", ".claude", "_docwork"]);
const RECURSIVE_ROOTS = ["docs", "specs", "queue", "app_docs"];
const ENTRY_BASENAMES = new Set(["agents.md", "index.md", "constitution.md", "glossary.md"]);
const ADR_RE = /^adr-\d+/i;
const MAX_FILE_BYTES = 1_000_000; // spec row 118: ">1MB truncated with one stated line"
const MAX_SEARCH_RESULTS = 40;

export interface DocsTreeEntry {
  path: string; // posix-style (forward slashes), relative to project root
  kind: "file";
  title: string;
  role: "entry" | "adr" | null;
}

export interface DocsFileResponse {
  path: string;
  text: string;
  bytes: number;
  mtime: string;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function param(req: Request, key: string): string {
  return decodeURIComponent((req as Request & { params: Record<string, string> }).params[key] ?? "");
}

/** The same confinement guard spec 1.3 names: "file paths confined with the
 * existing resolve(root, p).startsWith(root + sep) guard" - index.ts's
 * prompt-file reader and static server both use this exact shape. */
function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function isLinkedWorktree(dirAbsPath: string): boolean {
  const gitPath = join(dirAbsPath, ".git");
  try {
    return existsSync(gitPath) && statSync(gitPath).isFile();
  } catch {
    return false;
  }
}

async function firstHeading(absPath: string): Promise<string | null> {
  try {
    const text = await readFile(absPath, "utf-8");
    for (const line of text.split("\n").slice(0, 40)) {
      const m = /^#\s+(.+?)\s*$/.exec(line);
      if (m) return m[1]!.trim();
    }
  } catch {
    /* unreadable - fall back to the filename in buildTree below */
  }
  return null;
}

/**
 * Detection, not schema (spec 2.7 / W3-B4) - but detection of the
 * *documentation-factory taxonomy*, which puts its entry docs at a doc root:
 * `docs/index.md`, `docs/AGENTS.md`, `docs/constitution.md`,
 * `docs/glossary.md` (plus `AGENTS.md` at the repo root, where agent harnesses
 * actually look for it). The four entry basenames are ordinary words, so
 * matching them at any depth turns unrelated files into taxonomy - a
 * screenshot library's `docs/design/inspiration/t3code-live/INDEX.md` was
 * rendering an Entry group in a repo that has no taxonomy at all, and the
 * spec is explicit that such a repo renders neither group. Depth is the whole
 * fix: an entry doc sits at the root of a docs root, never buried in it.
 *
 * ADR names carry their own evidence (`ADR-0007-slug.md` is nobody's accident),
 * so those stay matched wherever a project files them.
 *
 * @param relPath project-relative, posix-style.
 */
function roleFor(relPath: string): "entry" | "adr" | null {
  const segments = relPath.split("/");
  const lower = segments[segments.length - 1]!.toLowerCase();
  const atDocRoot = segments.length === 1 || (segments.length === 2 && RECURSIVE_ROOTS.includes(segments[0]!));
  if (atDocRoot && ENTRY_BASENAMES.has(lower)) return "entry";
  if (ADR_RE.test(lower)) return "adr";
  return null;
}

async function walkMarkdown(dirAbs: string, recursive: boolean, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return; // missing/unreadable directory is an honest empty contribution, never a throw
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!recursive) continue;
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      const childAbs = join(dirAbs, entry.name);
      if (isLinkedWorktree(childAbs)) continue;
      await walkMarkdown(childAbs, recursive, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(join(dirAbs, entry.name));
    }
  }
}

async function buildTree(root: string): Promise<DocsTreeEntry[]> {
  const absPaths: string[] = [];
  await walkMarkdown(root, false, absPaths); // repo root, depth-1 only
  for (const name of RECURSIVE_ROOTS) {
    const dirAbs = join(root, name);
    if (existsSync(dirAbs) && statSync(dirAbs).isDirectory()) {
      await walkMarkdown(dirAbs, true, absPaths);
    }
  }
  const entries = await Promise.all(
    absPaths.map(async (absPath): Promise<DocsTreeEntry> => {
      const rel = toPosix(relative(root, absPath));
      const basename = rel.split("/").pop() ?? rel;
      const heading = await firstHeading(absPath);
      return {
        path: rel,
        kind: "file",
        title: heading ?? basename.replace(/\.md$/i, ""),
        role: roleFor(rel),
      };
    }),
  );
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export async function getDocsTree(req: Request): Promise<Response> {
  const id = param(req, "id");
  if (!id) return appError("missing project id");
  const project = await findProject(id);
  if (!project) return appError(`no project ${id}`, 404);
  return appJson(await buildTree(project.root));
}

export async function getDocsFile(req: Request): Promise<Response> {
  const id = param(req, "id");
  if (!id) return appError("missing project id");
  const project = await findProject(id);
  if (!project) return appError(`no project ${id}`, 404);

  const rawPath = new URL(req.url).searchParams.get("path") ?? "";
  if (!rawPath.trim()) return appError("path is required");

  const root = resolve(project.root);
  const abs = resolve(join(root, rawPath));
  if (!within(root, abs)) return appError("invalid path", 400);
  if (!existsSync(abs) || !statSync(abs).isFile()) return appError(`no such file: ${rawPath}`, 404);

  const st = await stat(abs);
  const bytes = st.size;
  const buf = await readFile(abs);
  const text =
    bytes > MAX_FILE_BYTES
      ? `${buf.subarray(0, MAX_FILE_BYTES).toString("utf-8")}\n\n[truncated - file is ${bytes} bytes, showing the first ${MAX_FILE_BYTES}]\n`
      : buf.toString("utf-8");

  return appJson({ path: toPosix(rawPath), text, bytes, mtime: st.mtime.toISOString() } satisfies DocsFileResponse);
}

export async function getDocsSearch(req: Request): Promise<Response> {
  const id = param(req, "id");
  if (!id) return appError("missing project id");
  const project = await findProject(id);
  if (!project) return appError(`no project ${id}`, 404);

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const tree = await buildTree(project.root);
  const matches = q ? tree.filter((e) => e.path.toLowerCase().includes(q) || e.title.toLowerCase().includes(q)) : tree;
  return appJson(matches.slice(0, MAX_SEARCH_RESULTS).map((e) => e.path));
}
