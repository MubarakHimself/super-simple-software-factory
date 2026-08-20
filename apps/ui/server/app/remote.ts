/**
 * What the SERVER knows, read from the laptop.
 *
 * ── The complaint this module answers ──────────────────────────────────────
 * "things are happening in the vps, but i do not know." The factory RUNS on a
 * VPS; this app runs on the laptop. Every read in `factory.ts` and `live.ts`
 * was a read of THIS checkout, so the footer said "no engine runs on this
 * machine", the Board topbar said "engine status unknown", and Runs was empty
 * - all three true about the laptop and all three useless, because the thing
 * the operator wanted to know was happening 4,000km away.
 *
 * ── What it does, and what it deliberately does not ────────────────────────
 * Two reads, over the SSH layer `machines.ts` already owns (pinned host key,
 * this app's own generated key, BatchMode by construction - ssh2 never reads a
 * terminal - and short timeouts):
 *
 *   engine   `systemctl is-active` + `LoadState` + `NRestarts` + the last two
 *            journal lines. Three properties and a tail: enough to say
 *            running / stopped / no such service, and to say WHY in the
 *            engine's own words. Not uptime, not the checkout's HEAD - the
 *            probe in `machines.ts` already reads those for Settings.
 *   runs     the newest 50 sessions out of `<repo_dir>/adws/adw_data/sssf.db`,
 *            read by python3's sqlite3 (the box has no sqlite CLI - the
 *            bootstrap says so - and python3 is guaranteed) and dumped as one
 *            JSON object.
 *
 * There is NO second transport, no agent on the box, no polling loop here. A
 * read happens because a browser poll asked for it, and every machine's answer
 * is cached for 15s with a single-flight lock, so the sidebar's 5s health poll
 * and Runs' 2s poll cost at most one SSH round trip per machine per 15s.
 *
 * ── The honesty rule, unchanged ────────────────────────────────────────────
 * `factory.ts`'s header states it: a count this process could not know is
 * never printed as a zero, and "stopped" is never said about a machine this
 * process has not spoken to. So every answer below carries the host that
 * produced it and one plain sentence, and every failure - no machine bound, no
 * key, unreachable, no unit, no db yet, python missing - is a NAMED state with
 * the far end's own error in it. Nothing here throws into a route.
 *
 * ── Which machine ──────────────────────────────────────────────────────────
 * The linkage already exists and is the one Settings · Machines draws: a
 * project's "Runs on" select writes `machine_id` into its manifest entry
 * (`machines.ts:bindProject`), and the empty option in that select reads "use
 * the default machine" - `registry.default_machine`. This module reads exactly
 * those two, in that order, and invents no third mapping.
 *
 * ── What the cache may hold, and what it may NOT ───────────────────────────
 * A cache entry is a fact about a BOX: what systemd said, which rows its db
 * holds. It is never a fact about the project that asked, because two projects
 * can reach one machine by the two different links above - one by its own
 * "Runs on", the other by falling through to the default - and the clause that
 * says WHICH ("this project's Runs-on machine" / "this app's default machine")
 * is true of the asker, not of the box. So `where` is applied to the cached
 * facts by each caller, after the lookup: the SSH round trip is shared, the
 * attribution never is. Caching the finished sentence would hand whichever
 * project won the 15s race its own attribution to every other project on that
 * machine, which is the one thing this module exists not to do.
 *
 * ── Read-only, and why not a copy ──────────────────────────────────────────
 * The remote db is opened `file:<path>?mode=ro` (a URI connection): SQLite
 * takes no write lock on the database, cannot create it if it is missing, and
 * refuses any statement that would write. The alternative the brief offered -
 * copy the file to a temp path on the box first - was rejected for two
 * reasons: it doubles a growing file's disk use on a small VPS every 15s, and
 * a plain `cp` of a live WAL database can catch it mid-checkpoint, which
 * produces a torn copy that is *less* truthful than the live read. `mode=ro`
 * with WAL is the same thing `db.ts` does locally (readonly bun:sqlite,
 * reading straight through the engine's inserts).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Client } from "ssh2";
import { agentsFromRows, titlesFromLogRows, type AgentStartRow, type TitleLogRow } from "../db.ts";
import type { AgentSession, Phase, RunsSource, Session, SessionSummary } from "../../shared/types.ts";
import { connect, execCapture, pinHostKey, readBindings, readRegistry, shq, type MachineRecord } from "./machines.ts";

/** The unit `deploy/bootstrap.sh` installs, spelled the same way the
 * reachability probe in `machines.ts` spells it. */
