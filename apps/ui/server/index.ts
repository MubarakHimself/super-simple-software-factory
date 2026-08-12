/**
 * SDL Factory UI server - one Bun process, 127.0.0.1:4700 only.
 *
 * Serves the built SPA (./dist) plus a GET-only JSON API over a target repo's
 * sssf.db, queue/*.md, sssf.config.yaml, and read-only git. There is no
 * ingest endpoint, no websocket, and no write anywhere in this process - the
 * data path is agents -> sqlite -> web ui, and the UI gets there by polling.
 *
 *   bun run server/index.ts --db /path/to/repo/adws/adw_data/sssf.db
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { buildObservabilityInfo, configPathFromRepoRoot, readConfig } from "./config.ts";
import { SssfDb, resolveDbPath } from "./db.ts";
import { availableScopes, computeGateItems, resolveDiff } from "./gate.ts";
import { GitRepo, isSafeSegment, repoRootFromDbPath } from "./gitro.ts";
import { readQueue } from "./queue.ts";
import type {
  AgentPrompts,
  ApiError,
  ConfigResponse,
  DiffResponse,
  GateResponse,
  HealthResponse,
  LaneStatus,
  PathsInfo,
  QueueResponse,
} from "../shared/types.ts";

const PORT = 4700;
const HOSTNAME = "127.0.0.1";
const DIST_DIR = resolve(import.meta.dir, "..", "dist");
const BUILD_TIME = existsSync(DIST_DIR) ? statSync(DIST_DIR).mtime.toISOString() : null;

let dbPath: string;
try {
  dbPath = resolveDbPath();
} catch (error) {
  console.error(`[ui] ${(error as Error).message}`);
  process.exit(1);
}

let db: SssfDb;
try {
  db = new SssfDb(dbPath);
} catch (error) {
  console.error(`[ui] ${(error as Error).message}`);
  process.exit(1);
}

const repoRoot = repoRootFromDbPath(dbPath);
const repo = new GitRepo(repoRoot);
const queueDir = join(repoRoot, "queue");
const configPath = configPathFromRepoRoot(repoRoot);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function notFound(message: string): Response {
  return json({ error: message } satisfies ApiError, 404);
}

/** Every /api/ handler goes through this: GET only (spec 4's non-negotiable
 * #1), and any thrown error becomes a 500 with a message instead of taking
 * the whole server down mid-run. */
function safely(handler: (req: Request) => Response | Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json({ error: "this ui is read-only" } satisfies ApiError, 405);
    }
    try {
      return await handler(req);
    } catch (error) {
      console.error(`[ui] ${req.method} ${new URL(req.url).pathname}:`, error);
      return json({ error: (error as Error).message } satisfies ApiError, 500);
    }
  };
}

function param(req: Request, key: string): string {
  return decodeURIComponent((req as Request & { params: Record<string, string> }).params[key] ?? "");
}

