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

// -- v3 app plane: ship / cards / factory -------------------------------------
//
// Additive only. Everything below is served under `/api/app/*` by
// `server/app/ship.ts`, `server/app/cards.ts` and `server/app/factory.ts`, and
// is what the v3 surfaces read. Nothing here is stored: every field is derived
// per request from git, `queue/`, the roster yaml, or `adws/ship_report.py`'s
// own output - and anything that cannot be derived is `null`/`"unknown"` with
// a sentence saying why, never a guess (docs/user-journeys.md J7).

/** One acceptance box as `adws/ship_report.py` walked it. The verdict
 * vocabulary is the script's own and is never widened here. */
export interface ShipCriterion {
  text: string;
  /** the card's own checkbox, as the script reported it */
  checked: boolean;
  verdict: "confirmed-by-record" | "cannot-confirm-from-record";
  /** the script's `record:` line, verbatim */
  evidence: string;
}

/** One card in the chunk sitting on `integration` that `main` does not have. */
export interface ShipCard {
  /** `003-slug.md` - the basename `Needs:` and `POST /ship`'s `cut` both use */
  name: string;
  title: string;
  /** the park ("integration") commit, abbreviated exactly as the script prints
   * it. This is the CUT POINT: shipping "up to" this card advances `main` to
   * this commit. Null when the script could not name one. */
  sha: string | null;
  /** ISO 8601 commit date of the park event */
  date: string | null;
  detected_by: "commit-message" | "diff" | null;
  branch: string | null;
  files_changed: number | null;
  insertions: number | null;
  deletions: number | null;
  /** the script's `- Diff: none recorded (<note>)` reason, when it printed one */
  diff_note: string | null;
  criteria: ShipCriterion[];
  /** the script's own `- Gap:` line for this card, when it printed one */
  gap: string | null;
}

export interface ShipReportResponse {
  /** the report exactly as `uv run adws/ship_report.py --pr` printed it - this
   * is what becomes the squash commit's body, so it is served unedited */
  markdown: string;
  cards: ShipCard[];
  /** commits on `integration` that `main` does not have, per the report */
  commit_count: number;
  /** nothing to ship: no commits, or no card parked inside them */
  empty: boolean;
  /** `BASE..TIP` as the script resolved it (its own range expression) */
  range: string | null;
  base: string | null;
  tip: string | null;
  /** the report's own Gaps section, one entry per line */
  gaps: string[];
  /** false when the script could not run or refused - then `reason` says why
   * in the script's own words and every field above is empty */
  available: boolean;
  reason: string | null;
  generated_at: string;
}

/** What `POST /api/app/p/:id/ship` did. A refusal is never this shape - it is
 * `{error}` with the reason as a sentence (409). */
export interface ShipResult {
  shipped: true;
  /** what the operator asked to ship: `"all"` or a card basename */
  cut: string;
  /** the integration commit `main` advanced to (full sha) */
  cut_sha: string;
  /** the range the squash body covers, `BASE..CUT` */
  range: string;
  /** basenames of the cards inside that range, in integration order */
  cards: string[];
  /** `main`'s new short sha - the one squash commit */
  commit: string;
  /** where the body was written (inside the git dir, never the work tree) */
  message_file: string;
  /** `integration` or `origin/integration` - whichever this checkout has */
  integration_ref: string;
  fetched: boolean;
  fetch_note: string | null;
  pushed: boolean;
  /** git's own words when the push was refused - the squash still landed
   * locally, which is why this is a 200 and not an error */
  push_error: string | null;
  remote: string | null;
  previous_branch: string;
  restored_branch: boolean;
  restore_error: string | null;
}

/** The card lifecycle of docs/user-journeys.md's "Card lifecycle" row.
 * `unknown` is a real answer: a state this server cannot derive is never
 * guessed at, it is `unknown` with a reason. */
export type CardState = "ready" | "running" | "blocked" | "done" | "integrated" | "shipped" | "unknown";

export interface CardItem {
  /** `queue/003-slug.md`, or `queue/done/003-slug.md` once parked */
  path: string;
  /** `003-slug.md` - the basename `Needs:` names and `cut` takes */
  name: string;
  slug: string;
  title: string;
  /** the card's own `Status:` line; null when it carries none (parked cards
   * are sometimes left at their last status) */
  status: QueueStatus | null;
  state: CardState;
  /** always set - the plain sentence behind `state` (status triple rule) */
  state_reason: string;
  /** the card file lives in `queue/done/` (the engine parked it) */
  parked: boolean;
  adw: string | null;
  adw_id: string | null;
  created: string | null;
  context: string | null;
  category: string | null;
  /** `Feature:` header - the feature id `/to-kanban` stamps; null when absent */
  feature: string | null;
  /** `Priority:` header, passed through verbatim when a card carries one
   * (docs/user-journeys.md change #7 leaves it optional) */
  priority: string | null;
  /** `Needs:` basenames, comma-split exactly as dispatch.py splits them */
  needs: string[];
  /** the needs that are NOT yet parked in `queue/done/` - the holding hint
   * "waiting on <cards>" the Board face shows (change #6). Empty otherwise. */
  waiting_on: string[];
  /** `Blocked-reason:` header, verbatim; null when the card carries none */
  blocked_reason: string | null;
  /** other cards whose `Needs:` name this one (reverse edges) */
  blocks: string[];
  criteria_done: number;
  criteria_total: number;
  criteria: { text: string; done: boolean }[];
  body: string;
}

