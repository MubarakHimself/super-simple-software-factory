/**
 * The one fetch seam. The v2 UI reads exclusively `/api/app/*` (spec section
 * 4); `/api/*` belongs to the v1 SPA and stays untouched.
 *
 * Failures carry the server's own error string and nothing else - the shell
 * renders `read failed - <that string>` verbatim (spec 2.1). We never invent a
 * friendlier sentence, because a friendlier sentence is a sentence the server
 * did not say.
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

/** Every write carries `X-App-Token`; the server checks it plus Origin (spec 1.2). */
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

/** The shapes the shell itself depends on. Surfaces own their own types. */
export interface Project {
  id: string;
  name: string;
  root: string;
  added_at: string;
  last_opened_at: string | null;
}

export interface Readiness {
  git: { is_repo: boolean; branch: string | null; remote: string | null; dirty: boolean | null };
  factory: { config: boolean; queue_template: boolean; db: boolean; justfile: boolean; adws: boolean };
  harnesses: Record<string, { state: "ready" | "missing"; version: string | null; path: string | null; can_steer: boolean }>;
  runs: { count: number };
}

/** The one 2s poll (spec 1.3, W2-A3). Only `counts` is the shell's business. */
export interface Live {
  running: unknown[];
  /** ISO timestamp of the newest `queue/*.md` mtime, as the server sends it
   * (`live.ts` -> `queue_mtime: string | null`); null when there is no queue. */
  queue_mtime: string | null;
  counts: { board_ready: number; runs_running: number; gate: number };
}

export interface Provider {
  id: string;
  bin: string;
  resolved_path: string | null;
  version: string | null;
  state: "ready" | "missing" | "error";
  detail: string | null;
}
