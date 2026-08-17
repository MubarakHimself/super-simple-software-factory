/**
 * Response helpers + the CSRF guard for the app plane (spec 1.2).
 *
 * `/api/*` stays GET-only (index.ts's own `safely()`, untouched). `/api/app/*`
 * is the bounded write plane, so every non-GET request on it must present:
 *
 *   (a) an `Origin` header equal to this server's own origin, or absent
 *   (b) header `X-App-Token` matching the per-process token injected into
 *       `apps/ui-v2/dist/index.html` at serve time (index.ts's third
 *       permitted edit) - the value `routes.ts` generates as `APP_TOKEN`
 *
 * Failure -> 403, one-line JSON error. Without this, spawning processes over
 * loopback HTTP - which POST `/api/app/sessions` will do once the bridge
 * lands - is a remote-code-execution hole any page in the browser can open.
 */

export interface AppApiError {
  error: string;
}

/**
 * Per-process, random, never logged. The only thing that proves a write
 * request came from this server's own served page (spec 1.2).
 *
 * It lives HERE rather than in `routes.ts` (which still re-exports it, so
 * `index.ts`'s permitted import is unchanged) because `routes.ts` now mounts
 * `sessions/bridge.ts`, and `bridge.ts` needs the token at module-evaluation
 * time to build its own route fragment. Declared in `routes.ts`, that is an
 * import cycle whose token read lands in the temporal dead zone: bridge.ts is
 * evaluated as a dependency of routes.ts, before routes.ts's own
 * `const APP_TOKEN = ...` line runs. This is the "APP_TOKEN import-cycle note"
 * bridge.ts's header hands to whoever mounts it (K12). guard.ts is the honest
 * home anyway - the token is the guard's own secret.
 */
export const APP_TOKEN: string = crypto.randomUUID();

/** The app's own origin, plus the dev Vite origins - one per UI generation,
 * so a dev server can run beside the API (spec section 4: "Vite dev server:
 * 4720, proxying /api to 4700"). All are loopback ports bound by the
 * operator's own tooling, never a third party's page.
 *
 * 4730 is `ui3-dev`. It belongs here for the same reason 4720 does, and its
 * absence was a real break: `apps/ui-v3/vite.config.ts` proxies with
 * `changeOrigin: false`, so the browser's own `http://127.0.0.1:4730` Origin
 * reaches this check verbatim and every write from the v3 dev SPA - add
 * project, roster, lanes, providers, machines - answered 403 "origin
 * mismatch". `just ui3` (built SPA on 4700) was unaffected, which is why it
 * survived this long. */
export const SELF_ORIGINS: ReadonlySet<string> = new Set([
  "http://127.0.0.1:4700",
  "http://127.0.0.1:4720",
  "http://127.0.0.1:4730",
]);

/** Every `/api/app/*` JSON response: `cache-control: no-store` (spec 1.3 -
 * "all new, all under /api/app/, all JSON cache-control: no-store"). */
export function appJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function appError(message: string, status = 400): Response {
  return appJson({ error: message } satisfies AppApiError, status);
}

/**
 * The only names this server answers to.
 *
 * WHY A HOST CHECK EXISTS AT ALL. `csrfGuard` covers the WRITE plane, but every
 * `/api/app/*` GET was reachable with no token and no origin check, and this
 * server - though bound to 127.0.0.1 - answers whatever arrives at that socket
 * whatever name it was asked by. That is the DNS-rebinding shape: a page on
 * `evil.example` whose name resolves, on its second lookup, to 127.0.0.1, then
 * reads `/api/app/terminals/:id/raw` (a live shell's whole ring buffer),
 * `/api/app/machines` (hosts, users, key paths, fingerprints) and
 * `/api/app/auth-session` (scrubbed transcripts plus the live pairing code) -
 * and `GET /` hands out the per-process APP_TOKEN in the injected HTML, so the
 * write plane falls with the read plane.
 *
 * A rebound request carries the ATTACKER's name in `Host`, because that is the
 * name the browser was told to fetch. Bun builds `req.url` from that header, so
 * comparing its hostname against loopback is the whole check, and no browser
 * can spoof it (`Host` is a forbidden header name - script cannot set it).
 *
 * Port-blind on purpose: the Vite dev servers proxy with `changeOrigin: false`,
 * so their `Host` is `127.0.0.1:4730`, and pinning the port would break every
 * dev read while adding nothing (an attacker who can choose a loopback name has
 * already lost this check).
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0000:0000:0000:0000:0000:0000:0000:0001"]);

/** True when this request asked for a loopback name. Anything else is a request
 * that reached our socket under somebody else's name. */
export function isLoopbackRequest(req: Request): boolean {
  let hostname: string;
  try {
    hostname = new URL(req.url).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Wraps any `/api/app/*` handler so a throw becomes `{error}` + 500 instead
 * of taking the whole server down mid-request (spec 1.3: "wrapped so a throw
 * returns {error} + 500, never a dead server") - the app-plane twin of
 * index.ts's `safely()`.
 *
 * It is also where the loopback-host check lives, so it covers the READ plane
 * as well as the write plane (`csrfGuard` wraps itself in this function). One
 * place, every `/api/app/*` route. */
export function appSafely(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      if (!isLoopbackRequest(req)) return appError("this server answers on loopback only", 403);
      return await handler(req);
    } catch (error) {
      console.error(`[ui] app ${req.method} ${new URL(req.url).pathname}:`, error);
      return appJson({ error: (error as Error).message } satisfies AppApiError, 500);
    }
  };
}

/**
 * Wraps a write handler (POST/PUT/DELETE) with the origin+token check, then
 * `appSafely`. `selfOrigins` is a set rather than one string so the Vite dev
 * server (`:4720`, proxying `/api` to `:4700` per spec section 4) can be
 * trusted too without weakening the production check - both are loopback
 * ports the operator's own tooling binds, never a third party's origin.
 */
export function csrfGuard(
  token: string,
  selfOrigins: ReadonlySet<string>,
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return appSafely(async (req) => {
    const origin = req.headers.get("origin");
    if (origin !== null && !selfOrigins.has(origin)) {
      return appError("origin mismatch", 403);
    }
    const presented = req.headers.get("x-app-token");
    if (!presented || presented !== token) {
      return appError("missing or invalid X-App-Token", 403);
    }
    return handler(req);
  });
}
