/**
 * Tests for the machines plane (`app/machines.ts`), run with
 * `bun test server/app/machines.test.ts` from `apps/ui`.
 *
 * ── What is real here ───────────────────────────────────────────────────────
 * The SSH is REAL. Every test that connects does so over a genuine SSH
 * transport on loopback — real key exchange, real password auth, real
 * publickey auth, real `exec` channels with exit codes, real SFTP — against an
 * `ssh2.Server` started in this process. Nothing about the client path is
 * stubbed, which is exactly the point: this file is the proof that ssh2's
 * client works under Bun on Windows, the risky choice the design rests on.
 *
 * ── What is a stand-in, and why ─────────────────────────────────────────────
 * The far end's *shell* is emulated: the fake server pattern-matches the small,
 * fixed set of commands `machines.ts` sends and answers them the way a Ubuntu
 * box would. Running a real `apt-get` in a unit test is not a test, it is a
 * provisioning run. The two things that emulation could hide are covered
 * separately:
 *
 *   * `bootstrap.sh`'s own syntax is checked with `sh -n` (skipped, loudly,
 *     when no POSIX shell is on PATH), and its line endings are asserted.
 *   * `authorized_keys` append-if-absent is emulated faithfully enough to catch
 *     the duplicate-line bug, because that is the behaviour idempotency rests
 *     on.
 *
 * The MANUAL proof path — the one thing no test in any CI can do — is written
 * out at the bottom of this file: what the operator runs against his own box,
 * and what he should see.
 *
 * Nothing outside a fresh temp directory is read or written: `SDL_FACTORY_HOME`
 * is redirected before the module's registry functions are ever called, so the
 * operator's real `~/.sdl-factory` is untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Server, utils, type Connection } from "ssh2";
// Type-only, so it is erased before it can load the module: the runtime import
// below must not happen until SDL_FACTORY_HOME is redirected.
import type { ProviderSyncRun } from "../../shared/types.ts";
import type { MachineRecord } from "./machines.ts";

const home = await mkdtemp(join(tmpdir(), "sdl-machines-"));
process.env["SDL_FACTORY_HOME"] = home;
// The provider-sync round-trip below loads `providers-v3.ts`, whose local-home
// probes must never reach the operator's real `~/.pi`, `~/.codex` or
// `~/.claude`. Both overrides are read at call time, so setting this here is
// enough and it cannot collide with providers-v3.test.ts's own temp home.
process.env["SDL_FACTORY_LOCAL_HOME"] = home;

const {
  addMachine,
  bindProject,
  bootstrapPath,
  generateUsableKeyPair,
  isPublicKeyLine,
  keyDir,
  localRow,
  machineId,
  machinesHome,
  parseProbeOutput,
  parseStepLine,
  probeMachine,
  providerSyncSummary,
  readBindings,
  readProviderSyncLog,
  readRegistry,
  registryPath,
  remoteHasBranch,
  repoDirName,
  shq,
  startDeploy,
  toRow,
  writeRegistry,
} = await import("./machines.ts");

/** The providers plane's own writer, used only to prove that the file this
 * module reads is the file that module writes. Nothing here syncs anything. */
const { providersRegistryPath, writeProvidersRegistry } = await import("./providers-v3.ts");

/* ── the fake VPS ──────────────────────────────────────────────────────────
   A real SSH server; a scripted shell. `authorizedKeys` is the box's own
   ~/.ssh/authorized_keys, and `uploads` is its filesystem as far as SFTP is
   concerned. `deployScript` decides what the bootstrap run prints. */

interface FakeBox {
  server: Server;
  port: number;
  password: string;
  authorizedKeys: string[];
  uploads: Map<string, string>;
  commands: string[];
  /** lines the emulated `sh bootstrap.sh ...` prints, and the code it exits */
  deploy: { lines: string[]; code: number };
  close: () => Promise<void>;
}

/** The exact command `installKey` sends, emulated: append the key line only if
 * it is not already there. Returns true when it handled the command. */
function handleInstallKey(box: FakeBox, command: string): boolean {
  if (!command.includes("authorized_keys")) return false;
  const quoted = [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1]!.replace(/'\\''/g, "'"));
  const key = quoted.find((value) => value.startsWith("ssh-"));
  if (!key) return false;
  if (!box.authorizedKeys.includes(key)) box.authorizedKeys.push(key);
  return true;
}

async function startFakeBox(options: { password?: string } = {}): Promise<FakeBox> {
  const hostKey = utils.generateKeyPairSync("ed25519", {}).private;
  const box: Partial<FakeBox> & { authorizedKeys: string[]; uploads: Map<string, string>; commands: string[] } = {
    password: options.password ?? "hunter2",
    authorizedKeys: [],
    uploads: new Map(),
    commands: [],
    deploy: { lines: ["STEP preflight OK user=root sudo=no", "DEPLOY COMPLETE"], code: 0 },
  };

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password") {
        return ctx.password === box.password ? ctx.accept() : ctx.reject(["password", "publickey"]);
      }
      if (ctx.method === "publickey") {
        // The key must actually be one this box was told to trust - otherwise
        // "reconnected with the key" would pass even when the install failed.
        const presented = ctx.key.data.toString("base64");
        const trusted = box.authorizedKeys.some((line) => line.split(" ")[1] === presented);
        return trusted ? ctx.accept() : ctx.reject(["password", "publickey"]);
      }
      return ctx.reject(["password", "publickey"]);
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          const command = info.command;
          box.commands.push(command);

          if (handleInstallKey(box as FakeBox, command)) {
            stream.exit(0);
            return stream.end();
          }
          if (command.includes("sdl-factory-key-ok")) {
            stream.write("sdl-factory-key-ok\n");
            stream.exit(0);
            return stream.end();
          }
          if (command.includes("uname -sr")) {
            stream.write("os=Linux 6.8.0-generic\n");
            stream.write("whoami=root\n");
            stream.write("engine=active\n");
            stream.write("head=a1b2c3d\n");
            stream.write("branch=integration\n");
            stream.exit(0);
            return stream.end();
          }
          if (command.startsWith("sh ")) {
            for (const line of box.deploy!.lines) stream.write(`${line}\n`);
            stream.exit(box.deploy!.code);
            return stream.end();
          }
          stream.stderr.write(`sh: not emulated: ${command}\n`);
          stream.exit(127);
          return stream.end();
        });

        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          // Chunks are kept as BYTES and decoded once, at CLOSE. Decoding each
          // WRITE packet on its own splits any multi-byte character that
          // straddles a packet boundary into two replacement characters - a
          // corruption invented by this stand-in, not by the uploader (a real
          // SFTP server writes the bytes to disk). The script is full of
          // box-drawing characters, so shifting one line by a few bytes was
          // enough to fail the byte-for-byte assertion below for no real
          // reason. `Buffer.from` copies: ssh2 reuses its receive buffer.
          const open = new Map<string, { path: string; chunks: Buffer[] }>();
          let counter = 0;
          sftp.on("OPEN", (reqid, filename) => {
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(++counter, 0);
            open.set(handle.toString("hex"), { path: filename, chunks: [] });
            sftp.handle(reqid, handle);
          });
          sftp.on("WRITE", (reqid, handle, _offset, data) => {
            open.get(handle.toString("hex"))?.chunks.push(Buffer.from(data));
            sftp.status(reqid, 0);
          });
          sftp.on("CLOSE", (reqid, handle) => {
            const entry = open.get(handle.toString("hex"));
            if (entry) box.uploads.set(entry.path, Buffer.concat(entry.chunks).toString("utf-8"));
            sftp.status(reqid, 0);
          });
          sftp.on("REALPATH", (reqid, path) => sftp.name(reqid, [{ filename: path, longname: path, attrs: {} as never }]));
          sftp.on("FSTAT", (reqid) => sftp.status(reqid, 0));
          sftp.on("STAT", (reqid) => sftp.status(reqid, 2));
        });
      });
    });

    // A client that ends mid-handshake must not take the test process down.
    client.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;

  const full: FakeBox = {
    ...(box as FakeBox),
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  // `handleInstallKey` and the exec handler close over `box`, so the mutable
  // collections must be the SAME objects the caller inspects.
  full.authorizedKeys = box.authorizedKeys;
  full.uploads = box.uploads;
  full.commands = box.commands;
  full.deploy = box.deploy!;
  return full;
}

