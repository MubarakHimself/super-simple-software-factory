/**
 * `/api/app/p/:id/runs/:adw_id/worklog` and `/quality` (spec 4, chunk K2a) -
 * the server-side fold of `events` into the typed rows Runs' work log
 * renders (spec 2.5.3), plus the narrower `quality:%` view (spec 2.5.5).
 *
 * The fold is deliberately the server's job, not the client's: "one table,
 * server-side" (spec 2.5.3) for the tool-name -> heading mapping, so every
 * harness's raw tool names collapse to the same vocabulary before they ever
 * reach a component. The client still owns collapse-and-count, grouping and
 * icon choice - this file only ever adds structure, never trims it (the
 * cursor page is the same rowid-bounded shape `db.events()` already returns).
 */
import type { AgentSession, Event, Phase } from "../../shared/types.ts";
import { isSafeSegment } from "../gitro.ts";
import { appError, appJson, appSafely } from "./guard.ts";
import { factoryAbsent, getScope, intQuery, param } from "./scoped.ts";

// -- the fold -----------------------------------------------------------------

export type WorkLogKind = "tool" | "commit" | "log" | "handoff" | "error" | "gate";

export interface WorkLogEntry {
  rowid: number;
  kind: WorkLogKind;
  phase_id: string | null;
  /** The phase's owner (spec 2.5.3: "every entry carries the agent's color
   * chip") - resolved from `phases.owner`, falling back to the tool-call
   * payload's own `agent` field when the phase lookup has nothing (older
   * telemetry, or an event outside a phase). */
  agent: string | null;
  agent_color: string | null;
  /** `events.parent_id` truthiness, never null-ness - `parent_id` is the
   * empty string on every row this tracer has ever written (`tracer.py:130`,
   * default `""` - `data_types.py:457`), never SQL `NULL`. Testing
   * `!== null` would indent every single row; testing truthiness indents
   * none today, which is the honest answer (no traced run has ever recorded
   * a nested event - W2-G1). Stated so nobody "fixes" it into the trap. */
  indent: boolean;
  started_at: string | null;

  // kind: "tool"
  heading?: string;
  preview?: string | null;
  status?: "ok" | "fail" | "neutral";
  args?: Record<string, unknown>;
  result_snippet?: string | null;
  duration_ms?: number | null;

  // kind: "commit"
  sha?: string;
  message?: string;
  /** From a same-phase `paths_touched` event, when one exists - never
   * invented when it does not (spec's mock-data ban applied to a count). */
  file_count?: number | null;

  // kind: "log"
  text?: string;
  level?: string | null;

  // kind: "handoff"
  summary?: string;
  artifacts?: string[];

  // kind: "error"
  detail?: string;

  // kind: "gate"
  gate?: string | null;
  passed?: boolean | null;
}

/** `bash->Ran commands`, `write|edit->Edited a file`, `read|grep|ls->Read
 * files` (spec 2.5.3's exact table) - matched case-insensitively since
 * harnesses differ in casing (pi's own tool names vs. Claude Code's).
 * Unknown tools fall back to their own name, never an invented verb. */
const VERB_TABLE: Record<string, string> = {
  bash: "Ran commands",
  write: "Edited a file",
  edit: "Edited a file",
  read: "Read files",
  grep: "Read files",
  ls: "Read files",
};

function headingFor(tool: string): string {
  return VERB_TABLE[tool.toLowerCase()] ?? tool;
}

const PREVIEW_CHARS = 120;

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** "preview (first arg)" (spec 2.5.3) - the first value in the tool's own
 * `args` object, whatever key it is filed under (harness-specific). */
