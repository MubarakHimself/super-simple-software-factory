/**
 * The factory's own facts, derived on THIS machine:
 *
 *   GET /api/app/p/:id/factory/health      the footer strip's source of truth
 *   GET /api/app/p/:id/lanes               Settings > Lanes (per project)
 *   GET /api/app/p/:id/factory/providers   Settings > Providers (definitions)
 *   GET /api/app/factory/machines          Settings > Machines
 *
 * ── The honesty rule this module exists to keep ────────────────────────────
 * The engine runs on the server (`sdl-engine.service`), and its health is the
 * engine's own to report (docs/user-journeys.md's Engine row). This laptop has
 * no engine and no server connection yet, so everything here is marked
 * `source: "local-derived"`: queue counts come from the files, lanes from the
 * roster yaml, provider definitions from the git-tracked JSON in the repo -
 * and `engine` is `"unknown"` with a sentence, never `"stopped"`. "Stopped"
 * would be a claim about a machine this process has never spoken to. When the
 * server connection lands, THAT is what fills in engine/uptime/free-slots;
 * every field which will come from there is `null` today with its own reason
 * beside it, so the surface can render the difference instead of a zero.
 *
 * Nothing here reads a credential. Provider auth status is `"unknown"` and
 * says why: credentials live in `~/.pi/agent/auth.json` (0600) on the machine
 * that runs the factory, written over SSH, never git
 * (`docs/research/pi-provider-mechanism-2026-08-15.md`).
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type {
  FactoryHealth,
  FactoryQueueCounts,
  LaneRow,
  LanesResponse,
  MachineRow,
  MachinesResponse,
  ProviderDefinition,
  ProviderDefinitionsResponse,
} from "../../shared/types.ts";
import { readConfig } from "../config.ts";
import { readCards, shippedFromMain } from "./cards.ts";
import { appError, appJson, appSafely } from "./guard.ts";
import { appHome } from "./manifest.ts";
import { readRouterAndLanes } from "./roster.ts";
import { getScope, param } from "./scoped.ts";

/** `adws/engine.py`'s own `DEFAULT_LANE_SLOTS` (a slot counts one RUN; inner
 * subagents draw on their parent's lane and are not counted). */
const DEFAULT_LANE_SLOTS = 2;

/** Where the git-tracked provider definitions live in a factory repo -
 * `installer/steps.py` reads this same directory when it seeds a provider
 * into `~/.pi/agent/models.json`. */
const PROVIDER_DIR = join("installer", "assets", "pi");
const PROVIDER_SUFFIX = ".provider.json";

const AUTH_REASON =
  "credentials are never in git and never on this server: pi reads them from " +
  "~/.pi/agent/auth.json (0600) on the machine that runs the factory, written over SSH";

// ── lanes ───────────────────────────────────────────────────────────────────

/** `engine.py:parse_lanes` - `"xai=2,opencode-go=1"` -> `{xai: 2, ...}`.
 * A malformed entry is skipped rather than thrown: the engine fails loudly at
 * startup because a wrong slot count changes what it RUNS; this endpoint only
 * describes, so it reports what it could read and says nothing about the rest. */
export function parseLaneSlots(value: string): Map<string, number> {
  const slots = new Map<string, number>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    const name = trimmed.slice(0, at).trim();
    const count = trimmed.slice(at + 1).trim();
    if (!name || !/^\d+$/.test(count)) continue;
    const parsed = Number.parseInt(count, 10);
    if (parsed >= 1) slots.set(name, parsed);
  }
  return slots;
}

/** What the Lanes tab may write, in words the tab prints verbatim. */
const LANE_WRITES_REASON =
  "slots and the on/off switch are written into the config's `lanes:` block, one lane at a time; " +
  "the engine's own concurrency cap is set on the engine service, not here";

/** `engine.py:roster_lanes` - the distinct provider prefixes of the roster's
 * `provider/model` strings (`defaults.model` plus any per-agent `model:`),
 * PLUS the same prefixes of `router.builder_pool`: a pool entry draws on its
 * provider account exactly like a roster model does, so it is a lane.
 * A model string with no `/` names no provider and is skipped, never guessed.
 *
 * Slot precedence, most local first: `SSSF_LANES` in THIS process's
 * environment, then the config's `lanes.<name>.slots`, then engine.py's
 * DEFAULT_LANE_SLOTS. `slots_config` carries the config's own number
 * separately, because that is the one the Lanes tab edits - the tab must be
 * able to show what the file says even when this process's env disagrees. */
