/**
 * Readonly bun:sqlite reader over a repo's sssf.db.
 *
 * Opened readonly, full stop - there is no writer connection anywhere in this
 * process (unlike the shipped visualizer, which keeps one lazy write
 * connection for archiving). Every query below is a SELECT. WAL lets us read
 * straight through a running ADW's inserts.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  AgentSession,
  Envelope,
  Event,
  EventsPage,
  GateResult,
  Phase,
  ProcessRow,
  Session,
  SessionDetail,
  SessionSummary,
  SessionUsage,
} from "../shared/types.ts";

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

/** Resolve `--db <path>` (or `--db=<path>`) from argv. No env-var fallback -
 * the db path is a CLI argument by design (spec 2). */
export function resolveDbPath(argv: string[] = Bun.argv): string {
  const flagIndex = argv.indexOf("--db");
  const inline = argv.find((a) => a.startsWith("--db="));
  const raw = (flagIndex !== -1 ? argv[flagIndex + 1] : undefined) ?? inline?.slice("--db=".length);
  if (!raw) {
    throw new Error(
      "missing --db <path to sssf.db> - the server needs an explicit db path, not an env var",
    );
  }
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

export interface CommitLogEntry {
  phase_id: string;
  seq: number | null;
  name: string | null;
  sha: string;
  message: string;
}

export class SssfDb {
  readonly path: string;
  readonly sessionsDir: string;
  readonly journalMode: string;
  private readonly db: Database;
  private readonly columnCache = new Map<string, boolean>();

  constructor(path: string) {
    if (!existsSync(path)) {
      throw new Error(
        `sssf.db not found at ${path}\n` + `Pass --db <abs path to adws/adw_data/sssf.db>.`,
      );
    }
    this.path = path;
    this.sessionsDir = resolve(dirname(path), "sessions");
    this.db = new Database(path, { readonly: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    const mode = this.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    this.journalMode = mode?.journal_mode ?? "unknown";
    if (this.journalMode.toLowerCase() !== "wal") {
      console.warn(
        `[ui] journal_mode is "${this.journalMode}", expected "wal" - live reads during agent writes may block`,
      );
    }
  }

  /** A SELECT fragment for a column added by an additive migration - probe and
   * substitute NULL rather than throw on a db written by an older tracer. */
  private hasColumn(table: string, column: string): boolean {
    const key = `${table}.${column}`;
    if (!this.columnCache.get(key)) {
      const cols = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      this.columnCache.set(key, cols.some((c) => c.name === column));
    }
    return this.columnCache.get(key) ?? false;
  }

  private optionalColumn(table: string, column: string): string {
    return this.hasColumn(table, column) ? column : `NULL AS ${column}`;
  }

  close(): void {
    this.db.close();
  }

  sessions(limit = 200): SessionSummary[] {
    const archivedCol = this.hasColumn("sessions", "archived") ? "archived" : "0";
    const rows = this.db
      .query<Session, [number]>(
        `SELECT adw_id, ${this.optionalColumn("sessions", "adw_name")}, request,
                status, engineer, started_at, ended_at,
                total_tokens, total_cost, ${this.optionalColumn("sessions", "archived")}
           FROM sessions
          WHERE COALESCE(${archivedCol}, 0) = 0
          ORDER BY started_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(clamp(limit, 1, MAX_LIMIT));

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.adw_id);
    const placeholders = ids.map(() => "?").join(", ");
    const phaseRows = this.db
      .query<Phase, string[]>(
        `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                attempt, retries, error, started_at, ended_at
           FROM phases WHERE adw_id IN (${placeholders}) ORDER BY seq, rowid`,
      )
      .all(...ids);
    const byAdw = new Map<string, Phase[]>();
    for (const p of phaseRows) {
      const list = byAdw.get(p.adw_id);
      if (list) list.push(p);
      else byAdw.set(p.adw_id, [p]);
    }

    const agentsByAdw = this.agentsFor(ids);
    const titlesByAdw = this.titlesFor(ids);

    return rows.map((session) =>
      Object.assign(session, {
        phases: byAdw.get(session.adw_id) ?? [],
        agents: agentsByAdw.get(session.adw_id) ?? [],
        title: titlesByAdw.get(session.adw_id) ?? null,
      }),
    );
  }

  session(adwId: string): Session | null {
    return (
      this.db
        .query<Session, [string]>(
          `SELECT adw_id, ${this.optionalColumn("sessions", "adw_name")}, request,
                  status, engineer, started_at, ended_at,
                  total_tokens, total_cost, ${this.optionalColumn("sessions", "archived")}
             FROM sessions WHERE adw_id = ?`,
        )
        .get(adwId) ?? null
    );
  }

  phases(adwId: string): Phase[] {
    return this.db
      .query<Phase, [string]>(
        `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                attempt, retries, error, started_at, ended_at
           FROM phases WHERE adw_id = ? ORDER BY seq, rowid`,
      )
      .all(adwId);
  }

  processes(adwId: string): ProcessRow[] {
    return this.db
      .query<ProcessRow, [string]>(
        `SELECT id, adw_id, kind, name, pid, command, started_at, ended_at
           FROM processes WHERE adw_id = ? ORDER BY id`,
      )
      .all(adwId);
  }

  agentSessions(adwId: string): AgentSession[] {
    return this.agentsFor([adwId]).get(adwId) ?? [];
  }

  /** Agents per session for a set of ids at once: finished agent_sessions rows
   * plus anything started but not yet finished (agents.py writes the row only
   * after the envelope persists, so a running agent has no row there yet). */
  private agentsFor(adwIds: string[]): Map<string, AgentSession[]> {
    const byAdw = new Map<string, AgentSession[]>();
    if (adwIds.length === 0) return byAdw;
    const placeholders = adwIds.map(() => "?").join(", ");
    const append = (adwId: string, agent: AgentSession) => {
      const list = byAdw.get(adwId);
      if (list) list.push(agent);
      else byAdw.set(adwId, [agent]);
    };

    const color = this.optionalColumn("agent_sessions", "color");
    const ctxUsed = this.optionalColumn("agent_sessions", "context_tokens");
    const ctxWindow = this.optionalColumn("agent_sessions", "context_window");
    const completed = this.db
      .query<AgentSession, string[]>(
        `SELECT adw_id, agent, coding_agent, model, session_id, ${color},
                ${ctxUsed}, ${ctxWindow}, created_at, last_used_at
           FROM agent_sessions WHERE adw_id IN (${placeholders})
          ORDER BY created_at, agent`,
      )
      .all(...adwIds);
    for (const row of completed) append(row.adw_id, row);

    const started = this.db
      .query<
        { adw_id: string; agent: string | null; payload_json: string | null; started_at: string | null },
        string[]
      >(
        `SELECT e.adw_id, p.owner AS agent, e.payload_json, e.started_at
           FROM events e JOIN phases p ON p.phase_id = e.phase_id
          WHERE e.adw_id IN (${placeholders}) AND e.type = 'agent_start'
          ORDER BY e.rowid`,
      )
      .all(...adwIds);
    for (const row of started) {
      if (!row.agent) continue;
      if (byAdw.get(row.adw_id)?.some((a) => a.agent === row.agent)) continue;
      let payload: { model?: string; session_id?: string; color?: string } = {};
      try {
        payload = JSON.parse(row.payload_json ?? "{}");
      } catch {
        /* malformed payload -> just no label, never a failed request */
      }
      append(row.adw_id, {
        adw_id: row.adw_id,
        agent: row.agent,
        coding_agent: null,
        model: payload.model ?? null,
        session_id: payload.session_id ?? null,
        color: payload.color ?? null,
        context_tokens: null,
        context_window: null,
        created_at: row.started_at,
        last_used_at: row.started_at,
      });
    }
    return byAdw;
  }

  /** adw_id -> human title, derived from the run's own trace events - the
   * `type='log', name='branch'` event stamped at worktree entry (see
   * runner.py's `Run._log_branch_and_title`) when a run has one, else the
   * SAME fallback the CLI (`adw_modules/worktrees.py:_build_row`) already
   * applies: humanize the branch slug (`git_helper.humanize_slug`, mirrored
   * here by `humanizeSlug`).
   *
   * Two OLDER event shapes exist and neither carries a `title` field, which
   * is why a plain `name = 'branch'` filter alone under-titles real runs:
   *   - `name='branch'`, payload `{branch}` only - the pre-worktree `branch`
   *     PHASE's own `ph.log(branch=...)`, before this trace-recording fix.
   *   - `name='worktree'`, payload `{branch, path, reused, base}` - every
   *     worktree-layer run BEFORE `_log_branch_and_title` existed logged
   *     ONLY this event (`ph.log(**run.enter_worktree(...))`, which always
   *     names the event after its OWN enclosing phase, "worktree" - never
   *     "branch"). A `name = 'branch'`-only filter misses these runs
   *     entirely, so their title reads null in the UI even though the CLI,
   *     which reads `branch_name` straight from git rather than this event,
   *     already humanizes one for them.
   * Both are read here too, with `branch`-named rows always authoritative
   * (a real title, or the humanized fallback) and `worktree`-named rows only
   * ever filling in when NO `branch`-named row exists for that run - so a
   * post-fix run's real `derive_title` is never overwritten by the cruder
   * fallback its own (later) `worktree` event also carries. */
  private titlesFor(adwIds: string[]): Map<string, string> {
    const titles = new Map<string, string>();
    if (adwIds.length === 0) return titles;
    const placeholders = adwIds.map(() => "?").join(", ");
    const rows = this.db
      .query<{ adw_id: string; name: string; payload_json: string | null }, string[]>(
        `SELECT adw_id, name, payload_json FROM events
          WHERE adw_id IN (${placeholders}) AND type = 'log' AND name IN ('branch', 'worktree')
          ORDER BY rowid`,
      )
      .all(...adwIds);
    for (const row of rows) {
      let payload: { branch?: string; title?: string } = {};
      try {
        payload = JSON.parse(row.payload_json ?? "{}");
      } catch {
        continue; // malformed payload -> no title from this row, never a failed request
      }
      const fallback = payload.branch ? humanizeSlug(slugFromBranch(payload.branch)) : "";
      if (row.name === "branch") {
        // Authoritative: a real title if this run stamped one, else the same
        // humanized-slug fallback. ORDER BY rowid -> a later `branch` row
        // (a rejoin's fresh worktree entry) always wins over an earlier one.
        const title = payload.title || fallback;
        if (title) titles.set(row.adw_id, title);
      } else if (fallback && !titles.has(row.adw_id)) {
        // Old shape, no `branch` row seen for this run (yet) - this is the
        // only title source it has. Never overrides a `branch` row, whatever
        // order the two arrive in.
        titles.set(row.adw_id, fallback);
      }
    }
    return titles;
  }

  /** Everything except `branch`, which needs a git call the caller (index.ts)
   * makes once it has the adw_id, so db.ts stays pure sqlite. */
  sessionDetail(adwId: string): Omit<SessionDetail, "branch"> | null {
    const session = this.session(adwId);
    if (!session) return null;
    return {
      session,
      usage: this.usage(adwId),
      phases: this.phases(adwId),
      agents: this.agentSessions(adwId),
      processes: this.processes(adwId),
      title: this.titlesFor([adwId]).get(adwId) ?? null,
    };
  }

  /** Raw read/written tokens beside the billed `total_tokens` spend number -
   * derived from agent_end payloads, no migration needed. */
  usage(adwId: string): SessionUsage {
    const rows = this.db
      .query<{ payload_json: string | null }, [string]>(
        "SELECT payload_json FROM events WHERE adw_id = ? AND type = 'agent_end'",
      )
      .all(adwId);
    let read = 0;
    let written = 0;
    for (const row of rows) {
      if (!row.payload_json) continue;
      try {
        const u = (JSON.parse(row.payload_json) as { usage?: Record<string, number> }).usage;
        if (!u) continue;
        read += (u.input_tokens ?? 0) + (u.cache_write_tokens ?? 0);
        written += u.output_tokens ?? 0;
      } catch {
        /* payload from an older tracer contributes nothing */
      }
    }
    return { read, written };
  }

  /** The polling query. Rowid cursor, insertion order, bounded page. */
  events(adwId: string, after = 0, limit = DEFAULT_LIMIT): EventsPage {
    const cappedLimit = clamp(limit, 1, MAX_LIMIT);
    const events = this.db
      .query<Event, [string, number, number]>(
        `SELECT rowid, event_id, adw_id, phase_id, parent_id, type, name,
                payload_json, tokens, started_at, ended_at
           FROM events
          WHERE adw_id = ? AND rowid > ?
          ORDER BY rowid
          LIMIT ?`,
      )
      .all(adwId, Math.max(0, after), cappedLimit);
    return {
      events,
      cursor: events.length > 0 ? events[events.length - 1]!.rowid : Math.max(0, after),
      has_more: events.length === cappedLimit,
    };
  }

  envelopes(adwId: string): Envelope[] {
    return this.db
      .query<Envelope, [string]>(
        `SELECT envelope_id, adw_id, phase_id, agent, output_type, payload_json,
                valid, attempt, created_at
           FROM envelopes WHERE adw_id = ? ORDER BY created_at, rowid`,
      )
      .all(adwId);
  }

  gates(adwId: string): GateResult[] {
    const checks = this.optionalColumn("gate_results", "checks_json");
    return this.db
      .query<GateResult, [string]>(
        `SELECT id, adw_id, phase_id, attempt, gate, passed, violations_json,
                ${checks}, created_at
           FROM gate_results WHERE adw_id = ? ORDER BY id`,
      )
      .all(adwId);
  }

  sessionCount(): number {
    const row = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get();
    return row?.n ?? 0;
  }

  /** Every session that ever ran, most-recent-started first - Gate scans this
   * for the eligibility rule (success + uncut/unmerged branch), Settings scans
   * it for lane round trips. Cheap: no phases/agents joined. */
  allSessions(): Session[] {
    return this.db
      .query<Session, []>(
        `SELECT adw_id, ${this.optionalColumn("sessions", "adw_name")}, request,
                status, engineer, started_at, ended_at,
                total_tokens, total_cost, ${this.optionalColumn("sessions", "archived")}
           FROM sessions ORDER BY started_at DESC, rowid DESC`,
      )
      .all();
  }

  /** Commit shas a run recorded via `ph.log(sha=..., message=...)`, in phase
   * order - the raw material for the per-phase diff selector (spec 5.2.1). */
  commitLog(adwId: string): CommitLogEntry[] {
    const rows = this.db
      .query<{ phase_id: string; seq: number | null; name: string | null; payload_json: string | null }, [string]>(
        `SELECT e.phase_id AS phase_id, p.seq AS seq, e.name AS name, e.payload_json AS payload_json
           FROM events e LEFT JOIN phases p ON p.phase_id = e.phase_id
          WHERE e.adw_id = ? AND e.type = 'log'
          ORDER BY e.rowid`,
      )
      .all(adwId);
    const out: CommitLogEntry[] = [];
    for (const row of rows) {
      if (!row.payload_json || !row.phase_id) continue;
      try {
        const payload = JSON.parse(row.payload_json) as { sha?: unknown; message?: unknown };
        if (typeof payload.sha === "string" && payload.sha.length > 0) {
          out.push({
            phase_id: row.phase_id,
            seq: row.seq,
            name: row.name,
            sha: payload.sha,
            message: typeof payload.message === "string" ? payload.message : "",
          });
        }
      } catch {
        /* not JSON, or no sha - not a commit log line */
      }
    }
    return out;
  }

  /** Every distinct (coding_agent, model) pair ever recorded, with the real
   * round-trip evidence behind it - Settings' Lanes pane (spec 5.5): a lane is
   * verified only by tokens actually returned, never by a liveness probe.
   *
   * Correlates each `agent_end` event (its `tokens` column is the round-trip
   * spend the tracer already extracted) through the phase it closed to the
   * agent that ran it, then to that agent's model in agent_sessions - the
   * events table itself carries no model column. */
  laneRoundTrips(): Map<string, { last_at: string | null; last_tokens: number; run_count: number }> {
    const rows = this.db
      .query<
        { model: string | null; coding_agent: string | null; started_at: string | null; tokens: number | null; adw_id: string },
        []
      >(
        `SELECT a.model AS model, a.coding_agent AS coding_agent,
                e.started_at AS started_at, e.tokens AS tokens, e.adw_id AS adw_id
           FROM events e
           JOIN phases p ON p.phase_id = e.phase_id
           JOIN agent_sessions a ON a.adw_id = e.adw_id AND a.agent = p.owner
          WHERE e.type = 'agent_end' AND a.model IS NOT NULL
          ORDER BY e.started_at ASC`,
      )
      .all();
    const map = new Map<
      string,
      { last_at: string | null; last_tokens: number; run_count: number; adwIds: Set<string> }
    >();
    for (const row of rows) {
      // Spec 5.5: "per distinct provider/model" - agent_sessions.model is
      // already that string (e.g. "ollama-cloud/kimi-k2.7-code"). coding_agent
      // (pi) is the harness driving the lane, not part of the lane's own
      // identity, so it is fetched but deliberately left out of the key.
      const key = row.model ?? "?";
      const prev = map.get(key) ?? { last_at: null, last_tokens: 0, run_count: 0, adwIds: new Set<string>() };
      // ORDER BY ASC, so the last row seen per key is the most recent round trip.
      prev.last_at = row.started_at;
      prev.last_tokens = row.tokens ?? prev.last_tokens;
      prev.adwIds.add(row.adw_id);
      prev.run_count = prev.adwIds.size;
      map.set(key, prev);
    }
    const out = new Map<string, { last_at: string | null; last_tokens: number; run_count: number }>();
    for (const [key, v] of map) out.set(key, { last_at: v.last_at, last_tokens: v.last_tokens, run_count: v.run_count });
    return out;
  }
}

/** `adw/<adw_id>_<slug>` -> `<slug>` - the part `humanizeSlug` turns back
 * into a title. "" when the branch has no `_` (should not happen for a
 * factory-cut branch, but this is a fallback path reading old telemetry). */
function slugFromBranch(branch: string): string {
  const short = branch.startsWith("adw/") ? branch.slice(4) : branch;
  const idx = short.indexOf("_");
  return idx === -1 ? "" : short.slice(idx + 1);
}

/** Mirrors adw_modules/git_helper.py's `humanize_slug` exactly: dashes to
 * spaces, sentence case. "add-a-clamp-helper" -> "Add a clamp helper". */
function humanizeSlug(slug: string): string {
  const words = slug.split("-").filter(Boolean);
  if (words.length === 0) return slug;
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
