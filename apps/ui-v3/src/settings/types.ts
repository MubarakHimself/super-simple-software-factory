/**
 * The shapes Settings reads, mirrored from `apps/ui/shared/types.ts` and from
 * the handlers in `apps/ui/server/app/`.
 *
 * They are re-declared here rather than imported across the app boundary, on
 * S1's stated convention ("a surface owns its own types in its own directory";
 * `lib/api.ts` keeps only what the shell itself reads). Every field below was
 * checked against a live response from the real routes on this machine, not
 * copied from a spec:
 *
 *   GET  /api/app/p/:id/config             roster + defaults (v1 route)
 *   POST /api/app/p/:id/config/roster      the one roster write (model/thinking)
 *   GET  /api/app/models                   pi's own catalog, for the dropdowns
 *   GET  /api/app/p/:id/lanes              lanes derived from the roster
 *   GET  /api/app/p/:id/factory/providers  git-tracked provider definitions
 *   GET  /api/app/factory/machines         localhost + the one configured server
 *   GET  /api/app/projects/:id/readiness   git / factory detection
 *   POST /api/app/p/:id/init/git|factory   the two init jobs
 *   GET  /api/app/jobs/:job_id             their poll
 */

// ── roster ──────────────────────────────────────────────────────────────────

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
  /** resolved: the agent's own `model:` or the one it inherits from defaults */
  model: string;
  model_inherited: boolean;
  thinking: string;
  thinking_inherited: boolean;
  tools: string[];
  /** null = unrestricted (no `writes:` key); [] = writes nothing */
  writes: string[] | null;
  harness_engineering: string[];
}

export interface ConfigResponse {
  roster: RosterAgent[];
  defaults: RosterAgentDefaults;
}

/** `/config` answers `{factory:"absent"}` with a 200 when the project has no
 * `sssf.config.yaml` - a state, not an error, so it is part of the type. */
export type ConfigRead = ConfigResponse | { factory: "absent" };

export function isFactoryAbsent(read: ConfigRead | null): read is { factory: "absent" } {
  return read !== null && (read as { factory?: string }).factory === "absent";
}

/** What `POST /config/roster` hands back. `changed` is the server's own
 * sentences about what moved; the save bar prints them verbatim. */
export interface RosterEditResult {
  roster: RosterAgent[];
  defaults: RosterAgentDefaults;
  backup: string;
  changed: string[];
}

export interface RosterEditBody {
  target: "agent" | "defaults";
  agent?: string;
  /** absent = leave alone; null = clear the key so it inherits again */
  model?: string | null;
  thinking?: string | null;
}

// ── the model catalog (pi's own) ────────────────────────────────────────────

export interface CatalogModel {
  id: string;
  context: number | null;
  max_out: number | null;
  /** whether a thinking level means anything for this model at all */
  thinking: boolean;
  images: boolean;
}

export interface CatalogProvider {
  id: string;
  models: CatalogModel[];
}

export interface ModelCatalog {
  providers: CatalogProvider[];
  /** pi's own vocabulary, from its `--help`; global, not per provider */
  thinking_levels: string[];
  /** how pi was resolved, so this pane never implies more than it knows */
  source: string | null;
  /** set only when `providers` is empty: the honest sentence about why */
  detail: string | null;
}

// ── lanes ───────────────────────────────────────────────────────────────────

export interface LaneRow {
  name: string;
  slots: number;
  slots_source: "default" | "SSSF_LANES";
  models: string[];
  agents: string[];
  /** null here always: free slots are the running engine's own count */
  free: number | null;
}

export interface LanesResponse {
  lanes: LaneRow[];
  config_path: string;
  slots_default: number;
  env: string | null;
  /** false today - the toggles and the retry budget have no field to write to */
  writes_supported: boolean;
  reason: string | null;
}

// ── provider definitions ────────────────────────────────────────────────────

export interface ProviderDefinition {
  id: string;
  source: string | null;
  defined: boolean;
  api: string | null;
  base_url: string | null;
  auth_mechanism: "api-key-command" | "api-key" | "none" | "unknown";
  /** always "unknown": this server never reads a credential file */
  auth_status: "unknown";
  auth_reason: string;
  models: { id: string; name: string | null; context: number | null; max_tokens: number | null }[];
  in_roster: boolean;
}

export interface ProviderDefinitionsResponse {
  providers: ProviderDefinition[];
  dir: string;
  reason: string | null;
}

// ── machines ────────────────────────────────────────────────────────────────

export interface MachineRow {
  id: string;
  name: string;
  kind: "local" | "server";
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
  multi_machine_supported: boolean;
  reason: string;
}

// ── add project ─────────────────────────────────────────────────────────────

export interface Readiness {
  git: { is_repo: boolean; branch: string | null; remote: string | null; dirty: boolean | null };
  factory: { config: boolean; queue_template: boolean; db: boolean; justfile: boolean; adws: boolean };
  runs: { count: number };
}

export interface JobHandle {
  job_id: string;
}

export interface JobStatus {
  state: "running" | "done" | "failed";
  exit_code: number | null;
  lines: string[];
  dropped: number;
}