export async function readLanes(configPath: string, env: string | null): Promise<LanesResponse> {
  const overrides = parseLaneSlots(env ?? "");
  const base: Omit<LanesResponse, "lanes" | "reason" | "lanes_block_present"> = {
    config_path: configPath,
    slots_default: DEFAULT_LANE_SLOTS,
    env,
    writes_supported: true,
    writes_reason: LANE_WRITES_REASON,
  };

  let parsed;
  try {
    parsed = await readConfig(configPath);
  } catch (error) {
    return {
      ...base,
      lanes: [],
      writes_supported: false,
      writes_reason: "there is no config file to write a `lanes:` block into",
      lanes_block_present: false,
      reason: `no lanes could be derived: ${configPath} could not be read (${(error as Error).message}) - a lane is a provider prefix of that roster's models`,
    };
  }

  // The two optional blocks. They are read from the same file, and a file that
  // parsed for readConfig parses here too - but a throw is still an empty
  // block, never a lane list that silently loses its slot counts.
  let blocks: Awaited<ReturnType<typeof readRouterAndLanes>>;
  try {
    blocks = await readRouterAndLanes(configPath);
  } catch {
    blocks = { pool: [], pool_present: false, pool_reason: null, lanes: {}, lanes_present: false, lanes_reason: null };
  }

  const byLane = new Map<string, { models: Set<string>; pool: Set<string>; agents: Set<string> }>();
  const add = (model: string | null, agent: string, fromPool = false) => {
    if (!model || !model.includes("/")) return;
    const lane = model.split("/", 1)[0]!.trim();
    if (!lane) return;
    const entry = byLane.get(lane) ?? { models: new Set<string>(), pool: new Set<string>(), agents: new Set<string>() };
    (fromPool ? entry.pool : entry.models).add(model);
    entry.agents.add(agent);
    byLane.set(lane, entry);
  };
  add(parsed.defaults.model, "defaults");
  for (const agent of parsed.roster) add(agent.model, agent.name);
  for (const item of blocks.pool) add(item.model, "builder pool", true);

  const lanes: LaneRow[] = [...byLane.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => {
      const configured = blocks.lanes[name]?.slots ?? null;
      return {
        name,
        slots: overrides.get(name) ?? configured ?? DEFAULT_LANE_SLOTS,
        slots_source: overrides.has(name)
          ? ("SSSF_LANES" as const)
          : configured !== null
            ? ("config" as const)
            : ("default" as const),
        slots_config: configured,
        enabled: blocks.lanes[name]?.enabled ?? true,
        models: [...entry.models].sort(),
        pool_models: [...entry.pool].sort(),
        agents: [...entry.agents].sort(),
        free: null,
      };
    });

  return {
    ...base,
    lanes,
    lanes_block_present: blocks.lanes_present,
    reason:
      lanes.length === 0
        ? `no provider/model lanes in ${configPath} - every model there is a bare id with no provider prefix`
        : blocks.lanes_reason,
  };
}

async function getLanes(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  return appJson(await readLanes(scope.configPath, process.env.SSSF_LANES?.trim() || null));
}

// ── provider definitions ────────────────────────────────────────────────────

interface RawProviderFile {
  api?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  models?: unknown;
}

/** How a provider proves who it is, from the SHAPE of its `apiKey` field
 * alone. The value is never read into the response: in this repo's pattern it
 * holds a COMMAND (`"!python '.../key.py'"`), and a command line can carry a
 * path or a secret, so only its first character is ever looked at. */
function authMechanism(apiKey: unknown): ProviderDefinition["auth_mechanism"] {
  if (typeof apiKey !== "string" || apiKey.trim() === "") return "none";
  return apiKey.trim().startsWith("!") ? "api-key-command" : "api-key";
}

function providerModels(raw: unknown): ProviderDefinition["models"] {
  if (!Array.isArray(raw)) return [];
  const models: ProviderDefinition["models"] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const model = entry as Record<string, unknown>;
    if (typeof model["id"] !== "string") continue;
    models.push({
      id: model["id"],
      name: typeof model["name"] === "string" ? model["name"] : null,
      context: typeof model["contextWindow"] === "number" ? model["contextWindow"] : null,
      max_tokens: typeof model["maxTokens"] === "number" ? model["maxTokens"] : null,
    });
  }
  return models;
}

