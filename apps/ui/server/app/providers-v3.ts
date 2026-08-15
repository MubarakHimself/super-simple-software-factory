/**
 * PROVIDERS (v3) — two buckets, actually written, syncable to a machine.
 *
 * The operator's sentence this file exists to satisfy: *"none of these buttons
 * actually work."* The old `providers.ts` is a read-only `<bin> --version`
 * probe and stays exactly as it is (the v1/v2 SPAs still read it); this module
 * supersedes it for the v3 pane and is the only place in the app that holds a
 * provider credential.
 *
 * ── VOCABULARY ──────────────────────────────────────────────────────────────
 * A PROVIDER here is an ACCOUNT / LANE — Ollama Cloud, OpenCode Go, OpenRouter,
 * Claude-via-the-claude-CLI, GPT-via-codex. It is never a model family. Nothing
 * in this file derives a family from a provider name, and nothing here feeds the
 * cross-family reviewer rule (that reads MODEL names, in roster.ts).
 *
 * ── THE TWO BUCKETS ─────────────────────────────────────────────────────────
 * BUCKET A — API KEY. name + key. The key is stored on THIS laptop at
 *   `~/.sdl-factory/providers.json` (0600, utf-8, never git) and applied to the
 *   local pi auth store the way pi documents:
 *     `~/.pi/agent/auth.json`   {"<id>": {"type":"api_key","key":"..."}}   0600
 *     `~/.pi/agent/models.json` providers.<id> = the definition block
 *   pi's own credential resolution order puts `auth.json` (#2) ABOVE any
 *   `apiKey` on the models.json block (#4), which is why the block this file
 *   writes carries NO apiKey field at all: the shape is git-safe and inert, and
 *   the secret lives in the one file pi reads first
 *   (`docs/research/pi-provider-mechanism-2026-08-15.md` §2.1, §1.2).
 *   When pi has no `~/.pi/agent` on this machine nothing is created and nothing
 *   is claimed: the row says `stored - applied on sync`, which is the truth.
 *
 * BUCKET B — SIGNED IN. Claude (via the `claude` CLI) and Codex, and only those
 *   two. There is no key field because there is no key: these are OAuth
 *   subscription logins. This module READS, never writes, their local auth
 *   artifacts — existence and mtime only, never a byte of content into a
 *   response:
 *     `~/.claude/.credentials.json` or `CLAUDE_CODE_OAUTH_TOKEN`
 *     `~/.codex/auth.json`
 *   Exactly the two probes `installer/steps.py:AUTH_LANES` already uses, for
 *   exactly the reason recorded there: `pi auth check` "reported ready on an
 *   expired token and not_ready on a working one in the same session".
 *
 * ── SYNC TO A MACHINE ───────────────────────────────────────────────────────
 * Over L2's own SSH helpers (`machines.ts`: `connect` / `execCapture` /
 * `sftpWrite` / `shq` / the machine registry) — nothing reinvented here.
 *   bucket A  -> merge into the machine's `~/.pi/agent/{auth,models}.json`
 *   Claude    -> `CLAUDE_CODE_OAUTH_TOKEN` into the machine's
 *                `~/.sdl-factory/secrets.env` (0600), which is the file
 *                `installer/steps.py:apply_oauth_token` already reads. A token
 *                cannot be minted non-interactively (`claude setup-token` opens
 *                a browser), so when none is on file the result is `needs-you`
 *                carrying the exact command to run.
 *   Codex     -> copy the local `~/.codex/auth.json` verbatim if it exists,
 *                else `needs-you` with `codex login`.
 * Every provider gets its own applied / needs-you / failed line with a reason.
 *
 * ── THE CREDENTIAL RULES, ENFORCED NOT PROMISED ─────────────────────────────
 *  1. No key is ever put on a shell command line (`ps` on the far end would
 *     show it). Every secret crosses by SFTP, inside a file body.
 *  2. No key is ever returned by a route. A stored key is described by a
 *     sha256 fingerprint (first 12 hex) and nothing else.
 *  3. Every reason string a route emits goes through `scrub()`, which replaces
 *     any known secret substring with `[redacted]` — insurance against a future
 *     edit interpolating a value into a message.
 *  4. A remote credential file that is not valid JSON is NEVER overwritten. It
 *     is somebody's live auth store; the sync fails and says so.
 *
 * ── ROUTES (all static; no `:param` siblings) ───────────────────────────────
 * `machines.ts` records why: a static path beside a dynamic one races in the
 * router for any method only one of them declares. So there is no
 * `/providers-v3/:id` here at all — the id travels in the body.
 *   GET  /api/app/providers-v3          everything the pane renders
 *   POST /api/app/providers-v3/add      {id,label,api,base_url,models[],key}
 *   POST /api/app/providers-v3/apply    {id}
 *   POST /api/app/providers-v3/remove   {id}   (this registry only)
 *   POST /api/app/providers-v3/sync     {machine_id, provider_ids?, claude_token?}
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Client } from "ssh2";
import type {
  ProviderApiKeyRow,
  ProviderLocalState,
  ProviderPreset,
  ProviderSignedInRow,
  ProviderSyncResult,
  ProviderSyncRun,
  ProvidersV3Response,
} from "../../shared/types.ts";
import { appError, appJson, appSafely, csrfGuard } from "./guard.ts";
import { connect, execCapture, machinesHome, readRegistry, sftpWrite, shq, type MachineRecord } from "./machines.ts";

// ── paths ───────────────────────────────────────────────────────────────────

/** This machine's home. `SDL_FACTORY_LOCAL_HOME` overrides it, the same test
 * seam `machines.ts` gives itself with `SDL_FACTORY_HOME` — so a test can drive
 * the whole pi-apply path without touching the operator's real `~/.pi`. */
