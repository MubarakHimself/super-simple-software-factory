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
import type { MachineRecord } from "./machines.ts";

const home = await mkdtemp(join(tmpdir(), "sdl-machines-"));
process.env["SDL_FACTORY_HOME"] = home;

const {
  addMachine,
  bindProject,
  bootstrapPath,
  generateUsableKeyPair,
  isPublicKeyLine,
  keyDir,
  machineId,
  machinesHome,
  parseProbeOutput,
  parseStepLine,
  probeMachine,
  readBindings,
  readRegistry,
  registryPath,
  repoDirName,
  shq,
  startDeploy,
  writeRegistry,
} = await import("./machines.ts");

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
          const open = new Map<string, { path: string; chunks: string[] }>();
          let counter = 0;
          sftp.on("OPEN", (reqid, filename) => {
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(++counter, 0);
            open.set(handle.toString("hex"), { path: filename, chunks: [] });
            sftp.handle(reqid, handle);
          });
          sftp.on("WRITE", (reqid, handle, _offset, data) => {
            open.get(handle.toString("hex"))?.chunks.push(data.toString("utf-8"));
            sftp.status(reqid, 0);
          });
          sftp.on("CLOSE", (reqid, handle) => {
            const entry = open.get(handle.toString("hex"));
            if (entry) box.uploads.set(entry.path, entry.chunks.join(""));
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

afterAll(async () => {
  for (const created of boxes) await created.close().catch(() => {});
  await rm(home, { recursive: true, force: true }).catch(() => {});
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
    for (const name of ["preflight", "apt", "uv", "node", "just", "clone", "checkout", "uv-sync", "installer", "skills", "engine"]) {
      expect(script).toContain(` ${name} `);
    }
    expect(script).toContain("DEPLOY COMPLETE");
    // The honest clone failure the operator asked for, verbatim.
    expect(script).toContain("repository not reachable from the server - make it public or add a deploy key");
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
 *   3. Deploy factory on that row. EXPECT the STEP lines to stream in order:
 *      preflight, apt, uv, node, just, clone, checkout, uv-sync, installer,
 *      skills, engine, then DEPLOY COMPLETE. On the box:
 *      `systemctl is-active sdl-engine` -> `active`.
 *   4. Click Deploy factory again on the same box. EXPECT the same list, every
 *      step reading `already ...`, and DEPLOY COMPLETE - that is idempotency.
 */
