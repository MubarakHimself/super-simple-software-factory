/**
 * The Session bridge's HTTP surface (spec 1.3's Session bridge table):
 * `POST /api/app/sessions`, `GET /api/app/sessions`,
 * `GET /api/app/sessions/:id/stream`, `POST /api/app/sessions/:id/input`,
 * `POST /api/app/sessions/:id/answer`, `POST /api/app/sessions/:id/stop`,
 * `GET /api/app/sessions/:id/raw`, `POST /api/app/sessions/:id/resize`.
 *
 * Exports `sessionRoutes`, a Bun `routes` fragment shaped exactly like
 * `routes.ts`'s own `appRoutes` (spec 4's `routes.ts` header names "the
 * session bridge" as one of the files meant to "plug its own route fragment
 * in here as it lands"). K12 performed that mount: `routes.ts` now spreads
 * this fragment into `appRoutes`, and the APP_TOKEN import cycle it warned
 * about was broken by moving the token itself into `guard.ts` (which
 * `routes.ts` re-exports, so `index.ts`'s permitted import is unchanged).
 */
import { APP_TOKEN, SELF_ORIGINS, appError, appJson, appSafely, csrfGuard } from "../guard.ts";
import {
  answer,
  attachRaw,
  createSession,
  detachRaw,
  getMeta,
  hasLiveSession,
  hasRaw,
  listSessions,
  readPersistedEvents,
  resizeRaw,
  sendInput,
  stop,
  subscribeLive,
} from "./store.ts";
import type { PtyListener } from "./pty.ts";
import type { ChainState, HarnessId, SessionMode } from "./types.ts";

function param(req: Request, key: string): string {
  return decodeURIComponent((req as Request & { params: Record<string, string> }).params[key] ?? "");
}

function intQuery(req: Request, key: string, fallback: number): number {
  const raw = new URL(req.url).searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const HARNESSES: readonly HarnessId[] = ["claude", "codex", "pi"];
const MODES: readonly SessionMode[] = ["chain", "terminal"];

async function createSessionHandler(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return appError("invalid JSON body");
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const projectId = typeof b.projectId === "string" ? b.projectId : "";
  const harness = b.harness as HarnessId;
  const mode = b.mode as SessionMode;
  const prompt = typeof b.prompt === "string" ? b.prompt : "";

  if (!projectId) return appError("projectId is required");
  if (!HARNESSES.includes(harness)) return appError(`harness must be one of ${HARNESSES.join(", ")}`);
  if (!MODES.includes(mode)) return appError(`mode must be one of ${MODES.join(", ")}`);
  if (mode === "chain" && !prompt.trim()) return appError("prompt is required for mode=chain");

  const result = await createSession({ projectId, harness, mode, prompt, chain: readChain(b.chain) });
  if (!result.ok) return appError(result.error, result.status);
  return appJson({ sessionId: result.sessionId });
}

/** The Chain the client derived from the invoked skill (spec 2.3: app-owned,
 * "identical across harnesses"). Stored verbatim when it is the declared
 * shape and dropped entirely when it is not - the server never repairs a
 * malformed chain into a plausible one, because a plausible chain nobody
 * declared is invented structure. */
function readChain(raw: unknown): ChainState | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { entered_at_step?: unknown; steps?: unknown };
  if (typeof c.entered_at_step !== "string" || !Array.isArray(c.steps)) return null;
  if (!c.steps.every((s) => typeof s === "string")) return null;
  return { entered_at_step: c.entered_at_step, steps: c.steps as string[] };
}

function listSessionsHandler(): Response {
  return appJson(listSessions());
}

// ---------------------------------------------------------------------------
// SSE plumbing shared by the normalized event stream and the raw pty stream.
// ---------------------------------------------------------------------------

/** The SSE `id:` line is set for native `EventSource` reconnects, but the
 * cursor is ALSO embedded in the JSON payload itself (`seq` alongside the
 * event) - spec 1.3 threads the cursor through an explicit `?after=` query
 * parameter, not the browser's own `Last-Event-ID` replay, so a fetch-based
 * SSE reader (equally likely as `EventSource` for a client that also needs
 * to POST) must not have to also parse the `id:` line just to resume. */