export function localHome(): string {
  const override = process.env["SDL_FACTORY_LOCAL_HOME"]?.trim();
  return override ? override : homedir();
}

export function providersRegistryPath(): string {
  return join(machinesHome(), "providers.json");
}

export function piAuthPath(): string {
  return join(localHome(), ".pi", "agent", "auth.json");
}

export function piModelsPath(): string {
  return join(localHome(), ".pi", "agent", "models.json");
}

export function codexAuthPath(): string {
  return join(localHome(), ".codex", "auth.json");
}

export function claudeCredentialsPath(): string {
  return join(localHome(), ".claude", ".credentials.json");
}

/** `installer/steps.py:apply_oauth_token` writes CLAUDE_CODE_OAUTH_TOKEN here,
 * mode 0600, "never to the repo, never to the run log, never to stdout". */
export function secretsEnvPath(): string {
  return join(machinesHome(), "secrets.env");
}

// ── the registry ────────────────────────────────────────────────────────────

/** One bucket-A provider as it is stored on this laptop. `key` is the only
 * secret this app holds, and it never leaves this file's own module boundary
 * except by SFTP into a machine's auth store. */
export interface StoredProvider {
  id: string;
  label: string;
  api: string;
  base_url: string;
  auth_header: boolean;
  compat: Record<string, unknown> | null;
  models: { id: string; name: string | null }[];
  key: string;
  added_at: string;
  updated_at: string;
  /** where the definition's shape came from: a preset id, or "operator" */
  source: string;
}

export interface ProvidersRegistry {
  version: 1;
  providers: StoredProvider[];
  /** last sync outcome per machine id — what makes a row able to say
   * "synced to <machine>" after a reload instead of "unknown". */
  sync: Record<string, ProviderSyncRun>;
}

function emptyRegistry(): ProvidersRegistry {
  return { version: 1, providers: [], sync: {} };
}

export async function readProvidersRegistry(): Promise<ProvidersRegistry> {
  const path = providersRegistryPath();
  if (!existsSync(path)) return emptyRegistry();
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<ProvidersRegistry>;
    return {
      version: 1,
      providers: Array.isArray(parsed.providers) ? (parsed.providers as StoredProvider[]) : [],
      sync: parsed.sync && typeof parsed.sync === "object" ? (parsed.sync as Record<string, ProviderSyncRun>) : {},
    };
  } catch (error) {
    // A hand-edited registry must not take the app plane down, and must not be
    // silently replaced either: the read degrades to empty and the route says
    // why. Nothing overwrites the file until the operator adds a provider.
    console.error(`[ui] providers: could not read ${path}: ${(error as Error).message}`);
    return emptyRegistry();
  }
}

export async function writeProvidersRegistry(registry: ProvidersRegistry): Promise<void> {
  await mkdir(machinesHome(), { recursive: true });
  const path = providersRegistryPath();
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  // writeFile's mode only applies when it CREATES the file, so an existing one
  // keeps whatever mode it had. Windows ignores this; on Linux it is the whole
  // protection.
  await chmod(path, 0o600).catch(() => {});
}

// ── pure helpers (every one of these is a test) ──────────────────────────────

/** A pi provider id: it becomes a JSON object key and the leading segment of a
 * `provider/model` lane string. Kept to the shape `ollama-cloud-2` has, which is
 * also the shape that can never need shell quoting. */
export function isValidProviderId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

/** `claude` and `codex` are this pane's own bucket-B row ids; an API-key
 * provider claiming one of them would put two different things on one row. */
const RESERVED_IDS = new Set(["claude", "codex"]);

/** A key's identity without the key. Non-reversible, stable, and enough to see
 * that two rows carry the same credential. */
