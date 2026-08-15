/**
 * Tests for the two config BLOCK writes in `app/roster.ts` - `router:` (the
 * builder's model pool) and `lanes:` (per-lane slots and the on/off switch),
 * run with `bun test server/app/roster.test.ts` from `apps/ui`.
 *
 * The claim under test is the one that matters for a file the operator hand
 * aligned and the factory reads on every run: a block write replaces THAT
 * BLOCK and nothing else. Every byte outside it - comments, alignment, blank
 * lines, CRLF endings - comes back identical, and a block that carries a
 * comment of its own is refused rather than rewritten without it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_BUILDER_POOL,
  getRouter,
  postLaneEdit,
  postRouterEdit,
  readRouterAndLanes,
  spliceBlock,
  validatePool,
} from "./roster.ts";

/** A config with the shapes the real one has: aligned trailing comments, a
 * comment block between top-level keys, nested lists. */
const CONFIG = `# the factory's agent roster
defaults:
  coding_agent: pi
  model: ollama-cloud/kimi-k2.7-code   # provider/id - TEST LANE
  thinking: medium                 # off | minimal | low | medium | high

# One worktree per concurrently running agent.
worktrees:
  enabled: true
  trunk: integration

agents:
  - name: builder
    color: "#22d3ee"
    purpose: Implement the plan exactly.
    tools:
      - read
      - bash

  - name: reviewer
    thinking: high
    purpose: Confirm that what was built is what was asked for.
`;

async function tempConfig(text = CONFIG): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sdl-roster-"));
  const path = join(dir, "sssf.config.yaml");
  await writeFile(path, text, "utf-8");
  return path;
}

function asText(result: string | { refused: string }): string {
  if (typeof result !== "string") throw new Error(`refused: ${result.refused}`);
  return result;
}

describe("spliceBlock - inserting a block", () => {
  test("a new block is appended and every other byte is unchanged", () => {
    const next = asText(spliceBlock(CONFIG, "router", { builder_pool: [{ model: "xai/grok-4.5" }] }));

    expect(next.startsWith(CONFIG.trimEnd())).toBe(true);
    // the untouched part is byte-identical, comments and alignment included
    expect(next.slice(0, CONFIG.length)).toBe(CONFIG);
    expect(next).toContain("router:\n  builder_pool:\n    - model: xai/grok-4.5");
    expect(next).toContain("model: ollama-cloud/kimi-k2.7-code   # provider/id - TEST LANE");
  });

  test("a CRLF file gets a CRLF block", () => {
    const crlf = CONFIG.replace(/\n/g, "\r\n");
    const next = asText(spliceBlock(crlf, "lanes", { xai: { slots: 3 } }));
    expect(next.slice(0, crlf.length)).toBe(crlf);
    expect(next).toContain("lanes:\r\n  xai:\r\n    slots: 3");
    expect(next.includes("\n\n")).toBe(false); // no bare LF anywhere
  });
});

describe("spliceBlock - replacing and deleting a block", () => {
  const withBlocks = `${CONFIG}
router:
  builder_pool:
    - model: ollama-cloud/kimi-k2.7-code
    - model: xai/grok-4.5

lanes:
  xai: { slots: 2 }
`;

  test("replacing router leaves lanes, and everything before it, untouched", () => {
    const next = asText(
      spliceBlock(withBlocks, "router", { builder_pool: [{ model: "zai/glm-5.2" }] }),
    );
    expect(next.slice(0, CONFIG.length)).toBe(CONFIG);
    expect(next).toContain("lanes:\n  xai: { slots: 2 }");
    expect(next).toContain("- model: zai/glm-5.2");
    expect(next).not.toContain("grok-4.5");
    // the blank line that separated the two blocks survives
    expect(next).toContain("\n\nlanes:");
  });

  test("deleting a block removes exactly its own lines", () => {
    const next = asText(spliceBlock(withBlocks, "router", null));
    expect(next.slice(0, CONFIG.length)).toBe(CONFIG);
    expect(next).not.toContain("builder_pool");
    expect(next).toContain("lanes:\n  xai: { slots: 2 }");
  });

  test("deleting a block that is not there changes nothing", () => {
    expect(spliceBlock(CONFIG, "router", null)).toBe(CONFIG);
  });

  test("a block carrying a comment is refused, not silently rewritten", () => {
    const commented = `${CONFIG}
router:
  builder_pool:
    - model: xai/grok-4.5   # the one that never rate-limits
`;
    const result = spliceBlock(commented, "router", { builder_pool: [{ model: "zai/glm-5.2" }] });
    expect(typeof result).toBe("object");
    expect((result as { refused: string }).refused).toContain("carries a comment");
    expect((result as { refused: string }).refused).toContain("nothing was written");
  });

  test("a file that will not parse is refused with the parser's own words", () => {
    const result = spliceBlock("defaults:\n  model: [unclosed\n", "router", { builder_pool: [] });
    expect(typeof result).toBe("object");
    expect((result as { refused: string }).refused).toContain("does not parse as yaml");
  });
});