function sseEvent(seq: number, event: unknown): Uint8Array {
  return new TextEncoder().encode(`id: ${seq}\ndata: ${JSON.stringify({ seq, event })}\n\n`);
}

/** `appSafely` (guard.ts) only forwards a single `(req)` argument, so the two
 * streaming routes - which need Bun's own second `server` argument for
 * `server.timeout()` (see streamHandler's header) - wrap themselves the same
 * way appSafely does (log + `{error}` 500 on a throw) rather than going
 * through it. */
function safeStreamRoute(
  handler: (req: Request, server: { timeout(req: Request, seconds: number): void }) => Response,
): (req: Request, server: { timeout(req: Request, seconds: number): void }) => Response {
  return (req, server) => {
    try {
      return handler(req, server);
    } catch (error) {
      console.error(`[ui] app ${req.method} ${new URL(req.url).pathname}:`, error);
      return appError((error as Error).message, 500);
    }
  };
}

function sseHeaders(): Record<string, string> {
  return { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" };
}

/** `controller.enqueue` throws (`ERR_INVALID_STATE`) once the underlying
 * connection is gone - a browser tab closed, a network drop, or (found live
 * while building this chunk) Bun's OWN default 10s idle timeout closing a
 * quiet-but-still-live Session's SSE connection out from under it. That
 * throw happens asynchronously, inside a `pty`/child-process data callback
 * nowhere near any request's own try/catch (`appSafely` cannot see it - the
 * write happens long after the handler that opened the stream returned), so
 * an unguarded enqueue is an uncaught exception with no request to blame it
 * on. Every enqueue in this file goes through here: on failure it reports
 * "dead" so the caller unsubscribes instead of leaking a subscription that
 * will only ever fail again. */
function safeEnqueue(controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array): boolean {
  try {
    controller.enqueue(bytes);
    return true;
  } catch {
    return false;
  }
}

/** `GET /api/app/sessions/:id/stream?after=` - normalized `SessionEvent`s,
 * replayed from the durable cursor (spec 1.3). Live in this process: backlog
 * then live. Not live (unknown id, or a session from before a restart):
 * whatever `events.ndjson` has after the cursor, then the stream closes -
 * "the Session renders as ended" (Open Decision 6) is the client's own
 * inference from the stream ending with no live tail, not a field this
 * response invents.
 *
 * `server.timeout(req, 0)` disables Bun's default 10s idle timeout for this
 * request specifically (found live: a Session that goes quiet for 10s - an
 * unremarkable thinking pause - otherwise has its SSE connection force-closed
 * by Bun itself, independent of anything this file or the client does). This
 * is the one thing in this chunk that reaches for the `server` argument
 * Bun's route dispatcher passes as the handler's second parameter - which is
 * exactly why this route bypasses `guard.ts`'s `appSafely` (single-arg) and
 * wraps its own try/catch instead. */
function streamHandler(req: Request, server: { timeout(req: Request, seconds: number): void }): Response {
  server.timeout(req, 0);
  const id = param(req, "id");
  if (!id) return appError("missing session id");
  const after = intQuery(req, "after", 0);

  // Existence is checked BEFORE the Response/ReadableStream is constructed -
  // SSE responses commit their 200 status the instant the stream starts, so
  // an unknown id must 404 the ordinary way rather than open-then-error a
  // stream the client already has to treat as a 200.
  if (!hasLiveSession(id) && getMeta(id) === null) return appError(`no session ${id}`, 404);

  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const liveSub = subscribeLive(id, after, (stored) => {
        if (!safeEnqueue(controller, sseEvent(stored.seq, stored.event))) unsubscribe?.();
      });

      if (liveSub) {
        for (const stored of liveSub.backlog) {
          if (!safeEnqueue(controller, sseEvent(stored.seq, stored.event))) return;
        }
        if (liveSub.ended) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }
        unsubscribe = liveSub.unsubscribe;
        return;
      }

      // Not live in this process (unknown-to-memory or server-restarted) -
      // whatever the file has after the cursor, then close (Open Decision 6:
      // "the Session renders as ended").
      for (const stored of readPersistedEvents(id, after) ?? []) {
        if (!safeEnqueue(controller, sseEvent(stored.seq, stored.event))) return;
      }
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

async function inputHandler(req: Request): Promise<Response> {
  const id = param(req, "id");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return appError("invalid JSON body");
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const text = typeof b.text === "string" ? b.text : "";
  const mode = b.mode === "steer" || b.mode === "queue" ? b.mode : null;
  // Emptiness, not blankness: a terminal-mode Session's keystrokes come
  // through here as raw bytes, and Enter is "\r" - a `trim()` test would
  // reject the single most-pressed key on the surface. A chain-mode adapter
  // is unharmed by whitespace; store.ts routes on the session, not on this.
  if (text.length === 0) return appError("text is required");
  if (!mode) return appError("mode must be 'steer' or 'queue'");

  const result = sendInput(id, text, mode);
  return result.ok ? appJson({ ok: true }) : appError(result.error, 409);
}

async function answerHandler(req: Request): Promise<Response> {
  const id = param(req, "id");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return appError("invalid JSON body");
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const requestId = typeof b.requestId === "string" ? b.requestId : "";
  const optionId = typeof b.optionId === "string" ? b.optionId : undefined;
  const text = typeof b.text === "string" ? b.text : undefined;
  if (!requestId) return appError("requestId is required");
  if (!optionId && !text) return appError("optionId or text is required");

  const result = answer(id, requestId, { optionId, text });
  return result.ok ? appJson({ ok: true }) : appError(result.error, 409);
}

function stopHandler(req: Request): Response {
  const id = param(req, "id");
  const result = stop(id);
  return result.ok ? appJson({ ok: true }) : appError(result.error, 404);
}

/** `GET /api/app/sessions/:id/raw` - the Terminal escape hatch: raw pty
 * bytes over SSE, replaying pty.ts's backscroll buffer on every attach (spec
 * 1.3). Each SSE `data:` line here is a plain string (the raw chunk), not a
 * `SessionEvent` - this stream is a different contract on purpose (§1.3:
 * "it carries normalized events, never raw bytes" describes events.ndjson;
 * this is the other half). */
function rawStreamHandler(req: Request, server: { timeout(req: Request, seconds: number): void }): Response {
  server.timeout(req, 0); // see streamHandler's header - same idle-timeout finding applies here
  const id = param(req, "id");
  if (!id) return appError("missing session id");
  if (!hasRaw(id)) return appError(`no terminal session ${id}`, 404);

  let listener: PtyListener | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let seq = 0;
      const l: PtyListener = {
        onData: (chunk) => {
          if (!safeEnqueue(controller, sseEvent(seq++, { kind: "data", chunk }))) detachRaw(id, l);
        },
        onExit: (code) => {
          safeEnqueue(controller, sseEvent(seq++, { kind: "exit", code }));
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      };
      const attached = attachRaw(id, l);
      if (!attached) {
        // Raced closed between the pre-check above and here (session ended
        // in the interim) - close cleanly rather than error a 200 already
        // in flight.
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }
      listener = l;
    },
    cancel() {
      if (listener) detachRaw(id, listener);
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

async function resizeHandler(req: Request): Promise<Response> {
  const id = param(req, "id");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return appError("invalid JSON body");
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const cols = typeof b.cols === "number" ? b.cols : NaN;
  const rows = typeof b.rows === "number" ? b.rows : NaN;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
    return appError("cols and rows must be positive numbers");
  }
  const ok = resizeRaw(id, cols, rows);
  return ok ? appJson({ ok: true }) : appError(`no terminal session ${id}`, 404);
}

export const sessionRoutes = {
  "/api/app/sessions": {
    GET: appSafely(async () => listSessionsHandler()),
    POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, createSessionHandler),
  },
  "/api/app/sessions/:id/stream": { GET: safeStreamRoute(streamHandler) },
  "/api/app/sessions/:id/input": { POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, inputHandler) },
  "/api/app/sessions/:id/answer": { POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, answerHandler) },
  "/api/app/sessions/:id/stop": { POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, async (req) => stopHandler(req)) },
  "/api/app/sessions/:id/raw": { GET: safeStreamRoute(rawStreamHandler) },
  "/api/app/sessions/:id/resize": { POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, resizeHandler) },
};