function firstArgPreview(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  const first = Object.values(args)[0];
  if (first === undefined || first === null) return null;
  const text = typeof first === "string" ? first : JSON.stringify(first);
  return clip(text, PREVIEW_CHARS);
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * `events[]` (already rowid-ordered) -> `WorkLogEntry[]`, one entry per
 * narrative-bearing event. `quality:%` tool calls are deliberately excluded
 * here - they are their own surface (`getQuality` below, spec 2.5.5's
 * distinct Quality block) and would otherwise duplicate as noisy generic
 * tool rows next to the coding work they are checking. Structural events
 * (`agent_start`/`agent_end`/`phase_start`/`phase_end`) contribute no row -
 * they back the beat rail and agent chips elsewhere, not the work log.
 */
export function foldEvents(events: Event[], phases: Phase[], agents: AgentSession[]): WorkLogEntry[] {
  const ownerByPhase = new Map<string, string | null>();
  for (const p of phases) ownerByPhase.set(p.phase_id, p.owner);

  const colorByAgent = new Map<string, string | null>();
  for (const a of agents) colorByAgent.set(a.agent, a.color);

  // A commit's file count comes from the `paths_touched` event logged in the
  // SAME phase (agents.py:222-226) - collected in a first pass so the main
  // pass can look it up in O(1) instead of re-scanning per commit.
  const pathsTouchedByPhase = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "log" || e.name !== "paths_touched" || !e.phase_id) continue;
    const payload = parsePayload(e.payload_json);
    const paths = payload["paths"];
    if (Array.isArray(paths)) pathsTouchedByPhase.set(e.phase_id, paths.length);
  }

  const entries: WorkLogEntry[] = [];

  for (const e of events) {
    const owner = e.phase_id ? (ownerByPhase.get(e.phase_id) ?? null) : null;
    const base = {
      rowid: e.rowid,
      phase_id: e.phase_id,
      indent: Boolean(e.parent_id),
      started_at: e.started_at,
    };

    if (e.type === "tool_call") {
      if (e.name?.startsWith("quality:")) continue; // spec 2.5.5's own surface
      const payload = parsePayload(e.payload_json);
      const tool = typeof payload["tool"] === "string" ? (payload["tool"] as string) : (e.name ?? "tool");
      const agent = typeof payload["agent"] === "string" ? (payload["agent"] as string) : owner;
      const ok = payload["ok"];
      entries.push({
        ...base,
        kind: "tool",
        agent,
        agent_color: agent ? (colorByAgent.get(agent) ?? null) : null,
        heading: headingFor(tool),
        preview: firstArgPreview(payload["args"] as Record<string, unknown> | undefined),
        status: ok === true ? "ok" : ok === false ? "fail" : "neutral",
        args: (payload["args"] as Record<string, unknown> | undefined) ?? {},
        result_snippet: typeof payload["result_snippet"] === "string" ? (payload["result_snippet"] as string) : null,
        duration_ms: typeof payload["duration_ms"] === "number" ? (payload["duration_ms"] as number) : null,
      });
      continue;
    }

    if (e.type === "log") {
      const payload = parsePayload(e.payload_json);
      const sha = payload["sha"];
      if (typeof sha === "string" && sha.length > 0) {
        entries.push({
          ...base,
          kind: "commit",
          agent: owner,
          agent_color: owner ? (colorByAgent.get(owner) ?? null) : null,
          sha,
          message: typeof payload["message"] === "string" ? (payload["message"] as string) : "",
          file_count: e.phase_id ? (pathsTouchedByPhase.get(e.phase_id) ?? null) : null,
        });
        continue;
      }
      const message = payload["message"];
      if (typeof message === "string" && message.length > 0) {
        entries.push({
          ...base,
          kind: "log",
          agent: owner,
          agent_color: owner ? (colorByAgent.get(owner) ?? null) : null,
          text: message,
          level: typeof payload["level"] === "string" ? (payload["level"] as string) : null,
        });
      }
      // Other `log` events (branch/worktree/paths_touched/main_checkout_drift)
      // carry structural payloads, not narrative text - no row (they are not
      // a "verb-phrase" the work log's own vocabulary can honestly render).
      continue;
    }

    if (e.type === "handoff") {
      const payload = parsePayload(e.payload_json);
      const artifacts = payload["artifacts"];
      entries.push({
        ...base,
        kind: "handoff",
        agent: owner,
        agent_color: owner ? (colorByAgent.get(owner) ?? null) : null,
        summary: typeof payload["summary"] === "string" ? (payload["summary"] as string) : "",
        artifacts: Array.isArray(artifacts) ? (artifacts.filter((a) => typeof a === "string") as string[]) : [],
      });
      continue;
    }

    if (e.type === "error") {
      const payload = parsePayload(e.payload_json);
      const detail =
        (typeof payload["error"] === "string" && (payload["error"] as string)) ||
        (typeof payload["message"] === "string" && (payload["message"] as string)) ||
        JSON.stringify(payload);
      entries.push({ ...base, kind: "error", agent: owner, agent_color: owner ? (colorByAgent.get(owner) ?? null) : null, detail });
      continue;
    }

    if (e.type === "gate_pass" || e.type === "gate_fail") {
      entries.push({
        ...base,
        kind: "gate",
        agent: owner,
        agent_color: owner ? (colorByAgent.get(owner) ?? null) : null,
        gate: e.name,
        passed: e.type === "gate_pass",
      });
      continue;
    }

    // phase_start | phase_end | agent_start | agent_end -> no row.
  }

  return entries;
}