describe("validatePool", () => {
  test("accepts an ordered pool of provider/model pairs", () => {
    const pool = validatePool([{ model: "ollama-cloud/kimi-k2.7-code" }, { model: "xai/grok-4.5" }]);
    expect(pool).toEqual([{ model: "ollama-cloud/kimi-k2.7-code" }, { model: "xai/grok-4.5" }]);
    expect(validatePool([])).toEqual([]);
  });

  test("refuses more than the pool holds, a duplicate, and a model that could break the line", () => {
    const six = Array.from({ length: MAX_BUILDER_POOL + 1 }, (_, i) => ({ model: `p${i}/m${i}` }));
    expect(validatePool(six)).toContain(`at most ${MAX_BUILDER_POOL}`);
    expect(validatePool([{ model: "xai/grok-4.5" }, { model: "xai/grok-4.5" }])).toContain("twice");
    expect(validatePool([{ model: "xai/grok\n  evil: true" }])).toContain("must look like provider/id");
    expect(validatePool([{ model: "xai/grok # comment" }])).toContain("must look like provider/id");
    expect(validatePool([{ model: "  " }])).toContain("every pool entry needs a model");
    expect(validatePool("not a list")).toContain("must be a list");
  });
});

describe("readRouterAndLanes", () => {
  test("reads both blocks as data, and reports a file that has neither", async () => {
    const path = await tempConfig();
    const empty = await readRouterAndLanes(path);
    expect(empty.pool).toEqual([]);
    expect(empty.pool_present).toBe(false);
    expect(empty.lanes).toEqual({});
    expect(empty.lanes_present).toBe(false);

    await writeFile(
      path,
      asText(spliceBlock(asText(spliceBlock(CONFIG, "router", { builder_pool: [{ model: "xai/grok-4.5" }] })), "lanes", {
        xai: { slots: 3 },
        "ollama-cloud": { slots: 1, enabled: false },
      })),
      "utf-8",
    );
    const full = await readRouterAndLanes(path);
    expect(full.pool).toEqual([{ model: "xai/grok-4.5" }]);
    expect(full.pool_present).toBe(true);
    expect(full.lanes).toEqual({ xai: { slots: 3 }, "ollama-cloud": { slots: 1, enabled: false } });
    expect(full.lanes_present).toBe(true);
    await rm(join(path, ".."), { recursive: true, force: true });
  });

  test("a block of the wrong shape is reported, never read as if it were right", async () => {
    const path = await tempConfig(`${CONFIG}\nrouter:\n  builder_pool: kimi\nlanes:\n  - xai\n`);
    const read = await readRouterAndLanes(path);
    expect(read.pool).toEqual([]);
    expect(read.pool_reason).toContain("not a list");
    expect(read.lanes).toEqual({});
    expect(read.lanes_reason).toContain("not a map");
    await rm(join(path, ".."), { recursive: true, force: true });
  });

  test("a block of the wrong shape stays exactly as written", async () => {
    const path = await tempConfig(`${CONFIG}\nrouter: kimi\n`);
    const read = await readRouterAndLanes(path);
    expect(read.pool_present).toBe(true);
    expect(read.pool_reason).toContain("not a map");
    await rm(join(path, ".."), { recursive: true, force: true });
  });

  test("the round trip a save makes: write, read back, and the roster still parses", async () => {
    const path = await tempConfig();
    const original = await readFile(path, "utf-8");
    const written = asText(spliceBlock(original, "router", { builder_pool: [{ model: "zai/glm-5.2" }] }));
    await writeFile(path, written, "utf-8");

    const read = await readRouterAndLanes(path);
    expect(read.pool).toEqual([{ model: "zai/glm-5.2" }]);

    // and taking it away again restores the file byte for byte
    const cleared = asText(spliceBlock(written, "router", null));
    expect(cleared).toBe(original);
    await rm(join(path, ".."), { recursive: true, force: true });
  });
});