export const ENGINE_UNIT = "sdl-engine";

/** One answer per machine, for this long. The health poll is 5s and the runs
 * poll is 2s, so this is what keeps a browser tab from opening an SSH
 * connection several times a second. Same TTL as `machines.ts`'s probe cache. */
export const REMOTE_TTL_MS = 15_000;

/** Short on purpose: a read that cannot answer in this long is an honest
 * "could not be reached" and the surface says so, which is far better than a
 * poll that hangs. */
const CONNECT_TIMEOUT_MS = 6_000;
const COMMAND_TIMEOUT_MS = 10_000;

/** The most runs one remote read fetches. `db.ts`'s local reader defaults to
 * 200; 50 is the newest chunk of work, which is what "what happened on the
 * VPS" means, at a fraction of the bytes over a link that is not loopback. */
export const REMOTE_RUNS_LIMIT = 50;

// ── which machine answers for a project ─────────────────────────────────────

export interface ProjectMachine {
  record: MachineRecord;
  /** how this project reached this machine - the two links Settings draws */
  via: "runs-on" | "default";
  /** the clause every sentence below ends with, so the source is never a
   * mystery: "155.133.27.86, this project's Runs-on machine" */
  where: string;
}

/**
 * The machine a project's factory runs on: its own `Runs on` binding first,
 * then the machine marked default. Null when neither names one - which is the
 * ordinary state of a laptop-only project and reads as "no remote to ask",
 * never as an error.
 */
export async function resolveProjectMachine(projectId: string): Promise<ProjectMachine | null> {
  const registry = await readRegistry();
  if (registry.machines.length === 0) return null;

  const boundId = (await readBindings())[projectId];
  const bound = boundId ? registry.machines.find((machine) => machine.id === boundId) : undefined;
  if (bound) return { record: bound, via: "runs-on", where: `${bound.host}, this project's Runs-on machine` };

  const fallback = registry.default_machine
    ? registry.machines.find((machine) => machine.id === registry.default_machine)
    : undefined;
  if (fallback) {
    return {
      record: fallback,
      via: "default",
      where: `${fallback.host}, this app's default machine (no project Runs-on names one)`,
    };
  }
  return null;
}

// ── the cache (one answer per machine, single-flight) ───────────────────────

interface Slot<T> {
  at: number;
  value: T;
}

/**
 * Cache with a single-flight lock: while one read is in the air every other
 * caller awaits THAT promise rather than opening a second SSH connection. The
 * in-flight entry is dropped in `finally`, so a failed read is retried by the
 * next poll rather than wedging the key forever - and because the failure is a
 * VALUE here (never a throw), a rejection means a bug in this module, not an
 * unreachable box.
 */
class RemoteCache<T> {
  private readonly done = new Map<string, Slot<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, produce: () => Promise<T>): Promise<T> {
    const slot = this.done.get(key);
    if (slot && Date.now() - slot.at < this.ttlMs) return Promise.resolve(slot.value);

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const run = produce()
      .then((value) => {
        this.done.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, run);
    return run;
  }

  /** Tests only - each one starts from a cold cache. */
  clear(): void {
    this.done.clear();
    this.inflight.clear();
  }
}

/**
 * What ONE BOX said, and nothing about who asked it: either the systemd fields
 * it printed, or the error the connection to it raised. The finished
 * `RemoteEngine` sentence is built from this per caller (see the header's
 * "What the cache may hold"), so a shared entry can never carry one project's
 * "this project's Runs-on machine" onto another project's answer.
 */