// -- quality --------------------------------------------------------------

export type QualityStatus = "pass" | "fail" | "incomplete";

export interface QualityCheck {
  area: string | null;
  operation: string | null;
  command: string | null;
  returncode: number | null;
  status: QualityStatus | "unknown";
  output_artifact: string | null;
}

export function foldQuality(events: Event[]): QualityCheck[] {
  const checks: QualityCheck[] = [];
  for (const e of events) {
    if (e.type !== "tool_call" || !e.name?.startsWith("quality:")) continue;
    const payload = parsePayload(e.payload_json);
    const status = payload["status"];
    checks.push({
      area: typeof payload["area"] === "string" ? (payload["area"] as string) : null,
      operation: typeof payload["operation"] === "string" ? (payload["operation"] as string) : null,
      command: typeof payload["command"] === "string" ? (payload["command"] as string) : null,
      returncode: typeof payload["returncode"] === "number" ? (payload["returncode"] as number) : null,
      status: status === "pass" || status === "fail" || status === "incomplete" ? status : "unknown",
      output_artifact: typeof payload["output_artifact"] === "string" ? (payload["output_artifact"] as string) : null,
    });
  }
  return checks;
}

// -- routes -----------------------------------------------------------------

async function getWorklog(req: Request): Promise<Response> {
  const id = param(req, "id");
  const adwId = param(req, "adw_id");
  if (!isSafeSegment(adwId)) return appError("invalid adw_id", 400);

  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!scope.db) return factoryAbsent();
  if (!scope.db.session(adwId)) return appError(`no run ${adwId}`, 404);

  const after = intQuery(req, "after", 0);
  const page = scope.db.events(adwId, after, 500);
  const phases = scope.db.phases(adwId);
  const agents = scope.db.agentSessions(adwId);

  return appJson({
    entries: foldEvents(page.events, phases, agents),
    cursor: page.cursor,
    has_more: page.has_more,
  });
}

async function getQuality(req: Request): Promise<Response> {
  const id = param(req, "id");
  const adwId = param(req, "adw_id");
  if (!isSafeSegment(adwId)) return appError("invalid adw_id", 400);

  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!scope.db) return factoryAbsent();
  if (!scope.db.session(adwId)) return appError(`no run ${adwId}`, 404);

  // quality:% events can arrive past the default page cap on a long run;
  // MAX_LIMIT (1000, db.ts) covers every run on this box today (255 events
  // total across all 12 sessions) with headroom to spare.
  const page = scope.db.events(adwId, 0, 1000);
  return appJson(foldQuality(page.events));
}

export const worklogRoutes = {
  "/api/app/p/:id/runs/:adw_id/worklog": appSafely(getWorklog),
  "/api/app/p/:id/runs/:adw_id/quality": appSafely(getQuality),
};
