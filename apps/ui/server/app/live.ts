/**
 * `/api/app/p/:id/live`, `/runs`, `/runs/:adw_id` (+ its `events`/`diff`/
 * `gates`/`envelopes` sub-routes), and `/config` (spec 4, chunk K2a) - the
 * project-scoped twins of `index.ts`'s existing `/api/sessions*` and
 * `/api/config` handlers, built on the SAME shared modules (`db.ts`,
 * `gate.ts`, `config.ts`) so a project's numbers are computed exactly the
 * way the boot project's already are. Nothing here re-derives logic that
 * already exists; this file only adds the per-project `scope` and the two
 * genuinely new shapes spec 1.3 asks for: `/live`'s running-run summary and
 * `/runs/:adw_id`'s per-phase `beat`.
 */
import { existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildObservabilityInfo, readConfig } from "../config.ts";
import type { SssfDb } from "../db.ts";
import type { GitRepo } from "../gitro.ts";
import { availableScopes, resolveDiff } from "../gate.ts";
import { isSafeSegment } from "../gitro.ts";
import { readQueue } from "../queue.ts";
import type { ConfigResponse, Event, LaneStatus, Phase, RunsSource, SessionSummary } from "../../shared/types.ts";
import { appError, appJson, appSafely } from "./guard.ts";
import { localRunsSource, remoteRuns, resolveProjectMachine } from "./remote.ts";
import { factoryAbsent, getScope, intQuery, param, strQuery } from "./scoped.ts";
import { maybeAutoSync } from "./sync.ts";

const HOSTNAME = "127.0.0.1";
const PORT = 4700;

// -- /live ----------------------------------------------------------------

interface LivePhase {
  name: string | null;
  seq: number | null;
  owner: string | null;
}

interface LiveRun {
  adw_id: string;
  title: string | null;
  adw_name: string | null;
  started_at: string | null;
  latest_event_at: string | null;
  latest_event_rowid: number | null;
  phase: LivePhase | null;
  model: string | null;
  coding_agent: string | null;
  branch: string | null;
  worktree_path: string | null;
  open_processes: number;
}

interface LiveResponse {
  running: LiveRun[];
  queue_mtime: string | null;
  counts: { board_ready: number; runs_running: number; gate: number };
}

function parseBranchPayload(raw: string | null): { branch: string | null; path: string | null } {
  if (!raw) return { branch: null, path: null };
  try {
    const payload = JSON.parse(raw) as { branch?: unknown; path?: unknown };
    return {
      branch: typeof payload.branch === "string" ? payload.branch : null,
      path: typeof payload.path === "string" ? payload.path : null,
    };
  } catch {
    return { branch: null, path: null };
  }
}

/** The open phase: has started, has not ended. Retried/queued phases can
 * leave more than one row with `ended_at IS NULL` on a fresh session row
 * that never started - so this also requires `started_at`, and takes the
 * last match (phases arrive seq-ordered) as the currently active one. */
function openPhaseOf(phases: Phase[]): Phase | null {
  for (let i = phases.length - 1; i >= 0; i--) {
    const p = phases[i]!;
    if (p.started_at && !p.ended_at) return p;
  }
  return null;
}

function buildLiveRun(db: SssfDb, s: SessionSummary): LiveRun {
  // events(adwId, 0, 1000): MAX_LIMIT (db.ts) - covers every run on this box
  // today (255 events total across all 12 sessions); a run past that many
  // events would under-report `latest_event_at` rather than crash, which is
  // the same "degrade honestly" shape as everything else in this chunk.
  const events = db.events(s.adw_id, 0, 1000).events;
  const latest = events.length > 0 ? events[events.length - 1]! : null;

  const openPhase = openPhaseOf(s.phases);

  const processes = db.processes(s.adw_id);
  const openProcesses = processes.filter((p) => p.ended_at === null).length;

  let branch: string | null = null;
  let worktreePath: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "log" && (e.name === "branch" || e.name === "worktree")) {
      const parsed = parseBranchPayload(e.payload_json);
      branch = parsed.branch;
      worktreePath = parsed.path;
      break;
    }
  }

  let model: string | null = null;
  let codingAgent: string | null = null;
  const byOwner = openPhase?.owner ? s.agents.find((a) => a.agent === openPhase.owner) : undefined;
  const active = byOwner ?? s.agents[s.agents.length - 1];
  if (active) {
    model = active.model;
    codingAgent = active.coding_agent;
  }

  return {
    adw_id: s.adw_id,
    title: s.title,
    adw_name: s.adw_name,
    started_at: s.started_at,
    latest_event_at: latest?.started_at ?? null,
    latest_event_rowid: latest?.rowid ?? null,
    phase: openPhase ? { name: openPhase.name, seq: openPhase.seq, owner: openPhase.owner } : null,
    model,
    coding_agent: codingAgent,
    branch,
    worktree_path: worktreePath,
    open_processes: openProcesses,
  };
}