export function fingerprint(key: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(key);
  return hash.digest("hex").slice(0, 12);
}

/** Replaces any known secret with `[redacted]`. Applied to every reason string
 * a route emits — rule 3 of this file's header. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** pi's auth store shape: one entry per provider name, every sibling untouched
 * (`docs/research/pi-provider-mechanism-2026-08-15.md` §2.1). */
export function mergeAuthJson(existing: unknown, id: string, key: string): Record<string, unknown> {
  const merged: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  const current = merged[id];
  const entry: Record<string, unknown> =
    current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  entry["type"] = "api_key";
  entry["key"] = key;
  merged[id] = entry;
  return merged;
}

/**
 * `models.json` merge, ported from `installer/steps.py:merge_ollama_provider`
 * one behaviour at a time: deep-copy the whole file, touch only
 * `providers[id]`, leave every sibling provider byte-identical, and carry a
 * hand-added `modelOverrides` block across the replacement.
 */
export function mergeModelsJson(existing: unknown, id: string, block: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (JSON.parse(JSON.stringify(existing)) as Record<string, unknown>)
      : {};
  const providersRaw = merged["providers"];
  const providers: Record<string, unknown> =
    providersRaw && typeof providersRaw === "object" && !Array.isArray(providersRaw) ? (providersRaw as Record<string, unknown>) : {};
  const current = providers[id];
  const next = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
  if (current && typeof current === "object" && !Array.isArray(current)) {
    const overrides = (current as Record<string, unknown>)["modelOverrides"];
    if (overrides && typeof overrides === "object") next["modelOverrides"] = overrides;
  }
  providers[id] = next;
  merged["providers"] = providers;
  return merged;
}

/**
 * The provider block written into `models.json`. It deliberately carries NO
 * `apiKey`: the credential lives in `auth.json`, which pi resolves first. That
 * makes this block inert — safe to read, safe to show, worthless if copied.
 */
export function providerBlock(entry: Pick<StoredProvider, "api" | "base_url" | "auth_header" | "compat" | "models">): Record<string, unknown> {
  const block: Record<string, unknown> = {
    api: entry.api,
    baseUrl: entry.base_url,
    authHeader: entry.auth_header,
  };
  if (entry.compat && Object.keys(entry.compat).length > 0) block["compat"] = entry.compat;
  if (entry.models.length > 0) {
    block["models"] = entry.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      input: ["text"],
    }));
  }
  return block;
}

/**
 * Ported from `installer/steps.py:merge_env_text`: preserve every line —
 * comments, blanks, unrelated keys — in place; replace the named key where it
 * already appears; append it when it does not. Never reorders a line it does
 * not own.
 */
export function mergeEnvText(text: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  let seen = false;
  const out: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) {
      out.push(line);
      continue;
    }
    if (stripped.split("=", 1)[0]!.trim() === key) {
      out.push(`${key}=${value}`);
      seen = true;
    } else {
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  if (!seen) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

/** `KEY=value` out of an env file's text, or null. Used to find an existing
 * CLAUDE_CODE_OAUTH_TOKEN without ever printing one. */
export function readEnvValue(text: string, key: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at === -1) continue;
    if (line.slice(0, at).trim() !== key) continue;
    let value = line.slice(at + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

/** JSON that must be an object, or a thrown reason. Never guesses: a credential
 * file this app cannot parse is a file it refuses to rewrite (rule 4). */
function parseObject(text: string, what: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${what} is not valid JSON (${(error as Error).message}) - refusing to overwrite it`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${what} is not a JSON object - refusing to overwrite it`);
  }
  return parsed as Record<string, unknown>;
}

async function readLocalJson(path: string, what: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  return parseObject(await readFile(path, "utf-8"), what);
}

async function writeJson600(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

// ── presets (the Add form's starting points) ────────────────────────────────

/**
 * The three API-key lanes the operator named. Every field is either taken from
 * this repo's own running seed or from the vendor's documented endpoint, and
 * each row says which — a base URL nobody verified must not look like one that
 * was. All of it is editable in the form: a preset is a starting point, never a
 * constraint.
 */
export const PRESETS: ProviderPreset[] = [
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    api: "openai-completions",
    base_url: "https://ollama.com/v1",
    auth_header: true,
    compat: {
      maxTokensField: "max_tokens",
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
    },
    models: ["kimi-k2.7-code"],
    source_note:
      "Verified: byte-for-byte this repo's own running seed, installer/assets/pi/ollama-cloud.provider.json.",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    api: "openai-completions",
    base_url: "https://opencode.ai/zen/go/v1/",
    auth_header: true,
    compat: null,
    models: [],
    source_note:
      "Endpoint and provider prefix from docs/research/provider-limits-and-models.md section 1.4, quoting opencode.ai/docs/go. Model ids are yours to name - the research doc records no fixed list.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    api: "openai-completions",
    base_url: "https://openrouter.ai/api/v1",
    auth_header: true,
    compat: null,
    models: [],
    source_note:
      "OpenRouter's published OpenAI-compatible base URL. NOT VERIFIED against this repo's own record - no doc here has ever wired it. Check it against openrouter.ai/docs before trusting the row.",
  },
];