/**
 * End to end, through the handlers themselves: an isolated `SDL_FACTORY_HOME`
 * with its own manifest, a project whose root holds a real
 * `adws/adw_sssf_config/sssf.config.yaml`, and requests carrying the `params`
 * the route matcher would inject. This is the test that says the controls
 * work: validation, the block write, the proof, the `.bak`, and the read-back
 * the pane renders after a save.
 */
describe("the router and lanes endpoints", () => {
  const dirs: string[] = [];
  const realHome = process.env.SDL_FACTORY_HOME;

  afterAll(async () => {
    if (realHome === undefined) delete process.env.SDL_FACTORY_HOME;
    else process.env.SDL_FACTORY_HOME = realHome;
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  /** A manifest of one project, in a home nothing else on this machine reads. */
  async function project(configText = CONFIG): Promise<{ id: string; configPath: string }> {
    const home = await mkdtemp(join(tmpdir(), "sdl-home-"));
    const root = await mkdtemp(join(tmpdir(), "sdl-proj-"));
    dirs.push(home, root);
    process.env.SDL_FACTORY_HOME = home;
    const id = "test-project";
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        active: id,
        projects: [{ id, name: "test", root, added_at: "", last_opened_at: null }],
        ui: {},
      }),
      "utf-8",
    );
    const dir = join(root, "adws", "adw_sssf_config");
    await mkdir(dir, { recursive: true });
    const configPath = join(dir, "sssf.config.yaml");
    await writeFile(configPath, configText, "utf-8");
    return { id, configPath };
  }

  function request(id: string, body?: unknown): Request {
    const req = new Request("http://127.0.0.1:4700/api/app/p/x/config/router", {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    (req as Request & { params: Record<string, string> }).params = { id };
    return req;
  }

  test("GET router: an empty pool, the builder's own model, and the cap", async () => {
    const { id } = await project();
    const body = (await (await getRouter(request(id))).json()) as Record<string, unknown>;
    expect(body.builder_pool).toEqual([]);
    expect(body.present).toBe(false);
    expect(body.builder_model).toBe("ollama-cloud/kimi-k2.7-code"); // inherited from defaults
    expect(body.max_pool).toBe(MAX_BUILDER_POOL);
  });

  test("POST router: the pool lands, the file keeps its shape, and a .bak is left", async () => {
    const { id, configPath } = await project();
    const before = await readFile(configPath, "utf-8");

    const res = await postRouterEdit(
      request(id, { builder_pool: [{ model: "ollama-cloud/kimi-k2.7-code" }, { model: "xai/grok-4.5" }] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builder_pool: { model: string }[]; changed: string[]; backup: string };
    expect(body.builder_pool).toEqual([{ model: "ollama-cloud/kimi-k2.7-code" }, { model: "xai/grok-4.5" }]);
    expect(body.changed[0]).toContain("router.builder_pool");
    expect(body.changed[0]).toContain(`2 of ${MAX_BUILDER_POOL}`);

    const after = await readFile(configPath, "utf-8");
    expect(after.slice(0, before.length)).toBe(before); // nothing above the block moved
    expect(await readFile(body.backup, "utf-8")).toBe(before);

    // and the read the pane does next reports exactly what landed
    const read = (await (await getRouter(request(id))).json()) as { builder_pool: unknown; present: boolean };
    expect(read.present).toBe(true);
    expect(read.builder_pool).toEqual([{ model: "ollama-cloud/kimi-k2.7-code" }, { model: "xai/grok-4.5" }]);
  });

  test("POST router: a sixth model, a duplicate and an unwritable string are all refused", async () => {
    const { id, configPath } = await project();
    const before = await readFile(configPath, "utf-8");

    const six = Array.from({ length: MAX_BUILDER_POOL + 1 }, (_, i) => ({ model: `p${i}/m${i}` }));
    expect((await postRouterEdit(request(id, { builder_pool: six }))).status).toBe(400);
    expect((await postRouterEdit(request(id, { builder_pool: [{ model: "xai/a" }, { model: "xai/a" }] }))).status).toBe(400);
    expect((await postRouterEdit(request(id, { builder_pool: [{ model: "xai/a\nlanes: []" }] }))).status).toBe(400);
    expect((await postRouterEdit(request(id, { builder_pool: "nope" }))).status).toBe(400);

    // a refusal writes nothing at all
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });

  test("POST router: writing the same pool twice is refused as already-said", async () => {
    const { id } = await project();
    expect((await postRouterEdit(request(id, { builder_pool: [{ model: "xai/grok-4.5" }] }))).status).toBe(200);
    const again = await postRouterEdit(request(id, { builder_pool: [{ model: "xai/grok-4.5" }] }));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("already what the file says");
  });

  test("POST router: an empty pool takes the block away again, byte for byte", async () => {
    const { id, configPath } = await project();
    const before = await readFile(configPath, "utf-8");
    expect((await postRouterEdit(request(id, { builder_pool: [{ model: "xai/grok-4.5" }] }))).status).toBe(200);
    expect((await postRouterEdit(request(id, { builder_pool: [] }))).status).toBe(200);
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });

  test("POST lanes: slots and the switch land in the `lanes:` block", async () => {
    const { id, configPath } = await project();

    const slots = await postLaneEdit(request(id, { lane: "ollama-cloud", slots: 3 }));
    expect(slots.status).toBe(200);
    expect(((await slots.json()) as { changed: string[] }).changed[0]).toContain("lanes.ollama-cloud.slots set to 3");

    const off = await postLaneEdit(request(id, { lane: "ollama-cloud", enabled: false }));
    expect(off.status).toBe(200);
    const body = (await off.json()) as { lanes: Record<string, unknown>; changed: string[] };
    expect(body.lanes["ollama-cloud"]).toEqual({ slots: 3, enabled: false });
    expect(body.changed[0]).toContain("disabled");

    // `enabled: true` is what a lane already is, so switching back removes the
    // key rather than writing a line that says nothing
    const on = await postLaneEdit(request(id, { lane: "ollama-cloud", enabled: true }));
    expect(((await on.json()) as { lanes: Record<string, unknown> }).lanes["ollama-cloud"]).toEqual({ slots: 3 });

    // clearing the slot count empties the entry, and the block with it
    const cleared = await postLaneEdit(request(id, { lane: "ollama-cloud", slots: null }));
    expect(((await cleared.json()) as { lanes: Record<string, unknown> }).lanes).toEqual({});
    expect(await readFile(configPath, "utf-8")).not.toContain("lanes:");
  });

  test("POST lanes: a lane no model names, and a slot count of zero, are refused", async () => {
    const { id } = await project();

    const unknown = await postLaneEdit(request(id, { lane: "openrouter", slots: 2 }));
    expect(unknown.status).toBe(409);
    expect(((await unknown.json()) as { error: string }).error).toContain("is not a lane of this config");

    const zero = await postLaneEdit(request(id, { lane: "xai", slots: 0 }));
    expect(zero.status).toBe(400);
    expect(((await zero.json()) as { error: string }).error).toContain("holds every card that draws on it forever");
  });

  test("POST lanes: a lane the builder pool names is a lane, even with no agent on it", async () => {
    const { id } = await project();
    expect((await postRouterEdit(request(id, { builder_pool: [{ model: "zai/glm-5.2" }] }))).status).toBe(200);
    const res = await postLaneEdit(request(id, { lane: "zai", slots: 2 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { lanes: Record<string, unknown> }).lanes.zai).toEqual({ slots: 2 });
  });
});
