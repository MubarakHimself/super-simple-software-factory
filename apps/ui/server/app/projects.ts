/**
 * `/api/app/projects` - list, probe, add, remove. The manifest
 * (`~/.sdl-factory/config.json`) is the only source of truth; this file is the
 * request/response shape around `manifest.ts`.
 *
 * ── Why the POST carries an intent ─────────────────────────────────────────
 * The Add-project modal needs three things from this path: "tell me what is at
 * this path" (detection rows), "register it" (Add), and "stop listing it"
 * (removing the auto-seeded self-repo, and any path added by mistake). The
 * route table mounts exactly one method per path here (`GET` + `POST` on
 * `/api/app/projects`), and the mount lives in `routes.ts`, which this lane
 * does not own - so the POST names what it is doing instead of pretending
 * three verbs exist:
 *
 *   {"path": "..."}                     -> add (unchanged default; the
 *   {"path": "...", "intent": "add"}       shell's older callers keep working)
 *   {"path": "...", "intent": "probe"}  -> read-only detection, writes nothing
 *   {"id": "...",   "intent": "remove"} -> drops one registration
 *
 * An unknown intent is refused by name rather than silently treated as "add" -
 * a write that happens because a word was not recognised is the worst kind.
 */
import { appError, appJson } from "./guard.ts";
import { describePath, readManifest, removeProject, upsertProject } from "./manifest.ts";

export async function listProjects(): Promise<Response> {
  const manifest = await readManifest();
  return appJson(manifest.projects);
}

export async function createProject(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return appError("invalid JSON body");
  }
  const fields = (body ?? {}) as { path?: unknown; id?: unknown; intent?: unknown };
  const intent = typeof fields.intent === "string" && fields.intent.trim() ? fields.intent.trim() : "add";

  if (intent === "remove") {
    const id = fields.id;
    if (typeof id !== "string" || !id.trim()) return appError("id is required to remove a project");
    const removed = await removeProject(id);
    if (!removed.ok) return appError(removed.error, 404);
    return appJson({ removed: removed.project });
  }

  if (intent !== "add" && intent !== "probe") {
    return appError(`unknown intent "${intent}" - use "probe", "add" or "remove"`);
  }

  const path = fields.path;
  if (typeof path !== "string" || !path.trim()) {
    return appError("path is required");
  }

  if (intent === "probe") {
    const probe = await describePath(path);
    if ("ok" in probe) return appError(probe.error);
    return appJson(probe);
  }

  const result = await upsertProject(path);
  if (!result.ok) return appError(result.error);
  return appJson(result.project, 201);
}