// ── local state (what is true on THIS machine, read-only) ───────────────────

/** `which`, duplicated from `providers.ts` on that file's own stated precedent
 * ("local duplication over cross-chunk coupling"). */
function which(cmd: string): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Whether this laptop's own pi actually carries the provider. Reads only for
 * the presence of the id: `auth.json` is opened, the key is NOT read out of it,
 * and nothing from either file reaches a response.
 */
export async function localStateFor(id: string): Promise<ProviderLocalState> {
  const agentDir = join(localHome(), ".pi", "agent");
  if (!existsSync(agentDir)) {
    return {
      state: "stored",
      reason: `pi has no agent directory on this machine (${agentDir}), so there is nothing here to apply to - the key is stored and will be written on the machine you sync to`,
      pi_auth_entry: false,
      pi_models_entry: false,
    };
  }
  let auth = false;
  let models = false;
  let trouble: string | null = null;
  try {
    auth = Object.prototype.hasOwnProperty.call(await readLocalJson(piAuthPath(), piAuthPath()), id);
  } catch (error) {
    trouble = (error as Error).message;
  }
  try {
    const parsed = await readLocalJson(piModelsPath(), piModelsPath());
    const providers = parsed["providers"];
    models = !!providers && typeof providers === "object" && Object.prototype.hasOwnProperty.call(providers, id);
  } catch (error) {
    trouble = trouble ?? (error as Error).message;
  }
  if (trouble) return { state: "missing", reason: trouble, pi_auth_entry: auth, pi_models_entry: models };
  if (auth && models) {
    return {
      state: "applied",
      reason: `pi on this machine has ${id} in both ~/.pi/agent/auth.json (0600) and models.json`,
      pi_auth_entry: true,
      pi_models_entry: true,
    };
  }
  if (auth || models) {
    return {
      state: "stored",
      reason: `half applied on this machine: ${auth ? "the key is in auth.json but the provider block is missing from models.json" : "the provider block is in models.json but no key is in auth.json"} - Apply writes both`,
      pi_auth_entry: auth,
      pi_models_entry: models,
    };
  }
  return {
    state: "stored",
    reason: "stored on this laptop only - pi on this machine has no entry for it yet; Apply writes one, or sync writes it on the factory machine",
    pi_auth_entry: false,
    pi_models_entry: false,
  };
}

/** Writes the provider into this machine's own pi store. Returns the state the
 * row should then show, never an invented success. */
export async function applyLocally(entry: StoredProvider): Promise<ProviderLocalState> {
  const agentDir = join(localHome(), ".pi", "agent");
  if (!existsSync(agentDir)) {
    return {
      state: "stored",
      reason: `nothing was applied here: pi has no ${agentDir} on this machine. The definition and key are stored - sync to a machine that runs the factory writes them there`,
      pi_auth_entry: false,
      pi_models_entry: false,
    };
  }
  try {
    const auth = await readLocalJson(piAuthPath(), piAuthPath());
    const models = await readLocalJson(piModelsPath(), piModelsPath());
    await writeJson600(piAuthPath(), mergeAuthJson(auth, entry.id, entry.key));
    await writeJson600(piModelsPath(), mergeModelsJson(models, entry.id, providerBlock(entry)));
  } catch (error) {
    return {
      state: "missing",
      reason: scrub((error as Error).message, [entry.key]),
      pi_auth_entry: false,
      pi_models_entry: false,
    };
  }
  return localStateFor(entry.id);
}

async function mtimeOf(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}

/** The local CLAUDE_CODE_OAUTH_TOKEN, from the two places this repo already
 * puts one. Returned to CALLERS INSIDE THIS MODULE ONLY — never to a route. */
async function localClaudeToken(): Promise<{ token: string | null; source: string | null }> {
  const fromEnv = (process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "").trim();
  if (fromEnv) return { token: fromEnv, source: "the CLAUDE_CODE_OAUTH_TOKEN in this server's environment" };
  const path = secretsEnvPath();
  if (existsSync(path)) {
    const value = readEnvValue(await readFile(path, "utf-8"), "CLAUDE_CODE_OAUTH_TOKEN");
    if (value) return { token: value, source: `CLAUDE_CODE_OAUTH_TOKEN in ${path}` };
  }
  return { token: null, source: null };
}