/**
 * Every `installer/assets/pi/<id>.provider.json` in the project, plus a row
 * for every lane of the roster that has no definition file here - a lane the
 * factory draws on and this repo cannot describe is a fact Settings must show,
 * not a row that silently does not exist.
 */
export async function readProviderDefinitions(root: string, laneNames: string[]): Promise<ProviderDefinitionsResponse> {
  const dir = join(root, PROVIDER_DIR);
  const lanes = new Set(laneNames);
  const providers: ProviderDefinition[] = [];

  let names: string[] = [];
  let reason: string | null = null;
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(PROVIDER_SUFFIX))
      .map((e) => e.name)
      .sort();
  } catch {
    reason = `no provider definitions in ${dir} - this project tracks none (they are optional: pi's built-in providers need no file)`;
  }

  for (const name of names) {
    const id = name.slice(0, -PROVIDER_SUFFIX.length);
    let raw: RawProviderFile;
    try {
      raw = JSON.parse(await readFile(join(dir, name), "utf-8")) as RawProviderFile;
    } catch (error) {
      providers.push({
        id,
        source: `${PROVIDER_DIR.replace(/\\/g, "/")}/${name}`,
        defined: true,
        api: null,
        base_url: null,
        auth_mechanism: "unknown",
        auth_status: "unknown",
        auth_reason: `this definition could not be read: ${(error as Error).message}`,
        models: [],
        in_roster: lanes.has(id),
      });
      continue;
    }
    providers.push({
      id,
      source: `${PROVIDER_DIR.replace(/\\/g, "/")}/${name}`,
      defined: true,
      api: typeof raw.api === "string" ? raw.api : null,
      base_url: typeof raw.baseUrl === "string" ? raw.baseUrl : null,
      auth_mechanism: authMechanism(raw.apiKey),
      auth_status: "unknown",
      auth_reason: AUTH_REASON,
      models: providerModels(raw.models),
      in_roster: lanes.has(id),
    });
  }

  const defined = new Set(providers.map((p) => p.id));
  for (const lane of [...lanes].sort()) {
    if (defined.has(lane)) continue;
    providers.push({
      id: lane,
      source: null,
      defined: false,
      api: null,
      base_url: null,
      auth_mechanism: "unknown",
      auth_status: "unknown",
      auth_reason: `${lane} is a lane of this project's roster with no definition file in ${PROVIDER_DIR.replace(/\\/g, "/")} - it is either one of pi's built-in providers or registered only in ~/.pi/agent/models.json on the factory machine`,
      models: [],
      in_roster: true,
    });
  }

  return { providers, dir, reason };
}

async function getProviderDefinitions(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  const lanes = await readLanes(scope.configPath, process.env.SSSF_LANES?.trim() || null);
  return appJson(await readProviderDefinitions(scope.root, lanes.lanes.map((lane) => lane.name)));
}

// ── machines ────────────────────────────────────────────────────────────────

interface RawServer {
  host?: unknown;
  keyPath?: unknown;
  remotePort?: unknown;
}

/** The drawn `localhost` row: "planning only - no factory"
 * (docs/user-journeys.md J1.3). It is a constant because it is a statement
 * about the model, not a probe: planning happens on the laptop, factory
 * execution happens on a VPS. */
function localhostRow(): MachineRow {
  return {
    id: "localhost",
    name: hostname() || "localhost",
    kind: "local",
    role: "planning only - no factory",
    host: null,
    status: "this machine",
    status_reason: "the app runs here; the engine does not",
    factory_version: null,
    runs: null,
  };
}

/**
 * v1 is ONE server plus localhost (change-list #11). The server row is read
 * from `~/.sdl-factory/server.json` - the app plane's own home, beside the
 * project manifest.
 *
 * It deliberately does NOT read the desktop app's `userData/server.json`:
 * `apps/ui/electron/server-lens.ts`'s header states that file is "written and
 * read ONLY by main ... never by the Bun server", and that rule is not this
 * wave's to revoke. So: no configured server here reads as exactly that, with
 * the sentence that says where one gets configured - never an invented row.
 */
