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

// ── the vocabulary law ───────────────────────────────────────────────────────
//
// Not a type - the one rule both Roster and Lanes read, and the correction of a
// confirmed bug. A PROVIDER is an account, a lane, a rate-limit bucket:
// Ollama Cloud, OpenCode, OpenRouter, xAI, Anthropic-via-claude-code,
// OpenAI-via-codex. A FAMILY is the MODEL's family: Kimi, GLM, Grok, Qwen,
// Claude, GPT, DeepSeek, Gemini.
//
// The two are independent. `ollama-cloud/kimi-k2.7-code` is served by the
// Ollama Cloud ACCOUNT and is a KIMI model; the old code read the provider
// prefix and called it a family, which is how "Ollama Cloud" ended up shown as
// a review family. Cross-family review compares the FAMILY of the reviewer's
// model against the FAMILY of every builder model - never the account names.
//
// So the family is read from the model id (everything after the last `/`) and
// from nothing else. A model whose id matches nothing here has NO family, and
// the surface says exactly that rather than guessing.

export interface ModelFamily {
  /** stable key, for comparing two models */
  id: string;
  /** what a human reads: family, then who makes it */
  label: string;
}

/** The matches, in order. Each is a substring of the model id, lowercased.
 * The aliases beyond the plain family word are model names the family actually
 * ships under (`moonshot` for Kimi; `sonnet`/`opus`/`haiku` for Claude), so a
 * roster naming one of those is not reported as unknown. */
const FAMILY_RULES: { match: RegExp; family: ModelFamily }[] = [
  { match: /kimi|moonshot/, family: { id: "kimi", label: "Kimi (Moonshot)" } },
  { match: /glm/, family: { id: "glm", label: "GLM (Z.ai)" } },
  { match: /grok/, family: { id: "grok", label: "Grok (xAI)" } },
  { match: /qwen/, family: { id: "qwen", label: "Qwen (Alibaba)" } },
  { match: /claude|sonnet|opus|haiku/, family: { id: "claude", label: "Claude (Anthropic)" } },
  { match: /deepseek/, family: { id: "deepseek", label: "DeepSeek" } },
  { match: /gemini/, family: { id: "gemini", label: "Gemini (Google)" } },
  { match: /gpt/, family: { id: "gpt", label: "GPT (OpenAI)" } },
  // The provider preset catalog made six more vendors one click away, and a
  // family this table cannot name is a family the cross-family rule cannot
  // ENFORCE: `familyOf` returns null for the reviewer, so `conflicts` comes back
  // empty and the same family on both sides reads as "unknown" instead of
  // CONFLICT. These four cover every starter model those presets ship
  // (mistral-large / mistral-medium / devstral, llama-3.3 / llama-3.1,
  // MiniMax-M2.7, cogito-v2-1-671b).
  { match: /mistral|mixtral|ministral|magistral|codestral|devstral/, family: { id: "mistral", label: "Mistral" } },
  { match: /llama/, family: { id: "llama", label: "Llama (Meta)" } },
  { match: /minimax/, family: { id: "minimax", label: "MiniMax" } },
  { match: /cogito/, family: { id: "cogito", label: "Cogito (Deep Cogito)" } },
];

/** The families this table can read, for the surfaces that list them in words -
 * so a rule added above is never contradicted by a sentence below it. */
export const FAMILY_WORDS: string[] = FAMILY_RULES.map((rule) => rule.family.id);
export const FAMILY_LABELS: string[] = FAMILY_RULES.map((rule) => rule.family.label);

/** The part of a `provider/model` string that names the MODEL. */
export function modelId(model: string): string {
  const at = model.lastIndexOf("/");
  return (at === -1 ? model : model.slice(at + 1)).trim();
}

/** The provider ACCOUNT a model draws on - the lane, never the family. */
export function providerOf(model: string): string | null {
  if (!model.includes("/")) return null;
  return model.split("/", 1)[0]!.trim() || null;
}

/** The model's family, or null when its id matches no family this app knows.
 * Null is a real answer here: "unknown family - check manually". */
export function familyOf(model: string): ModelFamily | null {
  const id = modelId(model).toLowerCase();
  if (!id) return null;
  for (const rule of FAMILY_RULES) if (rule.match.test(id)) return rule.family;
  return null;
}

export const UNKNOWN_FAMILY = "unknown family - check manually";

// ── the builder's model pool (`router.builder_pool`) ─────────────────────────

/** One entry of the pool. The shared config schema the factory's engine reads:
 *
 *   router:
 *     builder_pool:
 *       - model: "ollama-cloud/kimi-k2.7-code"
 *       - model: "xai/grok-4.5"
 */
export interface BuilderPoolEntry {
  model: string;
}

/** `GET /api/app/p/:id/config/router`. */
export interface RouterRead {
  builder_pool: BuilderPoolEntry[];
  present: boolean;
  /** the builder agent's resolved model - the pool's first entry mirrors it */
  builder_model: string | null;
  max_pool: number;
  config_path: string;
  reason: string | null;
}

export interface RouterEditResult {
  builder_pool: BuilderPoolEntry[];
  backup: string;
  changed: string[];
}

// ── the lanes block (`lanes.<name>.slots` / `.enabled`) ──────────────────────

export interface LaneBlockEntry {
  slots?: number;
  enabled?: boolean;
}

export interface LaneEditResult {
  lanes: Record<string, LaneBlockEntry>;
  backup: string;
  changed: string[];
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
  /** a PROVIDER account (one rate-limit bucket), never a model family */
  name: string;
  /** the slot count that applies, after `SSSF_LANES` and the config block */
  slots: number;
  slots_source: "default" | "SSSF_LANES" | "config";
  /** what the config's `lanes:` block says - the number this tab edits */
  slots_config: number | null;
  enabled: boolean;
  models: string[];
  /** `router.builder_pool` models drawing on this lane */
  pool_models: string[];
  agents: string[];
  /** null here always: free slots are the running engine's own count */
  free: number | null;
}

export interface LanesResponse {
  lanes: LaneRow[];
  config_path: string;
  slots_default: number;
  env: string | null;
  /** true once slots and the on/off switch have a home: the `lanes:` block */
  writes_supported: boolean;
  writes_reason: string;
  lanes_block_present: boolean;
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