type EngineProbe = { ok: true; fields: EngineFields } | { ok: false; error: string };

const engineCache = new RemoteCache<EngineProbe>(REMOTE_TTL_MS);
const runsCache = new RemoteCache<RemoteRuns>(REMOTE_TTL_MS);

export function clearRemoteCaches(): void {
  engineCache.clear();
  runsCache.clear();
}

// ── one connection, one command ─────────────────────────────────────────────

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Connect with the pinned host key, run one command, capture it, hang up.
 * `probeMachine`'s shape exactly - including pinning what a never-pinned
 * record presents - because there is only one way this app talks to a box.
 */
export async function runOnMachine(record: MachineRecord, command: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (!existsSync(record.key_path)) {
    throw new Error(`the key this app authenticates with is missing at ${record.key_path} - re-add the machine to generate a new one`);
  }
  const privateKey = await readFile(record.key_path, "utf-8");
  const seen = { fingerprint: null as string | null };
  let client: Client | null = null;
  try {
    client = await connect({
      host: record.host,
      port: record.port,
      user: record.user,
      privateKey,
      readyTimeoutMs: CONNECT_TIMEOUT_MS,
      expectFingerprint: record.host_fingerprint,
      onHostKey: (fingerprint) => {
        seen.fingerprint = fingerprint;
      },
    });
    if (seen.fingerprint) await pinHostKey(record, seen.fingerprint);
    return await withTimeout(execCapture(client, command), COMMAND_TIMEOUT_MS, record.host);
  } finally {
    client?.end();
  }
}

// ── the engine read ─────────────────────────────────────────────────────────

export interface RemoteEngine {
  host: string;
  /** what this app can honestly say. "stopped" only when systemd said a loaded
   * unit is not active; never a guess about a box that did not answer. */
  engine: "running" | "stopped" | "unknown";
  /** one plain sentence, always naming the host that produced it */
  reason: string;
  /** systemd's `NRestarts`, or null when it could not be read - never a zero
   * standing in for "did not ask" */
  restarts: number | null;
  reachable: boolean;
}

/**
 * Three systemd properties and the last two journal lines, in one exec.
 * `is-active` exits non-zero for a stopped unit, so its value is captured from
 * a plain substitution rather than an `|| echo` fallback that would append a
 * second word to it. Every field is prefixed so the parse cannot be fooled by
 * a journal line that happens to contain an `=`.
 */
export function engineCommand(unit: string = ENGINE_UNIT): string {
  const u = shq(unit);
  return [
    `printf 'active=%s\\n' "$(systemctl is-active ${u} 2>/dev/null)"`,
    `printf 'load=%s\\n' "$(systemctl show -p LoadState --value ${u} 2>/dev/null)"`,
    `printf 'restarts=%s\\n' "$(systemctl show -p NRestarts --value ${u} 2>/dev/null)"`,
    `journalctl -u ${u} -n 2 --no-pager -o cat 2>/dev/null | sed -e 's/^/journal=/'`,
  ].join("; ");
}

export interface EngineFields {
  active: string;
  load: string;
  restarts: number | null;
  journal: string[];
}

/** The `key=value` lines above. Journal lines collect into a list instead of
 * overwriting one another, and anything unparseable is simply absent. */
export function parseEngineOutput(stdout: string): EngineFields {
  const fields: EngineFields = { active: "", load: "", restarts: null, journal: [] };
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1).trim();
    if (key === "active") fields.active = value;
    else if (key === "load") fields.load = value;
    else if (key === "restarts") fields.restarts = /^\d+$/.test(value) ? Number.parseInt(value, 10) : null;
    else if (key === "journal" && value) fields.journal.push(value);
  }
  return fields;
}

/** "reported by 155.133.27.86" - the phrase every remote sentence is built on,
 * so a reader never has to wonder which machine a claim is about. */