export async function readMachines(): Promise<MachinesResponse> {
  const machines: MachineRow[] = [localhostRow()];
  const path = join(appHome(), "server.json");

  if (!existsSync(path)) {
    return {
      machines,
      server_configured: false,
      multi_machine_supported: false,
      reason: `no factory server is configured on this machine (${path} does not exist) - Settings > Machines > Add server is where one is added; until then this app plans only`,
    };
  }

  let raw: RawServer;
  try {
    raw = JSON.parse(await readFile(path, "utf-8")) as RawServer;
  } catch (error) {
    return {
      machines,
      server_configured: false,
      multi_machine_supported: false,
      reason: `${path} could not be read: ${(error as Error).message}`,
    };
  }

  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  if (host === "") {
    return {
      machines,
      server_configured: false,
      multi_machine_supported: false,
      reason: `${path} names no host - the server row appears once a host is set`,
    };
  }

  machines.push({
    id: "server",
    name: host,
    kind: "server",
    role: "factory execution",
    host,
    // "configured", never "connected": this server process has not spoken to
    // that machine, and saying it is up would be a claim it cannot make.
    status: "configured",
    status_reason: `configured in ${path}; this app has not connected to it from here, so its engine, version and run count are unknown until the connection lands`,
    factory_version: null,
    runs: null,
  });

  return {
    machines,
    server_configured: true,
    multi_machine_supported: false,
    reason: "one server plus localhost is the whole of v1 - the default-machine and failover selects stay drawn and disabled",
  };
}

// ── health ──────────────────────────────────────────────────────────────────

/**
 * The footer strip. Queue counts are files, lanes are the roster, and the two
 * things only a running engine knows - liveness and uptime - are `"unknown"`
 * / `null` with the reason attached.
 */
export async function buildHealth(input: {
  root: string;
  queueDir: string;
  configPath: string;
  runsRunning: number | null;
  factoryPresent: boolean;
  env: string | null;
}): Promise<FactoryHealth> {
  const shipped = await shippedFromMain(input.root);
  const cards = await readCards({
    queueDir: input.queueDir,
    doneDir: join(input.queueDir, "done"),
    ...shipped,
  });
  const lanes = await readLanes(input.configPath, input.env);

  const queue: FactoryQueueCounts = {
    ready: 0,
    running: 0,
    blocked: 0,
    done: 0,
    integrated: 0,
    shipped: 0,
    unknown: 0,
    unparsed: cards.unparsed.length,
    total: cards.items.length,
  };
  for (const item of cards.items) queue[item.state] += 1;

  return {
    source: "local-derived",
    checked_at: new Date().toISOString(),
    engine: "unknown",
    engine_reason:
      "no engine runs on this machine and no server connection is configured - the engine's own health " +
      "arrives with that connection; these numbers were derived here from the repo",
    uptime_seconds: null,
    uptime_reason: "uptime is the engine service's own, and this machine has no engine to ask",
    lanes: lanes.lanes,
    lanes_active: null,
    lanes_reason:
      lanes.lanes.length === 0
        ? (lanes.reason ?? "this project's roster names no provider lanes")
        : "the lanes are this project's roster; how many are busy is the running engine's count, not this machine's",
    queue,
    runs_running: input.runsRunning,
    factory: input.factoryPresent ? "present" : "absent",
    factory_reason: input.factoryPresent
      ? "this project has an sssf.db - run history is readable here"
      : "no adws/adw_data/sssf.db in this project yet, so no run history is readable here",
  };
}

async function getHealth(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);

  let runsRunning: number | null = null;
  if (scope.db) {
    try {
      runsRunning = scope.db.allSessions().filter((session) => session.status === "running").length;
    } catch {
      runsRunning = null; // a db mid-write is a state, not a 500
    }
  }

  return appJson(
    await buildHealth({
      root: scope.root,
      queueDir: scope.queueDir,
      configPath: scope.configPath,
      runsRunning,
      factoryPresent: scope.db !== null,
      env: process.env.SSSF_LANES?.trim() || null,
    }),
  );
}

async function getMachines(_req: Request): Promise<Response> {
  return appJson(await readMachines());
}

export const factoryRoutes = {
  "/api/app/p/:id/factory/health": appSafely(getHealth),
  "/api/app/p/:id/lanes": appSafely(getLanes),
  "/api/app/p/:id/factory/providers": appSafely(getProviderDefinitions),
  "/api/app/factory/machines": appSafely(getMachines),
};
