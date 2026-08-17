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
  /** which SPA generation this process serves. `server/index.ts` has emitted
   * this field since the v3 shell landed (it refuses to reuse a server showing
   * another UI); the type never grew it, which was the one pre-existing
   * `tsc -p tsconfig.server.json` error. Additive, so no caller changes. */
  ui: "v1" | "v2" | "v3";
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
   * in ONE plain sentence and every field above is empty */
  available: boolean;
  reason: string | null;
  /** the script's full text when `reason` summarizes it, else null - what a
   * title/tooltip carries, so nothing is hidden and nothing is a wall */
  detail: string | null;
  /** true only when this project has no `integration` branch: the factory has
   * never run here. A quiet empty state, never an error - see `refusalFrom` */
  not_started: boolean;
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
   * "ollama-cloud" - one provider account = one lane = one quota pool.
   * A PROVIDER, never a model family: "ollama-cloud" is an account, and the
   * family of what it serves is read from the model name (see FamilyId). */
  name: string;
  /** the slot count that applies: `lanes.<name>.slots` from the config when
   * the block names it, an `SSSF_LANES` override when this process carries
   * one, otherwise engine.py's DEFAULT_LANE_SLOTS */
  slots: number;
  slots_source: "default" | "SSSF_LANES" | "config";
  /** what the config's `lanes:` block says for this lane, or null when the
   * block does not name it - this is the number the Lanes tab edits */
  slots_config: number | null;
  /** `lanes.<name>.enabled`; true when the block is silent (a lane exists by
   * virtue of a model naming its provider, so present = on unless said otherwise) */
  enabled: boolean;
  /** the roster model strings drawing on this lane */
  models: string[];
  /** the `router.builder_pool` model strings drawing on this lane (a pool
   * entry is a real draw on its provider account, exactly like a roster model) */
  pool_models: string[];
  /** the roster agents drawing on this lane ("defaults" when inherited,
   * "builder pool" when the draw comes from `router.builder_pool`) */
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
  /** true once the config file can carry a `lanes:` block - slots and the
   * enable switch are written there by `POST /config/lanes` */
  writes_supported: boolean;
  /** what exactly is writable, in words, for the tab to print verbatim */
  writes_reason: string;
  /** whether the file already carries a `lanes:` block */
  lanes_block_present: boolean;
  reason: string | null;
}

/** One entry of `router.builder_pool` - the shared config schema both this app
 * and the factory's engine read. Ordered; entry #1 is the builder's own
 * `model:`, mirrored, so the engine has one place to read the whole pool. */
export interface BuilderPoolEntry {
  model: string;
}

/** `GET /api/app/p/:id/config/router`. The builder is the concurrency-critical
 * agent - longest running, run in parallel - so it is the one agent with a
 * POOL of provider/model entries instead of a single model. */
export interface RouterRead {
  builder_pool: BuilderPoolEntry[];
  /** whether the file carries a `router:` block at all */
  present: boolean;
  /** the builder agent's resolved model, or null when the roster names no
   * agent called `builder` */
  builder_model: string | null;
  /** the largest pool this endpoint will write */
  max_pool: number;
  config_path: string;
  /** set when a `router:` block exists but is not a list of `{model: ...}` */
  reason: string | null;
}

export interface RouterEditBody {
  /** the whole ordered pool, 0-5 entries. `[]` removes `builder_pool` (and the
   * `router:` block with it when nothing else is in it). */
  builder_pool: { model: string }[];
}

export interface RouterEditResult {
  builder_pool: BuilderPoolEntry[];
  backup: string;
  changed: string[];
}

/** One lane's entry in the config's `lanes:` block. */
export interface LaneBlockEntry {
  slots?: number;
  /** written only when the lane is switched OFF; a lane the block is silent
   * about is on */
  enabled?: boolean;
}