/** Max mtime across `queue/*.md` - NOT the directory's own mtime.
 * `dispatch.py` rewrites `Status:` IN PLACE (never renames/adds/removes a
 * file), and on Windows/NTFS editing a file's content does not bump its
 * parent directory's mtime - only entry add/remove does. Reading the
 * directory's mtime here would silently stop reflecting card status
 * changes, which is the one thing this field exists to signal. */
async function latestQueueMtime(queueDir: string): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(queueDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name);
  } catch {
    return null;
  }
  let max: number | null = null;
  for (const name of names) {
    try {
      const st = await stat(join(queueDir, name));
      const t = st.mtime.getTime();
      if (max === null || t > max) max = t;
    } catch {
      /* file vanished between readdir and stat - not this poll's problem */
    }
  }
  return max === null ? null : new Date(max).toISOString();
}

/** Eligibility only (no diff/quality build) - `computeGateItems`'s own
 * filter (gate.ts), reused here without its expensive per-item diff/patch
 * work, because this runs on "the one 2s poll" (spec 2.1) and a git-diff
 * per gate-eligible run every 2 seconds is not a cost that poll should pay
 * just to report a badge count. */
async function countGateEligible(db: SssfDb, repo: GitRepo): Promise<number> {
  const sessions = db.allSessions().filter((s) => s.status === "success" && isSafeSegment(s.adw_id));
  let count = 0;
  for (const s of sessions) {
    const branches = await repo.branchesMatching(`adw/${s.adw_id}_*`);
    if (branches.length === 0) continue;
    const ancestor = await repo.isAncestor(branches[0]!, "main");
    if (ancestor === false) count++;
  }
  return count;
}

async function getLive(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!scope.db) return factoryAbsent();

  const db = scope.db;
  const running = db.sessions(200).filter((s) => s.status === "running");
  const liveRuns = running.map((s) => buildLiveRun(db, s));

  const [queueMtime, queue, gate] = await Promise.all([
    latestQueueMtime(scope.queueDir),
    readQueue(scope.queueDir),
    countGateEligible(db, scope.repo),
  ]);
  const boardReady = queue.items.filter((i) => i.status === "ready-for-agent").length;

  return appJson({
    running: liveRuns,
    queue_mtime: queueMtime,
    counts: { board_ready: boardReady, runs_running: liveRuns.length, gate },
  } satisfies LiveResponse);
}

// -- /runs ------------------------------------------------------------------

const SELF_CHECK_ADW_NAME = "adw_prompt";
const SELF_CHECK_REQUEST = "reply with the single word OK";

function isSelfCheck(s: SessionSummary): boolean {
  return s.adw_name === SELF_CHECK_ADW_NAME && s.request === SELF_CHECK_REQUEST;
}

interface RunsResponse {
  runs: SessionSummary[];
  hidden_self_checks: number;
  /** where these rows came from - see `RunsSource`. Always present, so the
   * surface never has to guess whether an empty list means "nothing ran" or
   * "nobody was asked". */
  source: RunsSource;
}

/**
 * The runs list.
 *
 * ── Why this read has a second half ────────────────────────────────────────
 * The engine runs on a VPS and writes ITS sssf.db there. A laptop checkout of
 * the same project has no such file, so this endpoint used to answer
 * `{factory:"absent"}` and the Runs surface was empty while the factory was
 * busy - the operator's whole complaint. So: read locally first, and when
 * this checkout holds no rows AND the project names a machine, read that
 * machine's own db over SSH (`app/remote.ts`).
 *
 * Remote-WHEN-LOCAL-EMPTY, not a merge. Merging would need a rule for the same
 * adw_id appearing on both sides and a per-row provenance the surface would
 * have to explain; "these rows are this checkout's" / "these rows are that
 * machine's" is one sentence each and cannot be read two ways. Every remote row
 * carries `machine: "on <host>"`, which the list already renders as its muted
 * chip, so the two are never confusable even side by side in a screenshot.
 *
 * ── What "local empty" is counted on ───────────────────────────────────────
 * The non-self-check rows, and NOT the rows this request happens to be showing.
 * The two differ whenever a checkout holds nothing but `adw_prompt` self-checks
 * - which is the ordinary state of a laptop that has validated its roster and
 * run its real work on the VPS (this repo's own sssf.db is 22 rows, all 22 of
 * them self-checks). Counting the displayed rows would make `?self_checks=1`
 * flip the SOURCE as well as the filter: toggling "show self-checks" on such a
 * project would swap fifty of the machine's real runs for one local no-op. So
 * the source is decided once, on the rows that represent work, and the toggle
 * only ever decides what is shown out of the source that decision picked.
 */
