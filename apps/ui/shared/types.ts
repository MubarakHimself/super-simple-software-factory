/**
 * Types shared by the read-only Bun server and the React client.
 *
 * Every interface mirrors a table in sssf.db one-for-one (see
 * adws/adw_modules/tracer.py) or a file on disk (queue/*.md,
 * sssf.config.yaml, context_handoff/changes.diff). Nothing here is stored
 * derived state: phase durations, session progress and diff summaries are
 * computed at request time, never cached in a table of their own.
 */

// -- sssf.db mirror -----------------------------------------------------------

/** sessions.status - a run is running until it earns success. */
export type SessionStatus = "running" | "success" | "fail";

/** phases.status - the DDL default is "fail" but a live phase has ended_at
 * NULL; render liveness from ended_at, never from this string alone. */
export type PhaseStatus = "queued" | "running" | "success" | "fail";

/** phases.kind - decides how a phase's header reads. */
export type PhaseKind = "engineer" | "code" | "agent";

/** events.type - the types tracer.py emits. */
export type EventType =
  | "phase_start"
  | "phase_end"
  | "agent_start"
  | "agent_end"
  | "tool_call"
  | "handoff"
  | "gate_pass"
  | "gate_fail"
  | "log"
  | "error";

export interface Session {
  adw_id: string;
  /** ADW script(s) that ran this session, e.g. "adw_plan + adw_build_test". */
  adw_name: string | null;
  request: string | null;
  status: SessionStatus | null;
  engineer: string | null;
  started_at: string | null;
  ended_at: string | null;
  total_tokens: number | null;
  total_cost: number | null;
  /** 1 once archived by some other tool. This UI never writes it. */
  archived: number | null;
}

/** A session row with its phases and agents embedded, so L1 draws without a
 * second request per row. */
export interface SessionSummary extends Session {
  phases: Phase[];
  agents: AgentSession[];
  /** The run's human name - "an id tells me nothing" (MAP.md's worktree-
   * naming ticket). Derived server-side from the run's `branch` trace event
   * (title stamped once at worktree entry, see runner.py's
   * `Run._log_branch_and_title`), falling back to a humanized branch slug
   * for telemetry recorded before this fix. Null for a run that never cut a
   * branch (adw_prompt, adw_scout, adw_quality) - never invented. */
  title: string | null;
}