function intQuery(req: Request, key: string, fallback: number): number {
  const raw = new URL(req.url).searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function strQuery(req: Request, key: string, fallback: string): string {
  const raw = new URL(req.url).searchParams.get(key);
  return raw === null || raw.trim() === "" ? fallback : raw;
}

async function serveStatic(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (!existsSync(DIST_DIR)) {
    return new Response(
      `SDL Factory UI API is running on :${PORT}, but ./dist has not been built.\n` +
        `Run "just ui" (builds then serves), or "just ui-dev" for the Vite dev server on :4710.\n`,
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const candidate = resolve(join(DIST_DIR, pathname));
  if (candidate === DIST_DIR || candidate.startsWith(DIST_DIR + sep)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return new Response(Bun.file(candidate));
    }
  }
  const indexHtml = join(DIST_DIR, "index.html");
  if (existsSync(indexHtml)) {
    return new Response(Bun.file(indexHtml), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return notFound("not found");
}

const server = (() => {
  try {
    return Bun.serve({
      hostname: HOSTNAME, // loopback only - the shipped visualizer's 0.0.0.0 bind is the landmine
      port: PORT,
      routes: {
        "/api/health": safely(async () => {
          const [isRepo, branch, remote] = await Promise.all([
            repo.isRepo(),
            repo.currentBranch(),
            repo.remoteUrl("origin"),
          ]);
          return json({
            ok: true,
            db: db.path,
            journal_mode: db.journalMode,
            read_only: true,
            sessions: db.sessionCount(),
            queue_dir: queueDir,
            git: { repo: isRepo ? repoRoot : null, branch, remote },
          } satisfies HealthResponse);
        }),

        "/api/sessions": safely((req) => json(db.sessions(intQuery(req, "limit", 200)))),

        "/api/sessions/:adw_id": safely(async (req) => {
          const id = param(req, "adw_id");
          if (!isSafeSegment(id)) return json({ error: "invalid adw_id" } satisfies ApiError, 400);
          const detail = db.sessionDetail(id);
          if (!detail) return notFound(`no session ${id}`);
          const branches = await repo.branchesMatching(`adw/${id}_*`);
          return json({ ...detail, branch: branches[0] ?? null });
        }),

        "/api/sessions/:adw_id/events": safely((req) => {
          const id = param(req, "adw_id");
          if (!isSafeSegment(id)) return json({ error: "invalid adw_id" } satisfies ApiError, 400);
          if (!db.session(id)) return notFound(`no session ${id}`);
          return json(db.events(id, intQuery(req, "after", 0), intQuery(req, "limit", 500)));
        }),

        "/api/sessions/:adw_id/envelopes": safely((req) => {
          const id = param(req, "adw_id");
          if (!isSafeSegment(id)) return json({ error: "invalid adw_id" } satisfies ApiError, 400);
          if (!db.session(id)) return notFound(`no session ${id}`);
          return json(db.envelopes(id));
        }),

        "/api/sessions/:adw_id/gates": safely((req) => {
          const id = param(req, "adw_id");
          if (!isSafeSegment(id)) return json({ error: "invalid adw_id" } satisfies ApiError, 400);
          if (!db.session(id)) return notFound(`no session ${id}`);
          return json(db.gates(id));
        }),

        "/api/sessions/:adw_id/prompts/:agent": safely(async (req) => {
          const adwId = param(req, "adw_id");
          const agent = param(req, "agent");
          if (!isSafeSegment(adwId) || !isSafeSegment(agent)) {
            return json({ error: "invalid adw_id or agent" } satisfies ApiError, 400);
          }
          if (!db.session(adwId)) return notFound(`no session ${adwId}`);

          const dir = resolve(db.sessionsDir, adwId, agent, "prompts");
          if (dir !== db.sessionsDir && !dir.startsWith(db.sessionsDir + sep)) {
            return json({ error: "invalid path" } satisfies ApiError, 400);
          }
          const read = async (name: string): Promise<string | null> => {
            const file = Bun.file(join(dir, `${name}.md`));
            return (await file.exists()) ? await file.text() : null;
          };
          return json({ system: await read("system"), user: await read("user") } satisfies AgentPrompts);
        }),

        "/api/sessions/:adw_id/diff": safely(async (req) => {
          const adwId = param(req, "adw_id");
          if (!isSafeSegment(adwId)) return json({ error: "invalid adw_id" } satisfies ApiError, 400);
          if (!db.session(adwId)) return notFound(`no session ${adwId}`);
          const scope = strQuery(req, "scope", "run");
          if (scope !== "run" && !isSafeSegment(scope)) {
            return json({ error: "invalid scope" } satisfies ApiError, 400);
          }
          const commits = db.commitLog(adwId);
          const scopes = availableScopes(commits);
          if (!scopes.some((s) => s.id === scope)) {
            return json({ error: `unknown scope ${scope}` } satisfies ApiError, 400);
          }
          const sessionDir = join(db.sessionsDir, adwId);
          const diff = await resolveDiff({ repo, sessionDir, commits, scope });
          return json(
            (diff ?? {
              base: "no diff available",
              files: [],
              added: 0,
              deleted: 0,
              patch: "",
              truncated: false,
              empty: true,
            }) satisfies DiffResponse,
          );
        }),

        "/api/queue": safely(async () => json((await readQueue(queueDir)) satisfies QueueResponse)),

        "/api/gate": safely(async () =>
          json({ items: await computeGateItems({ db, repo }, db.sessionsDir) } satisfies GateResponse),
        ),

        "/api/config": safely(async () => {
          const parsed = await readConfig(configPath);
          const observability = buildObservabilityInfo(parsed, db.path, db.journalMode, db.sessionCount());
          const rt = db.laneRoundTrips();
          const lanes: LaneStatus[] = Array.from(rt.entries()).map(([key, v]) => ({
            provider_model: key,
            last_round_trip_at: v.last_at,
            last_round_trip_tokens: v.last_tokens,
            run_count: v.run_count,
            exercised: true,
          }));
          const paths: PathsInfo = { bind: HOSTNAME, port: PORT, read_only: true, build_time: BUILD_TIME };
          return json({
            roster: parsed.roster,
            defaults: parsed.defaults,
            lanes,
            observability,
            paths,
          } satisfies ConfigResponse);
        }),
      },

      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname.startsWith("/api/")) return notFound(`no route ${pathname}`);
        return serveStatic(req);
      },
    });
  } catch (error) {
    const err = error as Error & { code?: string };
    const message = err.message ?? String(error);
    // Bun's own message is "Failed to start server. Is port N in use?" with
    // no "EADDRINUSE" substring - the reliable signal is the `code` field.
    const portTaken =
      err.code === "EADDRINUSE" || message.includes("EADDRINUSE") || message.toLowerCase().includes("in use");
    if (portTaken) {
      console.error(`[ui] port ${PORT} is in use - stop the other ui process`);
    } else {
      console.error(`[ui] failed to start: ${message}`);
    }
    process.exit(1);
  }
})();

console.log(`[ui] http://${HOSTNAME}:${server.port}`);
console.log(`[ui] db     ${db.path}  [journal_mode=${db.journalMode}]`);
console.log(`[ui] queue  ${queueDir}`);
console.log(
  existsSync(DIST_DIR) ? `[ui] serving built ui from ${DIST_DIR}` : `[ui] no ./dist yet - build, or use ui-dev`,
);

process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});
