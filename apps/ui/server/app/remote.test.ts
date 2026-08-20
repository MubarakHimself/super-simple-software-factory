/**
 * Tests for the remote reads (`app/remote.ts`), run with
 * `bun test server/app/remote.test.ts` from `apps/ui`.
 *
 * ── What is real ───────────────────────────────────────────────────────────
 * The SSH is real, exactly as in `machines.test.ts`: an `ssh2.Server` on
 * loopback, real key exchange, real publickey auth, real exec channels with
 * exit codes. The far end's SHELL is the stand-in - the box pattern-matches
 * the two commands this module sends and answers them the way a Ubuntu VPS
 * would, including the two failures that matter most and cannot be provoked on
 * demand against a real box: a machine that is gone, and a machine with no
 * python3.
 *
 * ── What these tests are actually guarding ─────────────────────────────────
 * The operator's report was "things are happening in the vps, but i do not
 * know". The bug class that report belongs to is not "the read failed" - it is
 * "the read answered confidently about the wrong machine". So every test below
 * asserts the SENTENCE as much as the state: that a stopped engine says
 * stopped AND names the host, that an unreachable box says unknown and never
 * "stopped", that an absent db says "no runs recorded on <host> yet" and never
 * an empty list with no explanation, and that nothing on this path writes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, utils, type Connection } from "ssh2";

const home = await mkdtemp(join(tmpdir(), "sdl-remote-"));
process.env["SDL_FACTORY_HOME"] = home;
process.env["SDL_FACTORY_LOCAL_HOME"] = home;

const { addMachine, readRegistry, writeRegistry, bindProject } = await import("./machines.ts");
const {
  assembleRemoteRuns,
  clearRemoteCaches,
  engineCommand,
  engineFromFields,
  localRunsSource,
  parseEngineOutput,
  remoteDbPath,
  remoteEngine,
  remoteRuns,
  resolveProjectMachine,
  runsCommand,
  RUNS_SCRIPT,
} = await import("./remote.ts");
const { buildHealth } = await import("./factory.ts");
const { liveRoutes } = await import("./live.ts");
const { upsertProject } = await import("./manifest.ts");

/* ── the fake VPS ───────────────────────────────────────────────────────── */

interface EngineState {
  active: string;
  load: string;
  restarts: string;
  journal: string[];
}

interface FakeBox {
  server: Server;
  port: number;
  password: string;
  authorizedKeys: string[];
  commands: string[];
  engine: EngineState;
  /** what `python3 -c ...` prints on stdout; null = no python3 on the box */
  runsJson: string | null;
  close: () => Promise<void>;
}

/** `installKey`'s exact command, emulated - append the key line if absent. */
function handleInstallKey(box: FakeBox, command: string): boolean {
  if (!command.includes("authorized_keys")) return false;
  const quoted = [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1]!.replace(/'\\''/g, "'"));
  const key = quoted.find((value) => value.startsWith("ssh-"));
  if (!key) return false;
  if (!box.authorizedKeys.includes(key)) box.authorizedKeys.push(key);
  return true;
}

async function startFakeBox(password: string): Promise<FakeBox> {
  const hostKey = utils.generateKeyPairSync("ed25519", {}).private;
  // ONE object, mutated in place and handed back as-is. A spread copy would
  // give the test a different object from the one the exec handler closes
  // over, and `vps.engine = {...}` would silently do nothing.
  const box = {
    password,
    authorizedKeys: [] as string[],
    commands: [] as string[],
    engine: { active: "active", load: "loaded", restarts: "0", journal: [] } as EngineState,
    runsJson: JSON.stringify({ ok: true, sessions: [], phases: [], agents: [], agent_starts: [], logs: [] }) as string | null,
  } as FakeBox;

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password") return ctx.password === box.password ? ctx.accept() : ctx.reject(["password", "publickey"]);
      if (ctx.method === "publickey") {
        const presented = ctx.key.data.toString("base64");
        return box.authorizedKeys.some((line) => line.split(" ")[1] === presented)
          ? ctx.accept()
          : ctx.reject(["password", "publickey"]);
      }
      return ctx.reject(["password", "publickey"]);
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const command = info.command;
          box.commands.push(command);

          if (handleInstallKey(box, command)) {
            stream.exit(0);
            return stream.end();
          }
          if (command.includes("sdl-factory-key-ok")) {
            stream.write("sdl-factory-key-ok\n");
            stream.exit(0);
            return stream.end();
          }
          // The engine read: three systemd properties plus a journal tail.
          if (command.includes("systemctl is-active")) {
            const engine = box.engine;
            stream.write(`active=${engine.active}\n`);
            stream.write(`load=${engine.load}\n`);
            stream.write(`restarts=${engine.restarts}\n`);
            for (const line of engine.journal) stream.write(`journal=${line}\n`);
            stream.exit(0);
            return stream.end();
          }
          // The runs read.
          if (command.startsWith("python3 -c ")) {
            if (box.runsJson === null) {
              stream.stderr.write("sh: 1: python3: not found\n");
              stream.exit(127);
              return stream.end();
            }
            stream.write(`${box.runsJson}\n`);
            stream.exit(0);
            return stream.end();
          }
          stream.stderr.write(`sh: not emulated: ${command}\n`);
          stream.exit(127);
          return stream.end();
        });
      });
    });

    client.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  box.server = server;
  box.port = (server.address() as { port: number }).port;
  box.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return box;
}

