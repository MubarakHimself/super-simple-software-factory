/**
 * The shapes `/api/app/p/:id/config` serves, and the one hook that reads it.
 *
 * The endpoint returns the v1 `ConfigResponse` project-scoped (spec 1.3), or
 * the honest `{factory:"absent"}` body when the project has no
 * `sssf.config.yaml` yet (spec 2.5's rule that a missing factory is a state,
 * not a throw). Both arrive with 200, so every pane discriminates on the body
 * rather than on a status code.
 *
 * Declared here rather than imported from `apps/ui/shared/types.ts`: the v2
 * SPA is its own package with its own tsconfig and does not reach into the
 * server's tree - the same reason `lib/api.ts` restates the shell's shapes.
 */
import { useResource, type Resource } from "../lib/poll.ts";

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
  /** Resolved: the agent's own model, or the inherited default. */
  model: string;
  model_inherited: boolean;
  thinking: string;
  thinking_inherited: boolean;
  tools: string[];
  /** `null` = no `writes:` key at all = unrestricted; `[]` = read-only. */
  writes: string[] | null;
  harness_engineering: string[];
}

export interface LaneStatus {
  provider_model: string;
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

export interface ProjectConfig {
  roster: RosterAgent[];
  defaults: RosterAgentDefaults;
  lanes: LaneStatus[];
  observability: ObservabilityInfo;
  paths: PathsInfo;
}

export interface FactoryAbsent {
  factory: "absent";
}

export type ConfigBody = ProjectConfig | FactoryAbsent;

export function factoryAbsent(body: ConfigBody | null): body is FactoryAbsent {
  return body !== null && (body as FactoryAbsent).factory === "absent";
}

/** One read per Settings open, no interval - Settings is not a live surface
 * and spec 2.8 bars background polling from this page. */
export function useProjectConfig(projectId: string): Resource<ConfigBody> {
  return useResource<ConfigBody>(
    projectId ? `${projectId}|config` : null,
    projectId ? `/api/app/p/${encodeURIComponent(projectId)}/config` : null,
  );
}