async function claudeRow(): Promise<ProviderSignedInRow> {
  const artifact = claudeCredentialsPath();
  const present = existsSync(artifact);
  const { token, source } = await localClaudeToken();
  const cli = which("claude");
  const detected = present || token !== null;
  return {
    id: "claude",
    label: "Claude",
    bucket: "signed-in",
    auth_mechanism: "Signed in through the claude CLI - a subscription login, so there is no key to type",
    cli: "claude",
    cli_path: cli,
    detected,
    detail: detected
      ? present
        ? `signed in on this machine: ${artifact} exists`
        : `no ${artifact}, but a CLAUDE_CODE_OAUTH_TOKEN is on file (${source}) - that is what a machine needs`
      : cli
        ? `not signed in on this machine: no ${artifact} and no CLAUDE_CODE_OAUTH_TOKEN on file`
        : `not signed in, and 'claude' is not on this machine's PATH`,
    artifact_path: artifact,
    artifact_present: present,
    artifact_mtime: await mtimeOf(artifact),
    token_available: token !== null,
    token_source: source,
    how_to_sign_in:
      "Run `claude` once to log in in a browser, then `claude setup-token` and paste the token it prints into the box on this row. This app cannot mint one for you - setup-token opens a browser and waits for a human.",
    sync_note:
      "Syncing writes CLAUDE_CODE_OAUTH_TOKEN into the machine's ~/.sdl-factory/secrets.env (0600) - the file the installer already reads. Nothing is written into this repo.",
  };
}

async function codexRow(): Promise<ProviderSignedInRow> {
  const artifact = codexAuthPath();
  const present = existsSync(artifact);
  const cli = which("codex");
  return {
    id: "codex",
    label: "Codex (OpenAI)",
    bucket: "signed-in",
    auth_mechanism: "Signed in through the codex CLI - a subscription login, so there is no key to type",
    cli: "codex",
    cli_path: cli,
    detected: present,
    detail: present
      ? `signed in on this machine: ${artifact} exists`
      : cli
        ? `not signed in on this machine: ${artifact} does not exist`
        : `not signed in, and 'codex' is not on this machine's PATH`,
    artifact_path: artifact,
    artifact_present: present,
    artifact_mtime: await mtimeOf(artifact),
    token_available: present,
    token_source: present ? artifact : null,
    how_to_sign_in:
      "Run `codex login`. It opens a browser; on a headless box, forward the callback port with ssh -L. This app cannot do that step for you.",
    sync_note:
      "Syncing copies this machine's ~/.codex/auth.json to the machine's own ~/.codex/auth.json (0600), verbatim. If it is not here, the row says so instead of pretending.",
  };
}

function toApiRow(entry: StoredProvider, local: ProviderLocalState): ProviderApiKeyRow {
  return {
    id: entry.id,
    label: entry.label,
    bucket: "api-key",
    auth_mechanism: "API key - stored on this laptop (0600, never git) and written into pi's own auth store",
    api: entry.api,
    base_url: entry.base_url,
    models: entry.models,
    key_fingerprint: fingerprint(entry.key),
    added_at: entry.added_at,
    updated_at: entry.updated_at,
    source: entry.source,
    local,
  };
}

// ── GET ─────────────────────────────────────────────────────────────────────

export async function buildResponse(): Promise<ProvidersV3Response> {
  const registry = await readProvidersRegistry();
  const rows: ProviderApiKeyRow[] = [];
  for (const entry of registry.providers) {
    rows.push(toApiRow(entry, await localStateFor(entry.id)));
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));

  return {
    api_key: rows,
    signed_in: [await claudeRow(), await codexRow()],
    presets: PRESETS,
    sync: registry.sync,
    registry_path: providersRegistryPath(),
    pi_auth_path: piAuthPath(),
    pi_models_path: piModelsPath(),
    reason:
      rows.length === 0
        ? `no API-key provider is registered yet (${providersRegistryPath()} holds none). Add provider takes a name and a key; the key is written there with mode 0600 and never enters git.`
        : null,
    catalog_note:
      "The roster's model dropdown reads GET /api/app/models, which runs `pi -ne --list-models` - pi's MERGED catalog, so a provider applied to this machine's ~/.pi/agent/models.json appears there. That endpoint caches for the life of the server process, so this pane re-reads it with ?refresh=1 after every apply.",
  };
}

async function getProvidersV3(): Promise<Response> {
  return appJson(await buildResponse());
}

// ── POST add ────────────────────────────────────────────────────────────────

interface AddBody {
  id?: unknown;
  label?: unknown;
  api?: unknown;
  base_url?: unknown;
  auth_header?: unknown;
  compat?: unknown;
  models?: unknown;
  key?: unknown;
  source?: unknown;
}

