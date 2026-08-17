/**
 * Tests for "Sign in on <machine>" (`app/auth-sessions.ts`), run with
 * `bun test server/app/auth-sessions.test.ts` from `apps/ui`.
 *
 * ── What is real here ───────────────────────────────────────────────────────
 * The SSH is REAL, on the pattern `machines.test.ts` proved and
 * `providers-v3.test.ts` reused: a genuine `ssh2.Server` on loopback, real
 * publickey auth, a real `exec` channel with a real pty request, real stdin
 * from this app to the far end, and — for the codex flow — a real
 * direct-tcpip channel with real bytes travelling through the port forward in
 * both directions. Nothing about the client path is stubbed.
 *
 * ── What is a stand-in ──────────────────────────────────────────────────────
 * The far end's `claude login` / `codex login` are TRANSCRIPTS: the fake box
 * prints the lines a real CLI prints, waits for the pasted code where a real
 * one waits, and only then puts the credential file "on disk" (a set the
 * probes read). That is the point — the re-probe has to see a change it did
 * not make up. No CI can run a real browser OAuth, and the manual proof for
 * that is written at the bottom of this file.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 * `SDL_FACTORY_HOME` is redirected before the module loads, so the machine
 * registry and the generated keys live in a temp directory and the operator's
 * own `~/.sdl-factory` is never touched. Nothing here reads `~/.claude`,
 * `~/.codex` or `~/.pi` on this laptop at all: every probe in this feature runs
 * on the far end.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, utils, type Connection } from "ssh2";
// Type-only, so both are erased: the runtime imports below must not happen
// until SDL_FACTORY_HOME is redirected.
import type { AuthFlow } from "./auth-sessions.ts";
import type { MachineRecord } from "./machines.ts";

const appHomeDir = await mkdtemp(join(tmpdir(), "sdl-auth-"));
process.env["SDL_FACTORY_HOME"] = appHomeDir;
process.env["SDL_FACTORY_LOCAL_HOME"] = appHomeDir;

const { readRegistry, writeRegistry } = await import("./machines.ts");
const {
  AUTH_FLOWS,
  REMOTE_PATH_PREFIX,
  authSessionRoutes,
  authView,
  cancelAuthSession,
  extractCode,
  extractUrl,
  flowById,
  getAuthSession,
  parseProbeAnswer,
  probeSignedIn,
  remoteCommand,
  scrubSecrets,
  sendAuthInput,
  startAuthSession,
  stripAnsi,
} = await import("./auth-sessions.ts");

/** A login literal, as it arrives at the far end: the fixed PATH prefix, then
 * the command. `client.exec` is a non-login shell that sources no .profile, so
 * a CLI in a per-user directory (the xAI one lives in ~/.grok/bin) is not found
 * without it. */
function ranLogin(box: FakeBox, command: string): boolean {
  return box.commands.includes(remoteCommand(command));
}

/* ── the fake VPS ──────────────────────────────────────────────────────────
   A real SSH server whose `claude login` / `codex login` are scripted, and
   whose "credential files" are a set the probe scripts are answered from. */

interface LoginScript {
  /** lines printed before the command waits (or exits) */
  lines: string[];
  /** when set, the command prints this and waits for a line on stdin */
  prompt: string | null;
  /** lines printed after the paste (or after `lines`, when there is no prompt) */
  after: string[];
  exitCode: number;
  /** which credential the login puts on the box when it finishes */
  signsIn: string | null;
}

interface FakeBox {
  server: Server;
  port: number;
  /** what the box "has": "claude" | "codex" | "pi-codex" | "grok" */
  signedIn: Set<string>;
  /** whether `pi` is on this box's PATH at all - the two halves of every
   * pi-lane probe are "ask pi" and "read the JSON yourself", and a box that
   * has never had pi installed must still get a truthful answer. */
  hasPi: boolean;
  /** the lanes `pi auth check` reports ready on this box */
  piLanes: Set<string>;
  /** the box's filesystem, as far as SFTP and `cat` are concerned */
  files: Map<string, string>;
  fileModes: Map<string, number>;
  commands: string[];
  /** whether a pty was requested for the login channel */
  ptyRequested: boolean;
  /** every line this app wrote to the login's stdin */
  stdin: string[];
  login: LoginScript;
  /** direct-tcpip channels the forward opened: [destIP, destPort] */
  forwards: { host: string; port: number }[];
  /** bytes that arrived through the forward */
  forwardBytes: string[];
  close: () => Promise<void>;
}

/**
 * The pi-lane probes, answered the way a real box would answer them.
 *
 * A real box runs the whole `case` in a shell; this stand-in reads the ONE
 * thing that decides the branch — is `pi` on PATH — and produces the sentence
 * that branch produces. What is being tested through it is the app's side: the
 * flow wiring, the SIGNEDIN/NO protocol, and that a machine with no pi still
 * gets a truthful answer instead of a shrug.
 */
function piLaneAnswerFor(command: string, box: FakeBox): string | null {
  const asked = /pi auth check --provider ([a-z-]+) /.exec(command);
  if (!asked) return null;
  const lane = asked[1]!;
  if (box.hasPi) {
    return box.piLanes.has(lane)
      ? `SIGNEDIN pi auth check says the ${lane} lane is configured on this machine - pi refreshes the token itself on first use\n`
      : `NO pi auth check says the ${lane} lane is not ready on this machine (credentials_not_configured)\n`;
  }
  // No pi: the fallback read of the JSON on disk, which is what the `*)` branch
  // of the real probe runs.
  if (lane === "ollama-cloud") {
    return box.files.has("/root/.pi/agent/models.json")
      ? "SIGNEDIN an ollama-cloud provider block is in /root/.pi/agent/models.json (read directly - pi is not on PATH to resolve its key script)\n"
      : "NO no pi on this machine's PATH, and no /root/.pi/agent/models.json to read either\n";
  }
  return box.piLanes.has(lane)
    ? `SIGNEDIN ${lane} has an entry in /root/.pi/agent/auth.json (read directly - pi is not on this machine's PATH to ask)\n`
    : `NO /root/.pi/agent/auth.json is on the machine but has no ${lane} entry, and pi is not on PATH to ask\n`;
}