async function getRuns(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);

  // The Runs surface is polling, so somebody is watching this project: kick a
  // background sync if this checkout has gone a minute without one (sync.ts
  // owns the interval, the single-flight lock and every refusal). Never
  // awaited, and deliberately BEFORE the factory-absent branch - a project
  // with no db still has a checkout worth keeping current. This response
  // carries no sync field; the Board's `cards` read is the one surface that
  // prints the outcome.
  maybeAutoSync(scope);

  const limit = intQuery(req, "limit", 200);
  const includeSelfChecks = strQuery(req, "self_checks", "0") === "1";

  const all = scope.db ? scope.db.sessions(limit) : [];
  const work = all.filter((s) => !isSelfCheck(s));
  const hidden = all.length - work.length;
  const runs = includeSelfChecks ? all : work;
  if (work.length > 0) {
    return appJson({ runs, hidden_self_checks: hidden, source: localRunsSource() } satisfies RunsResponse);
  }

  const machine = await resolveProjectMachine(id);
  if (machine) {
    // Never throws: an unreachable box, a checkout that was never deployed, a
    // db that does not exist yet - each is an empty list plus one sentence
    // naming the host, which is what the pane prints.
    const remote = await remoteRuns(machine);
    const visible = includeSelfChecks ? remote.runs : remote.runs.filter((s) => !isSelfCheck(s));
    // The count describes THE LIST BEING RETURNED, which is the machine's - the
    // same thing it means in the local answer. Any self-checks sitting in this
    // laptop's own db are not added to it: they are not in this list, they are
    // not on that host, and a number that mixed the two would belong to neither
    // sentence `source` can print.
    return appJson({
      runs: visible,
      hidden_self_checks: remote.runs.length - visible.length,
      source: remote.source,
    } satisfies RunsResponse);
  }

  // No rows here and no machine to ask. A project with no db at all is still
  // the `{factory:"absent"}` state - "there is no factory record here" and "the
  // record is empty" are different sentences and the surface prints both.
  if (!scope.db) return factoryAbsent();
  return appJson({ runs, hidden_self_checks: hidden, source: localRunsSource() } satisfies RunsResponse);
}

// -- /runs/:adw_id (+ beat) ---------------------------------------------------

/** The ONE fixed table (spec 2.5.2), and nothing else: every other owner
 * (`git`, the engineer's own name, a roster agent running `adw_prompt`)
 * contributes no beat. A run with no beat-bearing phase gets no beat rail at
 * all - the client decides that by seeing every phase's `beat` come back
 * null, never by this server inventing five empty circles. */
const BEAT_TABLE: Record<string, string> = {
  planner: "Plan",
  builder: "Build",
  quality: "Test",
  reviewer: "Review",
  documenter: "Document",
};

function beatFor(owner: string | null): string | null {
  return owner ? (BEAT_TABLE[owner] ?? null) : null;
}

interface PhaseWithBeat extends Phase {
  beat: string | null;
}

async function getRun(req: Request): Promise<Response> {
  const id = param(req, "id");
  const adwId = param(req, "adw_id");
  if (!isSafeSegment(adwId)) return appError("invalid adw_id", 400);

  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!scope.db) return factoryAbsent();

  const detail = scope.db.sessionDetail(adwId);
  if (!detail) return appError(`no run ${adwId}`, 404);

  const branches = await scope.repo.branchesMatching(`adw/${adwId}_*`);
  const phases: PhaseWithBeat[] = detail.phases.map((p) => ({ ...p, beat: beatFor(p.owner) }));

  return appJson({ ...detail, phases, branch: branches[0] ?? null });
}