function modelList(raw: unknown): { id: string; name: string | null }[] {
  if (!Array.isArray(raw)) return [];
  const out: { id: string; name: string | null }[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const id = entry.trim();
      if (id) out.push({ id, name: null });
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      if (typeof record["id"] === "string" && record["id"].trim()) {
        out.push({ id: record["id"].trim(), name: typeof record["name"] === "string" ? record["name"] : null });
      }
    }
  }
  return out;
}

async function postAdd(req: Request): Promise<Response> {
  let body: AddBody;
  try {
    body = ((await req.json()) ?? {}) as AddBody;
  } catch {
    return appError("invalid JSON body");
  }

  const id = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
  if (!id) return appError("a provider id is required - it is the lane name, e.g. ollama-cloud or ollama-cloud-2");
  if (!isValidProviderId(id)) {
    return appError(
      `'${id}' is not a usable provider id - lowercase letters, digits, dot, dash and underscore only, starting with a letter or digit`,
    );
  }
  if (RESERVED_IDS.has(id)) {
    return appError(`'${id}' is the id of a signed-in provider on this pane - an API-key provider needs its own name`);
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) return appError("an API key is required - a provider with no credential is a row that cannot work");
  const baseUrl = typeof body.base_url === "string" ? body.base_url.trim() : "";
  if (!/^https?:\/\//i.test(baseUrl)) return appError("a base URL starting with http:// or https:// is required");
  const api = (typeof body.api === "string" ? body.api.trim() : "") || "openai-completions";

  const registry = await readProvidersRegistry();
  const previous = registry.providers.find((entry) => entry.id === id);
  const now = new Date().toISOString();
  const entry: StoredProvider = {
    id,
    label: (typeof body.label === "string" && body.label.trim()) || previous?.label || id,
    api,
    base_url: baseUrl,
    auth_header: body.auth_header === undefined ? true : body.auth_header !== false,
    compat: body.compat && typeof body.compat === "object" && !Array.isArray(body.compat) ? (body.compat as Record<string, unknown>) : null,
    models: modelList(body.models),
    key,
    added_at: previous?.added_at ?? now,
    updated_at: now,
    source: (typeof body.source === "string" && body.source.trim()) || "operator",
  };

  registry.providers = [...registry.providers.filter((row) => row.id !== id), entry];
  await writeProvidersRegistry(registry);

  const local = await applyLocally(entry);
  return appJson({ provider: toApiRow(entry, local), replaced: previous !== undefined }, previous ? 200 : 201);
}

// ── POST apply / remove ─────────────────────────────────────────────────────

async function bodyId(req: Request): Promise<string | Response> {
  let body: unknown;
  try {
    body = (await req.json()) ?? {};
  } catch {
    return appError("invalid JSON body");
  }
  const raw = (body as { id?: unknown }).id;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) return appError("id is required");
  return id;
}

async function postApply(req: Request): Promise<Response> {
  const id = await bodyId(req);
  if (typeof id !== "string") return id;
  const registry = await readProvidersRegistry();
  const entry = registry.providers.find((row) => row.id === id);
  if (!entry) return appError(`no provider ${id} in ${providersRegistryPath()}`, 404);
  const local = await applyLocally(entry);
  return appJson({ provider: toApiRow(entry, local) });
}

async function postRemove(req: Request): Promise<Response> {
  const id = await bodyId(req);
  if (typeof id !== "string") return id;
  const registry = await readProvidersRegistry();
  const entry = registry.providers.find((row) => row.id === id);
  if (!entry) return appError(`no provider ${id} in ${providersRegistryPath()}`, 404);
  registry.providers = registry.providers.filter((row) => row.id !== id);
  await writeProvidersRegistry(registry);
  const state = await localStateFor(id);
  return appJson({
    removed: id,
    note:
      state.pi_auth_entry || state.pi_models_entry
        ? `Removed from this laptop's provider registry only. pi still has ${id} in its own ~/.pi/agent files on this machine, and any machine you synced it to still has it too - this app does not reach into a store it was told to forget.`
        : `Removed from this laptop's provider registry only. pi on this machine had no entry for ${id}; machines you synced it to still have theirs.`,
  });
}

// ── POST sync ───────────────────────────────────────────────────────────────

interface SyncBody {
  machine_id?: unknown;
  provider_ids?: unknown;
  /** a token pasted by the operator for this one sync; never stored here */
  claude_token?: unknown;
}

/** `cat` on the far end, with an unambiguous answer for "the file is not
 * there". Its stdout can hold a credential, so it is never logged and never put
 * in a message — only the exit code and stderr describe a failure. */
const ABSENT = "__SDL_ABSENT__";