function probeAnswerFor(command: string, box: FakeBox): string | null {
  // Asked FIRST: every pi lane's probe now leads with `pi auth check`, and the
  // openai-codex one still carries the original JSON read as its fallback - so
  // matching on the fallback's text first would answer the wrong half.
  const lane = piLaneAnswerFor(command, box);
  if (lane !== null) return lane;
  if (command.includes(".grok/auth.json")) {
    return box.signedIn.has("grok")
      ? "SIGNEDIN the grok CLI has an auth.x.ai entry in /root/.grok/auth.json\n"
      : "NO the machine has no /root/.grok/auth.json - the grok CLI has never signed in there\n";
  }
  if (command.includes('"openai-codex"')) {
    return box.signedIn.has("pi-codex")
      ? "SIGNEDIN openai-codex has an entry in /root/.pi/agent/auth.json\n"
      : "NO /root/.pi/agent/auth.json exists but has no openai-codex entry\n";
  }
  if (command.includes(".claude/.credentials.json")) {
    if (box.signedIn.has("claude")) return "SIGNEDIN /root/.claude/.credentials.json is on the machine\n";
    // The other half of the real probe, and the half this feature's claude flow
    // actually produces: the token written into the machine's own secrets.env.
    const secrets = box.files.get("/root/.sdl-factory/secrets.env") ?? "";
    if (/^CLAUDE_CODE_OAUTH_TOKEN=./m.test(secrets)) {
      return "SIGNEDIN CLAUDE_CODE_OAUTH_TOKEN is set in /root/.sdl-factory/secrets.env\n";
    }
    return "NO no /root/.claude/.credentials.json, and no CLAUDE_CODE_OAUTH_TOKEN in /root/.sdl-factory/secrets.env\n";
  }
  if (command.includes(".codex/auth.json")) {
    return box.signedIn.has("codex")
      ? "SIGNEDIN /root/.codex/auth.json is on the machine\n"
      : "NO no /root/.codex/auth.json on the machine\n";
  }
  return null;
}

