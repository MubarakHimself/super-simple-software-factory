/**
 * Tests for the factory plane (`app/factory.ts`), run with
 * `bun test server/app/factory.test.ts` from `apps/ui`.
 *
 * These are the "honest when it cannot know" tests: lanes really are derived
 * from a roster yaml on disk, provider rows really are parsed from a
 * git-tracked definition file, and everything that only a running engine can
 * answer (liveness, uptime, free slots) must come back null/unknown WITH a
 * reason. A test that let one of those become a plausible-looking number is
 * the bug this file exists to catch.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHealth, parseLaneSlots, readLanes, readMachines, readProviderDefinitions } from "./factory.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sdl-factory-"));
  roots.push(dir);
  return dir;
}

const ROSTER = `defaults:
  coding_agent: pi
  model: ollama-cloud/kimi-k2.7-code
  thinking: medium

agents:
  - name: planner
    model: xai/grok-5-code
  - name: builder          # inherits defaults.model
    color: "#e879f9"
  - name: reviewer
    model: xai/grok-5-code
  - name: scout
    model: bare-id-with-no-provider
`;

async function writeRoster(root: string, text = ROSTER): Promise<string> {
  const path = join(root, "sssf.config.yaml");
  await writeFile(path, text, "utf-8");
  return path;
}

describe("readLanes", () => {
  test("one provider account = one lane: prefixes, the agents on them, default slots", async () => {
    const root = await makeRoot();
    const lanes = await readLanes(await writeRoster(root), null);

    expect(lanes.lanes.map((lane) => lane.name)).toEqual(["ollama-cloud", "xai"]);
    expect(lanes.slots_default).toBe(2);
    // slots and the on/off switch have a home now: the config's `lanes:` block
    expect(lanes.writes_supported).toBe(true);
    expect(lanes.lanes_block_present).toBe(false);
    expect(lanes.reason).toBeNull();

    const ollama = lanes.lanes[0]!;
    expect(ollama.slots).toBe(2);
    expect(ollama.slots_source).toBe("default");
    expect(ollama.slots_config).toBeNull();
    expect(ollama.enabled).toBe(true);
    expect(ollama.pool_models).toEqual([]);
    expect(ollama.models).toEqual(["ollama-cloud/kimi-k2.7-code"]);
    // `builder` has no model: of its own, so it draws on the default lane -
    // and `scout`, whose model is a bare id with no provider, draws on none
    expect(ollama.agents).toEqual(["builder", "defaults"]);
    // free slots are the running engine's count - never invented here
    expect(ollama.free).toBeNull();

    const xai = lanes.lanes[1]!;
    expect(xai.agents).toEqual(["planner", "reviewer"]);
    // a bare id with no provider prefix names no lane and is skipped
    expect(lanes.lanes.some((lane) => lane.name === "bare-id-with-no-provider")).toBe(false);
  });

  test("SSSF_LANES overrides slots per lane, and says which lanes it moved", async () => {
    const root = await makeRoot();
    const lanes = await readLanes(await writeRoster(root), "xai=3, nowhere=9");

    const xai = lanes.lanes.find((lane) => lane.name === "xai")!;
    expect(xai.slots).toBe(3);
    expect(xai.slots_source).toBe("SSSF_LANES");
    const ollama = lanes.lanes.find((lane) => lane.name === "ollama-cloud")!;
    expect(ollama.slots).toBe(2);
    expect(ollama.slots_source).toBe("default");
    // a lane the roster does not use is not invented into existence
    expect(lanes.lanes.some((lane) => lane.name === "nowhere")).toBe(false);
    expect(lanes.env).toBe("xai=3, nowhere=9");
  });

  test("a builder-pool entry is a lane too, and the `lanes:` block sets its slots", async () => {
    const root = await makeRoot();
    const path = await writeRoster(
      root,
      `${ROSTER}
router:
  builder_pool:
    - model: ollama-cloud/kimi-k2.7-code
    - model: zai/glm-5.2
lanes:
  zai: { slots: 3 }
  xai: { slots: 1, enabled: false }
`,
    );
    const lanes = await readLanes(path, null);

    // zai is in no agent's model: line - it is a lane only because the pool
    // draws on it, which is a real draw on that provider account
    expect(lanes.lanes.map((lane) => lane.name)).toEqual(["ollama-cloud", "xai", "zai"]);
    expect(lanes.lanes_block_present).toBe(true);

    const zai = lanes.lanes.find((lane) => lane.name === "zai")!;
    expect(zai.models).toEqual([]);
    expect(zai.pool_models).toEqual(["zai/glm-5.2"]);
    expect(zai.agents).toEqual(["builder pool"]);
    expect(zai.slots).toBe(3);
    expect(zai.slots_source).toBe("config");
    expect(zai.slots_config).toBe(3);
    expect(zai.enabled).toBe(true);

    const xai = lanes.lanes.find((lane) => lane.name === "xai")!;
    expect(xai.slots).toBe(1);
    expect(xai.enabled).toBe(false);

    // the pool model that is also the builder's own model does not invent a
    // second lane, and its provider still lists both draws
    const ollama = lanes.lanes.find((lane) => lane.name === "ollama-cloud")!;
    expect(ollama.pool_models).toEqual(["ollama-cloud/kimi-k2.7-code"]);
    expect(ollama.agents).toEqual(["builder", "builder pool", "defaults"]);
  });

  test("SSSF_LANES in this process beats the config block, and says which number it used", async () => {
    const root = await makeRoot();
    const path = await writeRoster(root, `${ROSTER}\nlanes:\n  xai: { slots: 4 }\n`);
    const lanes = await readLanes(path, "xai=6");
    const xai = lanes.lanes.find((lane) => lane.name === "xai")!;
    expect(xai.slots).toBe(6);
    expect(xai.slots_source).toBe("SSSF_LANES");
    // the file's own number is still reported - it is the one the tab edits
    expect(xai.slots_config).toBe(4);
  });

  test("an unreadable roster is an empty lane list with the reason, not a throw", async () => {
    const root = await makeRoot();
    const lanes = await readLanes(join(root, "not-here.yaml"), null);
    expect(lanes.lanes).toEqual([]);
    expect(lanes.reason).toContain("not-here.yaml");
    expect(lanes.reason).toContain("could not be read");
  });

  test("a roster whose models carry no provider prefix says so plainly", async () => {
    const root = await makeRoot();
    const path = await writeRoster(root, "defaults:\n  model: kimi-k2.7-code\nagents:\n  - name: one\n");
    const lanes = await readLanes(path, null);
    expect(lanes.lanes).toEqual([]);
    expect(lanes.reason).toContain("bare id with no provider prefix");
  });
});

describe("parseLaneSlots", () => {
  test("engine.py's own grammar", () => {
    expect([...parseLaneSlots("xai=2,opencode-go=1")]).toEqual([
      ["xai", 2],
      ["opencode-go", 1],
    ]);
    expect([...parseLaneSlots("")]).toEqual([]);
    expect([...parseLaneSlots("xai")]).toEqual([]); // no "=slots"
    expect([...parseLaneSlots("xai=0")]).toEqual([]); // a lane with no slots holds every card forever
    expect([...parseLaneSlots("xai=two")]).toEqual([]);
  });
});

describe("readProviderDefinitions", () => {
  const definition = JSON.stringify(
    {
      api: "openai-completions",
      apiKey: "!python 'C:/Users/op/.pi/agent/ollama-cloud-key.py'",
      authHeader: true,
      baseUrl: "https://ollama.com/v1",
      models: [{ id: "kimi-k2.7-code", name: "kimi-k2.7-code (Ollama Cloud)", contextWindow: 262144, maxTokens: 32768 }],
    },
    null,
    2,
  );

  test("reads the git-tracked definition, and never echoes the credential field", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "installer", "assets", "pi"), { recursive: true });
    await writeFile(join(root, "installer", "assets", "pi", "ollama-cloud.provider.json"), definition, "utf-8");

    const result = await readProviderDefinitions(root, ["ollama-cloud", "xai"]);
    const ollama = result.providers.find((p) => p.id === "ollama-cloud")!;

    expect(ollama.defined).toBe(true);
    expect(ollama.source).toBe("installer/assets/pi/ollama-cloud.provider.json");
    expect(ollama.api).toBe("openai-completions");
    expect(ollama.base_url).toBe("https://ollama.com/v1");
    expect(ollama.auth_mechanism).toBe("api-key-command");
    expect(ollama.auth_status).toBe("unknown");
    expect(ollama.auth_reason).toContain("auth.json");
    expect(ollama.in_roster).toBe(true);
    expect(ollama.models).toEqual([
      { id: "kimi-k2.7-code", name: "kimi-k2.7-code (Ollama Cloud)", context: 262144, max_tokens: 32768 },
    ]);

    // the apiKey value never leaves this server, in any field
    expect(JSON.stringify(result)).not.toContain("ollama-cloud-key.py");

    // a lane with no definition file is a row that says why, not a silence
    const xai = result.providers.find((p) => p.id === "xai")!;
    expect(xai.defined).toBe(false);
    expect(xai.source).toBeNull();
    expect(xai.in_roster).toBe(true);
    expect(xai.auth_reason).toContain("built-in");
  });

  test("a project that tracks no definitions says so, and still lists its lanes", async () => {
    const root = await makeRoot();
    const result = await readProviderDefinitions(root, ["xai"]);
    expect(result.reason).toContain("no provider definitions");
    expect(result.providers.map((p) => p.id)).toEqual(["xai"]);
    expect(result.providers[0]!.defined).toBe(false);
  });

  test("a definition that will not parse is reported as that card, not dropped", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "installer", "assets", "pi"), { recursive: true });
    await writeFile(join(root, "installer", "assets", "pi", "broken.provider.json"), "{ not json", "utf-8");

    const result = await readProviderDefinitions(root, []);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]!.id).toBe("broken");
    expect(result.providers[0]!.auth_mechanism).toBe("unknown");
    expect(result.providers[0]!.auth_reason).toContain("could not be read");
  });
});

describe("readMachines", () => {
  test("localhost is always there, drawn as planning-only, and v1 is one server", async () => {
    const machines = await readMachines();
    const local = machines.machines.find((row) => row.kind === "local")!;

    expect(local.id).toBe("localhost");
    expect(local.role).toBe("planning only - no factory");
    expect(local.status).toBe("this machine");
    expect(local.factory_version).toBeNull();
    expect(local.runs).toBeNull();
    expect(machines.multi_machine_supported).toBe(false);
    expect(machines.reason.length).toBeGreaterThan(0);
    // no server row is ever "connected" from here - this process has spoken to
    // no machine but its own
    for (const row of machines.machines) expect(row.status).not.toBe("connected");
  });
});

describe("buildHealth", () => {
  test("counts the queue from files and refuses to claim anything about an engine", async () => {
    const root = await makeRoot();
    const queueDir = join(root, "queue");
    await mkdir(join(queueDir, "done"), { recursive: true });
    await writeFile(join(queueDir, "001-ready.md"), "# One\n\nStatus: ready-for-agent\nNeeds:\n", "utf-8");
    await writeFile(join(queueDir, "002-running.md"), "# Two\n\nStatus: running\nAdw-Id: adw-1\n", "utf-8");
    await writeFile(join(queueDir, "003-blocked.md"), "# Three\n\nStatus: blocked\nBlocked-reason: red gate\n", "utf-8");
    await writeFile(join(queueDir, "004-broken.md"), "no h1 at all\n", "utf-8");
    await writeFile(join(queueDir, "done", "000-parked.md"), "# Zero\n\nStatus: done\n", "utf-8");
    const configPath = await writeRoster(root);

    const health = await buildHealth({
      root, // not a git repo: the integrated/shipped split is unknown here
      queueDir,
      configPath,
      runsRunning: null,
      factoryPresent: false,
      env: null,
    });

    expect(health.source).toBe("local-derived");
    expect(health.engine).toBe("unknown");
    expect(health.engine_reason).toContain("no engine runs on this machine");
    expect(health.uptime_seconds).toBeNull();
    expect(health.uptime_reason).toBeTruthy();
    expect(health.lanes_active).toBeNull();
    expect(health.lanes_reason).toBeTruthy();
    expect(health.lanes.map((lane) => lane.name)).toEqual(["ollama-cloud", "xai"]);

    expect(health.queue.ready).toBe(1);
    expect(health.queue.running).toBe(1);
    expect(health.queue.blocked).toBe(1);
    expect(health.queue.unparsed).toBe(1);
    // a directory that is not a git checkout cannot answer integrated/shipped
    expect(health.queue.unknown).toBe(1);
    expect(health.queue.integrated + health.queue.shipped).toBe(0);
    expect(health.queue.total).toBe(4);

    expect(health.factory).toBe("absent");
    expect(health.factory_reason).toContain("sssf.db");
    expect(health.runs_running).toBeNull();
  }, 30_000);
});
