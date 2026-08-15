/**
 * Tests for the card plane (`app/cards.ts`), run with
 * `bun test server/app/cards.test.ts` from `apps/ui`.
 *
 * Two halves, matching the two halves of the module: the pure derivation
 * (states, holding hints, reverse edges) is driven from real files on disk
 * with the "what has main shipped" set injected, and the git half
 * (`shippedFromMain`) is exercised against a real throwaway repository whose
 * `main` genuinely holds one parked card and not the other. Nothing outside
 * the OS temp directory is read or written, and no network is touched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNeeds, readCards, shippedFromMain } from "./cards.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function run(cwd: string, argv: string[]): Promise<number> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return await proc.exited;
}

async function makeQueue(): Promise<{ queueDir: string; doneDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sdl-cards-"));
  roots.push(dir);
  const queueDir = join(dir, "queue");
  const doneDir = join(queueDir, "done");
  await mkdir(doneDir, { recursive: true });
  return { queueDir, doneDir };
}

/** A card written the way `/to-kanban`'s publish writes one: an H1, the
 * contiguous `Key: value` block, then the Agent Brief. */
async function card(dir: string, name: string, header: Record<string, string>, body = ""): Promise<void> {
  const lines = [`# ${name.replace(/\.md$/, "")} title`, ""];
  for (const [key, value] of Object.entries(header)) lines.push(`${key}: ${value}`);
  lines.push("", "## Agent Brief", "", "**Category:** enhancement", body);
  await writeFile(join(dir, name), `${lines.join("\n")}\n`, "utf-8");
}

describe("readCards", () => {
  test("every lifecycle state, its reason, and the two holding hints", async () => {
    const { queueDir, doneDir } = await makeQueue();

    await card(queueDir, "010-waiting.md", {
      Status: "ready-for-agent",
      Adw: "simple-sdlc",
      "Adw-Id": "",
      Created: "2026-08-15",
      Needs: "001-parked.md, 011-still-open.md",
      Feature: "F-002",
      Priority: "high",
    });
    await card(queueDir, "011-still-open.md", { Status: "ready-for-agent", Needs: "" });
    await card(queueDir, "012-free.md", { Status: "ready-for-agent", Needs: "001-parked.md" });
    await card(queueDir, "013-running.md", { Status: "running", "Adw-Id": "adw-4711" });
    await card(queueDir, "014-blocked.md", {
      Status: "blocked",
      "Blocked-reason": "rebase conflict in apps/ui/server/index.ts",
    });
    await card(queueDir, "015-mute-block.md", { Status: "blocked" });
    await card(
      queueDir,
      "016-done.md",
      { Status: "done", "Adw-Id": "adw-4712" },
      "**Acceptance criteria:**\n- [x] first\n- [ ] second\n",
    );
    await card(doneDir, "001-parked.md", { Status: "done", "Adw-Id": "adw-4700" });
    await card(doneDir, "002-parked.md", { Status: "done", "Adw-Id": "adw-4701" });

    const cards = await readCards({
      queueDir,
      doneDir,
      shippedNames: new Set(["001-parked.md"]),
      shippedReason: null,
      mainRef: "main",
    });
    const by = new Map(cards.items.map((item) => [item.name, item]));
    const state = (name: string) => by.get(name)!.state;

    expect(state("010-waiting.md")).toBe("ready");
    expect(by.get("010-waiting.md")!.waiting_on).toEqual(["011-still-open.md"]); // 001 is parked, so it is met
    expect(by.get("010-waiting.md")!.state_reason).toContain("waiting on 011-still-open.md");
    expect(by.get("010-waiting.md")!.feature).toBe("F-002");
    expect(by.get("010-waiting.md")!.priority).toBe("high");
    expect(by.get("010-waiting.md")!.needs).toEqual(["001-parked.md", "011-still-open.md"]);
    expect(by.get("010-waiting.md")!.adw_id).toBeNull(); // an empty Adw-Id: is null, not ""

    expect(by.get("012-free.md")!.waiting_on).toEqual([]);
    expect(by.get("012-free.md")!.state_reason).toContain("auto-picks");

    expect(state("013-running.md")).toBe("running");
    expect(by.get("013-running.md")!.state_reason).toContain("adw-4711");

    expect(state("014-blocked.md")).toBe("blocked");
    expect(by.get("014-blocked.md")!.blocked_reason).toBe("rebase conflict in apps/ui/server/index.ts");
    expect(by.get("014-blocked.md")!.state_reason).toBe("rebase conflict in apps/ui/server/index.ts");

    expect(state("015-mute-block.md")).toBe("blocked");
    expect(by.get("015-mute-block.md")!.blocked_reason).toBeNull();
    expect(by.get("015-mute-block.md")!.state_reason).toContain("no Blocked-reason:");

    expect(state("016-done.md")).toBe("done");
    expect(by.get("016-done.md")!.criteria_done).toBe(1);
    expect(by.get("016-done.md")!.criteria_total).toBe(2);
    expect(by.get("016-done.md")!.criteria[0]).toEqual({ text: "first", done: true });
    expect(by.get("016-done.md")!.category).toBe("enhancement");

    // parked: main's tree decides which of the two already shipped
    expect(state("001-parked.md")).toBe("shipped");
    expect(by.get("001-parked.md")!.state_reason).toContain("main's tree");
    expect(state("002-parked.md")).toBe("integrated");
    expect(by.get("002-parked.md")!.state_reason).toContain("waiting for the next ship");
    expect(by.get("002-parked.md")!.parked).toBe(true);
    expect(cards.shipped_source).toBe("git-tree");
    expect(cards.shipped_reason).toBeNull();

    // reverse edges: who is blocked by whom
    expect(by.get("001-parked.md")!.blocks).toEqual(["010-waiting.md", "012-free.md"]);
    expect(by.get("011-still-open.md")!.blocks).toEqual(["010-waiting.md"]);
    expect(by.get("016-done.md")!.blocks).toEqual([]);
  });

  test("a state that cannot be derived is 'unknown' with the reason, never a guess", async () => {
    const { queueDir, doneDir } = await makeQueue();
    await card(doneDir, "001-parked.md", { Status: "done" });

    const cards = await readCards({
      queueDir,
      doneDir,
      shippedNames: null,
      shippedReason: "neither main nor origin/main could be read in /tmp/x",
      mainRef: "main",
    });
    expect(cards.items[0]!.state).toBe("unknown");
    expect(cards.items[0]!.state_reason).toBe("neither main nor origin/main could be read in /tmp/x");
    expect(cards.shipped_source).toBe("unavailable");
    expect(cards.shipped_reason).toContain("neither main nor origin/main");
  });

  test("malformed live cards land in unparsed with the same reasons queue.ts gives", async () => {
    const { queueDir, doneDir } = await makeQueue();
    await writeFile(join(queueDir, "020-no-title.md"), "Status: ready-for-agent\n", "utf-8");
    await card(queueDir, "021-no-status.md", { Adw: "simple-sdlc" });
    await card(queueDir, "022-bad-status.md", { Status: "in-progress" });
    await writeFile(join(queueDir, "TEMPLATE.md"), "# Title of the change\n\nStatus: ready-for-agent\n", "utf-8");

    const cards = await readCards({ queueDir, doneDir, shippedNames: new Set(), shippedReason: null, mainRef: "main" });
    expect(cards.items).toEqual([]); // TEMPLATE.md is never a card
    expect(cards.unparsed.map((u) => u.path).sort()).toEqual([
      "queue/020-no-title.md",
      "queue/021-no-status.md",
      "queue/022-bad-status.md",
    ]);
    expect(cards.unparsed.find((u) => u.path.endsWith("021-no-status.md"))!.reason).toContain("missing Status:");
    expect(cards.unparsed.find((u) => u.path.endsWith("022-bad-status.md"))!.reason).toContain('unknown Status: "in-progress"');
  });

  test("a parked card whose Status line is stale or missing is still a parked card", async () => {
    const { queueDir, doneDir } = await makeQueue();
    await writeFile(join(doneDir, "003-parked.md"), "# A parked card\n\nAdw: simple-sdlc\n", "utf-8");

    const cards = await readCards({ queueDir, doneDir, shippedNames: new Set(), shippedReason: null, mainRef: "main" });
    expect(cards.unparsed).toEqual([]);
    expect(cards.items).toHaveLength(1);
    expect(cards.items[0]!.status).toBeNull();
    expect(cards.items[0]!.state).toBe("integrated");
  });

  test("a missing queue directory is an empty board, not an error", async () => {
    const cards = await readCards({
      queueDir: join(tmpdir(), "sdl-cards-does-not-exist", "queue"),
      doneDir: join(tmpdir(), "sdl-cards-does-not-exist", "queue", "done"),
      shippedNames: new Set(),
      shippedReason: null,
      mainRef: "main",
    });
    expect(cards.items).toEqual([]);
    expect(cards.unparsed).toEqual([]);
  });
});