async function startFakeBox(publicKey: string): Promise<FakeBox> {
  const hostKey = utils.generateKeyPairSync("ed25519", {}).private;
  const box: FakeBox = {
    server: null as unknown as Server,
    port: 0,
    signedIn: new Set<string>(),
    hasPi: true,
    piLanes: new Set<string>(),
    files: new Map<string, string>(),
    fileModes: new Map<string, number>(),
    commands: [],
    ptyRequested: false,
    stdin: [],
    login: { lines: [], prompt: null, after: [], exitCode: 0, signsIn: null },
    forwards: [],
    forwardBytes: [],
    close: async () => {},
  };

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "publickey") {
        const presented = ctx.key.data.toString("base64");
        return publicKey.split(" ")[1] === presented ? ctx.accept() : ctx.reject(["publickey"]);
      }
      return ctx.reject(["publickey"]);
    });

    client.on("ready", () => {
      // The port forward: every browser connection to the laptop's loopback
      // port arrives here as a direct-tcpip channel. The echo proves bytes
      // really traverse it, in both directions.
      client.on("tcpip", (accept, _reject, info) => {
        box.forwards.push({ host: info.destIP, port: info.destPort });
        const channel = accept();
        channel.on("data", (data: Buffer) => {
          box.forwardBytes.push(data.toString("utf-8"));
          channel.write(`callback-ok:${data.toString("utf-8")}`);
        });
        channel.on("error", () => {});
      });

      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => {
          box.ptyRequested = true;
          if (typeof acceptPty === "function") acceptPty();
        });
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const command = info.command;
          box.commands.push(command);

          const probe = probeAnswerFor(command, box);
          if (probe !== null) {
            stream.write(probe);
            stream.exit(0);
            return stream.end();
          }

          // The small shell `writeCaptured` uses to place the token.
          if (command.includes('printf \'%s\\n\' "$HOME"')) {
            stream.write("/root\n");
            stream.exit(0);
            return stream.end();
          }
          if (command.startsWith("mkdir -p ")) {
            stream.exit(0);
            return stream.end();
          }
          if (command.startsWith("if [ -f ")) {
            const quoted = [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((match) => match[1]!.replace(/'\\''/g, "'"));
            stream.write(box.files.get(quoted[0]!) ?? "");
            stream.exit(0);
            return stream.end();
          }

          // The app prefixes every login with a fixed PATH so a per-user CLI is
          // found by a non-login exec; a real box's shell strips that off by
          // running it, and this one strips it by matching on the tail.
          if (
            command.endsWith("claude setup-token") ||
            command.endsWith("codex login") ||
            command.endsWith("grok login --device-auth")
          ) {
            for (const line of box.login.lines) stream.write(`${line}\r\n`);
            const finish = () => {
              for (const line of box.login.after) stream.write(`${line}\r\n`);
              if (box.login.signsIn) box.signedIn.add(box.login.signsIn);
              stream.exit(box.login.exitCode);
              stream.end();
            };
            if (box.login.prompt !== null) {
              stream.write(box.login.prompt);
              stream.on("data", (data: Buffer) => {
                box.stdin.push(data.toString("utf-8"));
                finish();
              });
              return;
            }
            return finish();
          }

          stream.stderr.write(`sh: not emulated: ${command}\n`);
          stream.exit(127);
          return stream.end();
        });

        // SFTP, because the harvested token crosses inside a file body and
        // never on a command line - the same rule `providers-v3.ts` keeps.
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const open = new Map<string, { path: string; chunks: string[] }>();
          let counter = 0;
          sftp.on("OPEN", (reqid, filename, _flags, attrs) => {
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(++counter, 0);
            open.set(handle.toString("hex"), { path: filename, chunks: [] });
            if (attrs && typeof attrs.mode === "number") box.fileModes.set(filename, attrs.mode & 0o777);
            sftp.handle(reqid, handle);
          });
          sftp.on("WRITE", (reqid, handle, _offset, data) => {
            open.get(handle.toString("hex"))?.chunks.push(data.toString("utf-8"));
            sftp.status(reqid, 0);
          });
          sftp.on("CLOSE", (reqid, handle) => {
            const entry = open.get(handle.toString("hex"));
            if (entry) box.files.set(entry.path, entry.chunks.join(""));
            sftp.status(reqid, 0);
          });
          sftp.on("REALPATH", (reqid, path) => sftp.name(reqid, [{ filename: path, longname: path, attrs: {} as never }]));
          sftp.on("FSTAT", (reqid) => sftp.status(reqid, 0));
          sftp.on("STAT", (reqid) => sftp.status(reqid, 2));
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

/** A fake box, plus the machine record that reaches it, registered the way the
 * routes expect to find it. */
async function boxWithMachine(): Promise<{ box: FakeBox; record: MachineRecord }> {
  const pair = utils.generateKeyPairSync("ed25519", { comment: "sdl-factory-app-test" });
  const created = await startFakeBox(pair.public);
  boxes.push(created);
  const keyPath = join(appHomeDir, `key-${created.port}`);
  await writeFile(keyPath, pair.private, { encoding: "utf-8", mode: 0o600 });
  const record: MachineRecord = {
    id: `m-auth-${created.port}`,
    name: "test-box",
    host: "127.0.0.1",
    port: created.port,
    user: "root",
    key_path: keyPath,
    key_generated: true,
    added_at: new Date().toISOString(),
    last_connected_at: null,
    repo_dir: null,
    host_fingerprint: null,
  };
  const registry = await readRegistry();
  await writeRegistry({
    version: 1,
    default_machine: record.id,
    machines: [...registry.machines.filter((machine) => machine.id !== record.id), record],
  });
  return { box: created, record };
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for the sign-in to settle");
}

function claudeFlow(): AuthFlow {
  return flowById("claude")!;
}

function grokFlow(): AuthFlow {
  return flowById("grok")!;
}

/** The codex flow with its callback port moved to a free one: 1455 is the real
 * port and a test must not fight the operator's own tooling for it. */
function codexFlowOn(port: number): AuthFlow {
  return { ...flowById("codex")!, callback_port: port };
}

async function freePort(): Promise<number> {
  const probe = await startFakeBox("ssh-ed25519 AAAA");
  const port = probe.port;
  await probe.close();
  return port;
}

beforeEach(async () => {
  await writeRegistry({ version: 1, default_machine: null, machines: [] });
});

afterAll(async () => {
  for (const created of boxes) await created.close().catch(() => {});
  await rm(appHomeDir, { recursive: true, force: true }).catch(() => {});
});

/* ── the flow table ────────────────────────────────────────────────────────*/

describe("the flow table", () => {
  test("carries the rows the pane draws, with fixed literal commands, Grok first", () => {
    expect(AUTH_FLOWS.map((flow) => flow.id)).toEqual([
      "grok",
      "claude",
      "codex",
      "pi-xai",
      "pi-codex",
      "opencode-go",
      "ollama-cloud",
    ]);
    // Grok leads because the xAI lane is the operator's workhorse and its
    // sign-in is the first one he runs.
    expect(AUTH_FLOWS[0]!.id).toBe("grok");
    // Claude Code has no `login` subcommand: `claude` is the TUI (it never
    // exits) and `setup-token` is the documented non-browser path.
    expect(flowById("claude")!.command).toBe("claude setup-token");
    expect(flowById("codex")!.command).toBe("codex login");
    // `grok login --help`: --device-auth is the flag xAI ships for headless and
    // remote boxes. The sibling --oauth would need a callback port forwarded;
    // this one needs none, which is the whole reason it is the flag chosen.
    expect(flowById("grok")!.command).toBe("grok login --device-auth");
    // No interpolation anywhere: a command that cannot be built from operator
    // input cannot carry operator input onto a remote shell.
    for (const flow of AUTH_FLOWS) {
      if (flow.command) expect(flow.command).toMatch(/^[a-z]+ [a-z-]+(?: --[a-z-]+)*$/);
    }
  });

  test("the grok flow reads ~/.grok/auth.json and captures nothing", () => {
    const flow = flowById("grok")!;
    // The grok CLI writes its own credential - there is nothing printed for
    // this app to harvest, so it harvests nothing.
    expect(flow.capture).toBeNull();
    // Device-code auth has no loopback callback at all.
    expect(flow.callback_port).toBeNull();
    expect(flow.probe_target).toContain(".grok/auth.json");
    // The substring the probe greps for is the one the operator's own real file
    // carries: its single key is `https://auth.x.ai::<oidc-client-id>`.
    expect(flow.probe).toContain("auth");
    expect(flow.probe).toContain(".grok/auth.json");
  });

  test("every pi lane is check-only, and each names the exact line to type", () => {
    // `pi auth --help` lists print-api-key, print-bearer-token and check, and
    // nothing else. There is no `pi auth login`, so no row invents one.
    for (const id of ["pi-xai", "pi-codex", "opencode-go", "ollama-cloud"]) {
      const flow = flowById(id)!;
      expect(flow.command).toBeNull();
      expect(flow.capture).toBeNull();
      expect(flow.callback_port).toBeNull();
      // Not an apology - an instruction the operator can act on.
      expect(flow.note).toMatch(/`pi`|opencode|https:\/\//);
    }
    // pi's own docs/providers.md: "Run `/login xai`, then select Use a
    // subscription".
    expect(flowById("pi-xai")!.note).toContain("/login xai");
    expect(flowById("pi-codex")!.note).toContain("/login openai-codex");
    // The two key-mint lanes name where the key actually comes from.
    expect(flowById("opencode-go")!.note).toContain("https://opencode.ai/auth");
    expect(flowById("ollama-cloud")!.note).toContain("ollama-cloud-key.py");
  });

  test("the grok sign-in and pi's xai lane are named as two separate stores", () => {
    // Signing into the grok CLI does NOT fill pi's xai lane: the credentials
    // live in ~/.grok/auth.json and ~/.pi/agent/auth.json respectively, and a
    // row that implied otherwise would send the operator away believing a lane
    // was live when it was not.
    expect(flowById("grok")!.probe).toContain(".grok/auth.json");
    expect(flowById("grok")!.probe).not.toContain(".pi/agent");
    expect(flowById("pi-xai")!.note).toContain("two different stores");
  });

  test("every pi-lane probe passes --no-refresh and never asks for the credential", () => {
    for (const id of ["pi-xai", "pi-codex", "opencode-go", "ollama-cloud"]) {
      const probe = flowById(id)!.probe;
      // Without --no-refresh, `pi auth check` REFRESHES an expired OAuth
      // credential - which is a write, from something this app calls a probe.
      expect(probe).toContain("--no-refresh");
      // --credentials is the flag that emits the secret. It must never appear.
      expect(probe).not.toContain("--credentials");
      // And the probe must survive a machine with no pi at all.
      expect(probe).toContain("command -v pi");
    }
  });

  test("only the flow whose command PRINTS a credential carries a capture target", () => {
    // `claude setup-token` saves nothing of its own, so this app finishes the
    // job into the file installer/steps.py already reads. `codex login` saves
    // its own, so nothing is captured from it at all.
    expect(flowById("claude")!.capture).toEqual({ env_key: "CLAUDE_CODE_OAUTH_TOKEN", path: ".sdl-factory/secrets.env" });
    expect(flowById("codex")!.capture).toBeNull();
    expect(flowById("pi-codex")!.capture).toBeNull();
    // And it is the ONLY one, across the whole table.
    expect(AUTH_FLOWS.filter((flow) => flow.capture !== null).map((flow) => flow.id)).toEqual(["claude"]);
  });

  test("codex is the only flow with a callback port, and it is the one steps.py names", () => {
    expect(flowById("codex")!.callback_port).toBe(1455);
    expect(flowById("claude")!.callback_port).toBeNull();
    expect(flowById("pi-codex")!.callback_port).toBeNull();
    // Grok included: device-code auth is the flag that removes the need for a
    // forward, so a port here would be a forward nobody asked for.
    expect(AUTH_FLOWS.filter((flow) => flow.callback_port !== null).map((flow) => flow.id)).toEqual(["codex"]);
  });

  test("pi's own lane has no command, and says so instead of pretending", () => {
    const flow = flowById("pi-codex")!;
    expect(flow.command).toBeNull();
    expect(flow.note).toContain("/login");
    expect(flow.probe_target).toContain("auth.json");
  });

  test("every probe is read-only and can print no file content", () => {
    for (const flow of AUTH_FLOWS) {
      expect(flow.probe).toContain("printf");
      // `grep -q` answers with an exit code; a bare grep would print the line.
      if (flow.probe.includes("grep")) expect(flow.probe).toContain("grep -q");
      for (const writer of [" > ", ">>", "rm ", "mv ", "chmod ", "tee "]) {
        expect(flow.probe.includes(writer)).toBe(false);
      }
    }
  });
});

/* ── pure helpers ──────────────────────────────────────────────────────────*/

describe("what may never leave this process", () => {
  test("a printed token is redacted, whatever shape it takes", () => {
    expect(scrubSecrets("Your token: sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWX")).toBe("Your token: [redacted]");
    expect(scrubSecrets("bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP")).toBe("bearer [redacted]");
    // The setup-token shape: the token alone on a line, no prefix at all.
    expect(scrubSecrets("aVeryLongOpaqueCredentialValue012345678901234567890123")).toBe("[redacted]");
  });

  test("a callback URL's authorization code is redacted, the device code is not", () => {
    expect(scrubSecrets("http://localhost:1455/auth/callback?code=abc123def456&state=xyz")).toBe(
      "http://localhost:1455/auth/callback?code=[redacted]&state=xyz",
    );
    // A pairing code is what the operator has to read; it is not a credential.
    expect(scrubSecrets("https://example.com/device?user_code=ABCD-EFGH")).toBe("https://example.com/device?user_code=ABCD-EFGH");
  });

  test("a long URL survives whole - the opaque-blob rule never touches a link", () => {
    const url = "https://claude.ai/oauth/authorize?client_id=9d1c250a&redirect_uri=http%3A%2F%2Flocalhost&scope=user%3Ainference";
    expect(scrubSecrets(url)).toBe(url);
  });

  test("THE REAL `claude setup-token` LINK SURVIVES, `code=true` and all", () => {
    // The shape the real command prints, and the one that used to be destroyed
    // here: `code=true` is the manual-code FLAG, not a credential. The pattern
    // rewrote it to `code=[redacted]`, `append` then lifted the link out of the
    // already-scrubbed line, and `extractUrl` - whose character class excludes
    // `]` - truncated the whole thing at the bracket. session.url became
    // `https://claude.ai/oauth/authorize?code=[redacted`, so the strip's "open
    // in your browser", its copy-link and the transcript line were all dead
    // ends and the machine-side Claude sign-in could never be completed.
    const url =
      "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-1234-5678-9abc-def012345678" +
      "&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback" +
      "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference" +
      "&code_challenge=NqCLZSMxYzKmnGCiOplRPCvJnkVzXcHRltCKlXNbTFA&code_challenge_method=S256&state=6IHRnJ";
    expect(scrubSecrets(url)).toBe(url);
    // And the whole point: what the strip hands the operator is the whole link.
    expect(extractUrl(`Browser did not open. Use this URL to sign in: ${scrubSecrets(url)}`)).toBe(url);
  });

  test("...and a real authorization code is STILL redacted", () => {
    // The exemption is anchored to values that cannot be secret. A callback
    // URL's `code=` is an authorization code and must not survive.
    expect(scrubSecrets("callback: http://localhost:1455/cb?code=ac_9fXqAuthCode123&state=ok")).toBe(
      "callback: http://localhost:1455/cb?code=[redacted]&state=ok",
    );
    expect(scrubSecrets("api_key=true")).toBe("api_key=true");
    expect(scrubSecrets("api_key=sk_live_abcdefgh")).toBe("api_key=[redacted]");
  });

  test("what the operator pasted is redacted from the transcript by name", () => {
    expect(scrubSecrets("you typed ABCD-EFGH just now", ["ABCD-EFGH"])).toBe("you typed [redacted] just now");
    // A one-character reply must not redact the whole transcript.
    expect(scrubSecrets("press y to continue", ["y"])).toBe("press y to continue");
  });

  test("ansi noise is removed so the pane draws words, not escape codes", () => {
    expect(stripAnsi("\u001B[32mdone\u001B[0m")).toBe("done");
    expect(stripAnsi("\u001B]0;title\u0007ok")).toBe("ok");
    expect(stripAnsi("\u001B[2K\u001B[1Gspinner")).toBe("spinner");
  });
});

describe("reading the machine's answer", () => {
  test("the link is lifted out of the line it was printed on, without trailing punctuation", () => {
    expect(extractUrl("Open this URL in your browser: https://auth.example.com/x?y=1.")).toBe("https://auth.example.com/x?y=1");
    expect(extractUrl("nothing here")).toBeNull();
    // http:// is not offered as a link to click - only https.
    expect(extractUrl("http://localhost:1455/callback")).toBeNull();
  });

  test("a device code is read whether or not it carries a label", () => {
    expect(extractCode("Enter the code: WDJB-MJHT")).toBe("WDJB-MJHT");
    expect(extractCode("your one-time code is ABCD-EFGH12")).toBe("ABCD-EFGH12");
    expect(extractCode("  QWER-TYUI  ")).toBe("QWER-TYUI");
    expect(extractCode("no code on this line")).toBeNull();
  });

  test("the probe protocol has three answers, and 'could not tell' is one of them", () => {
    expect(parseProbeAnswer("SIGNEDIN /root/.codex/auth.json is on the machine\n")).toEqual({
      signed_in: true,
      detail: "/root/.codex/auth.json is on the machine",
    });
    expect(parseProbeAnswer("NO no /root/.codex/auth.json on the machine\n").signed_in).toBe(false);
    expect(parseProbeAnswer("bash: claude: command not found\n").signed_in).toBeNull();
  });
});

/* ── the real SSH path ─────────────────────────────────────────────────────*/

describe("the URL flow (claude setup-token)", () => {
  test(
    "runs the command on the machine, hands back the link, and only says signed in when the re-probe agrees",
    async () => {
      const { box, record } = await boxWithMachine();
      box.login = {
        lines: [
          "Browser did not open. Use this URL to sign in:",
          "https://claude.ai/oauth/authorize?client_id=9d1c250a&scope=user%3Ainference",
        ],
        prompt: "Paste code here: ",
        after: ["sk-ant-oat01-FAKETOKENVALUE0123456789ABCDEF"],
        exitCode: 0,
        // Nothing the command does signs this box in: the token it printed is
        // what does, once this app writes it back onto the machine.
        signsIn: null,
      };

      const session = startAuthSession(record, claudeFlow());
      expect(session.state).toBe("running");

      await waitFor(() => session.needs_input);
      expect(session.url).toBe("https://claude.ai/oauth/authorize?client_id=9d1c250a&scope=user%3Ainference");
      // Before the paste, the box has nothing and the row must not claim it does.
      expect(session.signed_in).toBeNull();

      expect(sendAuthInput(record.id, "WDJB-MJHT")).toBeNull();
      await waitFor(() => session.state !== "running");

      expect(session.state).toBe("completed");
      expect(session.exit_code).toBe(0);
      expect(session.signed_in).toBe(true);
      expect(session.signed_in_detail).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(ranLogin(box, "claude setup-token")).toBe(true);
      // A pty, because these CLIs draw one and because a paste needs a stdin.
      expect(box.ptyRequested).toBe(true);
      expect(box.stdin.join("")).toContain("WDJB-MJHT");
      // What the operator pasted is never echoed back into the transcript.
      expect(JSON.stringify(authView(session))).not.toContain("WDJB-MJHT");

      // The token the command printed went ONE way: back onto the machine it
      // came from, into the file installer/steps.py already reads, at 0600.
      const secrets = box.files.get("/root/.sdl-factory/secrets.env")!;
      expect(secrets).toBe("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKETOKENVALUE0123456789ABCDEF\n");
      expect(box.fileModes.get("/root/.sdl-factory/secrets.env")).toBe(0o600);
      // It crossed inside a file body, never on a command line where `ps` on
      // the far end would show it.
      for (const command of box.commands) expect(command).not.toContain("FAKETOKENVALUE");
      // And nothing about it is on this laptop or in the view.
      expect(JSON.stringify(authView(session))).not.toContain("FAKETOKENVALUE");
    },
    30_000,
  );

  test(
    "an existing secrets.env keeps every other line - the token is merged, not written over",
    async () => {
      const { box, record } = await boxWithMachine();
      box.files.set("/root/.sdl-factory/secrets.env", "# machine secrets\nOTHER=1\nCLAUDE_CODE_OAUTH_TOKEN=old\n");
      box.login = {
        lines: ["https://claude.ai/oauth/authorize?client_id=x"],
        prompt: null,
        after: ["sk-ant-oat01-NEWTOKENVALUE0123456789ABCDEF"],
        exitCode: 0,
        signsIn: null,
      };

      const session = startAuthSession(record, claudeFlow());
      await waitFor(() => session.state !== "running");

      expect(session.state).toBe("completed");
      expect(box.files.get("/root/.sdl-factory/secrets.env")).toBe(
        "# machine secrets\nOTHER=1\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-NEWTOKENVALUE0123456789ABCDEF\n",
      );
    },
    30_000,
  );

  test(
    "an exit 0 whose re-probe finds nothing is a FAILURE, never a green row",
    async () => {
      const { box, record } = await boxWithMachine();
      // Exits happily, prints no token: nothing is written, and nothing on the
      // machine changed - so the row must not go green.
      box.login = { lines: ["Login successful."], prompt: null, after: [], exitCode: 0, signsIn: null };

      const session = startAuthSession(record, claudeFlow());
      await waitFor(() => session.state !== "running");

      expect(session.exit_code).toBe(0);
      expect(session.signed_in).toBe(false);
      expect(session.state).toBe("failed");
      expect(session.error).toContain("still has nothing signed in");
      expect(box.files.has("/root/.sdl-factory/secrets.env")).toBe(false);
      expect(session.lines.join("\n")).toContain("printed nothing this app recognises as a token");
    },
    30_000,
  );
});

describe("the device-code flow", () => {
  test(
    "both the link and the code are lifted out, large enough for the pane to show",
    async () => {
      const { box, record } = await boxWithMachine();
      box.login = {
        lines: [
          "To sign in, open https://auth.openai.com/device",
          "and enter the code: WDJB-MJHT",
          "Waiting for approval...",
        ],
        prompt: null,
        after: ["Signed in."],
        exitCode: 0,
        signsIn: "codex",
      };

      // No callback port on this shape: a device flow needs no forward at all.
      const session = startAuthSession(record, { ...flowById("codex")!, callback_port: null });
      await waitFor(() => session.state !== "running");

      expect(session.url).toBe("https://auth.openai.com/device");
      expect(session.code).toBe("WDJB-MJHT");
      expect(session.forward).toBeNull();
      expect(session.state).toBe("completed");
      expect(session.signed_in).toBe(true);
    },
    30_000,
  );
});

describe("the callback flow (codex login, port forwarded)", () => {
  test(
    "the laptop's loopback port really carries bytes to the machine's, and closes with the session",
    async () => {
      const { box, record } = await boxWithMachine();
      const port = await freePort();
      box.login = {
        lines: [`Starting local login server on http://localhost:${port}`, "Opening your browser..."],
        prompt: "Press Enter when you are done: ",
        after: ["Successfully logged in."],
        exitCode: 0,
        signsIn: "codex",
      };

      const session = startAuthSession(record, codexFlowOn(port));
      await waitFor(() => session.needs_input);
      expect(session.forward_reason).toBeNull();
      expect(session.forward).toContain(`127.0.0.1:${port}`);

      // The browser's half: a plain socket to the laptop's own loopback port.
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = netConnect({ host: "127.0.0.1", port }, () => {
          socket.write("GET /auth/callback?code=SECRETAUTHCODE HTTP/1.1\r\n");
        });
        socket.setTimeout(10_000, () => reject(new Error("the forward never answered")));
        socket.on("data", (chunk) => {
          resolve(chunk.toString("utf-8"));
          socket.end();
        });
        socket.on("error", reject);
      });

      // Bytes went to the MACHINE's own loopback port, and came back.
      expect(answer).toContain("callback-ok:");
      expect(box.forwards).toContainEqual({ host: "127.0.0.1", port });
      expect(box.forwardBytes.join("")).toContain("/auth/callback");

      sendAuthInput(record.id, "");
      await waitFor(() => session.state !== "running");
      expect(session.state).toBe("completed");
      expect(session.signed_in).toBe(true);

      // The forward is gone the moment the session is: nothing on this laptop
      // keeps listening after the sign-in it existed for.
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = netConnect({ host: "127.0.0.1", port }, () => {
            socket.end();
            resolve();
          });
          socket.setTimeout(3_000, () => reject(new Error("timeout")));
          socket.on("error", reject);
        }),
      ).rejects.toThrow();
    },
    40_000,
  );
});

