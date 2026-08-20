/**
 * The one fetch seam. v3 reads exclusively `/api/app/*` (the app plane in
 * `apps/ui/server/app/routes.ts`); `/api/*` belongs to the v1 SPA and stays
 * untouched. Paths are relative, always - the app is served from the same
 * origin as the API, and a hard-coded host is how a packaged build breaks.
 *
 * Failures carry the server's own error string and nothing else. The UI
 * renders `read failed - <that string>` verbatim. We never invent a friendlier
 * sentence, because a friendlier sentence is a sentence the server did not
 * say.
 */
import { appToken } from "./token.ts";

export class ApiFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error.trim()) return body.error;
  } catch {
    /* not JSON - fall through to the status line */
  }
  return `${res.status} ${res.statusText}`.trim();
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new ApiFailure(await readError(res), res.status);
  return (await res.json()) as T;
}

/** Every write carries `X-App-Token`; the server checks it plus Origin. */
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const token = appToken();
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { "X-App-Token": token } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new ApiFailure(await readError(res), res.status);
  return (await res.json()) as T;
}

/* ── the shapes the shell itself depends on ─────────────────────────────────
   A surface owns its own types in its own directory; only what the sidebar,
   the topbar and the status footer read lives here. */

/** `GET /api/app/projects` - the manifest in `~/.sdl-factory/config.json`.
 * There is no colour field: the per-project accent is derived from list order
 * in `lib/projectColor.ts`, so two machines showing the same manifest show the
 * same colours without storing anything. */
export interface Project {
  id: string;
  name: string;
  root: string;
  added_at: string;
  last_opened_at: string | null;
}

/** `GET /api/app/p/:id/live` - the one 2s poll. The shell reads `counts` for
 * the sidebar's nav numbers; the Board and Runs surfaces read the rest. */
export interface Live {
  running: unknown[];
  queue_mtime: string | null;
  counts: { board_ready: number; runs_running: number; gate: number };
}

/** `GET /api/app/p/:id/factory/health` - the factory-status footer's source of
 * truth. `engine: "unknown"` is a first-class answer, not an error; when the
 * endpoint itself is absent the read 404s and the footer says that plainly.
 *
 * `source` distinguishes an answer a running engine gave from one this machine
 * derived from files and git - the footer says which, because a derived number
 * is a weaker claim than a reported one.
 *
 * Two shapes are accepted, deliberately. The server's shipped shape nests the
 * queue counts and makes every unknowable field nullable WITH a reason string
 * (`lanes_active: null` + `lanes_reason`, `uptime_seconds: null` +
 * `uptime_reason`); the flat `queue_ready` / `queue_running` pair is the
 * originally agreed contract and is still read if it appears. Everything past
 * `engine`/`source` is optional here, so a field the server adds or drops
 * cannot blank the strip. */
export interface FactoryQueueCounts {
  ready: number;
  running: number;
  [state: string]: number;
}

/** `POST /api/app/p/:id/sync` — the topbar Sync button's one write (a `git
 * fetch` + `merge --ff-only` in the project's own checkout; see
 * `server/app/sync.ts`'s header for the full policy). Every status is a named,
 * honest outcome — never pushes, never forces, and a dirty or diverged
 * checkout is reported rather than skipped in silence. */
export type RepoSyncStatus =
  | "pulled"
  | "up-to-date"
  | "dirty"
  | "diverged"
  | "detached"
  | "no-remote"
  | "not-a-repo"
  | "failed";

export interface RepoSyncResult {
  status: RepoSyncStatus;
  detail: string;
  branch: string | null;
  before_sha: string | null;
  after_sha: string | null;
}

export interface SyncResponse {
  repo: RepoSyncResult;
  checked_at: string;
}

export interface FactoryHealth {
  engine: "running" | "stopped" | "unknown";
  /** `"server"` = a registered machine answered over SSH and `source_host`
   * names it; `"local-derived"` = nothing that runs an engine was asked. */
  source: "server" | "local-derived";
  /** the machine that produced `engine`, set whenever one was ASKED - it is
   * set on an unreachable box too, which is why the strip can say "unknown"
   * and still name who did not answer. */
  source_host?: string | null;
  /** systemd's restart count on that machine; null when nobody was asked. */
  engine_restarts?: number | null;
  engine_reason?: string | null;
  uptime_seconds?: number | null;
  uptime_reason?: string | null;
  /** null when only a running engine could know it. */
  lanes_active?: number | null;
  lanes_reason?: string | null;
  lanes?: unknown[];
  queue?: FactoryQueueCounts;
  /** the flat pair, from the agreed contract. */
  queue_ready?: number;
  queue_running?: number;
  runs_running?: number | null;
  factory?: "present" | "absent";
  factory_reason?: string | null;
  checked_at?: string;
}