export interface CardsResponse {
  dir: string;
  done_dir: string;
  items: CardItem[];
  unparsed: UnparsedQueueItem[];
  /** how integrated/shipped was decided, and why it may be `unknown`:
   * `git ls-tree <main> -- queue/done` - a parked card whose file `main`'s
   * tree already holds shipped with that chunk's squash. */
  shipped_source: "git-tree" | "unavailable";
  shipped_reason: string | null;
  main_ref: string;
}

export interface LaneRow {
  /** the provider prefix of a roster `provider/model` string, e.g.
   * "ollama-cloud" - one provider account = one lane = one quota pool */
  name: string;
  /** concurrent runs this lane carries (engine.py's DEFAULT_LANE_SLOTS, or an
   * `SSSF_LANES` override read from this process's environment) */
  slots: number;
  slots_source: "default" | "SSSF_LANES";
  /** the roster model strings drawing on this lane */
  models: string[];
  /** the roster agents drawing on this lane ("defaults" when inherited) */
  agents: string[];
  /** null locally: free slots are the running engine's own count, and this
   * machine has no engine to ask */
  free: number | null;
}

export interface LanesResponse {
  lanes: LaneRow[];
  /** the roster the lanes were derived from */
  config_path: string;
  slots_default: number;
  /** `SSSF_LANES` as this process sees it, or null */
  env: string | null;
  /** the Lanes tab's toggles/retry budget have no field in any config file
   * today - false keeps the UI from pretending a switch is wired */
  writes_supported: false;
  reason: string | null;
}

/** A provider definition as it is git-tracked in the repo
 * (`installer/assets/pi/<id>.provider.json`). Credentials are never here:
 * they live in `~/.pi/agent/auth.json` on the machine that runs the factory. */
export interface ProviderDefinition {
  id: string;
  /** repo-relative path of the definition, or null for a lane with none */
  source: string | null;
  /** true when a git-tracked definition file exists for this id */
  defined: boolean;
  api: string | null;
  base_url: string | null;
  auth_mechanism: "api-key-command" | "api-key" | "none" | "unknown";
  /** always "unknown" from here: this server never reads a credential file */
  auth_status: "unknown";
  auth_reason: string;
  models: { id: string; name: string | null; context: number | null; max_tokens: number | null }[];
  /** true when this provider is a lane of the project's roster */
  in_roster: boolean;
}

export interface ProviderDefinitionsResponse {
  providers: ProviderDefinition[];
  dir: string;
  reason: string | null;
}

export interface MachineRow {
  id: string;
  name: string;
  kind: "local" | "server";
  /** the drawn caption: "planning only - no factory" / "factory execution" */
  role: string;
  host: string | null;
  status: "this machine" | "configured" | "unknown";
  status_reason: string;
  factory_version: string | null;
  runs: number | null;
}

export interface MachinesResponse {
  machines: MachineRow[];
  server_configured: boolean;
  /** v1 is one server + localhost (change #11) - the default-machine and
   * failover selects stay drawn and disabled */
  multi_machine_supported: false;
  reason: string;
}

export interface FactoryQueueCounts {
  ready: number;
  running: number;
  blocked: number;
  done: number;
  integrated: number;
  shipped: number;
  unknown: number;
  unparsed: number;
  total: number;
}

/** The footer strip's source of truth, derived on THIS machine. */
export interface FactoryHealth {
  /** everything below was derived from files and git in this checkout - no
   * engine was asked, because asking one needs the server connection */
  source: "local-derived";
  checked_at: string;
  /** "unknown" whenever no engine runs here - never "stopped" by guesswork */
  engine: "running" | "stopped" | "unknown";
  engine_reason: string;
  uptime_seconds: number | null;
  uptime_reason: string | null;
  lanes: LaneRow[];
  lanes_active: number | null;
  lanes_reason: string;
  queue: FactoryQueueCounts;
  /** runs still marked running in this project's sssf.db, or null when there
   * is no db here */
  runs_running: number | null;
  factory: "present" | "absent";
  factory_reason: string;
}