export interface Phase {
  phase_id: string;
  adw_id: string;
  seq: number | null;
  name: string | null;
  kind: PhaseKind | null;
  owner: string | null;
  description: string | null;
  status: PhaseStatus | null;
  attempt: number | null;
  retries: number | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface Event {
  /** SQLite rowid - the polling cursor. Monotonic, insertion-ordered. */
  rowid: number;
  event_id: string;
  adw_id: string;
  phase_id: string | null;
  parent_id: string | null;
  type: EventType | null;
  name: string | null;
  /** Raw JSON string as written by the tracer; parse at the point of display. */
  payload_json: string | null;
  tokens: number | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface Envelope {
  envelope_id: string;
  adw_id: string;
  phase_id: string | null;
  agent: string | null;
  output_type: string | null;
  payload_json: string | null;
  /** SQLite integer boolean. */
  valid: number | null;
  attempt: number | null;
  created_at: string | null;
}

/** One item a gate inspected - the parsed element of checks_json. */
export interface GateCheck {
  item: string;
  ok: boolean;
  note: string;
}

export interface GateResult {
  id: number;
  adw_id: string;
  phase_id: string | null;
  attempt: number | null;
  gate: string | null;
  /** SQLite integer boolean. */
  passed: number | null;
  violations_json: string | null;
  checks_json: string | null;
  created_at: string | null;
}

export interface ProcessRow {
  id: number;
  adw_id: string;
  kind: string | null;
  name: string | null;
  pid: number | null;
  command: string | null;
  started_at: string | null;
  /** NULL = believed alive. */
  ended_at: string | null;
}

export interface AgentSession {
  adw_id: string;
  agent: string;
  coding_agent: string | null;
  model: string | null;
  color: string | null;
  session_id: string | null;
  context_tokens: number | null;
  context_window: number | null;
  created_at: string | null;
  last_used_at: string | null;
}

/** Raw read/written tokens, derived from agent_end payloads - see db.ts. */
export interface SessionUsage {
  read: number;
  written: number;
}

export interface SessionDetail {
  session: Session;
  usage: SessionUsage;
  phases: Phase[];
  agents: AgentSession[];
  processes: ProcessRow[];
  /** adw/<adw_id>_<slug>, when one exists - null for a chain that never cut
   * a branch (adw_prompt, adw_scout, adw_quality today). */
  branch: string | null;
  /** Same derivation as SessionSummary.title - see there. */
  title: string | null;
}

export interface EventsPage {
  events: Event[];
  cursor: number;
  has_more: boolean;
}

export interface AgentPrompts {
  system: string | null;
  user: string | null;
}

// -- payload_json shapes ------------------------------------------------------

export interface AgentStartPayload {
  model?: string;
  thinking?: string;
  session_id?: string;
  color?: string;
  coding_agent?: string;
  purpose?: string;
  tools?: string[] | null;
  harness_engineering?: string[];
}

export interface UsageBreakdown {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens?: number;
  total_tokens: number;
  input_cost: number;
  output_cost: number;
  cache_read_cost: number;
  cache_write_cost: number;
  total_cost: number;
}

export interface AgentEndPayload {
  cost?: number;
  usage?: UsageBreakdown;
  context_tokens?: number;
  context_window?: number;
}

export interface ToolCallPayload {
  tool?: string;
  tool_call_id?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  result_snippet?: string;
  duration_ms?: number;
  agent?: string;
}

export interface LogPayload {
  message?: string;
  level?: string;
  input?: string;
  /** Commit phases log a sha + message here (git phases log). */
  sha?: string;
  /** `name: "branch"` events only (runner.py's `Run._log_branch_and_title`,
   * stamped at worktree entry): the run's branch, its worktree path, and its
   * derived human title. */
  branch?: string;
  path?: string;
  title?: string;
}

export interface HandoffPayload {
  artifacts?: string[];
  summary?: string;
}

export interface GatePayload {
  attempt?: number;
  violations?: string[];
  checks?: GateCheck[];
}

// -- diff ------------------------------------------------------------------

export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
}

export interface DiffResponse {
  /** The BaseRef.reason string the factory records, or a synthesized one. */
  base: string;
  files: DiffFile[];
  added: number;
  deleted: number;
  /** Unified diff text, capped; "" when there is nothing to show. */
  patch: string;
  truncated: boolean;
  /** True when the run made no commits and captured no diff. */
  empty: boolean;
}

/** One selectable scope in the phase-diff picker. */
export interface DiffScope {
  id: string; // "run" | phase_id
  label: string; // "Whole run" | "01 commit_plan"
  sha: string | null;
}

// -- queue (Board) ------------------------------------------------------------

export type QueueStatus = "ready-for-agent" | "running" | "blocked" | "done";

export interface QueueItem {
  path: string; // "queue/001-add-health-endpoint.md"
  slug: string;
  title: string;
  status: QueueStatus;
  adw: string | null;
  adw_id: string | null;
  created: string | null;
  context: string | null;
  category: string | null;
  criteria_done: number;
  criteria_total: number;
  body: string; // raw markdown, minus the header block
}

export interface UnparsedQueueItem {
  path: string;
  reason: string;
}

export interface QueueResponse {
  dir: string;
  items: QueueItem[];
  unparsed: UnparsedQueueItem[];
}

// -- gate ------------------------------------------------------------------

export interface GateItem {
  adw_id: string;
  adw_name: string | null;
  request: string | null;
  branch: string;
  ended_at: string | null;
  diff: DiffResponse;
  /** Same phase selector as Trace's Diff tab (spec 5.2.1, 5.4) - the Gate
   * card embeds the same DiffView component this feeds. */
  diff_scopes: DiffScope[];
  quality: GateResult | null;
  gates: GateResult[];
  reviewer_summary: string | null;
  /** null when there is no origin remote, or it is not GitHub. */
  compare_url: string | null;
  /** Set when compare_url is null: the manual push command as copyable text. */
  push_command: string | null;
  remote_kind: "github" | "other" | "none";
}

export interface GateResponse {
  items: GateItem[];
}

// -- settings --------------------------------------------------------------

export interface RosterAgentDefaults {
  coding_agent: string | null;
  model: string | null;
  thinking: string | null;
  tools: string[];
  harness_engineering: string[];
  protected_files: string[];
  data_dir: string | null;
}

export interface RosterAgent {
  name: string;
  color: string | null;
  purpose: string | null;
  model: string; // resolved (own or inherited)
  model_inherited: boolean;
  thinking: string; // resolved
  thinking_inherited: boolean;
  tools: string[];
  writes: string[] | null; // null = unrestricted (no writes: key)
  harness_engineering: string[];
}

export interface LaneStatus {
  provider_model: string; // "ollama-cloud/kimi-k2.7-code"
  last_round_trip_at: string | null;
  last_round_trip_tokens: number | null;
  run_count: number;
  exercised: boolean;
}

export interface ObservabilityInfo {
  db: string;
  journal_mode: string;
  poll_ms: number;
  session_count: number;
  data_dir: string;
  sessions_dir: string;
  protected_files: string[];
}

export interface PathsInfo {
  bind: string;
  port: number;
  read_only: true;
  build_time: string | null;
}

export interface ConfigResponse {
  roster: RosterAgent[];
  defaults: RosterAgentDefaults;
  lanes: LaneStatus[];
  observability: ObservabilityInfo;
  paths: PathsInfo;
}

// -- misc / health ------------------------------------------------------------

export interface GitInfo {
  repo: string | null;
  branch: string | null;
  remote: string | null;
}

export interface HealthResponse {
  ok: true;
  db: string;
  journal_mode: string;
  read_only: true;
  sessions: number;
  queue_dir: string;
  git: GitInfo;
}

export interface ApiError {
  error: string;
}