describe("failure and cancel", () => {
  test(
    "a failing command keeps its last lines and names the machine",
    async () => {
      const { box, record } = await boxWithMachine();
      box.login = {
        lines: ["Error: could not reach the authorization server", "Check the machine's network and try again"],
        prompt: null,
        after: [],
        exitCode: 1,
        signsIn: null,
      };

      const session = startAuthSession(record, claudeFlow());
      await waitFor(() => session.state !== "running");

      expect(session.state).toBe("failed");
      expect(session.exit_code).toBe(1);
      expect(session.signed_in).toBe(false);
      expect(session.lines.join("\n")).toContain("could not reach the authorization server");
      expect(session.error).toContain("test-box");
    },
    30_000,
  );

  test(
    "cancel kills the remote command, and the row says cancelled - not signed in",
    async () => {
      const { box, record } = await boxWithMachine();
      box.login = {
        lines: ["Open https://claude.ai/oauth/authorize?x=1"],
        prompt: "Paste code here: ",
        after: ["sk-ant-oat01-NEVERPRINTEDVALUE0123456789"],
        exitCode: 0,
        signsIn: null,
      };

      const session = startAuthSession(record, claudeFlow());
      await waitFor(() => session.needs_input);

      cancelAuthSession(record.id);
      await waitFor(() => session.state !== "running", 20_000);

      expect(session.state).toBe("cancelled");
      expect(session.error).toContain("cancel");
      // The token line never arrived, because the command was killed before
      // the paste that would have produced it - so nothing was written either.
      expect(session.lines.join("\n")).not.toContain("NEVERPRINTED");
      expect(box.files.has("/root/.sdl-factory/secrets.env")).toBe(false);
      expect(box.signedIn.has("claude")).toBe(false);
    },
    40_000,
  );

  test(
    "a machine this app has no key for never opens a connection, and names the file",
    async () => {
      const { record } = await boxWithMachine();
      const session = startAuthSession(
        { ...record, id: `${record.id}-nokey`, key_path: join(appHomeDir, "no-such-key") },
        claudeFlow(),
      );
      await waitFor(() => session.state !== "running");
      expect(session.state).toBe("failed");
      expect(session.error).toContain("no-such-key");
      expect(session.signed_in).toBeNull();
    },
    20_000,
  );

  test("one sign-in at a time per machine: a second start returns the running one", async () => {
    const { box, record } = await boxWithMachine();
    box.login = { lines: ["waiting"], prompt: "Paste code here: ", after: [], exitCode: 0, signsIn: null };
    const first = startAuthSession(record, claudeFlow());
    const second = startAuthSession(record, claudeFlow());
    expect(second.id).toBe(first.id);
    cancelAuthSession(record.id);
    await waitFor(() => first.state !== "running", 20_000);
  }, 40_000);
});