const boxes: FakeBox[] = [];

/** addMachine, with its own error as the failure message. Every test below
 * needs the record; a bare `added` would report a null dereference and
 * hide the SSH error that actually explains it. */
async function addOrFail(request: Parameters<typeof addMachine>[0]) {
  const outcome = await addMachine(request);
  if (!outcome.ok || !outcome.record) throw new Error(`addMachine failed: ${outcome.error ?? "no reason given"}`);
  return outcome.record;
}

async function box(options: { password?: string } = {}): Promise<FakeBox> {
  const created = await startFakeBox(options);
  boxes.push(created);
  return created;
}

/** Throwaway directories a test made (the git fixtures below), removed with
 * everything else when the file is done. */
const tempDirs: string[] = [];

afterAll(async () => {
  for (const created of boxes) await created.close().catch(() => {});
  await rm(home, { recursive: true, force: true }).catch(() => {});
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

beforeAll(async () => {
  await writeRegistry({ version: 1, default_machine: null, machines: [] });
});

/* ── pure parsers ──────────────────────────────────────────────────────────*/

describe("the STEP protocol", () => {
  test("parses OK and FAIL lines, with and without a detail", () => {
    expect(parseStepLine("STEP apt OK installed git curl")).toMatchObject({
      name: "apt",
      state: "ok",
      detail: "installed git curl",
    });
    expect(parseStepLine("STEP clone FAIL repository not reachable from the server")).toMatchObject({
      name: "clone",
      state: "fail",
      detail: "repository not reachable from the server",
    });
    expect(parseStepLine("STEP uv OK")).toMatchObject({ name: "uv", state: "ok", detail: "" });
  });

  test("never guesses: ordinary output is not a step", () => {
    expect(parseStepLine("Reading package lists... Done")).toBeNull();
    expect(parseStepLine("STEP")).toBeNull();
    expect(parseStepLine("stepping through STEP apt OK")).toBeNull();
    expect(parseStepLine("STEP apt MAYBE")).toBeNull();
  });
});

describe("probe output", () => {
  test("reads key=value lines and ignores everything else", () => {
    const parsed = parseProbeOutput("os=Linux 6.8\nnoise\nengine=active\n=bad\nhead=abc123\n");
    expect(parsed).toEqual({ os: "Linux 6.8", engine: "active", head: "abc123" });
  });
});

describe("shell quoting and key validation", () => {
  test("shq survives an embedded single quote", () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });

  test("a public key line is accepted; anything shaped like an injection is not", () => {
    const pair = utils.generateKeyPairSync("ed25519", { comment: "sdl-factory-app-test" });
    expect(isPublicKeyLine(pair.public)).toBe(true);
    expect(isPublicKeyLine("ssh-ed25519 AAAAC3Nz")).toBe(true);
    expect(isPublicKeyLine("ssh-ed25519 AAAA'; rm -rf / #")).toBe(false);
    expect(isPublicKeyLine("rm -rf /")).toBe(false);
    expect(isPublicKeyLine("ssh-ed25519 AAAA\nrm -rf /")).toBe(false);
  });

  // The bug this pins: ssh2's own `generateKeyPairSync` drops a leading zero
  // byte from the ed25519 material about 2 times in 256, and the key it hands
  // back then fails its own `parseKey` with "Malformed OpenSSH private key".
  // It surfaced here as a ~1-in-3 flake across the suite's ~20 key generations,
  // and in `addMachine` as a failure that only landed after the operator's
  // one-time password was spent. 600 draws puts the odds of this test passing
  // on a still-broken generator under 1 in 10^20.
  test("every generated key parses - no dropped leading zero byte", () => {
    for (let i = 0; i < 600; i++) {
      const pair = generateUsableKeyPair(`sdl-factory-app-${i}`);
      const parsed = utils.parseKey(pair.private);
      expect(parsed instanceof Error ? (parsed as Error).message : "parsed").toBe("parsed");
      expect(isPublicKeyLine(pair.public)).toBe(true);
    }
  }, 30_000);
});

describe("ids and paths", () => {
  test("the same host+user+port is always the same machine", () => {
    expect(machineId("1.2.3.4", "root", 22)).toBe(machineId("1.2.3.4", "root", 22));
    expect(machineId("1.2.3.4", "root", 22)).not.toBe(machineId("1.2.3.4", "root", 2222));
    expect(machineId("1.2.3.4", "root", 22)).not.toBe(machineId("1.2.3.5", "root", 22));
  });

  test("the remote checkout directory comes from the repo url", () => {
    expect(repoDirName("https://github.com/owner/sdl-factory.git")).toBe("sdl-factory");
    expect(repoDirName("git@github.com:owner/sdl-factory.git")).toBe("sdl-factory");
    expect(repoDirName("https://example.com/a/b/")).toBe("b");
  });

  test("the registry and keys live under SDL_FACTORY_HOME, never the real home", () => {
    expect(machinesHome()).toBe(home);
    expect(registryPath().startsWith(home)).toBe(true);
    expect(keyDir().startsWith(home)).toBe(true);
  });
});

/* ── the providers a machine actually carries ──────────────────────────────
   A deployed box with no provider credentials cannot run one model, and that
   was invisible from this pane. These tests hold the two halves of the fix:
   the summary is honest about zero, and the file this module reads is the file
   `providers-v3.ts` writes - the one thing a duplicated filename could break. */

describe("the provider sync summary on a machine row", () => {
  function record(id: string): MachineRecord {
    return {
      id,
      name: "box",
      host: "203.0.113.10",
      port: 22,
      user: "root",
      key_path: join(home, "keys", id),
      key_generated: true,
      added_at: "2026-01-01T00:00:00.000Z",
      last_connected_at: null,
      repo_dir: null,
      host_fingerprint: null,
    };
  }

  function run(machine: string, results: ProviderSyncRun["results"]): ProviderSyncRun {
    return {
      machine_id: machine,
      machine_name: "box",
      at: "2026-08-17T09:00:00.000Z",
      ok: results.every((result) => result.state === "applied"),
      results,
    };
  }

  test("counts each state separately and names only what landed", () => {
    const summary = providerSyncSummary(
      run("m-1", [
        { provider_id: "deepseek", bucket: "api-key", state: "applied", reason: "written" },
        { provider_id: "groq", bucket: "api-key", state: "applied", reason: "written" },
        { provider_id: "claude", bucket: "signed-in", state: "needs-you", reason: "run claude setup-token" },
        { provider_id: "codex", bucket: "signed-in", state: "failed", reason: "no ~/.codex/auth.json" },
      ]),
    )!;
    expect(summary).toEqual({
      at: "2026-08-17T09:00:00.000Z",
      ok: false,
      applied: 2,
      needs_you: 1,
      failed: 1,
      applied_ids: ["deepseek", "groq"],
    });
  });

  test("a run where nothing landed is applied:0, never a null that reads as 'not checked'", () => {
    const summary = providerSyncSummary(
      run("m-1", [{ provider_id: "claude", bucket: "signed-in", state: "needs-you", reason: "no token" }]),
    )!;
    expect(summary.applied).toBe(0);
    expect(summary.applied_ids).toEqual([]);
    expect(summary.ok).toBe(false);
  });

  test("no run at all is null - the state the pane warns on", () => {
    expect(providerSyncSummary(null)).toBeNull();
    expect(providerSyncSummary(undefined)).toBeNull();
    // A hand-edited record with no results array must not become a fake zero.
    expect(providerSyncSummary({ machine_id: "m", machine_name: "m", at: "x" } as unknown as ProviderSyncRun)).toBeNull();
  });

  test("a reason string never reaches a machine row - only counts and ids do", () => {
    const summary = providerSyncSummary(
      run("m-1", [
        { provider_id: "deepseek", bucket: "api-key", state: "applied", reason: "key written into /root/.pi/agent/auth.json" },
      ]),
    )!;
    expect(JSON.stringify(summary)).not.toContain("auth.json");
    expect(Object.keys(summary).sort()).toEqual(["applied", "applied_ids", "at", "failed", "needs_you", "ok"]);
  });

  test("the log this module reads is the file providers-v3 writes, under the same home", async () => {
    // The one thing spelling the filename twice could break. providers-v3's
    // own writer puts the file down; this module's reader has to find it.
    expect(providersRegistryPath()).toBe(join(machinesHome(), "providers.json"));
    await writeProvidersRegistry({
      version: 1,
      providers: [],
      sync: { "m-live": run("m-live", [{ provider_id: "deepseek", bucket: "api-key", state: "applied", reason: "ok" }]) },
    });
    const log = await readProviderSyncLog();
    expect(providerSyncSummary(log["m-live"])!.applied_ids).toEqual(["deepseek"]);
    // A machine with no run of its own reads null, not the neighbour's run.
    expect(providerSyncSummary(log["m-other"])).toBeNull();
  });

  test("no key in the registry can reach a machine row", async () => {
    await writeProvidersRegistry({
      version: 1,
      providers: [
        {
          id: "deepseek",
          label: "DeepSeek",
          api: "openai-completions",
          base_url: "https://api.deepseek.com",
          auth_header: true,
          compat: null,
          models: [{ id: "deepseek-v4-flash", name: null }],
          key: "sk-SECRETVALUE-machines-test",
          added_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          source: "deepseek",
        },
      ],
      sync: { "m-1": run("m-1", [{ provider_id: "deepseek", bucket: "api-key", state: "applied", reason: "ok" }]) },
    });
    const log = await readProviderSyncLog();
    const row = toRow(record("m-1"), null, null, providerSyncSummary(log["m-1"]));
    expect(JSON.stringify(row)).not.toContain("SECRETVALUE");
    expect(row.providers).toMatchObject({ applied: 1, applied_ids: ["deepseek"] });
  });

  test("an unreadable providers file degrades to 'nothing synced', never to a false success", async () => {
    await writeFile(providersRegistryPath(), "{ not json", "utf-8");
    expect(await readProviderSyncLog()).toEqual({});
    expect(toRow(record("m-1"), null, null, providerSyncSummary((await readProviderSyncLog())["m-1"])).providers).toBeNull();
    await rm(providersRegistryPath(), { force: true });
  });

  test("the local row never claims a provider sync - nothing is synced to this laptop", () => {
    expect(localRow().providers).toBeNull();
    expect(localRow().kind).toBe("local");
  });
});

/* ── the real SSH path ─────────────────────────────────────────────────────*/

describe("adding a machine with a password (the one-time bootstrap)", () => {
  test(
    "connects, installs a generated key, proves it, and never stores the password",
    async () => {
      const vps = await box({ password: "correct horse" });
      const outcome = await addMachine({
        name: "contabo",
        host: "127.0.0.1",
        port: vps.port,
        user: "root",
        password: "correct horse",
      });

      expect(outcome.error).toBeUndefined();
      expect(outcome.ok).toBe(true);
      expect(outcome.record?.key_generated).toBe(true);

      // The box was actually given a key, exactly one.
      expect(vps.authorizedKeys).toHaveLength(1);
      expect(vps.authorizedKeys[0]!.startsWith("ssh-ed25519 ")).toBe(true);

      // The key-only reconnect really happened: the box saw the proof command.
      expect(vps.commands.some((command) => command.includes("sdl-factory-key-ok"))).toBe(true);

      // The private key is on disk, and the public half beside it.
      const record = outcome.record!;
      expect(existsSync(record.key_path)).toBe(true);
      expect(existsSync(`${record.key_path}.pub`)).toBe(true);
      if (process.platform !== "win32") {
        expect((await stat(record.key_path)).mode & 0o777).toBe(0o600);
      }

      // The password is nowhere: not in the registry, not in the key files.
      const registryText = await readFile(registryPath(), "utf-8");
      expect(registryText).not.toContain("correct horse");
      expect(await readFile(record.key_path, "utf-8")).not.toContain("correct horse");
      expect(JSON.stringify(outcome)).not.toContain("correct horse");

      const registry = await readRegistry();
      expect(registry.machines.map((machine) => machine.id)).toContain(record.id);
      expect(registry.default_machine).toBe(record.id);
    },
    20_000,
  );

  test(
    "re-adding the same box is idempotent: same id, no duplicate authorized_keys line",
    async () => {
      const vps = await box({ password: "pw2" });
      const first = await addMachine({ host: "127.0.0.1", port: vps.port, user: "root", password: "pw2" });
      expect(first.ok).toBe(true);
      const before = (await readRegistry()).machines.length;

      const second = await addMachine({ host: "127.0.0.1", port: vps.port, user: "root", password: "pw2" });
      expect(second.ok).toBe(true);
      expect(second.record?.id).toBe(first.record!.id);
      expect((await readRegistry()).machines).toHaveLength(before);
      // The second run generated a second key, and the box now trusts both -
      // but neither line is a duplicate of the other, which is what
      // `grep -qxF || append` guarantees.
      expect(new Set(vps.authorizedKeys).size).toBe(vps.authorizedKeys.length);
    },
    30_000,
  );

  test("a wrong password fails by name and writes nothing", async () => {
    const vps = await box({ password: "right" });
    const before = await readFile(registryPath(), "utf-8");
    const outcome = await addMachine({ host: "127.0.0.1", port: vps.port, user: "root", password: "wrong" });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
    expect(vps.authorizedKeys).toHaveLength(0);
    expect(await readFile(registryPath(), "utf-8")).toBe(before);
  }, 20_000);

  test("neither a password nor a key path is an honest 'which one' error", async () => {
    const outcome = await addMachine({ host: "10.0.0.1" });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("password");
    expect(outcome.error).toContain("key");
  });

  test("no host is refused before any socket is opened", async () => {
    const outcome = await addMachine({ password: "x" });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("host");
  });
});

describe("the reachability probe", () => {
  test(
    "a live box answers with its os, engine state and factory head",
    async () => {
      const vps = await box({ password: "pw3" });
      const added = await addOrFail({ host: "127.0.0.1", port: vps.port, user: "root", password: "pw3" });
      const probe = await probeMachine(added);
      expect(probe.reachable).toBe(true);
      expect(probe.os).toBe("Linux 6.8.0-generic");
      expect(probe.engine).toBe("active");
      expect(probe.factory_head).toBe("a1b2c3d");
      expect(probe.factory_branch).toBe("integration");
      expect(probe.error).toBeNull();
      expect(typeof probe.latency_ms).toBe("number");
    },
    20_000,
  );

  test(
    "a box that is gone is unreachable WITH the server's own error, never a guess",
    async () => {
      const vps = await box({ password: "pw4" });
      const added = await addOrFail({ host: "127.0.0.1", port: vps.port, user: "root", password: "pw4" });
      await vps.close();

      const probe = await probeMachine(added);
      expect(probe.reachable).toBe(false);
      expect(probe.error).toBeTruthy();
      expect(probe.os).toBeNull();
      expect(probe.engine).toBeNull();
    },
    20_000,
  );

  test("a machine whose key file vanished says so instead of failing silently", async () => {
    const record: MachineRecord = {
      id: "m-ghost",
      name: "ghost",
      host: "127.0.0.1",
      port: 22,
      user: "root",
      key_path: join(home, "keys", "does-not-exist"),
      key_generated: true,
      added_at: new Date().toISOString(),
      last_connected_at: null,
      repo_dir: null,
      host_fingerprint: null,
    };
    const probe = await probeMachine(record);
    expect(probe.reachable).toBe(false);
    expect(probe.error).toContain("does-not-exist");
  });
});

describe("the host key", () => {
  test(
    "is pinned when the machine is added, and demanded on every connect afterwards",
    async () => {
      const vps = await box({ password: "pw-hostkey" });
      const added = await addOrFail({ host: "127.0.0.1", port: vps.port, user: "root", password: "pw-hostkey" });

      // Pinned, in OpenSSH's own spelling, and stored in the registry.
      expect(added.host_fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
      const stored = (await readRegistry()).machines.find((machine) => machine.id === added.id);
      expect(stored?.host_fingerprint).toBe(added.host_fingerprint!);

      // The pinned key is the one the box has, so the probe still works.
      expect((await probeMachine(added)).reachable).toBe(true);

      // A record pinned to a DIFFERENT key is refused by name, and the refusal
      // happens in the handshake - the box never sees an authentication attempt.
      const commandsBefore = vps.commands.length;
      const impostor: MachineRecord = { ...added, host_fingerprint: "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
      const probe = await probeMachine(impostor);
      expect(probe.reachable).toBe(false);
      expect(probe.error).toContain("host key");
      expect(probe.error).toContain("Nothing was sent");
      expect(vps.commands.length).toBe(commandsBefore);
    },
    20_000,
  );

  test(
    "is learned on first sight for a machine registered before pinning existed",
    async () => {
      const vps = await box({ password: "pw-legacy" });
      const added = await addOrFail({ host: "127.0.0.1", port: vps.port, user: "root", password: "pw-legacy" });

      // Rewrite the record the way an older version of this app wrote it.
      const registry = await readRegistry();
      const row = registry.machines.find((machine) => machine.id === added.id)!;
      const pinned = row.host_fingerprint!;
      row.host_fingerprint = null;
      await writeRegistry(registry);

      const legacy = (await readRegistry()).machines.find((machine) => machine.id === added.id)!;
      expect(legacy.host_fingerprint).toBeNull();
      expect((await probeMachine(legacy)).reachable).toBe(true);

      const after = (await readRegistry()).machines.find((machine) => machine.id === added.id)!;
      expect(after.host_fingerprint).toBe(pinned);
    },
    20_000,
  );
});

/* ── the deploy's pre-flight: is the branch even there? ────────────────────
   bootstrap.sh stops at step 7 when the remote has no `integration`, six steps
   and several minutes into a run, on the far end - and the only thing that ever
   CREATES that branch is the engine, which the deploy refuses to install until
   the branch exists. On every fresh project the operator paid for a full
   provisioning run to be told about a chicken-and-egg he has to break on the
   laptop. `postDeploy` asks first, so the refusal names the commands. */
describe("the deploy pre-flight", () => {
  async function git(cwd: string, argv: string[]): Promise<void> {
    const proc = Bun.spawn(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`git ${argv.join(" ")} exited ${code}: ${stderr}`);
  }

  test("answers true, false and 'could not ask' - and never confuses the last two", async () => {
    const origin = await mkdtemp(join(tmpdir(), "sdl-origin-"));
    const work = await mkdtemp(join(tmpdir(), "sdl-work-"));
    tempDirs.push(origin, work);

    await git(origin, ["init", "--bare", "-b", "main"]);
    await git(work, ["init", "-b", "main"]);
    await git(work, ["config", "user.email", "test@example.com"]);
    await git(work, ["config", "user.name", "test"]);
    await writeFile(join(work, "README.md"), "fixture\n", "utf-8");
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "-m", "first"]);
    await git(work, ["remote", "add", "origin", origin]);
    await git(work, ["push", "-u", "origin", "main"]);

    // The exact state a freshly stamped project is in: pushed, but no
    // `integration` anywhere. This is what the pre-flight has to catch.
    expect(await remoteHasBranch(work, "integration")).toBe(false);
    expect(await remoteHasBranch(work, "main")).toBe(true);

    await git(work, ["switch", "-c", "integration"]);
    await git(work, ["push", "-u", "origin", "integration"]);
    expect(await remoteHasBranch(work, "integration")).toBe(true);

    // A directory that is not a repository cannot answer - and "could not ask"
    // is NOT "not there". A pre-flight that guessed would refuse deploys that
    // would have worked; only a definite `false` may block one.
    const notARepo = await mkdtemp(join(tmpdir(), "sdl-norepo-"));
    tempDirs.push(notARepo);
    expect(await remoteHasBranch(notARepo, "integration")).toBeNull();
  }, 60_000);
});

describe("the one-click deploy", () => {
  async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return;
      await Bun.sleep(25);
    }
    throw new Error("timed out waiting for the deploy to finish");
  }

  test(
    "uploads the real bootstrap script, streams its STEP lines, and finishes done",
    async () => {
      const vps = await box({ password: "pw5" });
      const added = await addOrFail({ host: "127.0.0.1", port: vps.port, user: "root", password: "pw5" });
      vps.deploy.lines = [
        "STEP preflight OK user=root sudo=no target=/root/sdl-factory",
        "STEP apt OK installed git curl",
        "STEP uv OK installed uv 0.9.2",
        "Reading package lists... Done",
        "STEP clone OK cloned https://example.com/x.git into /root/sdl-factory",
        "STEP engine OK sdl-engine is active since now",
        "DEPLOY COMPLETE",
      ];
      vps.deploy.code = 0;

      const script = await readFile(bootstrapPath(), "utf-8");
      const job = startDeploy(added, {
        repoUrl: "https://example.com/x.git",
        branch: "integration",
        dir: "/root/sdl-factory",
        script,
      });
      expect(job.state).toBe("running");

      await waitFor(() => job.state !== "running");
      expect(job.error).toBeNull();
      expect(job.state).toBe("done");
      expect(job.exit_code).toBe(0);
      expect(job.steps.map((step) => step.name)).toEqual(["preflight", "apt", "uv", "clone", "engine"]);
      expect(job.steps.every((step) => step.state === "ok")).toBe(true);
      // Log noise is kept, beneath the steps, not thrown away.
      expect(job.lines).toContain("Reading package lists... Done");

      // The script the box received is byte-for-byte the repo's own, with LF
      // endings whatever the laptop's checkout did to them.
      const uploaded = vps.uploads.get(".sdl-factory-bootstrap.sh");
      expect(uploaded).toBeTruthy();
      expect(uploaded).toBe(script.replace(/\r\n/g, "\n"));
      expect(uploaded).not.toContain("\r");

      // The command line carried the url, branch and directory, quoted.
      const shCommand = vps.commands.find((command) => command.startsWith("sh "));
      expect(shCommand).toContain("'https://example.com/x.git'");
      expect(shCommand).toContain("'integration'");
      expect(shCommand).toContain("'/root/sdl-factory'");
    },
    40_000,
  );

  test(
    "a failing step fails the deploy and the error names that step",
    async () => {
      const vps = await box({ password: "pw6" });
      const added = await addOrFail({ host: "127.0.0.1", port: vps.port, user: "root", password: "pw6" });
      vps.deploy.lines = [
        "STEP preflight OK user=root sudo=no",
        "STEP apt OK already present",
        "STEP clone FAIL repository not reachable from the server - make it public or add a deploy key",
      ];
      vps.deploy.code = 1;

      const job = startDeploy(added, {
        repoUrl: "https://example.com/private.git",
        branch: "integration",
        dir: "/root/x",
        script: await readFile(bootstrapPath(), "utf-8"),
      });
      await waitFor(() => job.state !== "running");

      expect(job.state).toBe("failed");
      expect(job.exit_code).toBe(1);
      expect(job.error).toContain("clone");
      expect(job.error).toContain("make it public or add a deploy key");
      expect(job.steps.at(-1)?.state).toBe("fail");
    },
    40_000,
  );

  test(
    "the self-contained run's full step list streams through in order",
    async () => {
      // The shape a STAMPED PROJECT deploy prints: no `installer` step (that
      // repo has no installer/), and the provisioning the script does itself
      // instead. This is the contract machines.ts has to keep parsing.
      const vps = await box({ password: "pw8" });
      const added = await addOrFail({ host: "127.0.0.1", port: vps.port, user: "root", password: "pw8" });
      vps.deploy.lines = [
        "STEP preflight OK user=root sudo=no target=/root/hardware",
        "STEP apt OK installed git curl (waited 45s for the boot-time apt lock)",
        "STEP sqlite OK sqlite3 stdlib module present; CLI absent (optional, never installed)",
        "STEP uv OK installed uv 0.9.2",
        "STEP node OK installed node v22.11.0 npm 10.9.0",
        "STEP just OK installed just 1.58.0",
        "STEP clone OK cloned https://github.com/x/hardware.git into /root/hardware",
        "STEP checkout OK integration at 848a485",
        "STEP stamp OK adws/engine.py and adws/adw_modules present - this checkout can run the engine",
        "STEP uv-sync OK no pyproject.toml in /root/hardware - each adws/*.py carries its own PEP 723 dependencies",
        "STEP pi OK installed - PI_PATH='node /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'",
        "npm WARN deprecated something@1.0.0",
        "STEP pi-packages OK merged both names into settings.json; both installed under /root/.pi/agent/npm/node_modules",
        "STEP claude-cli OK installed 2.0.1 (Claude Code)",
        "STEP codex-cli OK installed codex-cli 0.44.0",
        "STEP git-identity OK set repo-local identity sdl-factory engine <engine@sdl-factory.local>",
        "STEP skills OK removed morning-brief grilling from /root/.claude/skills (sssf kept)",
        "STEP engine-service OK /etc/systemd/system/sdl-engine.service written (User=root, WorkingDirectory=/root/hardware)",
        "STEP engine OK sdl-engine is active since Sun 2026-08-17 20:00:00 UTC",
        "DEPLOY COMPLETE",
      ];
      vps.deploy.code = 0;

      const job = startDeploy(added, {
        repoUrl: "https://github.com/x/hardware.git",
        branch: "integration",
        dir: "/root/hardware",
        script: await readFile(bootstrapPath(), "utf-8"),
      });
      await waitFor(() => job.state !== "running");

      expect(job.state).toBe("done");
      expect(job.error).toBeNull();
      expect(job.steps.map((step) => step.name)).toEqual([
        "preflight", "apt", "sqlite", "uv", "node", "just", "clone", "checkout", "stamp",
        "uv-sync", "pi", "pi-packages", "claude-cli", "codex-cli", "git-identity", "skills",
        "engine-service", "engine",
      ]);
      expect(job.steps.every((step) => step.state === "ok")).toBe(true);
      // A detail with quotes, angle brackets and parentheses survives whole -
      // the parser takes everything after OK, and stops at nothing.
      expect(job.steps.find((step) => step.name === "git-identity")?.detail).toContain(
        "<engine@sdl-factory.local>",
      );
      expect(job.steps.find((step) => step.name === "apt")?.detail).toContain("waited 45s");
      expect(job.lines).toContain("npm WARN deprecated something@1.0.0");

      // The argv contract is unchanged by the rewrite: three quoted arguments,
      // url then branch then directory, and nothing else.
      const shCommand = vps.commands.find((command) => command.startsWith("sh "))!;
      const quoted = [...shCommand.matchAll(/'([^']*)'/g)].map((match) => match[1]);
      expect(quoted).toEqual([
        ".sdl-factory-bootstrap.sh",
        "https://github.com/x/hardware.git",
        "integration",
        "/root/hardware",
      ]);
    },
    40_000,
  );

  test(
    "an exit 0 without DEPLOY COMPLETE is still a failure - a truncated run is not a success",
    async () => {
      const vps = await box({ password: "pw7" });
      const added = await addOrFail({ host: "127.0.0.1", port: vps.port, user: "root", password: "pw7" });
      vps.deploy.lines = ["STEP preflight OK user=root"];
      vps.deploy.code = 0;

      const job = startDeploy(added, {
        repoUrl: "https://example.com/x.git",
        branch: "integration",
        dir: "/root/x",
        script: "#!/bin/sh\n",
      });
      await waitFor(() => job.state !== "running");
      expect(job.state).toBe("failed");
      expect(job.error).toContain("DEPLOY COMPLETE");
    },
    40_000,
  );
});

