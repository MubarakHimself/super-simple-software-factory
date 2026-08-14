/**
 * `/api/app/projects` - list + add (spec 1.3 table row 2, W1-A1/A2/B7,
 * W3-A1/A2). The manifest (`~/.sdl-factory/config.json`) is the only source
 * of truth; this file is the request/response shape around `manifest.ts`'s
 * upsert.
 */
import { appError, appJson } from "./guard.ts";
import { readManifest, upsertProject } from "./manifest.ts";

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
  const path = (body as { path?: unknown } | null)?.path;
  if (typeof path !== "string" || !path.trim()) {
    return appError("path is required");
  }

  const result = await upsertProject(path);
  if (!result.ok) return appError(result.error);
  return appJson(result.project, 201);
}