describe("parseNeeds", () => {
  test("splits the way dispatch.py splits it", () => {
    expect(parseNeeds("001-a.md, 002-b.md")).toEqual(["001-a.md", "002-b.md"]);
    expect(parseNeeds("  ")).toEqual([]);
    expect(parseNeeds(",,")).toEqual([]);
    expect(parseNeeds(undefined)).toEqual([]);
  });
});

describe("shippedFromMain", () => {
  test("reads main's own tree: one card shipped, one still only on integration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdl-cards-git-"));
    roots.push(dir);
    const root = join(dir, "work");
    await mkdir(join(root, "queue", "done"), { recursive: true });

    await run(root, ["git", "init", "-b", "main", "."]);
    await run(root, ["git", "config", "user.email", "test@example.com"]);
    await run(root, ["git", "config", "user.name", "Cards Test"]);
    await card(join(root, "queue", "done"), "001-shipped.md", { Status: "done" });
    await run(root, ["git", "add", "-A"]);
    await run(root, ["git", "commit", "-m", "a chunk shipped"]);

    await run(root, ["git", "checkout", "-b", "integration"]);
    await card(join(root, "queue", "done"), "002-integrated.md", { Status: "done" });
    await run(root, ["git", "add", "-A"]);
    await run(root, ["git", "commit", "-m", "factory: 002-integrated.md integrated"]);

    const shipped = await shippedFromMain(root);
    expect(shipped.mainRef).toBe("main");
    expect(shipped.shippedReason).toBeNull();
    expect([...shipped.shippedNames!].sort()).toEqual(["001-shipped.md"]);

    // and the board built from it tells the two apart
    const cards = await readCards({
      queueDir: join(root, "queue"),
      doneDir: join(root, "queue", "done"),
      ...shipped,
    });
    const by = new Map(cards.items.map((item) => [item.name, item.state]));
    expect(by.get("001-shipped.md")).toBe("shipped");
    expect(by.get("002-integrated.md")).toBe("integrated");
  }, 30_000);

  test("a checkout with no main at all says so instead of guessing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdl-cards-nomain-"));
    roots.push(dir);
    await run(dir, ["git", "init", "-b", "work", "."]);
    const shipped = await shippedFromMain(dir);
    expect(shipped.shippedNames).toBeNull();
    expect(shipped.shippedReason).toContain("neither main nor origin/main");
  }, 30_000);
});