/* ── the read-only check (the pi lane's whole button) ──────────────────────*/

describe("the read-only check", () => {
  test(
    "answers from the machine's own pi auth store, and never writes to it",
    async () => {
      const { box, record } = await boxWithMachine();
      const flow = flowById("pi-codex")!;

      const before = await probeSignedIn(record, flow);
      expect(before.signed_in).toBe(false);
      expect(before.detail).toContain("openai-codex");

      // The lane becoming authorized on the box is what flips the answer -
      // this app never writes it, it only asks again.
      box.piLanes.add("openai-codex");
      const after = await probeSignedIn(record, flow);
      expect(after.signed_in).toBe(true);

      // Every command this path ever sent is the probe itself.
      for (const command of box.commands) expect(command).toContain("printf");
    },
    30_000,
  );

  test(
    "a machine that cannot be reached is 'could not tell', never a false 'not signed in'",
    async () => {
      const { box, record } = await boxWithMachine();
      await box.close();
      const answer = await probeSignedIn(record, flowById("codex")!);
      expect(answer.signed_in).toBeNull();
      expect(answer.detail).toContain("could not ask");
    },
    30_000,
  );
});

/* ── the routes ────────────────────────────────────────────────────────────*/

describe("the routes", () => {
  const TOKEN = "test-app-token";
  const ORIGINS: ReadonlySet<string> = new Set(["http://127.0.0.1:4700"]);
  const routes = authSessionRoutes(TOKEN, ORIGINS);

  function post(path: string, body: unknown): Request {
    return new Request(`http://127.0.0.1:4700${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-token": TOKEN, origin: "http://127.0.0.1:4700" },
      body: JSON.stringify(body),
    });
  }

  test("the flow table reaches the pane, with the live session beside it", async () => {
    const { record } = await boxWithMachine();
    const response = await routes["/api/app/auth-session"].GET(
      new Request(`http://127.0.0.1:4700/api/app/auth-session?machine_id=${record.id}`),
    );
    const body = (await response.json()) as { flows: { id: string }[]; session: unknown; reason: string | null };
    expect(body.flows.map((flow) => flow.id)).toEqual([
      "grok",
      "claude",
      "codex",
      "pi-xai",
      "pi-codex",
      "opencode-go",
      "ollama-cloud",
    ]);
    // The view never carries a probe script or a capture target - only what the
    // pane draws.
    expect(Object.keys(body.flows[0]!).sort()).toEqual(["callback_port", "command", "id", "label", "note", "probe_target"]);
    expect(body.session).toBeNull();
    expect(body.reason).toContain("no sign-in has been started");
  });

  test("starting the pi lane is refused by name - there is no command to run", async () => {
    const { record } = await boxWithMachine();
    const response = await routes["/api/app/auth-session/start"].POST(
      post("/api/app/auth-session/start", { machine_id: record.id, flow: "pi-codex" }),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("/login");
  });

  test("an unknown machine and an unknown flow are named, not swallowed", async () => {
    const unknownMachine = await routes["/api/app/auth-session/start"].POST(
      post("/api/app/auth-session/start", { machine_id: "m-nope", flow: "claude" }),
    );
    expect(unknownMachine.status).toBe(404);
    const unknownFlow = await routes["/api/app/auth-session/start"].POST(
      post("/api/app/auth-session/start", { machine_id: "m-nope", flow: "opencode" }),
    );
    expect(unknownFlow.status).toBe(404);
  });

  test("a GET asked under somebody else's name is refused - the read plane is loopback-only", async () => {
    const { record } = await boxWithMachine();
    // The DNS-rebinding shape: the request really does arrive on 127.0.0.1, but
    // the browser was told to fetch `evil.example`, so that is the name in
    // `Host` - and Bun builds `req.url` from it. This route has no token check
    // (no `/api/app/*` GET does), and it hands back scrubbed transcripts plus
    // the live pairing code, so the name is the whole check.
    const rebound = await routes["/api/app/auth-session"].GET(
      new Request(`http://evil.example/api/app/auth-session?machine_id=${record.id}`),
    );
    expect(rebound.status).toBe(403);
    expect(((await rebound.json()) as { error: string }).error).toContain("loopback");

    // ...and the app's own page is unaffected.
    const ours = await routes["/api/app/auth-session"].GET(
      new Request(`http://127.0.0.1:4700/api/app/auth-session?machine_id=${record.id}`),
    );
    expect(ours.status).toBe(200);
  });

  test("a write with no app token is refused before anything is started", async () => {
    const { record } = await boxWithMachine();
    const response = await routes["/api/app/auth-session/start"].POST(
      new Request("http://127.0.0.1:4700/api/app/auth-session/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machine_id: record.id, flow: "claude" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(getAuthSession(record.id)).toBeNull();
  });

  test(
    "A TOKEN IN THE TRANSCRIPT NEVER REACHES A ROUTE RESPONSE",
    async () => {
      const { box, record } = await boxWithMachine();
      // Everything a real login could print that must not come back: a token
      // outright, a callback URL carrying an authorization code, and a bearer
      // JWT in a debug line.
      box.login = {
        lines: [
          "Open https://claude.ai/oauth/authorize?client_id=9d1c250a to sign in",
          "callback received: http://localhost:1455/auth/callback?code=AUTHCODESECRET123&state=ok",
          "debug: authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcCJ9.SFlAcRcVQfE",
          "Your long-lived token: sk-ant-oat01-FAKETOKENVALUE0123456789ABCDEF",
        ],
        prompt: null,
        after: ["Login successful."],
        exitCode: 0,
        signsIn: null,
      };

      const session = startAuthSession(record, claudeFlow());
      await waitFor(() => session.state !== "running");
      expect(session.state).toBe("completed");

      const status = await routes["/api/app/auth-session"].GET(
        new Request(`http://127.0.0.1:4700/api/app/auth-session?machine_id=${record.id}`),
      );
      const text = await status.text();

      expect(text).not.toContain("sk-ant-oat01-FAKETOKENVALUE");
      expect(text).not.toContain("AUTHCODESECRET123");
      expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(text).toContain("[redacted]");
      // The redaction is in the RECORD, not merely in this view - a future
      // route that reads `lines` cannot leak what this one refused to.
      expect(JSON.stringify(session.lines)).not.toContain("FAKETOKENVALUE");
      // And the useful half survives: the link the operator has to open.
      expect(text).toContain("https://claude.ai/oauth/authorize?client_id=9d1c250a");
      // The token went exactly one place - the machine's own file.
      expect(box.files.get("/root/.sdl-factory/secrets.env")).toContain("sk-ant-oat01-FAKETOKENVALUE");
    },
    30_000,
  );

  test(
    "the check route answers with the machine's own truth",
    async () => {
      const { box, record } = await boxWithMachine();
      box.signedIn.add("codex");
      const response = await routes["/api/app/auth-session/check"].POST(
        post("/api/app/auth-session/check", { machine_id: record.id, flow: "codex" }),
      );
      const body = (await response.json()) as { signed_in: boolean; detail: string; machine_name: string };
      expect(body.signed_in).toBe(true);
      expect(body.machine_name).toBe("test-box");
      expect(body.detail).toContain(".codex/auth.json");
    },
    30_000,
  );

  test(
    "a pi lane the machine cannot sign in from here answers 409 with the line to type",
    async () => {
      const { record } = await boxWithMachine();
      const response = await routes["/api/app/auth-session/start"].POST(
        post("/api/app/auth-session/start", { machine_id: record.id, flow: "pi-xai" }),
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      // Not "this app cannot help you" - the exact command, in the refusal.
      expect(body.error).toContain("/login xai");
      expect(body.error).toContain("check-only");
    },
    30_000,
  );
});

/* ── Grok: the device login, which is the operator's first click ───────────*/

describe("signing Grok in on a machine", () => {
  test(
    "the device code and the link both reach the operator, and the machine's own file decides the end",
    async () => {
      const { box, record } = await boxWithMachine();
      box.login = {
        lines: [
          "Starting device authorization with auth.x.ai",
          "Open https://x.ai/device and enter the code below.",
          "Your code: WDJB-MJHT",
        ],
        prompt: null,
        after: ["Waiting for authorization... done.", "Signed in as himselfmubarak@gmail.com"],
        exitCode: 0,
        // The real CLI writes ~/.grok/auth.json itself; the box does the same.
        signsIn: "grok",
      };

      const session = startAuthSession(record, grokFlow());
      await waitFor(() => session.state !== "running");

      expect(ranLogin(box, "grok login --device-auth")).toBe(true);
      // The PATH prefix really travels: the xAI CLI is a native binary in
      // ~/.grok/bin, and a non-login `ssh <host> '<cmd>'` sources no .profile,
      // so without this the operator's FIRST click exits 127 on a real box.
      expect(box.commands.some((command) => command.startsWith(REMOTE_PATH_PREFIX))).toBe(true);
      expect(REMOTE_PATH_PREFIX).toContain(".grok/bin");
      // Device auth opens NO port forward - that is the point of the flag.
      expect(box.forwards).toHaveLength(0);
      expect(session.forward).toBeNull();
      // Both halves of a device flow reach the pane: the page and the code.
      expect(session.url).toBe("https://x.ai/device");
      expect(session.code).toBe("WDJB-MJHT");
      // `completed` is the RE-PROBE's answer, not the exit code.
      expect(session.state).toBe("completed");
      expect(session.signed_in).toBe(true);
      expect(session.signed_in_detail).toContain(".grok/auth.json");
      // Nothing was harvested and nothing was written by this app: the grok CLI
      // saves its own credential, so no file crossed the wire at all.
      expect(session.harvested).toBeNull();
      expect(box.files.size).toBe(0);
    },
    30_000,
  );

  test(
    "a device login the operator never finishes ends red, and says the machine still has nothing",
    async () => {
      const { box, record } = await boxWithMachine();
      box.login = {
        lines: ["Open https://x.ai/device and enter the code below.", "Your code: ABCD-EFGH"],
        prompt: null,
        after: ["error: device authorization timed out"],
        exitCode: 1,
        signsIn: null,
      };

      const session = startAuthSession(record, grokFlow());
      await waitFor(() => session.state !== "running");

      expect(session.state).toBe("failed");
      expect(session.signed_in).toBe(false);
      // The sentence names the machine and what is missing on it - it does not
      // just report a number.
      expect(session.error).toContain("test-box");
      expect(session.error).toContain(".grok/auth.json");
    },
    30_000,
  );

  test(
    "a machine with no grok CLI says SO, instead of reporting a failed login",
    async () => {
      const { box, record } = await boxWithMachine();
      // The fake box answers anything it does not emulate the way a real shell
      // answers a command it cannot find: exit 127. That is the state EVERY
      // freshly deployed Ubuntu box is in for this CLI - bootstrap.sh installs
      // the claude and codex CLIs and does not install this one - and "the
      // command exited 127 but nothing is signed in" names neither the cause
      // nor the fix.
      const missing = { ...grokFlow(), command: "grok login --oauth" };
      const session = startAuthSession(record, missing);
      await waitFor(() => session.state !== "running");

      expect(session.state).toBe("failed");
      expect(session.exit_code).toBe(127);
      expect(session.error).toContain("command not found");
      expect(session.error).toContain("grok");
      expect(box.signedIn.has("grok")).toBe(false);
    },
    30_000,
  );

  test(
    "the pairing code is readable in the transcript - it is not a credential",
    async () => {
      const { box, record } = await boxWithMachine();
      box.login = {
        lines: ["Your code: WDJB-MJHT", "Open https://x.ai/device"],
        prompt: null,
        after: ["done"],
        exitCode: 0,
        signsIn: "grok",
      };
      const session = startAuthSession(record, grokFlow());
      await waitFor(() => session.state !== "running");
      // A redacted pairing code is a sign-in the operator cannot complete.
      expect(JSON.stringify(session.lines)).toContain("WDJB-MJHT");
    },
    30_000,
  );
});

/* ── the pi lanes: check-only, and truthful with or without pi ─────────────*/

describe("checking pi's own lanes on a machine", () => {
  test(
    "pi on the box answers for every lane, and the ready ones say configured",
    async () => {
      const { box, record } = await boxWithMachine();
      box.hasPi = true;
      box.piLanes.add("xai");
      box.piLanes.add("opencode-go");

      const xai = await probeSignedIn(record, flowById("pi-xai")!);
      expect(xai.signed_in).toBe(true);
      // The word is "configured", never "working": measured on the operator's
      // own laptop, `pi auth check --no-refresh` answered `ready` for an xai
      // token that had expired seven days earlier.
      expect(xai.detail).toContain("configured");

      const codex = await probeSignedIn(record, flowById("pi-codex")!);
      expect(codex.signed_in).toBe(false);
      expect(codex.detail).toContain("openai-codex");

      const go = await probeSignedIn(record, flowById("opencode-go")!);
      expect(go.signed_in).toBe(true);
    },
    30_000,
  );

  test(
    "a machine with no pi still gets a truthful answer, and says pi was not there to ask",
    async () => {
      const { box, record } = await boxWithMachine();
      box.hasPi = false;
      box.piLanes.add("xai");

      const xai = await probeSignedIn(record, flowById("pi-xai")!);
      expect(xai.signed_in).toBe(true);
      // The claim changes shape when the source changes: "a key is in a file"
      // is not the same claim as "pi says ready", and the row must not blur them.
      expect(xai.detail).toContain("not on this machine's PATH");

      const missing = await probeSignedIn(record, flowById("opencode-go")!);
      expect(missing.signed_in).toBe(false);
      expect(missing.detail).toContain("not on PATH");
    },
    30_000,
  );

  test(
    "ollama-cloud falls back to models.json, because its key is not in auth.json at all",
    async () => {
      const { box, record } = await boxWithMachine();
      box.hasPi = false;
      // installer/steps.py wires this lane as a models.json provider block whose
      // apiKey is the `!python .../ollama-cloud-key.py` escape - there is no
      // auth.json entry to find, so a probe that looked there would say "no"
      // about a lane that works.
      box.files.set("/root/.pi/agent/models.json", '{"providers":{"ollama-cloud":{}}}');
      const answer = await probeSignedIn(record, flowById("ollama-cloud")!);
      expect(answer.signed_in).toBe(true);
      expect(answer.detail).toContain("models.json");
    },
    30_000,
  );

  test(
    "the grok CLI's sign-in does not make pi's xai lane say signed in",
    async () => {
      const { box, record } = await boxWithMachine();
      box.signedIn.add("grok"); // ~/.grok/auth.json is on the box
      box.hasPi = true; // ...but pi's own xai lane is empty
      expect((await probeSignedIn(record, grokFlow())).signed_in).toBe(true);
      expect((await probeSignedIn(record, flowById("pi-xai")!)).signed_in).toBe(false);
    },
    30_000,
  );
});

/* ── MANUAL PROOF (nothing in CI can do this) ───────────────────────────────
 *
 * Against the real box already added in Settings > Machines:
 *
 *   0. GROK FIRST - it is the workhorse lane. Settings > Providers, pick the
 *      machine, then on the Grok row click "Sign in on <machine>".
 *      EXPECT: a link AND a short pairing code, within a few seconds. Open the
 *      link on the laptop, type the code, approve. No port forward is opened
 *      and none is needed (`--device-auth` is xAI's own headless flag).
 *      EXPECT the strip to end green, and on the box:
 *        ls -l ~/.grok/auth.json    -> it exists
 *        grep -c auth.x.ai ~/.grok/auth.json   -> 1 or more (do NOT cat it)
 *      Then click "Check on <machine>" on the pi lane: xai row. It will still
 *      say NOT signed in, and that is CORRECT - the grok CLI and pi's xai lane
 *      are two separate stores. To fill pi's, on the box run `pi`, type
 *      `/login xai`, choose "Use a subscription", quit, and Check again.
 *   1. Settings > Providers, pick the machine in "Sync to a machine", then on
 *      the Claude row click "Sign in on <machine>".
 *      EXPECT: a link appears within a few seconds. Open it - it is the real
 *      Claude sign-in - and finish it in the laptop's browser. If the machine
 *      asks for a code, paste it into the box on the strip.
 *      EXPECT the strip to end green, and on the box:
 *        ls -l ~/.claude/.credentials.json     -> it exists, mode 600
 *   2. Codex row, same click. While it runs, on the LAPTOP:
 *        netstat -ano | findstr 1455          -> this app is listening
 *      Finish the browser flow. On the box:
 *        ls -l ~/.codex/auth.json             -> it exists
 *      And after the strip finishes, on the laptop:
 *        netstat -ano | findstr 1455          -> nothing (the forward is gone)
 *   3. Any pi lane row, "Check on <machine>". On the box, the same question,
 *      asked pi's own way - this is the exact command the probe runs:
 *        pi auth check --provider xai --json --no-refresh
 *        pi auth check --provider openai-codex --json --no-refresh
 *      -> the same answer the row gives. (`--no-refresh` matters: without it
 *      the command refreshes and therefore WRITES. Never pass --credentials.)
 *      And on a box with no pi installed, the same rows still answer, from
 *        ~/.pi/agent/auth.json   (or models.json, for ollama-cloud)
 *      with a sentence that says pi was not there to ask.
 *   4. Nothing anywhere in the app's own output holds a token:
 *        the strip, the JSON at /api/app/auth-session?machine_id=<id>
 */
