/**
 * `~/.sdl-factory/projects/<id>/seen.json` (spec 1.4, 1.3's table row,
 * chunk K2a). Backs Home/Overnight (spec 2.2): "runs = /runs filtered by
 * seen.at; card movement = diff of current queue/*.md statuses against
 * seen.json's snapshot ... app-owned state (W2 Open 3 -> adopted)".
 *
 * The load-bearing rule, restated from spec 2.2 because it is the one place
 * the obvious design is wrong: **the snapshot advances at most once per
 * server process.** The first `POST /seen` of a process writes the CURRENT
 * queue snapshot to disk and returns the PREVIOUS one (what Home renders);
 * every later `POST` in that same process is a no-op that returns the same
 * previous value again. A browser refresh at 07:05 must show the same
 * overnight summary it showed at 07:00 - writing on every open would erase
 * exactly what W2-C3 ("reopen at 07:00, nothing lost") exists to preserve.
 * The window closes only when the server restarts.
 *
 * The snapshot itself is computed server-side from the live `queue/` state
 * (`readQueue`, this chunk's own `criteria.ts` sibling), never accepted from
 * the request body - the file's `cards:{path:status}` shape (spec 1.4) is
 * ground truth the server already owns; trusting a client-posted snapshot
 * would be the mock-data ban applied to app state instead of factory state.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readQueue } from "../queue.ts";
import { appJson, appSafely, csrfGuard } from "./guard.ts";
import { appHome } from "./manifest.ts";
import { findProject, type ManifestProject } from "./manifest.ts";
import { param } from "./scoped.ts";

export interface SeenSnapshot {
  at: string;
  cards: Record<string, string>;
}

function seenPath(projectId: string): string {
  return join(appHome(), "projects", projectId, "seen.json");
}

async function readSeen(projectId: string): Promise<SeenSnapshot | null> {
  const path = seenPath(projectId);
  if (!existsSync(path)) return null;
  try {
    const text = await readFile(path, "utf-8");
    const parsed = JSON.parse(text) as Partial<SeenSnapshot>;
    if (typeof parsed.at !== "string" || typeof parsed.cards !== "object" || parsed.cards === null) return null;
    return { at: parsed.at, cards: parsed.cards as Record<string, string> };
  } catch (error) {
    console.error(`[ui] app: could not read ${path}: ${(error as Error).message}`);
    return null;
  }
}

async function writeSeen(projectId: string, snapshot: SeenSnapshot): Promise<void> {
  const path = seenPath(projectId);
  await mkdir(join(appHome(), "projects", projectId), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}

async function currentCardStatuses(project: ManifestProject): Promise<Record<string, string>> {
  const queue = await readQueue(join(project.root, "queue"));
  const cards: Record<string, string> = {};
  for (const item of queue.items) cards[item.path] = item.status;
  return cards;
}

/** id -> the previous snapshot this process has already handed back, once a
 * POST has landed for it. Presence in the map (even mapped to null, for a
 * project with no prior seen.json) is what marks "already written this
 * process" - absence is what lets the first POST through. */
const writtenThisProcess = new Map<string, SeenSnapshot | null>();

async function postSeen(req: Request): Promise<Response> {
  const id = param(req, "id");
  const project = await findProject(id);
  if (!project) return appJson({ error: `no project ${id}` }, 404);

  if (writtenThisProcess.has(id)) {
    return appJson({ previous: writtenThisProcess.get(id) ?? null });
  }

  const previous = await readSeen(id);
  const next: SeenSnapshot = { at: new Date().toISOString(), cards: await currentCardStatuses(project) };
  await writeSeen(id, next);
  writtenThisProcess.set(id, previous);

  return appJson({ previous });
}

async function getSeen(req: Request): Promise<Response> {
  const id = param(req, "id");
  const project = await findProject(id);
  if (!project) return appJson({ error: `no project ${id}` }, 404);

  const previous = await readSeen(id);
  return appJson({ previous });
}

export function seenRoutes(token: string, selfOrigins: ReadonlySet<string>) {
  return {
    "/api/app/p/:id/seen": {
      GET: appSafely(getSeen),
      POST: csrfGuard(token, selfOrigins, postSeen),
    },
  };
}