function reportedBy(host: string): string {
  return `reported by ${host}`;
}

/** systemd's words -> the three this app is allowed to say, plus the sentence.
 * A unit systemd does not have is NOT "stopped": that would be a claim about a
 * service that does not exist. It is unknown, and the sentence says why. */
export function engineFromFields(host: string, fields: EngineFields, where: string): RemoteEngine {
  const tail = fields.journal.length > 0 ? ` Last from its journal: ${fields.journal.join(" / ")}` : "";
  const restarts =
    fields.restarts === null ? "" : ` It has restarted ${fields.restarts} time${fields.restarts === 1 ? "" : "s"}.`;

  if (fields.load && fields.load !== "loaded") {
    return {
      host,
      engine: "unknown",
      reason: `${reportedBy(host)}: there is no ${ENGINE_UNIT} service on it (systemd says LoadState=${fields.load}) - ${where}`,
      restarts: null,
      reachable: true,
    };
  }
  if (fields.active === "active") {
    return {
      host,
      engine: "running",
      reason: `${reportedBy(host)}: ${ENGINE_UNIT} is active.${restarts}${tail} Source: ${where}`,
      restarts: fields.restarts,
      reachable: true,
    };
  }
  if (fields.active === "inactive" || fields.active === "failed" || fields.active === "deactivating") {
    return {
      host,
      engine: "stopped",
      reason: `${reportedBy(host)}: ${ENGINE_UNIT} is ${fields.active}.${restarts}${tail} Source: ${where}`,
      restarts: fields.restarts,
      reachable: true,
    };
  }
  return {
    host,
    engine: "unknown",
    reason: fields.active
      ? `${reportedBy(host)}: systemctl answered "${fields.active}" for ${ENGINE_UNIT}, which is neither running nor stopped - ${where}`
      : `${reportedBy(host)}: systemctl said nothing about ${ENGINE_UNIT} - the box answered but systemd did not - ${where}`,
    restarts: fields.restarts,
    reachable: true,
  };
}

/**
 * The engine's state on one machine. Never throws: an unreachable box is
 * `engine: "unknown"` carrying the SSH error.
 *
 * The SSH read is cached per machine for 15s and shared by every project bound
 * to it; the sentence is then assembled HERE, from the asking project's own
 * `where`. Two projects that reach one box by different links get one round
 * trip and two truthful attributions.
 */
