/**
 * The app-plane route table (spec 4, chunk K0). This is the ONE thing
 * `index.ts` imports: `appRoutes`, spread into its own `routes` object
 * (index.ts's first permitted edit), and `APP_TOKEN`, used at serve time to
 * inject `window.__APP_TOKEN__` into `apps/ui-v2/dist/index.html` (index.ts's
 * third permitted edit).
 *
 * Every other `server/app/*.ts` file this build adds (scoped reads, docs,
 * skills, providers, jobs, the session bridge, ...) plugs its own route
 * fragment in here as it lands - this file is the seam, not a dead end.
 * It now carries the whole app plane: health/projects/readiness, the
 * machine-scoped reads (skills, files, providers), every per-project read
 * (live, runs, worklog, quality, worktrees, queue, gate, docs, seen, config),
 * the two initialization writes with their job poll, and the Session bridge.
 */
import { hostname } from "node:os";
import { acceptanceRoutes } from "./acceptance.ts";
import { authSessionRoutes } from "./auth-sessions.ts";
import { cardsRoutes } from "./cards.ts";
import { criteriaRoutes } from "./criteria.ts";
import { getDocsFile, getDocsSearch, getDocsTree } from "./docs.ts";
import { factoryRoutes } from "./factory.ts";
import { getFiles } from "./files.ts";
import { APP_TOKEN, SELF_ORIGINS, appJson, appSafely, csrfGuard } from "./guard.ts";
import { initFactory, initGit } from "./init.ts";
import { getJobStatus } from "./jobs.ts";
import { liveRoutes } from "./live.ts";
import { machinesRoutes } from "./machines.ts";
import { mergeRoutes } from "./merge.ts";
import { getModels } from "./models.ts";
import { createProject, listProjects } from "./projects.ts";
import { readManifest, seedBootProject } from "./manifest.ts";
import { getProviders } from "./providers.ts";
import { providersV3Routes } from "./providers-v3.ts";
import { getReadiness } from "./readiness.ts";
import { rosterRoutes } from "./roster.ts";
import { seenRoutes } from "./seen.ts";
import { sessionRoutes } from "./sessions/bridge.ts";
import { shipRoutes } from "./ship.ts";
import { getSkills } from "./skills.ts";
import { syncRoutes } from "./sync.ts";
import { terminalRoutes } from "./terminals.ts";
import { worklogRoutes } from "./worklog.ts";
import { worktreesRoutes } from "./worktrees.ts";

/** Re-exported so `index.ts`'s permitted import
 * (`import { APP_TOKEN, appRoutes } from "./app/routes.ts"`) is unchanged; the
 * declaration moved to `guard.ts` to break the routes -> bridge -> routes
 * cycle (see guard.ts's own note). */
export { APP_TOKEN } from "./guard.ts";

// Seeds `~/.sdl-factory/config.json` with the boot repo (spec 1.4) before any
// route runs. This is a static import's top-level await, so Bun's module
// loader finishes it before index.ts's own top-level code continues past its
// `import { appRoutes, APP_TOKEN } from "./app/routes.ts"` line - meaning
// index.ts's own `resolveDbPath()` call still runs afterward and is still
// the thing that prints the clean "[ui] missing --db ..." message and exits
// when `--db` is absent (seedBootProject swallows that same failure quietly
// so it never prints a second, confusing copy of the same error).
await seedBootProject();