/* ── the per-project binding ("Runs on") ───────────────────────────────────
   `machine_id` is an ADDITIVE field on the manifest's own project entries, and
   `machines.ts` writes it through `manifest.ts`'s read/write rather than
   editing that file. That only works because those two pass project entries
   through verbatim - the claim this block exists to prove, since a silent drop
   would lose the binding on the next manifest write by anyone. */

describe("binding a project to a machine", () => {
  const manifestPath = join(home, "config.json");

  async function seedManifest(): Promise<void> {
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          version: 1,
          active: "p-one",
          projects: [
            { id: "p-one", name: "one", root: "C:/repos/one", added_at: "2026-01-01T00:00:00.000Z", last_opened_at: null },
            { id: "p-two", name: "two", root: "C:/repos/two", added_at: "2026-01-02T00:00:00.000Z", last_opened_at: null },
          ],
          ui: { theme: "ember" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }

  test("writes machine_id, reads it back, and keeps every other field", async () => {
    await seedManifest();
    expect(await readBindings()).toEqual({});

    expect(await bindProject("p-one", "m-abc123")).toBeNull();
    expect(await readBindings()).toEqual({ "p-one": "m-abc123" });

    const written = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      active: string;
      ui: Record<string, unknown>;
      projects: { id: string; name: string; root: string; machine_id?: string | null }[];
    };
    // Nothing the binding does not own may move.
    expect(written.active).toBe("p-one");
    expect(written.ui).toEqual({ theme: "ember" });
    expect(written.projects).toHaveLength(2);
    expect(written.projects[0]!.name).toBe("one");
    expect(written.projects[0]!.root).toBe("C:/repos/one");
    expect(written.projects[0]!.machine_id).toBe("m-abc123");
    // An unbound project gains no key at all.
    expect(written.projects[1]!.machine_id).toBeUndefined();
  });

  test("unbinding clears it, and an unknown project is an honest error", async () => {
    await seedManifest();
    await bindProject("p-two", "m-xyz");
    expect(await readBindings()).toEqual({ "p-two": "m-xyz" });

    expect(await bindProject("p-two", null)).toBeNull();
    expect(await readBindings()).toEqual({});

    expect(await bindProject("p-nope", "m-xyz")).toContain("p-nope");
  });

  test("removing a machine clears the projects that pointed at it", async () => {
    await seedManifest();
    const vps = await box({ password: "pw8" });
    const added = await addOrFail({ host: "127.0.0.1", port: vps.port, user: "root", password: "pw8" });
    const id = added.id;
    await bindProject("p-one", id);
    expect(await readBindings()).toEqual({ "p-one": id });

    // What `DELETE /api/app/machines/:id` does after dropping the row: no
    // project may be left claiming to run on a machine that is gone.
    const registry = await readRegistry();
    await writeRegistry({ ...registry, machines: registry.machines.filter((machine) => machine.id !== id) });
    for (const [projectId, machineIdValue] of Object.entries(await readBindings())) {
      if (machineIdValue === id) await bindProject(projectId, null);
    }
    expect(await readBindings()).toEqual({});
  }, 20_000);
});

