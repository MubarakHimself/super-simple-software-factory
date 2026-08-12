/**
 * sssf.config.yaml -> roster + defaults + observability paths (spec 5.5).
 *
 * Read-only, and deliberately shallow: this file has no secrets in its
 * documented schema (models, prompts, tool allowlists, paths), and this
 * module never opens `.env`, so there is nothing here to blur or redact -
 * enforced by the code path simply not existing, per spec's "never reads
 * .env, never returns a key, token or secret".
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ObservabilityInfo, RosterAgent, RosterAgentDefaults } from "../shared/types.ts";

interface RawAgent {
  name: string;
  color?: string;
  purpose?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  writes?: string[];
  harness_engineering?: string[];
}

interface RawDefaults {
  coding_agent?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  harness_engineering?: string[];
  protected_files?: string[];
  data_dir?: string;
}

interface RawConfig {
  defaults?: RawDefaults;
  observability?: { db?: string; poll_ms?: number };
  agents?: RawAgent[];
}

export interface ParsedConfig {
  roster: RosterAgent[];
  defaults: RosterAgentDefaults;
  /** observability.db and poll_ms as written in the yaml, before this server
   * overlays the real --db path and derived session count. */
  observabilityRaw: { db: string | null; poll_ms: number | null };
}

export function configPathFromRepoRoot(repoRoot: string): string {
  return join(repoRoot, "adws", "adw_sssf_config", "sssf.config.yaml");
}

export async function readConfig(configPath: string): Promise<ParsedConfig> {
  const text = await readFile(configPath, "utf-8");
  const raw = (parseYaml(text) ?? {}) as RawConfig;
  const d = raw.defaults ?? {};

  const defaults: RosterAgentDefaults = {
    coding_agent: d.coding_agent ?? null,
    model: d.model ?? null,
    thinking: d.thinking ?? null,
    tools: d.tools ?? [],
    harness_engineering: d.harness_engineering ?? [],
    protected_files: d.protected_files ?? [],
    data_dir: d.data_dir ?? null,
  };

  const roster: RosterAgent[] = (raw.agents ?? []).map((a) => ({
    name: a.name,
    color: a.color ?? null,
    purpose: a.purpose ?? null,
    model: a.model ?? defaults.model ?? "",
    model_inherited: a.model === undefined,
    thinking: a.thinking ?? defaults.thinking ?? "",
    thinking_inherited: a.thinking === undefined,
    tools: a.tools ?? defaults.tools,
    writes: a.writes === undefined ? null : a.writes,
    harness_engineering: a.harness_engineering ?? defaults.harness_engineering,
  }));

  return {
    roster,
    defaults,
    observabilityRaw: {
      db: raw.observability?.db ?? null,
      poll_ms: raw.observability?.poll_ms ?? null,
    },
  };
}

export function buildObservabilityInfo(
  parsed: ParsedConfig,
  dbPath: string,
  journalMode: string,
  sessionCount: number,
): ObservabilityInfo {
  const dataDir = parsed.defaults.data_dir ?? "adws/adw_data";
  return {
    db: dbPath,
    journal_mode: journalMode,
    poll_ms: parsed.observabilityRaw.poll_ms ?? 500,
    session_count: sessionCount,
    data_dir: dataDir,
    sessions_dir: `${dataDir}/sessions`,
    protected_files: parsed.defaults.protected_files,
  };
}