const boxes: FakeBox[] = [];
const dirs: string[] = [];

async function box(password = "pw"): Promise<FakeBox> {
  const created = await startFakeBox(password);
  boxes.push(created);
  return created;
}

afterAll(async () => {
  for (const created of boxes) await created.close().catch(() => {});
  await rm(home, { recursive: true, force: true }).catch(() => {});
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** One project in the manifest this app-home holds. */
async function seedManifest(): Promise<void> {
  await writeFile(
    join(home, "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        active: "p-module",
        projects: [
          { id: "p-module", name: "module", root: "C:/repos/module", added_at: "2026-01-01T00:00:00.000Z", last_opened_at: null },
          { id: "p-other", name: "other", root: "C:/repos/other", added_at: "2026-01-02T00:00:00.000Z", last_opened_at: null },
        ],
        ui: {},
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

/** A registered machine, added over the real bootstrap path, with `repo_dir`
 * set the way a finished deploy sets it. */
async function machine(vps: FakeBox, repoDir: string | null = "/root/module") {
  const outcome = await addMachine({ host: "127.0.0.1", port: vps.port, user: "root", password: vps.password });
  if (!outcome.ok || !outcome.record) throw new Error(`addMachine failed: ${outcome.error ?? "no reason"}`);
  const registry = await readRegistry();
  const stored = registry.machines.find((m) => m.id === outcome.record!.id)!;
  stored.repo_dir = repoDir;
  await writeRegistry(registry);
  return { ...stored };
}

/**
 * A real `adws/adw_data/sssf.db` in a checkout, holding exactly the rows named.
 * The four tables are the four `db.ts:sessions()` reads; nothing here is a
 * stub, so the route under test opens the same kind of file the tracer writes.
 */
async function seedLocalDb(root: string, rows: { adw_id: string; adw_name: string; request: string }[]): Promise<void> {
  const dir = join(root, "adws", "adw_data");
  await mkdir(dir, { recursive: true });
  const db = new Database(join(dir, "sssf.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    "CREATE TABLE sessions (adw_id TEXT PRIMARY KEY, adw_name TEXT, request TEXT, status TEXT, engineer TEXT," +
      " started_at TEXT, ended_at TEXT, total_tokens INTEGER, total_cost REAL, archived INTEGER)",
  );
  db.exec(
    "CREATE TABLE phases (phase_id TEXT PRIMARY KEY, adw_id TEXT, seq INTEGER, name TEXT, kind TEXT, owner TEXT," +
      " description TEXT, status TEXT, attempt INTEGER, retries INTEGER, error TEXT, started_at TEXT, ended_at TEXT)",
  );
  db.exec(
    "CREATE TABLE agent_sessions (adw_id TEXT, agent TEXT, coding_agent TEXT, model TEXT, session_id TEXT," +
      " color TEXT, context_tokens INTEGER, context_window INTEGER, created_at TEXT, last_used_at TEXT)",
  );
  db.exec("CREATE TABLE events (adw_id TEXT, phase_id TEXT, type TEXT, name TEXT, payload_json TEXT, started_at TEXT)");
  for (const row of rows) {
    db.query(
      "INSERT INTO sessions VALUES (?, ?, ?, 'success', 'factory', '2026-08-19T00:00:00Z', '2026-08-19T00:01:00Z', 0, 0, 0)",
    ).run(row.adw_id, row.adw_name, row.request);
  }
  db.close();
}

/** The exact pair of rows `isSelfCheck` in `live.ts` hides. */
const SELF_CHECK = { adw_name: "adw_prompt", request: "reply with the single word OK" };

beforeAll(async () => {
  await writeRegistry({ version: 1, default_machine: null, machines: [] });
  await seedManifest();
});

beforeEach(() => {
  clearRemoteCaches();
});

/* ── pure parsing: the engine's own words -> the three this app may say ──── */

describe("parseEngineOutput", () => {
  test("reads the three properties and collects every journal line", () => {
    const fields = parseEngineOutput(
      ["active=inactive", "load=loaded", "restarts=4", "journal=Stopped SDL engine.", "journal=engine: lane xai=2 free"].join("\n"),
    );
    expect(fields.active).toBe("inactive");
    expect(fields.load).toBe("loaded");
    expect(fields.restarts).toBe(4);
    // A journal line containing its own `=` is kept whole, not truncated at it.
    expect(fields.journal).toEqual(["Stopped SDL engine.", "engine: lane xai=2 free"]);
  });

  test("an unreadable restart count is null, never zero", () => {
    expect(parseEngineOutput("active=active\nload=loaded\nrestarts=\n").restarts).toBeNull();
    expect(parseEngineOutput("active=active\n").restarts).toBeNull();
  });
});

describe("engineFromFields", () => {
  const where = "155.133.27.86, this project's Runs-on machine";

  test("an active unit is running, and the sentence names the machine that said so", () => {
    const view = engineFromFields("155.133.27.86", { active: "active", load: "loaded", restarts: 2, journal: [] }, where);
    expect(view.engine).toBe("running");
    expect(view.reason).toContain("reported by 155.133.27.86");
    expect(view.restarts).toBe(2);
  });

  test("an inactive unit is STOPPED - the state the local read could never claim", () => {
    const view = engineFromFields(
      "155.133.27.86",
      { active: "inactive", load: "loaded", restarts: 0, journal: ["Stopped SDL engine."] },
      where,
    );
    expect(view.engine).toBe("stopped");
    expect(view.reason).toContain("reported by 155.133.27.86");
    expect(view.reason).toContain("Stopped SDL engine.");
  });

  test("a unit systemd does not have is UNKNOWN, not stopped", () => {
    const view = engineFromFields("155.133.27.86", { active: "inactive", load: "not-found", restarts: null, journal: [] }, where);
    expect(view.engine).toBe("unknown");
    expect(view.reason).toContain("LoadState=not-found");
    expect(view.restarts).toBeNull();
  });

  test("a word this app does not know is unknown, quoted back verbatim", () => {
    const view = engineFromFields("155.133.27.86", { active: "activating", load: "loaded", restarts: null, journal: [] }, where);
    expect(view.engine).toBe("unknown");
    expect(view.reason).toContain('"activating"');
  });
});

/* ── which machine answers for a project ────────────────────────────────── */

describe("resolveProjectMachine", () => {
  test("a project's own Runs-on binding wins over the default machine", async () => {
    const vps = await box("pw-bind");
    const record = await machine(vps);
    const registry = await readRegistry();
    await writeRegistry({ ...registry, default_machine: null });
    await bindProject("p-module", record.id);

    const resolved = await resolveProjectMachine("p-module");
    expect(resolved?.record.id).toBe(record.id);
    expect(resolved?.via).toBe("runs-on");
    // An unbound project with no default reaches nothing at all.
    expect(await resolveProjectMachine("p-other")).toBeNull();
    await bindProject("p-module", null);
  }, 20_000);

  test("with no binding, the machine marked default is the one asked", async () => {
    const registry = await readRegistry();
    const first = registry.machines[0]!;
    await writeRegistry({ ...registry, default_machine: first.id });

    const resolved = await resolveProjectMachine("p-other");
    expect(resolved?.record.id).toBe(first.id);
    expect(resolved?.via).toBe("default");
    expect(resolved?.where).toContain("default machine");
  });

  test("no machine registered at all is null - never an invented row", async () => {
    const registry = await readRegistry();
    await writeRegistry({ version: 1, default_machine: null, machines: [] });
    expect(await resolveProjectMachine("p-module")).toBeNull();
    await writeRegistry(registry);
  });
});

/* ── the engine read, over real SSH ─────────────────────────────────────── */

describe("the remote engine read", () => {
  test(
    "a stopped engine on the far end reads stopped HERE, with the far end's own journal line",
    async () => {
      const vps = await box("pw-stopped");
      const record = await machine(vps);
      vps.engine = { active: "inactive", load: "loaded", restarts: "3", journal: ["Stopped SDL engine."] };

      const view = await remoteEngine({ record, via: "default", where: `${record.host}, this app's default machine` });
      expect(view.engine).toBe("stopped");
      expect(view.reachable).toBe(true);
      expect(view.restarts).toBe(3);
      expect(view.reason).toContain(`reported by ${record.host}`);
      expect(view.reason).toContain("Stopped SDL engine.");
      // The command really is the three properties plus the tail - nothing on
      // this path can write to the box.
      const sent = vps.commands.filter((c) => c.includes("systemctl is-active"));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("systemctl show -p NRestarts --value");
      expect(sent[0]).toContain("journalctl -u");
    },
    20_000,
  );

  test(
    "a machine that is gone is UNKNOWN with the ssh error - never a guessed 'stopped'",
    async () => {
      const vps = await box("pw-gone");
      const record = await machine(vps);
      await vps.close();

      const view = await remoteEngine({ record, via: "default", where: `${record.host}, this app's default machine` });
      expect(view.engine).toBe("unknown");
      expect(view.reachable).toBe(false);
      expect(view.reason).toContain(record.host);
      expect(view.reason).toContain("could not be reached");
      expect(view.restarts).toBeNull();
    },
    20_000,
  );

  test(
    "the answer is cached per machine and single-flighted: three overlapping polls, one connection",
    async () => {
      const vps = await box("pw-cache");
      const record = await machine(vps);
      const target = { record, via: "default" as const, where: `${record.host}, this app's default machine` };

      const [a, b, c] = await Promise.all([remoteEngine(target), remoteEngine(target), remoteEngine(target)]);
      expect(a.engine).toBe("running");
      expect(b).toEqual(a);
      expect(c).toEqual(a);
      expect(vps.commands.filter((line) => line.includes("systemctl is-active"))).toHaveLength(1);

      // A fourth poll inside the TTL asks nobody.
      await remoteEngine(target);
      expect(vps.commands.filter((line) => line.includes("systemctl is-active"))).toHaveLength(1);
    },
    20_000,
  );

  test(
    "two projects sharing ONE machine share the round trip and NOT the 'why we asked' sentence",
    async () => {
      const vps = await box("pw-attrib");
      const record = await machine(vps);
      // The two links `resolveProjectMachine` exists to tell apart: one project
      // bound by its own Runs-on, one falling through to the default machine.
      const runsOn = { record, via: "runs-on" as const, where: `${record.host}, this project's Runs-on machine` };
      const fallback = {
        record,
        via: "default" as const,
        where: `${record.host}, this app's default machine (no project Runs-on names one)`,
      };

      const [bound, unbound] = await Promise.all([remoteEngine(runsOn), remoteEngine(fallback)]);

      // Neither project is told the other's story, whichever one won the race.
      expect(bound.reason).toContain("this project's Runs-on machine");
      expect(bound.reason).not.toContain("default machine");
      expect(unbound.reason).toContain("this app's default machine");
      expect(unbound.reason).not.toContain("this project's Runs-on machine");
      // The FACTS are shared - that is what the cache is for.
      expect(unbound.engine).toBe(bound.engine);
      expect(unbound.restarts).toBe(bound.restarts);
      expect(vps.commands.filter((line) => line.includes("systemctl is-active"))).toHaveLength(1);

      // And a later poll inside the same 15s window is still its own asker's.
      const again = await remoteEngine(fallback);
      expect(again.reason).toBe(unbound.reason);
      expect(vps.commands.filter((line) => line.includes("systemctl is-active"))).toHaveLength(1);
    },
    20_000,
  );

  test(
    "an unreachable machine shares the ssh error and still names each asker's own link",
    async () => {
      const vps = await box("pw-attrib-gone");
      const record = await machine(vps);
      await vps.close();
      const runsOn = { record, via: "runs-on" as const, where: `${record.host}, this project's Runs-on machine` };
      const fallback = { record, via: "default" as const, where: `${record.host}, this app's default machine` };

      const [bound, unbound] = await Promise.all([remoteEngine(runsOn), remoteEngine(fallback)]);
      expect(bound.engine).toBe("unknown");
      expect(unbound.reachable).toBe(false);
      expect(bound.reason).toContain("this project's Runs-on machine");
      expect(unbound.reason).toContain("this app's default machine");
      expect(unbound.reason).not.toContain("Runs-on");
    },
    20_000,
  );
});

/* ── health: the footer's own shape, with the machine's answer in it ────── */

describe("factory/health with a machine to ask", () => {
  const local = { root: home, queueDir: join(home, "queue"), configPath: join(home, "sssf.config.yaml"), runsRunning: null, factoryPresent: false, env: null };

  test("with no machine, every engine field is byte-for-byte what it always was", async () => {
    const health = await buildHealth({ ...local, engine: null });
    expect(health.source).toBe("local-derived");
    expect(health.source_host).toBeNull();
    expect(health.engine).toBe("unknown");
    expect(health.engine_restarts).toBeNull();
    expect(health.uptime_seconds).toBeNull();
  });

  test(
    "with a machine, the footer says stopped ON that host and names it as the source",
    async () => {
      const vps = await box("pw-health");
      const record = await machine(vps);
      vps.engine = { active: "inactive", load: "loaded", restarts: "0", journal: ["Stopped SDL engine."] };
      const engine = await remoteEngine({ record, via: "runs-on", where: `${record.host}, this project's Runs-on machine` });

      const health = await buildHealth({ ...local, engine });
      expect(health.engine).toBe("stopped");
      expect(health.source).toBe("server");
      expect(health.source_host).toBe(record.host);
      expect(health.engine_reason).toContain(`reported by ${record.host}`);
      expect(health.engine_restarts).toBe(0);
      // Still honest about what a running engine alone knows.
      expect(health.uptime_seconds).toBeNull();
      expect(health.lanes_active).toBeNull();
    },
    20_000,
  );

  test(
    "a machine that could not answer leaves the claim local, but still names who was asked",
    async () => {
      const vps = await box("pw-health-gone");
      const record = await machine(vps);
      await vps.close();
      const engine = await remoteEngine({ record, via: "default", where: `${record.host}, this app's default machine` });

      const health = await buildHealth({ ...local, engine });
      expect(health.engine).toBe("unknown");
      expect(health.source).toBe("local-derived");
      expect(health.source_host).toBe(record.host);
      expect(health.engine_reason).toContain("could not be reached");
    },
    20_000,
  );
});

/* ── the runs read ──────────────────────────────────────────────────────── */

const REMOTE_PAYLOAD = {
  ok: true,
  sessions: [
    {
      adw_id: "a1b2c3",
      adw_name: "adw_plan + adw_build_test",
      request: "add the clamp helper",
      status: "running" as const,
      engineer: "factory",
      started_at: "2026-08-20T04:00:00Z",
      ended_at: null,
      total_tokens: 1200,
      total_cost: 0.4,
      archived: 0,
    },
  ],
  phases: [
    {
      phase_id: "ph1",
      adw_id: "a1b2c3",
      seq: 1,
      name: "build",
      kind: "agent" as const,
      owner: "builder",
      description: null,
      status: "running" as const,
      attempt: 1,
      retries: 0,
      error: null,
      started_at: "2026-08-20T04:00:10Z",
      ended_at: null,
    },
  ],
  agents: [],
  agent_starts: [
    { adw_id: "a1b2c3", agent: "builder", payload_json: '{"model":"xai/grok-5-code"}', started_at: "2026-08-20T04:00:10Z" },
  ],
  logs: [{ adw_id: "a1b2c3", name: "branch", payload_json: '{"branch":"adw/a1b2c3_add-a-clamp-helper"}' }],
};

describe("the remote runs read", () => {
  test("the command opens the db READ-ONLY and never writes", () => {
    const command = runsCommand("/root/module", 50);
    expect(command.startsWith("python3 -c ")).toBe(true);
    expect(command).toContain("/root/module/adws/adw_data/sssf.db");
    expect(RUNS_SCRIPT).toContain('"?mode=ro"');
    expect(RUNS_SCRIPT).toContain("uri=True");
    // Nothing that could change the far end may appear in the script at all.
    expect(/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ATTACH)\b/i.test(RUNS_SCRIPT)).toBe(false);
    expect(remoteDbPath("/root/module/")).toBe("/root/module/adws/adw_data/sssf.db");
  });

  test("rows assemble into exactly the shape the local reader produces", () => {
    const runs = assembleRemoteRuns(REMOTE_PAYLOAD, "155.133.27.86");
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.adw_id).toBe("a1b2c3");
    expect(run.status).toBe("running");
    expect(run.phases).toHaveLength(1);
    // The running agent has no agent_sessions row yet; its model comes off the
    // agent_start event, exactly as db.ts does it locally.
    expect(run.agents.map((agent) => agent.model)).toEqual(["xai/grok-5-code"]);
    // The title rule is the SAME function the local reader uses.
    expect(run.title).toBe("Add a clamp helper");
    // The muted chip the run list already renders.
    expect(run.machine).toBe("on 155.133.27.86");
  });

  test(
    "a live box hands back its runs, labelled with the host they came from",
    async () => {
      const vps = await box("pw-runs");
      const record = await machine(vps);
      vps.runsJson = JSON.stringify(REMOTE_PAYLOAD);

      const answer = await remoteRuns({ record, via: "runs-on", where: `${record.host}, this project's Runs-on machine` });
      expect(answer.runs).toHaveLength(1);
      expect(answer.runs[0]!.machine).toBe(`on ${record.host}`);
      expect(answer.source.origin).toBe("machine");
      expect(answer.source.host).toBe(record.host);
      expect(answer.source.repo_dir).toBe("/root/module");
      expect(answer.source.reachable).toBe(true);
      expect(answer.source.reason).toContain(record.host);
    },
    20_000,
  );

  test(
    "a box whose db does not exist yet says so BY NAME - not an error, not a bare empty list",
    async () => {
      const vps = await box("pw-nodb");
      const record = await machine(vps);
      vps.runsJson = JSON.stringify({ ok: false, missing: true, reason: "no database at /root/module/adws/adw_data/sssf.db" });

      const answer = await remoteRuns({ record, via: "default", where: `${record.host}, this app's default machine` });
      expect(answer.runs).toEqual([]);
      expect(answer.source.reachable).toBe(true);
      expect(answer.source.reason).toContain(`no runs recorded on ${record.host} yet`);
      expect(answer.source.reason).toContain("adws/adw_data/sssf.db");
    },
    20_000,
  );

  test(
    "a box with no python3 reports what the shell said, verbatim",
    async () => {
      const vps = await box("pw-nopython");
      const record = await machine(vps);
      vps.runsJson = null;

      const answer = await remoteRuns({ record, via: "default", where: `${record.host}, this app's default machine` });
      expect(answer.runs).toEqual([]);
      expect(answer.source.reason).toContain("python3: not found");
    },
    20_000,
  );

  test(
    "a machine that was never deployed names the missing checkout instead of guessing a path",
    async () => {
      const vps = await box("pw-nodeploy");
      const record = await machine(vps, null);

      const answer = await remoteRuns({ record, via: "default", where: `${record.host}, this app's default machine` });
      expect(answer.runs).toEqual([]);
      expect(answer.source.repo_dir).toBeNull();
      expect(answer.source.reason).toContain("no factory checkout is recorded");
      // It never opened a connection to guess with.
      expect(vps.commands.filter((line) => line.startsWith("python3"))).toHaveLength(0);
    },
    20_000,
  );

  test(
    "the never-deployed sentence belongs to the project that asked, not to the first one that did",
    async () => {
      const vps = await box("pw-attrib-runs");
      const record = await machine(vps, null);
      const runsOn = { record, via: "runs-on" as const, where: `${record.host}, this project's Runs-on machine` };
      const fallback = { record, via: "default" as const, where: `${record.host}, this app's default machine` };

      const [bound, unbound] = await Promise.all([remoteRuns(runsOn), remoteRuns(fallback)]);
      expect(bound.source.reason).toContain("this project's Runs-on machine");
      expect(unbound.source.reason).toContain("this app's default machine");
      expect(unbound.source.reason).not.toContain("Runs-on");
      expect(vps.commands.filter((line) => line.startsWith("python3"))).toHaveLength(0);
    },
    20_000,
  );

  test(
    "a gone box is an honest unreachable, and the read is single-flighted like the engine's",
    async () => {
      const vps = await box("pw-runs-cache");
      const record = await machine(vps);
      vps.runsJson = JSON.stringify(REMOTE_PAYLOAD);
      const target = { record, via: "default" as const, where: `${record.host}, this app's default machine` };

      const [a, b] = await Promise.all([remoteRuns(target), remoteRuns(target)]);
      expect(a.runs).toHaveLength(1);
      expect(b).toEqual(a);
      expect(vps.commands.filter((line) => line.startsWith("python3"))).toHaveLength(1);

      await vps.close();
      clearRemoteCaches();
      const gone = await remoteRuns(target);
      expect(gone.runs).toEqual([]);
      expect(gone.source.reachable).toBe(false);
      expect(gone.source.reason).toContain("could not be reached");
    },
    20_000,
  );

  test("the local answer carries a source row too, with nothing claimed in it", () => {
    expect(localRunsSource()).toEqual({ origin: "local", host: null, repo_dir: null, reachable: null, reason: null });
  });
});

/* ── the decision the /runs route actually makes ────────────────────────── */

describe("GET /api/app/p/:id/runs falls back to the machine", () => {
  async function runsRoute(id: string, query = ""): Promise<Response> {
    const request = new Request(`http://127.0.0.1:4700/api/app/p/${id}/runs${query}`);
    (request as Request & { params: Record<string, string> }).params = { id };
    return liveRoutes["/api/app/p/:id/runs"](request);
  }

  interface RunsBody {
    runs?: { adw_id: string; machine?: string }[];
    hidden_self_checks?: number;
    source?: { origin: string; host: string | null; reason: string | null };
    factory?: string;
  }

  test(
    "a checkout with no runs and a bound machine answers with the MACHINE's runs",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "sdl-remote-proj-"));
      dirs.push(root);
      const upserted = await upsertProject(root);
      if (!("project" in upserted)) throw new Error("upsertProject failed");
      const projectId = upserted.project.id;

      const vps = await box("pw-route");
      const record = await machine(vps);
      vps.runsJson = JSON.stringify(REMOTE_PAYLOAD);
      await bindProject(projectId, record.id);

      const body = (await (await runsRoute(projectId)).json()) as {
        runs?: { adw_id: string; machine?: string }[];
        source?: { origin: string; host: string | null; reason: string | null };
        factory?: string;
      };
      // NOT `{factory:"absent"}` any more: there IS a record, it is just not
      // on this laptop - which is the whole of the operator's complaint.
      expect(body.factory).toBeUndefined();
      expect(body.runs?.map((run) => run.adw_id)).toEqual(["a1b2c3"]);
      expect(body.runs?.[0]!.machine).toBe(`on ${record.host}`);
      expect(body.source?.origin).toBe("machine");
      expect(body.source?.host).toBe(record.host);
      expect(body.source?.reason).toContain("/root/module/adws/adw_data/sssf.db");

      await bindProject(projectId, null);
    },
    30_000,
  );

  test(
    "the same checkout with NO machine to ask is still the honest factory-absent answer",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "sdl-remote-lonely-"));
      dirs.push(root);
      const upserted = await upsertProject(root);
      if (!("project" in upserted)) throw new Error("upsertProject failed");

      const registry = await readRegistry();
      await writeRegistry({ version: 1, default_machine: null, machines: [] });
      const body = (await (await runsRoute(upserted.project.id)).json()) as { factory?: string };
      expect(body.factory).toBe("absent");
      await writeRegistry(registry);
    },
    30_000,
  );

  test(
    "a checkout holding nothing but self-checks still hears from the machine - and the self-check toggle never changes WHO answered",
    async () => {
      // The ordinary state of a laptop that validated its roster here and ran
      // its real work on the VPS. This repo's own sssf.db is exactly this: 22
      // rows, all 22 of them `adw_prompt` self-checks.
      const root = await mkdtemp(join(tmpdir(), "sdl-remote-selfchecks-"));
      dirs.push(root);
      await seedLocalDb(root, [
        { adw_id: "sc00001", ...SELF_CHECK },
        { adw_id: "sc00002", ...SELF_CHECK },
      ]);
      const upserted = await upsertProject(root);
      if (!("project" in upserted)) throw new Error("upsertProject failed");
      const projectId = upserted.project.id;

      const vps = await box("pw-selfchecks");
      const record = await machine(vps);
      vps.runsJson = JSON.stringify(REMOTE_PAYLOAD);
      await bindProject(projectId, record.id);

      const body = (await (await runsRoute(projectId)).json()) as RunsBody;
      expect(body.source?.origin).toBe("machine");
      expect(body.runs?.map((run) => run.adw_id)).toEqual(["a1b2c3"]);

      // The toggle decides what is SHOWN out of the record that answered; it
      // must never decide WHICH record answers, or turning self-checks on would
      // swap the machine's real runs for two local no-ops.
      const shown = (await (await runsRoute(projectId, "?self_checks=1")).json()) as RunsBody;
      expect(shown.source?.origin).toBe("machine");
      expect(shown.source?.host).toBe(record.host);
      expect(shown.runs?.map((run) => run.adw_id)).toEqual(["a1b2c3"]);

      await bindProject(projectId, null);
    },
    30_000,
  );

  test(
    "a checkout that holds real work answers for itself, machine bound or not, and counts its own hidden self-checks",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "sdl-remote-local-"));
      dirs.push(root);
      await seedLocalDb(root, [
        { adw_id: "sc00003", ...SELF_CHECK },
        { adw_id: "local01", adw_name: "adw_plan + adw_build_test", request: "add the clamp helper" },
      ]);
      const upserted = await upsertProject(root);
      if (!("project" in upserted)) throw new Error("upsertProject failed");
      const projectId = upserted.project.id;

      const vps = await box("pw-local-wins");
      const record = await machine(vps);
      vps.runsJson = JSON.stringify(REMOTE_PAYLOAD);
      await bindProject(projectId, record.id);

      const body = (await (await runsRoute(projectId)).json()) as RunsBody;
      expect(body.source?.origin).toBe("local");
      expect(body.runs?.map((run) => run.adw_id)).toEqual(["local01"]);
      expect(body.hidden_self_checks).toBe(1);
      // Nobody was asked, so nothing was said about anybody.
      expect(vps.commands.filter((line) => line.startsWith("python3"))).toHaveLength(0);

      await bindProject(projectId, null);
    },
    30_000,
  );
});

/* ── the command shape ──────────────────────────────────────────────────── */

describe("engineCommand", () => {
  test("asks systemd three things and the journal two lines, and nothing else", () => {
    const command = engineCommand();
    expect(command).toContain("systemctl is-active 'sdl-engine'");
    expect(command).toContain("systemctl show -p LoadState --value 'sdl-engine'");
    expect(command).toContain("systemctl show -p NRestarts --value 'sdl-engine'");
    expect(command).toContain("journalctl -u 'sdl-engine' -n 2 --no-pager -o cat");
    // No restart, no start, no enable: this read cannot change the far end.
    expect(/systemctl (start|stop|restart|enable|disable)/.test(command)).toBe(false);
  });
});