async function getRunEvents(req: Request): Promise<Response> {
  const id = param(req, "id");
  const adwId = param(req, "adw_id");
  if (!isSafeSegment(adwId)) return appError("invalid adw_id", 400);
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!scope.db) return factoryAbsent();
  if (!scope.db.session(adwId)) return appError(`no run ${adwId}`, 404);
  return appJson(scope.db.events(adwId, intQuery(req, "after", 0), intQuery(req, "limit", 500)) satisfies { events: Event[]; cursor: number; has_more: boolean });
}

async function getRunEnvelopes(req: Request): Promise<Response> {
  const id = param(req, "id");
  const adwId = param(req, "adw_id");
  if (!isSafeSegment(adwId)) return appError("invalid adw_id", 400);
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!scope.db) return factoryAbsent();
  if (!scope.db.session(adwId)) return appError(`no run ${adwId}`, 404);
  return appJson(scope.db.envelopes(adwId));
}

async function getRunGates(req: Request): Promise<Response> {
  const id = param(req, "id");
  const adwId = param(req, "adw_id");
  if (!isSafeSegment(adwId)) return appError("invalid adw_id", 400);
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!scope.db) return factoryAbsent();
  if (!scope.db.session(adwId)) return appError(`no run ${adwId}`, 404);
  return appJson(scope.db.gates(adwId));
}

async function getRunDiff(req: Request): Promise<Response> {
  const id = param(req, "id");
  const adwId = param(req, "adw_id");
  if (!isSafeSegment(adwId)) return appError("invalid adw_id", 400);
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!scope.db) return factoryAbsent();
  if (!scope.db.session(adwId)) return appError(`no run ${adwId}`, 404);

  const scopeParam = strQuery(req, "scope", "run");
  if (scopeParam !== "run" && !isSafeSegment(scopeParam)) return appError("invalid scope", 400);

  const commits = scope.db.commitLog(adwId);
  const scopes = availableScopes(commits);
  if (!scopes.some((s) => s.id === scopeParam)) return appError(`unknown scope ${scopeParam}`, 400);

  const sessionDir = join(scope.sessionsDir, adwId);
  const diff = await resolveDiff({ repo: scope.repo, sessionDir, commits, scope: scopeParam });
  return appJson(
    diff ?? { base: "no diff available", files: [], added: 0, deleted: 0, patch: "", truncated: false, empty: true },
  );
}

// -- /config ------------------------------------------------------------------

/** `ui-v2/dist`'s own mtime - the same "build time" `index.ts` reports for
 * the boot project, recomputed here rather than imported (this module
 * cannot reach into `index.ts`, which is frozen except its three permitted
 * edits) - cheap and read-only, so recomputing costs nothing real. */
function uiV2BuildTime(): string | null {
  const distDir = resolve(import.meta.dir, "..", "..", "..", "ui-v2", "dist");
  return existsSync(distDir) ? statSync(distDir).mtime.toISOString() : null;
}

async function getProjectConfig(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!existsSync(scope.configPath)) return factoryAbsent();

  const parsed = await readConfig(scope.configPath);
  const journalMode = scope.db?.journalMode ?? "unknown";
  const sessionCount = scope.db?.sessionCount() ?? 0;
  const observability = buildObservabilityInfo(parsed, scope.dbPath, journalMode, sessionCount);

  const lanes: LaneStatus[] = scope.db
    ? Array.from(scope.db.laneRoundTrips().entries()).map(([key, v]) => ({
        provider_model: key,
        last_round_trip_at: v.last_at,
        last_round_trip_tokens: v.last_tokens,
        run_count: v.run_count,
        exercised: true,
      }))
    : [];

  return appJson({
    roster: parsed.roster,
    defaults: parsed.defaults,
    lanes,
    observability,
    paths: { bind: HOSTNAME, port: PORT, read_only: true, build_time: uiV2BuildTime() },
  } satisfies ConfigResponse);
}

// -- routes -------------------------------------------------------------------

export const liveRoutes = {
  "/api/app/p/:id/live": appSafely(getLive),
  "/api/app/p/:id/runs": appSafely(getRuns),
  "/api/app/p/:id/runs/:adw_id": appSafely(getRun),
  "/api/app/p/:id/runs/:adw_id/events": appSafely(getRunEvents),
  "/api/app/p/:id/runs/:adw_id/diff": appSafely(getRunDiff),
  "/api/app/p/:id/runs/:adw_id/gates": appSafely(getRunGates),
  "/api/app/p/:id/runs/:adw_id/envelopes": appSafely(getRunEnvelopes),
  "/api/app/p/:id/config": appSafely(getProjectConfig),
};