export async function remoteEngine(machine: ProjectMachine): Promise<RemoteEngine> {
  const { record, where } = machine;
  const probe = await engineCache.get(record.id, async () => {
    try {
      const result = await runOnMachine(record, engineCommand());
      return { ok: true as const, fields: parseEngineOutput(result.stdout) };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  });

  if (probe.ok) return engineFromFields(record.host, probe.fields, where);
  return {
    host: record.host,
    engine: "unknown",
    // The far end's own words, verbatim - a friendlier sentence would be a
    // sentence nothing said.
    reason: `${record.host} could not be reached from this machine: ${probe.error} (${where})`,
    restarts: null,
    reachable: false,
  };
}

// ── the runs read ───────────────────────────────────────────────────────────

/**
 * The script python3 runs on the box. It is passed the db path and the limit
 * as ARGV, never interpolated into the source, so nothing a path contains can
 * become code. Every failure prints a JSON object and exits 0: a non-zero exit
 * would arrive here as a bare exec failure with no room for a reason.
 *
 * Columns are probed with `PRAGMA table_info` and substituted with NULL when
 * absent, mirroring `db.ts`'s `optionalColumn` - a db written by an older
 * tracer must read as "that column is null", never as a failed request.
 */
export const RUNS_SCRIPT = `
import json, os, sqlite3, sys
p, n = sys.argv[1], int(sys.argv[2])
if not os.path.exists(p):
    print(json.dumps({"ok": False, "missing": True, "reason": "no database at " + p}))
    sys.exit(0)
try:
    c = sqlite3.connect("file:" + p + "?mode=ro", uri=True)
except Exception as e:
    print(json.dumps({"ok": False, "missing": False, "reason": str(e)}))
    sys.exit(0)
def cols(t):
    try:
        return set(r[1] for r in c.execute("PRAGMA table_info(" + t + ")"))
    except Exception:
        return set()
def rows(t, want, sql, args=()):
    have = cols(t)
    if not have:
        return []
    picked = ", ".join((x if x in have else "NULL AS " + x) for x in want)
    try:
        cur = c.execute(sql.replace("@@", picked), args)
    except Exception:
        return []
    keys = [d[0] for d in cur.description]
    return [dict(zip(keys, r)) for r in cur.fetchall()]
have = cols("sessions")
where = "WHERE COALESCE(archived, 0) = 0 " if "archived" in have else ""
sess = rows("sessions",
    ["adw_id", "adw_name", "request", "status", "engineer", "started_at", "ended_at", "total_tokens", "total_cost", "archived"],
    "SELECT @@ FROM sessions " + where + "ORDER BY started_at DESC, rowid DESC LIMIT ?", (n,))
ids = [s["adw_id"] for s in sess]
marks = ", ".join("?" for _ in ids)
ph, ag, st, lg = [], [], [], []
if ids:
    ph = rows("phases",
        ["phase_id", "adw_id", "seq", "name", "kind", "owner", "description", "status", "attempt", "retries", "error", "started_at", "ended_at"],
        "SELECT @@ FROM phases WHERE adw_id IN (" + marks + ") ORDER BY seq, rowid", ids)
    ag = rows("agent_sessions",
        ["adw_id", "agent", "coding_agent", "model", "session_id", "color", "context_tokens", "context_window", "created_at", "last_used_at"],
        "SELECT @@ FROM agent_sessions WHERE adw_id IN (" + marks + ") ORDER BY created_at, agent", ids)
    if cols("phases"):
        st = rows("events", ["adw_id", "agent", "payload_json", "started_at"],
            "SELECT e.adw_id, p.owner AS agent, e.payload_json, e.started_at FROM events e JOIN phases p ON p.phase_id = e.phase_id WHERE e.adw_id IN (" + marks + ") AND e.type = 'agent_start' ORDER BY e.rowid", ids)
    lg = rows("events", ["adw_id", "name", "payload_json"],
        "SELECT @@ FROM events WHERE adw_id IN (" + marks + ") AND type = 'log' AND name IN ('branch', 'worktree') ORDER BY rowid", ids)
print(json.dumps({"ok": True, "sessions": sess, "phases": ph, "agents": ag, "agent_starts": st, "logs": lg}, default=str))
`.trim();

/** `<repo_dir>/adws/adw_data/sssf.db` - the same path `scoped.ts` builds
 * locally, spelled POSIX-style because the far end is Linux. */
export function remoteDbPath(repoDir: string): string {
  return `${repoDir.replace(/\/+$/, "")}/adws/adw_data/sssf.db`;
}

export function runsCommand(repoDir: string, limit: number): string {
  return `python3 -c ${shq(RUNS_SCRIPT)} ${shq(remoteDbPath(repoDir))} ${shq(String(limit))}`;
}

interface RunsPayload {
  ok: boolean;
  missing?: boolean;
  reason?: string;
  sessions?: Session[];
  phases?: Phase[];
  agents?: AgentSession[];
  agent_starts?: AgentStartRow[];
  logs?: TitleLogRow[];
}

/** A session row read from a machine, tagged with the machine that holds it.
 * `machine` is the field `ui-v3/src/runs/model.ts:machineOf` has always read
 * defensively ("the moment run records arrive over the server connection
 * carrying one the chip appears with no other change anywhere") - so this is
 * the label appearing on the row, not a new UI. */
export type RemoteSession = SessionSummary & { machine: string };

export interface RemoteRuns {
  runs: RemoteSession[];
  source: RunsSource;
}

/** The python payload -> the exact rows `db.ts:sessions()` produces locally,
 * assembled by the very functions that assemble the local ones. */
export function assembleRemoteRuns(payload: RunsPayload, host: string): RemoteSession[] {
  const sessions = payload.sessions ?? [];
  const byAdw = new Map<string, Phase[]>();
  for (const phase of payload.phases ?? []) {
    const list = byAdw.get(phase.adw_id);
    if (list) list.push(phase);
    else byAdw.set(phase.adw_id, [phase]);
  }
  const agents = agentsFromRows(payload.agents ?? [], payload.agent_starts ?? []);
  const titles = titlesFromLogRows(payload.logs ?? []);

  return sessions.map((session) => ({
    ...session,
    phases: byAdw.get(session.adw_id) ?? [],
    agents: agents.get(session.adw_id) ?? [],
    title: titles.get(session.adw_id) ?? null,
    // What the row's muted chip prints.
    machine: `on ${host}`,
  }));
}

function emptySource(host: string, repoDir: string | null, reachable: boolean | null, reason: string): RunsSource {
  return { origin: "machine", host, repo_dir: repoDir, reachable, reason };
}

/**
 * The newest runs recorded on one machine, cached per machine for 15s. Never
 * throws and never invents: a box with no checkout, no db, no python3 or no
 * route to it comes back with an empty list and the sentence that says which.
 */
export async function remoteRuns(machine: ProjectMachine, limit = REMOTE_RUNS_LIMIT): Promise<RemoteRuns> {
  const { record, where } = machine;
  const host = record.host;
  const repoDir = record.repo_dir;

  // Answered before the cache is touched, and deliberately so: this branch
  // opens no connection (there is no path to read), and its sentence is the one
  // answer on this path that ends in the ASKING project's `where`. Everything
  // below is a fact about the box and is shared; this is not.
  if (!repoDir) {
    return {
      runs: [],
      source: emptySource(
        host,
        null,
        true,
        `no factory checkout is recorded on ${host} yet - Settings · Machines · Deploy is what puts one there (${where})`,
      ),
    };
  }

  return runsCache.get(`${record.id}|${repoDir}|${limit}`, async () => {
    let result: { code: number | null; stdout: string; stderr: string };
    try {
      result = await runOnMachine(record, runsCommand(repoDir, limit));
    } catch (error) {
      return {
        runs: [],
        source: emptySource(host, repoDir, false, `${host} could not be reached from this machine: ${(error as Error).message}`),
      };
    }

    let payload: RunsPayload;
    try {
      payload = JSON.parse(result.stdout.trim()) as RunsPayload;
    } catch {
      // python3 missing, or anything else the shell printed instead of JSON.
      // The far end's own last line is the reason - never a guess at the cause.
      const said = (result.stderr || result.stdout).trim().split("\n").slice(-1)[0] ?? "no output";
      return {
        runs: [],
        source: emptySource(host, repoDir, true, `${host} could not read its own run record: ${said}`),
      };
    }

    if (!payload.ok) {
      return {
        runs: [],
        source: emptySource(
          host,
          repoDir,
          true,
          payload.missing
            ? `no runs recorded on ${host} yet - ${remoteDbPath(repoDir)} does not exist there, so the engine has not run a card in that checkout`
            : `${host} holds a run record this app could not open: ${payload.reason ?? "no reason given"}`,
        ),
      };
    }

    const runs = assembleRemoteRuns(payload, host);
    return {
      runs,
      source: emptySource(
        host,
        repoDir,
        true,
        runs.length === 0
          ? `no runs recorded on ${host} yet - ${remoteDbPath(repoDir)} is there but holds none`
          : `${runs.length === limit ? `the newest ${limit} runs` : `${runs.length} run${runs.length === 1 ? "" : "s"}`} recorded on ${host}, read from ${remoteDbPath(repoDir)}`,
      ),
    };
  });
}

/** The local answer's own source row, so the shape is the same either way. */
export function localRunsSource(): RunsSource {
  return { origin: "local", host: null, repo_dir: null, reachable: null, reason: null };
}