export interface LaneEditBody {
  /** the lane (provider account) name - it must already be a lane of this
   * config, because a lane exists by a model naming its provider */
  lane: string;
  /** absent = leave alone; null = drop the key so the default applies again */
  slots?: number | null;
  enabled?: boolean | null;
}

export interface LaneEditResult {
  lanes: Record<string, LaneBlockEntry>;
  backup: string;
  changed: string[];
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

// -- providers v3: the two buckets (server/app/providers-v3.ts) ---------------
// A PROVIDER is an ACCOUNT / LANE (Ollama Cloud, OpenCode Go, OpenRouter,
// Claude-via-the-claude-CLI, Codex). Never a model family. Nothing in these
// shapes ever carries a key: a stored credential is described by a sha256
// fingerprint and by nothing else.

export type ProviderBucket = "api-key" | "signed-in";

/** What is true about a bucket-A provider on THIS laptop's own pi install.
 * `stored` is the honest middle state the operator asked for: the key is on
 * file, nothing here could apply it, and sync will write it where it matters. */
export interface ProviderLocalState {
  state: "applied" | "stored" | "missing";
  reason: string;
  /** the id has an entry in ~/.pi/agent/auth.json (presence only - never read) */
  pi_auth_entry: boolean;
  /** the id has a providers.<id> block in ~/.pi/agent/models.json */
  pi_models_entry: boolean;
}

export interface ProviderApiKeyRow {
  id: string;
  label: string;
  bucket: "api-key";
  /** the drawn caption, and it reflects what really happens */
  auth_mechanism: string;
  api: string;
  base_url: string;
  models: { id: string; name: string | null }[];
  /** sha256 of the key, first 12 hex. Non-reversible; the key never leaves the
   * server's own module. */
  key_fingerprint: string;
  added_at: string;
  updated_at: string;
  /** preset id the shape came from, or "operator" */
  source: string;
  local: ProviderLocalState;
}

/** Bucket B: an OAuth/subscription login. No key field, because there is no
 * key - only a local auth artifact this app reads for existence and mtime. */
export interface ProviderSignedInRow {
  id: "claude" | "codex";
  label: string;
  bucket: "signed-in";
  auth_mechanism: string;
  cli: string;
  cli_path: string | null;
  detected: boolean;
  detail: string;
  artifact_path: string;
  artifact_present: boolean;
  artifact_mtime: string | null;
  /** whether something exists locally that a sync could carry to a machine */
  token_available: boolean;
  /** where that something is - a path or an env var name, never a value */
  token_source: string | null;
  how_to_sign_in: string;
  sync_note: string;
}

/** A starting point for the Add form — a PREFILL, never a promise. Every field
 * is editable, nothing here is a claim that the lane works, and a row's state
 * still comes from what was actually written. `source_note` says whether the
 * endpoint was verified or is only the vendor's published one. */
export interface ProviderPreset {
  id: string;
  label: string;
  api: string;
  base_url: string;
  auth_header: boolean;
  compat: Record<string, unknown> | null;
  models: string[];
  /** The env var the vendor's own docs name for this key (`DEEPSEEK_API_KEY`).
   * Informational only: this app never reads it and never writes an `apiKey`
   * field - the key goes into pi's `auth.json`, which pi resolves first. */
  key_env: string | null;
  /** Placeholder for the key box. Never a real key, never an invented prefix. */
  key_placeholder: string;
  /** Model lists age. This is the one line that says so, per preset. */
  models_note: string;
  source_note: string;
}

export interface ProviderSyncResult {
  provider_id: string;
  bucket: ProviderBucket;
  state: "applied" | "needs-you" | "failed";
  reason: string;
}

export interface ProviderSyncRun {
  machine_id: string;
  machine_name: string;
  at: string;
  ok: boolean;
  results: ProviderSyncResult[];
}

export interface ProvidersV3Response {
  api_key: ProviderApiKeyRow[];
  signed_in: ProviderSignedInRow[];
  presets: ProviderPreset[];
  /** last sync outcome per machine id, so a reload still knows */
  sync: Record<string, ProviderSyncRun>;
  registry_path: string;
  pi_auth_path: string;
  pi_models_path: string;
  reason: string | null;
  catalog_note: string;
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

/* ── machines: the registry, the probe, the one-click deploy ────────────────
 * Additive beside `MachineRow` / `MachinesResponse` above, which describe the
 * older read-only `/api/app/factory/machines`. These describe
 * `/api/app/machines` — the registry the app can actually add to, reach and
 * deploy onto (`apps/ui/server/app/machines.ts`).
 *
 * Nothing here ever carries a credential. A machine's password is used once,
 * in memory, on the connect that installs this app's generated key, and is
 * never persisted or echoed; `key_path` names a file on THIS laptop, and its
 * contents never leave it. */

/** What one live reachability check learned. Every field is null unless this
 * process just proved it. */
export interface MachineProbe {
  reachable: boolean;
  checked_at: string;
  latency_ms: number | null;
  /** the server's own error when unreachable, verbatim */
  error: string | null;
  os: string | null;
  /** `systemctl is-active sdl-engine`, or "unknown" when systemd could not
   * answer - never a guess */
  engine: string | null;
  factory_head: string | null;
  factory_branch: string | null;
}

/** One `STEP <name> OK|FAIL <detail>` line from `deploy/bootstrap.sh`. */
export interface DeployStep {
  name: string;
  state: "ok" | "fail";
  detail: string;
  at: string;
}

/** The deploy job's poll shape - `jobs.ts`'s pattern, over SSH. */
export interface DeployJobView {
  job_id: string;
  machine_id: string;
  state: "running" | "done" | "failed";
  steps: DeployStep[];
  /** the raw remote output, capped; `dropped` counts what fell off the front */
  lines: string[];
  dropped: number;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  error: string | null;
  repo_url: string;
  branch: string;
  dir: string;
}

/** `GET /api/app/machines/:machine_id/deploy/status` before any deploy ran. */
export interface DeployNone {
  machine_id: string;
  state: "none";
  reason: string;
}

export interface MachineRegistryRow {
  id: string;
  name: string;
  kind: "local" | "server";
  role: string;
  host: string | null;
  port: number | null;
  user: string | null;
  /** path on this laptop to the private key this app authenticates with */
  key_path: string | null;
  /** true when this app generated that key (and installed its public half) */
  key_generated: boolean;
  added_at: string | null;
  last_connected_at: string | null;
  /** where the factory checkout lives on that box, once a deploy has run */
  repo_dir: string | null;
  /** `SHA256:...` of the host key this app pinned when the machine was added;
   * every later connection must be answered by that key. null = nothing pinned
   * yet (a record from before pinning existed, or the local row) */
  host_fingerprint: string | null;
  /** null when this read did not probe; the reason says which */
  probe: MachineProbe | null;
  probe_reason: string | null;
  /** the most recent deploy this app started for that machine, if any */
  deploy: DeployJobView | null;
}

export interface MachinesRegistryResponse {
  machines: MachineRegistryRow[];
  default_machine: string | null;
  /** project id -> machine id, from the project manifest's own entries */
  bindings: Record<string, string>;
  registry_path: string;
  key_dir: string;
  /** set only when there is no server registered: the honest sentence */
  reason: string | null;
}

/** `POST /api/app/machines`. Exactly one of `password` / `key_path`. */
export interface NewMachineRequest {
  name?: string;
  host?: string;
  port?: number;
  user?: string;
  /** used ONCE to install this app's key, then dropped - never stored */
  password?: string;
  /** an existing private key on this laptop, used instead of a password */
  key_path?: string;
}

/** `POST /api/app/machines/:machine_id/deploy`. The repository URL is not a
 * field: the server clones what this project's own `origin` points at. */
export interface MachineDeployRequest {
  project_id?: string;
  branch?: string;
  dir?: string;
}