/* ── the bootstrap script itself ───────────────────────────────────────────*/

describe("deploy/bootstrap.sh", () => {
  test("ships with LF endings and a POSIX shebang", async () => {
    const script = await readFile(bootstrapPath(), "utf-8");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).not.toContain("\r");
  });

  test("every step it can reach prints a STEP line", async () => {
    const script = await readFile(bootstrapPath(), "utf-8");
    for (const name of [
      "preflight", "apt", "sqlite", "uv", "node", "just", "clone", "checkout", "stamp",
      "uv-sync", "installer", "pi", "pi-packages", "claude-cli", "codex-cli", "git-identity",
      "skills", "engine-service", "engine",
    ]) {
      expect(script).toContain(` ${name} `);
    }
    expect(script).toContain("DEPLOY COMPLETE");
    // The honest clone failure the operator asked for, verbatim.
    expect(script).toContain("repository not reachable from the server - make it public or add a deploy key");
    // The stamped-project precondition: an older stamp is named as such, with
    // the fix (which is on the laptop, not on the box).
    expect(script).toContain(
      "this project was stamped by an older sssf skill - re-run Initialize factory on the laptop, push, and redeploy",
    );
  });

  test("nothing in it can stop and wait for a human", async () => {
    const script = await readFile(bootstrapPath(), "utf-8");
    const code = script.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    const joined = code.join("\n");

    // The backstop: no child of this script has a terminal to read from.
    expect(joined).toContain("exec </dev/null");

    // apt/dpkg: the field failure was a lock held by the boot-time apt timer.
    expect(joined).toContain("DEBIAN_FRONTEND=noninteractive");
    expect(joined).toContain("NEEDRESTART_MODE=a");
    expect(joined).toContain("DPkg::Lock::Timeout=600");
    expect(joined).toContain("--force-confdef");
    expect(joined).toContain("--force-confold");
    // and every apt-get the script itself runs carries them. A STEP message
    // that merely names apt-get is not an invocation, so those are excluded by
    // their `ok`/`fail` prefix - and the second filter proves the exclusion is
    // not hiding a real call: nothing runs apt-get except through `asroot`.
    const isMessage = (line: string) => /(^\s*|\|\|\s*|&&\s*|;\s*)(ok|fail)\s/.test(line);
    const aptCalls = code.filter((line) => line.includes("asroot apt-get "));
    expect(aptCalls.length).toBeGreaterThan(0);
    for (const call of aptCalls) expect(call).toContain("$APT_OPTS");
    const strayApt = code.filter(
      (line) =>
        line.includes("apt-get") &&
        !line.includes("asroot apt-get") &&
        !line.includes("have apt-get") &&
        !line.includes("grep -qxE") && // apt_busy's process-name pattern, not a call
        !isMessage(line),
    );
    expect(strayApt).toEqual([]);

    // git: a private repo fails, it never asks.
    expect(joined).toContain("GIT_TERMINAL_PROMPT=0");
    expect(joined).toContain("GIT_ASKPASS=/bin/true");
    expect(joined).toContain("BatchMode=yes");

    // npm: no confirmation, no funding/audit chatter to page through. Same
    // rule as apt above - a failure message that quotes the command is not the
    // command, and every real install goes through `asroot`.
    const npmInstalls = code.filter((line) => line.includes("asroot npm install"));
    expect(npmInstalls.length).toBeGreaterThan(0);
    for (const call of npmInstalls) {
      expect(call).toContain("--no-fund");
      expect(call).toContain("--no-audit");
    }
    const strayNpm = code.filter(
      (line) => line.includes("npm install") && !line.includes("asroot npm install") && !isMessage(line),
    );
    expect(strayNpm).toEqual([]);
    expect(joined).toContain("npm_config_yes=true");

    // curl: silent, fail-on-error forms only. (`git curl ca-certificates` in
    // the apt package list is a name, not a call - hence the `curl -` anchor.)
    const curlCalls = code.filter((line) => /curl\s+-/.test(line));
    expect(curlCalls.length).toBeGreaterThan(0);
    for (const call of curlCalls) expect(call).toMatch(/curl\s+(-LsSf|-fsSL|--proto)/);

    // sudo is only ever the non-interactive form: a password prompt on a box
    // with no tty is the hang this whole rewrite exists to prevent.
    const sudoCalls = code.filter((line) => line.includes("sudo ") && !isMessage(line));
    expect(sudoCalls.length).toBeGreaterThan(0);
    for (const call of sudoCalls) expect(call).toMatch(/sudo\s+-n\s/);

    // ssh is never INVOKED here - the only mention is the batch-mode transport
    // git would use if the operator's origin were an ssh url.
    for (const line of code.filter((line) => /(^|[;&|(]\s*)ssh\s/.test(line))) {
      expect(line).toContain("GIT_SSH_COMMAND=");
    }

    // pagers: `systemctl status` pages by default, and a pager with nowhere to
    // page to is a hang.
    for (const call of code.filter((line) => line.includes("systemctl status"))) {
      expect(call).toContain("--no-pager");
    }
    expect(joined).toContain("SYSTEMD_PAGER=cat");
  });

  // A STEP line is the entire contract with machines.ts, and its details are
  // interpolated command output - `npm --version` prepends a config warning on
  // some boxes, a python heredoc a DeprecationWarning on others. A newline in
  // there splits the step in two: parseStepLine keeps the truncated first half
  // and the remainder becomes orphan log noise. So this runs the script's OWN
  // `ok`/`fail` (lifted out of the file, never retyped here - a copy would pass
  // while the script regressed) against output that really does span lines.
  test("a STEP line stays one line even when the tool it quotes prints several", async () => {
    const shell = posixShell();
    if (!shell) {
      console.warn("[machines.test] no POSIX shell on PATH - STEP single-line check skipped");
      return;
    }
    const script = await readFile(bootstrapPath(), "utf-8");
    const start = script.indexOf("flatten() {");
    const end = script.indexOf("tail_of()");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const protocol = script.slice(start, end);

    const harness = [
      protocol,
      // `fail` exits 1 by design, so it is asked its question in a subshell.
      `ok node "node v20.11.1 npm $(printf 'npm WARN config production Use \\\`--omit=dev\\\` instead.\\n10.8.2\\n')"`,
      `( fail clone "unreachable $(printf 'line one\\nline two\\nline three\\n')" ) || true`,
    ].join("\n");

    const proc = Bun.spawn([shell, "-c", harness], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const guard = setTimeout(() => proc.kill(), 10_000);
    try {
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const lines = stdout.split("\n").filter((line) => line.length > 0);
      // Two calls in, two lines out. Three would mean a detail broke a step apart.
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(parseStepLine(line)).not.toBeNull();
      expect(parseStepLine(lines[0]!)).toMatchObject({ name: "node", state: "ok" });
      expect(parseStepLine(lines[1]!)).toMatchObject({ name: "clone", state: "fail" });
      // Flattened, not truncated: the whole of the tool's output survives on
      // the one line. Losing the reason would trade a broken parse for a
      // silent one - the version that came after the warning is the answer.
      expect(parseStepLine(lines[0]!)!.detail).toContain("10.8.2");
      expect(parseStepLine(lines[1]!)!.detail).toContain("line three");
    } finally {
      clearTimeout(guard);
    }
  }, 20_000);

  /* ── drift guards against installer/steps.py ────────────────────────────
     The inline provisioning path exists because a stamped project repo has no
     installer/. It is only correct while it installs the SAME things the
     installer does, so these read steps.py and fail when the two disagree -
     the mirror drift that made this rewrite necessary in the first place. */

  const stepsPath = join(import.meta.dir, "..", "..", "..", "..", "installer", "steps.py");

  test("it installs the packages installer/steps.py names, never a guess", async () => {
    if (!existsSync(stepsPath)) {
      console.warn("[machines.test] no installer/steps.py in this checkout - drift guard skipped");
      return;
    }
    const steps = await readFile(stepsPath, "utf-8");
    const script = await readFile(bootstrapPath(), "utf-8");

    // pi's own npm package and the cli.js under it.
    const piPackage = /"npm", "install", "-g", "--ignore-scripts",\s*"([^"]+)"/.exec(steps)?.[1];
    expect(piPackage).toBe("@earendil-works/pi-coding-agent");
    expect(script).toContain(`${piPackage}`);
    expect(script).toContain("@earendil-works/pi-coding-agent/dist/cli.js");
    expect(script).toContain(".pi/agent/npm/node_modules");

    // the two pi extensions, taken from steps.py's PI_PACKAGES tuple.
    const tuple = /PI_PACKAGES = \(([^)]*)\)/.exec(steps)?.[1] ?? "";
    const piPackages = [...tuple.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    expect(piPackages).toEqual(["npm:pi-claude-bridge", "npm:@tintinweb/pi-subagents"]);
    for (const name of piPackages) expect(script).toContain(name);

    // the two CLIs the bridge and codex lanes shell out to.
    const globalInstalls = [...steps.matchAll(/"npm", "install", "-g", "(@[^"]+)"/g)].map((m) => m[1]!);
    expect(globalInstalls).toContain("@anthropic-ai/claude-code");
    expect(globalInstalls).toContain("@openai/codex");
    for (const name of globalInstalls) expect(script).toContain(name);

    // the committer identity the engine refuses to run without.
    const gitName = /ENGINE_GIT_NAME = "([^"]+)"/.exec(steps)?.[1];
    const gitEmail = /ENGINE_GIT_EMAIL = "([^"]+)"/.exec(steps)?.[1];
    expect(script).toContain(`ENGINE_GIT_NAME="${gitName}"`);
    expect(script).toContain(`ENGINE_GIT_EMAIL="${gitEmail}"`);
    expect(script).toContain("git var GIT_COMMITTER_IDENT");
    expect(script).toContain("config --local");

    // the three .env values, and the roster default.
    for (const key of ["PI_PATH", "PI_MODELS_PATH", "PI_BRIDGE_PATH"]) expect(script).toContain(key);
    const defaultConfig = /DEFAULT_ENGINE_CONFIG = "([^"]+)"/.exec(steps)?.[1];
    expect(script).toContain(defaultConfig!);
  });

  test("the systemd unit it writes is the one installer/steps.py renders", async () => {
    if (!existsSync(stepsPath)) {
      console.warn("[machines.test] no installer/steps.py in this checkout - unit drift guard skipped");
      return;
    }
    const steps = await readFile(stepsPath, "utf-8");
    const script = await readFile(bootstrapPath(), "utf-8");
    const unit = /cat >"\$UNIT_TMP" <<UNIT\n([\s\S]*?)\nUNIT\n/.exec(script)?.[1];
    expect(unit).toBeTruthy();

    // Fixed lines: identical text on both sides.
    for (const line of [
      "[Unit]",
      "Description=SDL factory engine - runs the Kanban",
      "After=network-online.target",
      "Wants=network-online.target",
      "[Service]",
      "Type=simple",
      "Restart=always",
      "RestartSec=10",
      "[Install]",
      "WantedBy=multi-user.target",
    ]) {
      expect(unit).toContain(line);
      expect(steps).toContain(line);
    }

    // Templated lines: the same four keys, filled from this host.
    expect(unit).toContain("User=$SERVICE_USER");
    expect(unit).toContain("WorkingDirectory=$DIR");
    expect(unit).toContain("Environment=SSSF_CONFIG=$ENGINE_CONFIG");
    expect(unit).toContain("ExecStart=$UV_BIN run adws/engine.py");
    for (const key of ["User=", "WorkingDirectory=", "Environment=SSSF_CONFIG=", "run adws/engine.py"]) {
      expect(steps).toContain(key);
    }

    // `User=` is the checkout's owner, not whoever ran the deploy - without it
    // systemd starts the engine as root and every git call dies on "dubious
    // ownership" while is-active still says active.
    expect(script).toContain('stat -c %U "$DIR"');
    // ExecStart resolves uv absolutely: a unit gets no login shell.
    expect(script).toContain("UV_BIN=$(command -v uv");
    expect(script).toContain("systemctl daemon-reload");
    expect(script).toContain("systemctl enable --now sdl-engine");
  });

  test("the installer stays the preferred path where a repo has one", async () => {
    const script = await readFile(bootstrapPath(), "utf-8");
    expect(script).toContain('if [ -f "$DIR/installer/install.py" ]; then');
    expect(script).toContain("uv run installer/install.py --target server --yes");
    // Its three-way exit code still means what it meant: 2 is deployed-but-a-
    // credential-is-missing, not a failure.
    expect(script).toContain("converged, but something needs you");
    // And its absence is no longer fatal - that was the bug that made every
    // stamped-project deploy stop dead at this step.
    expect(script).not.toContain("this checkout is not an SDL Factory repository");
  });

  test("uses no bashisms a Ubuntu /bin/sh (dash) would reject", async () => {
    // Comments are stripped first: the script's own header *documents* the ban
    // ("no bashisms: no [[ ]], no arrays"), and a scan that flagged that
    // sentence would be a test of the prose, not of the code dash executes.
    const code = (await readFile(bootstrapPath(), "utf-8"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toContain("[[");
    expect(code).not.toMatch(/^\s*local\s/m);
    expect(code).not.toContain("function ");
    // `echo -e`, `source` and `$'...'` are the other three dash rejects.
    expect(code).not.toMatch(/\becho\s+-/);
    expect(code).not.toMatch(/^\s*source\s/m);
    expect(code).not.toContain("$'");
  });

  // On Windows, `C:\Windows\System32\bash.exe` is the WSL *launcher*, not a
  // POSIX shell: with no distro installed it blocks forever (or opens a Store
  // prompt) instead of parsing the script, which hung this test until the
  // runner killed it (exit 143). Never treat it as a shell. Git for Windows
  // ships a real one next to `git.exe`, so derive it when PATH has no `sh`.
  function posixShell(): string | null {
    const isWslLauncher = (p: string) => /[\\/]system32[\\/]bash\.exe$/i.test(p);
    for (const name of ["sh", "dash", "bash"]) {
      const found = Bun.which(name);
      if (found && !isWslLauncher(found)) return found;
    }
    const git = Bun.which("git");
    if (git) {
      // …\Git\cmd\git.exe -> …\Git\{usr\bin,bin}\sh.exe
      const gitRoot = dirname(dirname(git));
      for (const rel of [join("usr", "bin", "sh.exe"), join("bin", "sh.exe")]) {
        const candidate = join(gitRoot, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  test("passes `sh -n` where a POSIX shell exists", async () => {
    const shell = posixShell();
    if (!shell) {
      console.warn("[machines.test] no POSIX shell on PATH - bootstrap.sh syntax check skipped");
      return;
    }
    const proc = Bun.spawn([shell, "-n", bootstrapPath()], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    // A syntax check is instant; anything slower is a wedged interpreter, and a
    // named failure beats the whole gate timing out.
    const guard = setTimeout(() => proc.kill(), 10_000);
    try {
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(`${code} ${stderr}`.trim()).toBe("0");
    } finally {
      clearTimeout(guard);
    }
  }, 20_000);
});

/* ── the manual proof path ─────────────────────────────────────────────────
 * No CI can prove a real VPS deploy; this is what does, on the operator's own
 * cleared Contabo box:
 *
 *   1. `just app3`, Settings -> Machines -> Add server: the box's IP, user
 *      `root`, the password from the Contabo mail. Click Connect.
 *      EXPECT: the modal's step list reads connected -> generated -> installed
 *      -> reconnected with the key -> saved, and the row appears `reachable`
 *      with the box's `uname -sr`. `~/.sdl-factory/machines.json` holds no
 *      password; `~/.sdl-factory/keys/m-*` is the key it generated.
 *   2. `ssh -i ~/.sdl-factory/keys/m-<id> root@<ip> 'echo ok'` from a terminal
 *      -> `ok`. That is the same key the app installed.
 *   3. Deploy factory on that row. EXPECT the STEP lines to stream in order.
 *      For a STAMPED PROJECT repo (the normal case - it has no installer/):
 *      preflight, apt, sqlite, uv, node, just, clone, checkout, stamp,
 *      uv-sync, service-user, pi, pi-packages, claude-cli, codex-cli,
 *      providers, git-identity, skills, engine-service, engine, then DEPLOY
 *      COMPLETE. `providers` is the honest one: on a box with no provider
 *      registered in ~/.pi/agent/models.json it reads `OK NEEDS YOU: ...`,
 *      because this path cannot converge what steps.py copies out of
 *      installer/assets/.
 *      For the sdl-factory repo itself, `installer` replaces the six
 *      provisioning steps between uv-sync and skills. On the box:
 *      `systemctl is-active sdl-engine` -> `active`,
 *      `systemctl cat sdl-engine` -> User= the checkout's owner and
 *      Environment=SSSF_CONFIG=adws/adw_sssf_config/sssf.config.yaml, the same
 *      answer installer/steps.py's DEFAULT_ENGINE_CONFIG gives. Shipping on a
 *      different roster is one deliberate `SSSF_CONFIG=<path>` on the deploy,
 *      honoured by both writers - never a file the checkout merely carries.
 *   4. Click Deploy factory again on the same box. EXPECT the same list, every
 *      step reading `already ...`, and DEPLOY COMPLETE - that is idempotency.
 *   5. The humanless proof, on a box that has JUST booted (the field failure):
 *      deploy within a minute of first boot, while `apt-daily` still holds
 *      /var/lib/dpkg/lock-frontend. EXPECT `STEP apt OK ... (waited Ns for the
 *      boot-time apt lock)` and a run that never stops - not
 *      `E: Could not get lock`.
 */