async function readRemote(client: Client, path: string): Promise<string | null> {
  const result = await execCapture(client, `if [ -f ${shq(path)} ]; then cat ${shq(path)}; else printf '%s' ${shq(ABSENT)}; fi`);
  if (result.code !== 0) {
    throw new Error(`could not read ${path} on the machine: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout.trim() === ABSENT ? null : result.stdout;
}

async function ensureRemoteDir(client: Client, path: string): Promise<void> {
  const result = await execCapture(client, `mkdir -p ${shq(path)} && chmod 700 ${shq(path)}`);
  if (result.code !== 0) {
    throw new Error(`could not create ${path} on the machine: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}

/**
 * The whole sync, over one SSH connection. Exported so the test can drive it
 * against a real in-process ssh2 server rather than through the route.
 */
export async function syncToMachine(
  record: MachineRecord,
  options: { providerIds?: string[] | null; claudeToken?: string | null },
): Promise<ProviderSyncRun> {
  const registry = await readProvidersRegistry();
  const wanted = options.providerIds && options.providerIds.length > 0 ? new Set(options.providerIds) : null;
  const apiKeyEntries = registry.providers.filter((entry) => (wanted ? wanted.has(entry.id) : true));
  const doClaude = wanted ? wanted.has("claude") : true;
  const doCodex = wanted ? wanted.has("codex") : true;

  const secrets: string[] = apiKeyEntries.map((entry) => entry.key);
  const results: ProviderSyncResult[] = [];
  const at = new Date().toISOString();

  const fail = (reason: string): ProviderSyncRun => ({
    machine_id: record.id,
    machine_name: record.name,
    at,
    ok: false,
    results: [
      ...apiKeyEntries.map((entry) => ({ provider_id: entry.id, bucket: "api-key" as const, state: "failed" as const, reason })),
      ...(doClaude ? [{ provider_id: "claude", bucket: "signed-in" as const, state: "failed" as const, reason }] : []),
      ...(doCodex ? [{ provider_id: "codex", bucket: "signed-in" as const, state: "failed" as const, reason }] : []),
    ],
  });

  if (!existsSync(record.key_path)) {
    return fail(`this app has no private key at ${record.key_path} for ${record.name} - re-add the machine in Machines first`);
  }

  let client: Client;
  try {
    client = await connect({
      // Every secret this function moves crosses this connection, so it is the
      // one that most needs the pinned host key: an address that answers with a
      // different key is refused before a single credential is written.
      host: record.host,
      port: record.port,
      user: record.user,
      privateKey: await readFile(record.key_path, "utf-8"),
      expectFingerprint: record.host_fingerprint,
    });
  } catch (error) {
    return fail(`could not reach ${record.user}@${record.host}:${record.port} - ${(error as Error).message}`);
  }

  try {
    const homeResult = await execCapture(client, `printf '%s\\n' "$HOME"`);
    const remoteHome = homeResult.stdout.split("\n")[0]?.trim() ?? "";
    if (homeResult.code !== 0 || !remoteHome.startsWith("/")) {
      return fail(`the machine did not report a usable home directory (exit ${homeResult.code})`);
    }

    // ── bucket A: one read, one merge per provider, one write ──────────────
    if (apiKeyEntries.length > 0) {
      const authPath = `${remoteHome}/.pi/agent/auth.json`;
      const modelsPath = `${remoteHome}/.pi/agent/models.json`;
      try {
        await ensureRemoteDir(client, `${remoteHome}/.pi`);
        await ensureRemoteDir(client, `${remoteHome}/.pi/agent`);
        const authText = await readRemote(client, authPath);
        const modelsText = await readRemote(client, modelsPath);
        let auth = authText === null ? {} : parseObject(authText, `the machine's ${authPath}`);
        let models = modelsText === null ? {} : parseObject(modelsText, `the machine's ${modelsPath}`);
        for (const entry of apiKeyEntries) {
          auth = mergeAuthJson(auth, entry.id, entry.key);
          models = mergeModelsJson(models, entry.id, providerBlock(entry));
        }
        await sftpWrite(client, authPath, `${JSON.stringify(auth, null, 2)}\n`, 0o600);
        await sftpWrite(client, modelsPath, `${JSON.stringify(models, null, 2)}\n`, 0o644);
        for (const entry of apiKeyEntries) {
          results.push({
            provider_id: entry.id,
            bucket: "api-key",
            state: "applied",
            reason: `key written into ${authPath} (0600) and the provider block into ${modelsPath} - every other provider in both files was left exactly as it was`,
          });
        }
      } catch (error) {
        const reason = scrub((error as Error).message, secrets);
        for (const entry of apiKeyEntries) {
          results.push({ provider_id: entry.id, bucket: "api-key", state: "failed", reason });
        }
      }
    }

    // ── bucket B: Claude ───────────────────────────────────────────────────
    if (doClaude) {
      const pasted = typeof options.claudeToken === "string" ? options.claudeToken.trim() : "";
      const local = pasted ? { token: pasted, source: "the token you pasted for this sync" } : await localClaudeToken();
      if (!local.token) {
        results.push({
          provider_id: "claude",
          bucket: "signed-in",
          state: "needs-you",
          reason:
            "no CLAUDE_CODE_OAUTH_TOKEN on this machine to carry over. On a machine with a browser run `claude` to log in, then `claude setup-token`, and paste what it prints into the Claude row - it is written on the server only. This step cannot be automated: setup-token waits for a human.",
        });
      } else {
        secrets.push(local.token);
        try {
          const dir = `${remoteHome}/.sdl-factory`;
          const path = `${dir}/secrets.env`;
          await ensureRemoteDir(client, dir);
          const existing = (await readRemote(client, path)) ?? "";
          await sftpWrite(client, path, mergeEnvText(existing, "CLAUDE_CODE_OAUTH_TOKEN", local.token), 0o600);
          results.push({
            provider_id: "claude",
            bucket: "signed-in",
            state: "applied",
            reason: `CLAUDE_CODE_OAUTH_TOKEN written into ${path} (0600), from ${local.source}. Every other line in that file was left in place.`,
          });
        } catch (error) {
          results.push({
            provider_id: "claude",
            bucket: "signed-in",
            state: "failed",
            reason: scrub((error as Error).message, secrets),
          });
        }
      }
    }

    // ── bucket B: Codex ────────────────────────────────────────────────────
    if (doCodex) {
      const source = codexAuthPath();
      if (!existsSync(source)) {
        results.push({
          provider_id: "codex",
          bucket: "signed-in",
          state: "needs-you",
          reason: `there is no ${source} on this machine to copy. Run \`codex login\` here first (it opens a browser), then sync again.`,
        });
      } else {
        try {
          const content = await readFile(source, "utf-8");
          secrets.push(content);
          const dir = `${remoteHome}/.codex`;
          await ensureRemoteDir(client, dir);
          await sftpWrite(client, `${dir}/auth.json`, content, 0o600);
          results.push({
            provider_id: "codex",
            bucket: "signed-in",
            state: "applied",
            reason: `this machine's ${source} copied to ${dir}/auth.json (0600), verbatim`,
          });
        } catch (error) {
          results.push({
            provider_id: "codex",
            bucket: "signed-in",
            state: "failed",
            reason: scrub((error as Error).message, secrets),
          });
        }
      }
    }
  } finally {
    client.end();
  }

  const run: ProviderSyncRun = {
    machine_id: record.id,
    machine_name: record.name,
    at,
    ok: results.every((result) => result.state === "applied"),
    results,
  };
  // Persisted so a reload can still say "synced to <machine>" instead of
  // "unknown" - the registry read is the only memory this pane has.
  const stored = await readProvidersRegistry();
  stored.sync = { ...stored.sync, [record.id]: run };
  await writeProvidersRegistry(stored);
  return run;
}

async function postSync(req: Request): Promise<Response> {
  let body: SyncBody;
  try {
    body = ((await req.json()) ?? {}) as SyncBody;
  } catch {
    return appError("invalid JSON body");
  }
  const machineId = typeof body.machine_id === "string" ? body.machine_id.trim() : "";
  if (!machineId) return appError("machine_id is required - sync writes credentials on one named machine");

  const registry = await readRegistry();
  const record = registry.machines.find((machine) => machine.id === machineId);
  if (!record) {
    return appError(`no machine ${machineId} in this app's registry - add it in Settings > Machines first`, 404);
  }

  const providerIds = Array.isArray(body.provider_ids)
    ? body.provider_ids.filter((value): value is string => typeof value === "string" && value.trim() !== "")
    : null;
  const claudeToken = typeof body.claude_token === "string" ? body.claude_token : null;

  const run = await syncToMachine(record, { providerIds, claudeToken });
  return appJson(run);
}

// ── routes ──────────────────────────────────────────────────────────────────

export function providersV3Routes(token: string, selfOrigins: ReadonlySet<string>) {
  return {
    "/api/app/providers-v3": { GET: appSafely(getProvidersV3) },
    "/api/app/providers-v3/add": { POST: csrfGuard(token, selfOrigins, postAdd) },
    "/api/app/providers-v3/apply": { POST: csrfGuard(token, selfOrigins, postApply) },
    "/api/app/providers-v3/remove": { POST: csrfGuard(token, selfOrigins, postRemove) },
    "/api/app/providers-v3/sync": { POST: csrfGuard(token, selfOrigins, postSync) },
  };
}