export const appRoutes = {
  // The Session bridge (spec 1.3's own table), mounted here because this file
  // is the app plane's one seam - "every other server/app/*.ts file plugs its
  // own route fragment in here as it lands ... the session bridge" (K11's
  // bridge.ts header hands this mount to K12).
  ...sessionRoutes,

  // The Terminal surface (the KISS correction): a plain shell over a plain
  // pty, deliberately beside the Session bridge rather than inside it - it
  // shares nothing but the idea of a pty. See terminals.ts's header.
  ...terminalRoutes,

  "/api/app/health": appSafely(async () => {
    const manifest = await readManifest();
    return appJson({
      ok: true,
      host: { name: hostname() },
      projects: manifest.projects.length,
      // "ready" is a statement about this process, and it is now true: the
      // bridge's routes are mounted three lines above. The UI reads this to
      // decide between a real Session and spec 2.3's honest scaffold line.
      bridge: "ready" as const,
    });
  }),

  "/api/app/projects": {
    GET: appSafely(async () => listProjects()),
    POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, createProject),
  },

  "/api/app/projects/:id/readiness": {
    GET: appSafely(getReadiness),
  },

  // Machine-scoped reads (spec 1.3): skills feed the slash menu, files feed
  // the `@` menu and the palette, providers feed Settings.
  "/api/app/skills": appSafely(getSkills),
  "/api/app/files": appSafely(getFiles),
  "/api/app/providers": appSafely(getProviders),
  // The lanes pi knows on this machine, grouped by provider - what Roster's
  // model dropdown is built from. Cost-free (`--list-models` prints a table and
  // exits), cached per process, `?refresh=1` to re-probe.
  "/api/app/models": appSafely(getModels),

  // Per-project reads. Each module owns its own fragment; this file is the
  // one place they are mounted.
  ...liveRoutes, // live, runs, run detail, events/diff/gates/envelopes, config
  ...worklogRoutes, // worklog, quality
  ...worktreesRoutes,
  ...criteriaRoutes, // queue + criteria
  ...acceptanceRoutes, // gate + acceptance walk
  // The Merge button's endpoint: `git merge --ff-only` in the main checkout +
  // the run's queue card moved into `queue/done/`, atomically or not at all
  // (dispatch.py: that move IS the merge event). The only route on this plane
  // that writes to the repo, and it never forces.
  ...mergeRoutes(APP_TOKEN, SELF_ORIGINS),
  // Settings > Roster's Edit link: the model/thinking swap, written into
  // `adws/adw_sssf_config/sssf.config.yaml` one line at a time. The config yaml
  // is operator data; `adws/*.py` is code and no route touches it.
  ...rosterRoutes(APP_TOKEN, SELF_ORIGINS),
  ...seenRoutes(APP_TOKEN, SELF_ORIGINS), // GET previous / POST new snapshot

  // ── the v3 app plane ──────────────────────────────────────────────────
  // The Board's whole card truth (needs / waiting_on / blocked_reason /
  // feature / priority + the ready|running|blocked|done|integrated|shipped
  // lifecycle), beside the v1 `/queue` read rather than replacing it - the
  // parked v1/v2 SPAs still read that one.
  ...cardsRoutes,
  // Health + lanes + provider definitions + machines: everything Settings and
  // the footer strip read, all derived locally and all honest about what only
  // a running engine can answer.
  ...factoryRoutes,
  // SHIP (J5): the assembled report, and the one guarded squash that moves
  // `main`. The only write in this app that touches `main`, and the only
  // place `adws/ship_report.py` is shelled.
  ...shipRoutes(APP_TOKEN, SELF_ORIGINS),
  // MACHINES (J1): the registry of servers this app can actually reach, the
  // one-time-password key bootstrap, and the one-click deploy that turns a bare
  // Ubuntu box into a running factory. The only routes here that open a network
  // connection off this machine, and the only ones that hold a credential -
  // in memory, for one connect, never on disk (see machines.ts's header).
  ...machinesRoutes(APP_TOKEN, SELF_ORIGINS),
  // SYNC (topbar): `git fetch` + `merge --ff-only` in the project's own
  // checkout, never a push and never a force. See sync.ts's header for why
  // this is only the repo half of what the button reports.
  ...syncRoutes(APP_TOKEN, SELF_ORIGINS),
  // PROVIDERS v3 (J6.1): the two buckets - API-key accounts stored on this
  // laptop and applied to pi's own auth store, and the two signed-in CLIs whose
  // login state is probed read-only - plus the sync that writes both onto a
  // machine over L2's SSH helpers. Supersedes `/api/app/providers` for v3; that
  // read-only binary probe stays mounted above for the parked v1/v2 SPAs.
  ...providersV3Routes(APP_TOKEN, SELF_ORIGINS),
  // SIGN IN ON <MACHINE>: the login that actually works for the two
  // subscription CLIs - the command runs ON the machine over the same SSH
  // layer, the link it prints comes back here, and the row only says signed in
  // when a read-only re-probe finds the credential on that box. Nothing here
  // copies an auth file; providers-v3's sync still owns the API-key path.
  ...authSessionRoutes(APP_TOKEN, SELF_ORIGINS),

  "/api/app/p/:id/docs/tree": appSafely(getDocsTree),
  "/api/app/p/:id/docs/file": appSafely(getDocsFile),
  "/api/app/p/:id/docs/search": appSafely(getDocsSearch),

  // The two write endpoints that may ever create a job (spec 1.3), plus the
  // job poll the init log strip reads.
  "/api/app/p/:id/init/git": {
    POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, initGit),
  },
  "/api/app/p/:id/init/factory": {
    POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, initFactory),
  },
  "/api/app/jobs/:job_id": appSafely(getJobStatus),

  // Unmatched /api/app/* paths fall through to index.ts's own fetch(), whose
  // `pathname.startsWith("/api/")` branch already 404s with the same
  // `{error}` + cache-control:no-store shape `appError` would produce - no
  // need to duplicate that fallback here.
};
