/**
 * MACHINES — the servers the factory actually runs on, and the one-click deploy.
 *
 * The operator's sentence this file exists to satisfy: *"hypothetically the
 * server has NO CLI tool, nothing... I put in the IP together with the password
 * and I click connect, which means the factory is set up."* Nothing is assumed
 * to be installed on the far end. A bare Ubuntu box with sshd and a root
 * password is the whole starting condition.
 *
 * ── Why ssh2 (and the proof) ────────────────────────────────────────────────
 * `ssh2` is a pure-JS SSH client. It was chosen over shelling out to the system
 * OpenSSH client because OpenSSH cannot take a password non-interactively, and
 * a password is exactly what the operator has on a fresh box. Two things were
 * verified before this file was written, not assumed:
 *
 *   1. ssh2 runs under Bun on Windows. `machines.test.ts` proves it end to end
 *      against an in-process ssh2 *server*: password auth, `exec` with an exit
 *      code, and an SFTP upload — the three capabilities this file needs.
 *   2. ssh2's optional native `cpu-features` postinstall is BLOCKED by Bun's
 *      trusted-dependencies policy in this repo, and everything above still
 *      works — the native module only picks faster ciphers, it is not required.
 *
 * ── The credential rule ─────────────────────────────────────────────────────
 * The password is used ONCE, in memory, on the connect that installs this app's
 * own generated ed25519 public key into the server's `~/.ssh/authorized_keys`.
 * It is never written to disk, never put in the registry, never logged, and
 * never echoed back in a response. After that first connect the app only ever
 * authenticates with the key it generated, which lives at
 * `~/.sdl-factory/keys/<machine-id>` with mode 0600 on THIS laptop. Nothing
 * about a machine ever enters git.
 *
 * ── The host key rule (trust on first use, and only the first) ──────────────
 * The first connect has nothing to compare the server's host key against — the
 * operator typed an IP and a password, there is no out-of-band fingerprint — so
 * that key is ACCEPTED and its `SHA256:` fingerprint is PINNED into the machine
 * record. Every connect after that (probe, deploy, and the provider-credential
 * sync) demands exactly that fingerprint and refuses the connection by name
 * before one byte of a credential is sent. That is what
 * `ssh -o StrictHostKeyChecking=accept-new` does, and it is why the app can
 * carry API keys and an OAuth token over this channel at all: a re-provisioned
 * IP, or anything else answering on that address, fails loudly instead of being
 * handed the operator's secrets.
 *
 * ── The registry ────────────────────────────────────────────────────────────
 * `~/.sdl-factory/machines.json`, beside the project manifest — operator-local,
 * outside every repo. Per-project "Runs on" bindings are additive fields on the
 * project manifest's own entries (`machine_id`), written through
 * `manifest.ts`'s own read/write so that file needs no edit.
 *
 * ── The deploy ──────────────────────────────────────────────────────────────
 * A deploy has TWO phases, and the first one happens on this laptop: `adopt.ts`
 * gives the project's own origin the `integration` branch the server is about
 * to clone, cutting it losslessly from wherever the newest work lives, because
 * the operator does not run git commands. Only then does the second phase open
 * an SSH connection. Both phases print into the same stream.
 *
 * `deploy/bootstrap.sh` is pushed over SFTP and executed with `sh`. It prints
 * `STEP <name> OK|FAIL <reason>` lines; this file parses those into a step list
 * the UI streams, and keeps the raw output beneath it. The job record follows
 * `jobs.ts`'s pattern (capped ring of lines + a running/done/failed state) but
 * deliberately does NOT call `jobs.ts#createJob`: that function's header states
 * it has exactly two permitted call sites, and a remote deploy is not a local
 * subprocess anyway.
 *
 * ── Honest states ───────────────────────────────────────────────────────────
 * A machine is `reachable` only when this process just spoke to it. Anything it
 * has not proven is `null` with a reason beside it. Nothing here needs the
 * Electron shell: the SSH happens in this Bun server, so the plain browser at
 * :4700 has every capability the desktop app has.
 *
 * ── Providers, on the machine row ───────────────────────────────────────────
 * A deployed box with no provider credentials on it is a factory that cannot
 * run one model, and that used to be invisible from this pane: the operator saw
 * `engine active` and reasonably read it as finished. So every row now carries
 * `providers` — a count-only summary of the last sync `providers-v3.ts` ran
 * against that machine, read from that module's own registry (see
 * `readProviderSyncLog`). `null`, or zero applied, is what the pane draws the
 * warning from. Nothing on this path reads a key.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { Client, utils, type ConnectConfig } from "ssh2";
import type {
  DeployJobView,
  DeployStep,
  MachineDeployRequest,
  MachineProbe,
  MachineProviderSync,
  MachineRegistryRow,
  MachinesRegistryResponse,
  NewMachineRequest,
  ProviderSyncRun,
} from "../../shared/types.ts";
import { adoptIntegrationBranch, branchNameProblem, type AdoptOutcome } from "./adopt.ts";
import { appError, appJson, appSafely, csrfGuard } from "./guard.ts";
import { appHome, findProject, readManifest, writeManifest, type ManifestProject } from "./manifest.ts";
import { param } from "./scoped.ts";

// ── paths ───────────────────────────────────────────────────────────────────

/** The app's operator-local home. `SDL_FACTORY_HOME` overrides it so the tests
 * can run the whole registry + key-writing path without touching the real
 * `~/.sdl-factory` of whoever runs them. */
export function machinesHome(): string {
  const override = process.env["SDL_FACTORY_HOME"]?.trim();
  return override ? override : appHome();
}

export function registryPath(): string {
  return join(machinesHome(), "machines.json");
}

export function keyDir(): string {
  return join(machinesHome(), "keys");
}

/** Where `deploy/bootstrap.sh` sits beside this module. */
export function bootstrapPath(): string {
  return join(import.meta.dir, "deploy", "bootstrap.sh");
}

// ── the registry ────────────────────────────────────────────────────────────

export interface MachineRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** Path on THIS laptop to the private key. After a password bootstrap this
   * is the app's own generated key; when the operator supplied a key path it is
   * theirs and this app never rewrites it. */
  key_path: string;
  /** true when this app generated the key (and therefore installed the public
   * half into the server's authorized_keys). */
  key_generated: boolean;
  added_at: string;
  last_connected_at: string | null;
  /** where the checkout lives on that box; set by the first deploy */
  repo_dir: string | null;
  /** `SHA256:...` of the host key this app saw when the machine was added. Every
   * later connect must be answered by exactly this key. null on a record written
   * before pinning existed - the next successful connect pins what it sees. */
  host_fingerprint: string | null;
}

export interface Registry {
  version: 1;
  default_machine: string | null;
  machines: MachineRecord[];
}

function emptyRegistry(): Registry {
  return { version: 1, default_machine: null, machines: [] };
}

export async function readRegistry(): Promise<Registry> {
  const path = registryPath();
  if (!existsSync(path)) return emptyRegistry();
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<Registry>;
    // A record written before host-key pinning existed has no fingerprint field
    // at all; it reads as "nothing pinned yet", which the next connect fixes.
    const machines = (Array.isArray(parsed.machines) ? (parsed.machines as MachineRecord[]) : []).map((machine) => ({
      ...machine,
      host_fingerprint: typeof machine.host_fingerprint === "string" && machine.host_fingerprint ? machine.host_fingerprint : null,
    }));
    return {
      version: 1,
      default_machine: typeof parsed.default_machine === "string" ? parsed.default_machine : null,
      machines,
    };
  } catch (error) {
    // A hand-edited registry must not take the app plane down; it degrades to
    // "no machines known", the same honest empty state as no file at all. The
    // reason is surfaced by the route, not swallowed.
    console.error(`[ui] machines: could not read ${path}: ${(error as Error).message}`);
    return emptyRegistry();
  }
}

export async function writeRegistry(registry: Registry): Promise<void> {
  await mkdir(machinesHome(), { recursive: true });
  await writeFile(registryPath(), `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
}

// ── what providers landed on a machine (read-only) ──────────────────────────

/**
 * The providers registry, `~/.sdl-factory/providers.json`, which
 * `providers-v3.ts` owns and is the only module that writes.
 *
 * The filename is spelled again here rather than imported, on this plane's own
 * stated precedent (`providers-v3.ts:which()` — "local duplication over
 * cross-chunk coupling"): that module already imports THIS one for its SSH
 * helpers, so importing it back would turn one filename into a load-time
 * import cycle. `machines.test.ts` writes the file through providers-v3's own
 * writer and reads it back through this function, so the two cannot drift
 * apart silently.
 *
 * ONLY the `sync` map is read. The same file holds every API key this app
 * stores; nothing on this path touches `providers`, and the summary below
 * carries counts and ids, never a credential and never a reason string.
 */
export async function readProviderSyncLog(): Promise<Record<string, ProviderSyncRun>> {
  const path = join(machinesHome(), "providers.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as { sync?: unknown };
    const sync = parsed.sync;
    return sync && typeof sync === "object" && !Array.isArray(sync) ? (sync as Record<string, ProviderSyncRun>) : {};
  } catch (error) {
    // A hand-edited providers file must not take the machines list down. It
    // degrades to "no sync is on record", which reads as the honest warning
    // that no provider has landed - never as a false "synced".
    console.error(`[ui] machines: could not read the provider sync log at ${path}: ${(error as Error).message}`);
    return {};
  }
}

/** One run, reduced to what a machine row draws. A run with zero `applied` is
 * the state this whole field exists for: a box with no model credentials. */
export function providerSyncSummary(run: ProviderSyncRun | null | undefined): MachineProviderSync | null {
  if (!run || !Array.isArray(run.results) || typeof run.at !== "string") return null;
  const applied = run.results.filter((result) => result.state === "applied");
  return {
    at: run.at,
    ok: run.ok === true,
    applied: applied.length,
    needs_you: run.results.filter((result) => result.state === "needs-you").length,
    failed: run.results.filter((result) => result.state === "failed").length,
    applied_ids: applied.map((result) => result.provider_id),
  };
}

/** Stable id from host+user+port, so re-adding the same box updates its row
 * rather than growing a second one that points at the same server. */
export function machineId(host: string, user: string, port: number): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(`${user}@${host.toLowerCase()}:${port}`);
  return `m-${hash.digest("hex").slice(0, 10)}`;
}

// ── ssh primitives ──────────────────────────────────────────────────────────

export interface Target {
  host: string;
  port: number;
  user: string;
  /** used exactly once, for the bootstrap connect; never persisted */
  password?: string;
  privateKey?: string;
  readyTimeoutMs?: number;
  /** The fingerprint this app pinned for this machine. Set = the server must
   * present exactly this host key or the connection is refused before the
   * handshake completes, so nothing is ever sent to it. null/undefined = first
   * contact: whatever the server presents is accepted, and `onHostKey` is how
   * the caller pins it. */
  expectFingerprint?: string | null;
  /** Called with the fingerprint the server presented, on every connect. */
  onHostKey?: (fingerprint: string) => void;
}

/** OpenSSH's own spelling of a host key fingerprint - `SHA256:<base64, no
 * padding>`, byte-for-byte what `ssh-keygen -lf` prints - so an operator can
 * compare this app's pinned value against the server's console by eye. */
export function hostFingerprint(key: Buffer): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(key);
  return `SHA256:${hash.digest("base64").replace(/=+$/, "")}`;
}

function connectConfig(target: Target, verifier: (key: Buffer) => boolean): ConnectConfig {
  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.user,
    readyTimeout: target.readyTimeoutMs ?? 15_000,
    hostVerifier: verifier,
  };
  if (target.password !== undefined) config.password = target.password;
  if (target.privateKey !== undefined) config.privateKey = target.privateKey;
  return config;
}

/**
 * Connect, with the host key checked the way `StrictHostKeyChecking=accept-new`
 * checks it: unknown is accepted and reported to the caller for pinning, known
 * must match exactly.
 *
 * A mismatch is rejected inside the handshake — ssh2 tears the socket down
 * before authentication, so no password, no key and no SFTP body ever reaches
 * the far end. ssh2's own error for that is the generic "Handshake failed", so
 * the reason this app computed is what the caller is given.
 */
export function connect(target: Target): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let mismatch: string | null = null;
    const verify = (key: Buffer): boolean => {
      const seen = hostFingerprint(key);
      target.onHostKey?.(seen);
      const expected = (target.expectFingerprint ?? "").trim();
      if (!expected || expected === seen) return true;
      mismatch =
        `${target.user}@${target.host}:${target.port} answered with a host key this app has not seen before - ` +
        `it pinned ${expected} when the machine was added, and the server presented ${seen}. ` +
        `Nothing was sent. If you rebuilt or re-provisioned this box, remove the machine and add it again; ` +
        `otherwise something that is not your server is answering on that address.`;
      return false;
    };
    let settled = false;
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      client.removeListener("ready", onReady);
      client.removeListener("close", onClose);
      client.end();
      reject(mismatch ? new Error(mismatch) : error);
    };
    // A rejected host key can close the socket without an `error` of its own;
    // without this the promise would never settle and the caller would hang.
    const onClose = () => {
      if (settled) return;
      settled = true;
      client.removeListener("ready", onReady);
      client.removeListener("error", onError);
      reject(new Error(mismatch ?? `the connection to ${target.host}:${target.port} closed before it was ready`));
    };
    const onReady = () => {
      if (settled) return;
      settled = true;
      client.removeListener("error", onError);
      client.removeListener("close", onClose);
      resolve(client);
    };
    client.once("ready", onReady);
    client.once("error", onError);
    client.once("close", onClose);
    try {
      client.connect(connectConfig(target, verify));
    } catch (error) {
      reject(mismatch ? new Error(mismatch) : (error as Error));
    }
  });
}

/**
 * Pin the fingerprint a machine just presented, but only when nothing is pinned
 * yet — the "first use" half of trust-on-first-use. It never overwrites: a
 * record that already carries a fingerprint is the thing `connect` verifies
 * against, and a function that could quietly update it would undo the check.
 */
export async function pinHostKey(record: MachineRecord, fingerprint: string): Promise<void> {
  if (record.host_fingerprint) return;
  record.host_fingerprint = fingerprint;
  const registry = await readRegistry();
  const stored = registry.machines.find((machine) => machine.id === record.id);
  if (!stored || stored.host_fingerprint) return;
  stored.host_fingerprint = fingerprint;
  await writeRegistry(registry);
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function execCapture(client: Client, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      let code: number | null = null;
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });
      stream.on("exit", (exitCode: number | null) => {
        code = exitCode;
      });
      stream.on("close", () => resolve({ code, stdout, stderr }));
      stream.on("error", reject);
    });
  });
}

/** Runs `command` and hands every completed line to `onLine` as it arrives —
 * what makes the deploy log stream instead of appearing all at once at the end. */
export function execStream(client: Client, command: string, onLine: (line: string) => void): Promise<number | null> {
  return new Promise((resolve, reject) => {
    client.exec(command, { pty: false }, (error, stream) => {
      if (error) return reject(error);
      let code: number | null = null;
      let buffer = "";
      const push = (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        let at: number;
        while ((at = buffer.indexOf("\n")) !== -1) {
          onLine(buffer.slice(0, at).replace(/\r$/, ""));
          buffer = buffer.slice(at + 1);
        }
      };
      stream.on("data", push);
      stream.stderr.on("data", push);
      stream.on("exit", (exitCode: number | null) => {
        code = exitCode;
      });
      stream.on("close", () => {
        if (buffer.length > 0) onLine(buffer.replace(/\r$/, ""));
        resolve(code);
      });
      stream.on("error", reject);
    });
  });
}

export function sftpWrite(client: Client, remotePath: string, content: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(error);
      const stream = sftp.createWriteStream(remotePath, { mode });
      stream.once("close", () => resolve());
      stream.once("error", reject);
      stream.end(content);
    });
  });
}

/** Single-quote a value for a POSIX shell command line. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ── the key install (the one-time password step) ────────────────────────────

/** An OpenSSH public key line, and nothing else. Checked before the value is
 * ever put on a remote command line — a public key never contains a quote or a
 * newline, so anything that does is not one. */
export function isPublicKeyLine(value: string): boolean {
  return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+( [\w.@-]*)?$/.test(value.trim());
}

/**
 * `utils.generateKeyPairSync("ed25519", …)`, but never handing back a key its
 * own parser rejects.
 *
 * ssh2 drops a leading zero byte when it serialises the ed25519 key material
 * into the OpenSSH blob, so roughly one generated key in 140 comes out a byte
 * short and `parseKey` answers "Malformed OpenSSH private key". Measured on
 * this machine over 4000 keys: every good blob is 250 bytes, every bad one is
 * 249, and the bad rate was 28/4000 - about 2/256, which is what two 32-byte
 * fields each able to start with 0x00 predicts.
 *
 * Left alone this is not merely a flaky test. `addMachine` installs the public
 * half on the server BEFORE it proves the private half, so a bad key failed
 * only after the operator's one-time password had been spent and an unusable
 * line had already been appended to the box's authorized_keys.
 *
 * Generating again draws fresh bytes, so a bad draw is simply discarded. The
 * loop is bounded because an unbounded retry on a genuinely broken ssh2 would
 * hang the request instead of naming the problem.
 */
export function generateUsableKeyPair(comment: string): { public: string; private: string } {
  let lastError = "no attempt was made";
  for (let attempt = 0; attempt < 8; attempt++) {
    const pair = utils.generateKeyPairSync("ed25519", { comment });
    const parsed = utils.parseKey(pair.private);
    if (!(parsed instanceof Error)) return { public: pair.public, private: pair.private };
    lastError = parsed.message;
  }
  throw new Error(`could not generate a usable ed25519 key in 8 tries - the last one said: ${lastError}`);
}

/**
 * Appends `publicKey` to `~/.ssh/authorized_keys` on the far end, once. Running
 * it a second time is a no-op (`grep -qxF` finds the existing line), which is
 * what makes re-adding a machine safe.
 */
export async function installKey(client: Client, publicKey: string): Promise<void> {
  const line = publicKey.trim();
  if (!isPublicKeyLine(line)) {
    throw new Error("refusing to install a value that is not an OpenSSH public key line");
  }
  const command = [
    "set -e",
    'mkdir -p "$HOME/.ssh"',
    'chmod 700 "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    'chmod 600 "$HOME/.ssh/authorized_keys"',
    `grep -qxF ${shq(line)} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${shq(line)} >> "$HOME/.ssh/authorized_keys"`,
  ].join("; ");
  const result = await execCapture(client, command);
  if (result.code !== 0) {
    throw new Error(
      `could not install the app's key into ~/.ssh/authorized_keys (exit ${result.code}): ${
        (result.stderr || result.stdout).trim().split("\n").slice(-2).join(" ") || "no output"
      }`,
    );
  }
}

// ── the reachability probe ──────────────────────────────────────────────────

const PROBE_TTL_MS = 15_000;
const probeCache = new Map<string, { at: number; probe: MachineProbe }>();

function probeCommand(repoDir: string | null): string {
  const dir = repoDir ?? "$HOME/sdl-factory";
  return [
    `printf 'os=%s\\n' "$(uname -sr 2>/dev/null)"`,
    `printf 'whoami=%s\\n' "$(id -un 2>/dev/null)"`,
    `printf 'engine=%s\\n' "$(systemctl is-active sdl-engine 2>/dev/null || echo unknown)"`,
    `printf 'head=%s\\n' "$(git -C ${shq(dir)} rev-parse --short HEAD 2>/dev/null || echo none)"`,
    `printf 'branch=%s\\n' "$(git -C ${shq(dir)} rev-parse --abbrev-ref HEAD 2>/dev/null || echo none)"`,
  ].join("; ");
}

export function parseProbeOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const at = line.indexOf("=");
    if (at <= 0) continue;
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

export async function probeMachine(record: MachineRecord): Promise<MachineProbe> {
  const started = Date.now();
  let client: Client | null = null;
  try {
    if (!existsSync(record.key_path)) {
      return {
        reachable: false,
        checked_at: new Date().toISOString(),
        latency_ms: null,
        error: `the key this app authenticates with is missing at ${record.key_path} - re-add the machine to generate a new one`,
        os: null,
        engine: null,
        factory_head: null,
        factory_branch: null,
      };
    }
    const privateKey = await readFile(record.key_path, "utf-8");
    const seen = { fingerprint: null as string | null };
    client = await connect({
      host: record.host,
      port: record.port,
      user: record.user,
      privateKey,
      readyTimeoutMs: 6_000,
      expectFingerprint: record.host_fingerprint,
      onHostKey: (fingerprint) => {
        seen.fingerprint = fingerprint;
      },
    });
    if (seen.fingerprint) await pinHostKey(record, seen.fingerprint);
    const result = await execCapture(client, probeCommand(record.repo_dir));
    const fields = parseProbeOutput(result.stdout);
    const head = fields["head"];
    const branch = fields["branch"];
    return {
      reachable: true,
      checked_at: new Date().toISOString(),
      latency_ms: Date.now() - started,
      error: null,
      os: fields["os"] || null,
      engine: fields["engine"] || null,
      factory_head: head && head !== "none" ? head : null,
      factory_branch: branch && branch !== "none" ? branch : null,
    };
  } catch (error) {
    return {
      reachable: false,
      checked_at: new Date().toISOString(),
      latency_ms: null,
      error: (error as Error).message,
      os: null,
      engine: null,
      factory_head: null,
      factory_branch: null,
    };
  } finally {
    client?.end();
  }
}

async function cachedProbe(record: MachineRecord, refresh: boolean): Promise<MachineProbe> {
  const cached = probeCache.get(record.id);
  if (!refresh && cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.probe;
  const probe = await probeMachine(record);
  probeCache.set(record.id, { at: Date.now(), probe });
  return probe;
}

// ── the deploy job (jobs.ts's pattern, over ssh) ────────────────────────────

const MAX_LINES = 800;

/**
 * A deploy nobody can finish must not hold this machine forever.
 *
 * `startDeploy` returns the RUNNING job for a machine that already has one, so
 * a job wedged on the far end used to mean "Deploy again" silently no-opped for
 * that machine until the app server was restarted - and `DeployPanel` polled a
 * `running` state that would never change. bootstrap.sh's own guards make a
 * true hang unlikely (stdin </dev/null, a 600s apt lock timeout, `timeout 600`
 * on the engine warm) but not impossible: `uv sync` and `git fetch` on a
 * stalled network path have no ceiling of their own.
 *
 * Forty minutes is past any honest run: the two bounded waits above are ten
 * minutes each, and a cold apt+node+uv+just+clone+sync on a small VPS lands
 * inside fifteen. This is the backstop, not the schedule.
 */
const DEPLOY_TIMEOUT_MS = 40 * 60_000;

export interface DeployJob {
  id: string;
  machine_id: string;
  state: "running" | "done" | "failed";
  steps: DeployStep[];
  lines: string[];
  dropped: number;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  error: string | null;
  repo_url: string;
  branch: string;
  dir: string;
  // ── never in a view ──
  /** the live connection, so a cancel (or the timeout) can actually stop it */
  client: Client | null;
  cancelled: boolean;
  cancel_reason: string | null;
}

const deployJobs = new Map<string, DeployJob>();
/** machine id -> its most recent deploy job id, so the status route needs no
 * job id from the caller: a machine has one deploy at a time. */
const latestDeploy = new Map<string, string>();

/** `STEP apt OK installed git curl` -> a step row. Anything else is log noise
 * and returns null — the parser never guesses. */
export function parseStepLine(line: string): DeployStep | null {
  const match = /^STEP\s+(\S+)\s+(OK|FAIL)(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  return {
    name: match[1]!,
    state: match[2] === "OK" ? "ok" : "fail",
    detail: (match[3] ?? "").trim(),
    at: new Date().toISOString(),
  };
}

export function deployView(job: DeployJob): DeployJobView {
  return {
    job_id: job.id,
    machine_id: job.machine_id,
    state: job.state,
    steps: job.steps,
    lines: job.lines,
    dropped: job.dropped,
    started_at: job.started_at,
    finished_at: job.finished_at,
    exit_code: job.exit_code,
    error: job.error,
    repo_url: job.repo_url,
    branch: job.branch,
    dir: job.dir,
  };
}

export interface DeployInput {
  repoUrl: string;
  branch: string;
  dir: string;
  /** the script's text; injected so a test can run a stand-in and so a missing
   * script file is one honest error rather than a mystery */
  script: string;
  /**
   * The project's checkout on THIS laptop - the repository the adoption phase
   * works in before any SSH happens (see `adopt.ts`). `null` says there is
   * nothing local to adopt and the job goes straight to provisioning; the only
   * callers that pass `null` are tests exercising the SSH phase on its own.
   */
  projectRoot: string | null;
}

/**
 * Starts a deploy and returns its record synchronously (`state: "running"`),
 * mutating it in place as the far end talks — the same shape `jobs.ts` uses, so
 * the UI's poll is the same poll.
 *
 * Only one deploy per machine may be in flight: a second request while one runs
 * returns the running one rather than starting a competing apt transaction.
 */
export function startDeploy(record: MachineRecord, input: DeployInput): DeployJob {
  const existingId = latestDeploy.get(record.id);
  const existing = existingId ? deployJobs.get(existingId) : undefined;
  if (existing && existing.state === "running") return existing;

  const job: DeployJob = {
    id: crypto.randomUUID(),
    machine_id: record.id,
    state: "running",
    steps: [],
    lines: [],
    dropped: 0,
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    error: null,
    repo_url: input.repoUrl,
    branch: input.branch,
    dir: input.dir,
    client: null,
    cancelled: false,
    cancel_reason: null,
  };
  deployJobs.set(job.id, job);
  latestDeploy.set(record.id, job.id);

  const append = (line: string) => {
    if (job.lines.length >= MAX_LINES) {
      job.lines.shift();
      job.dropped += 1;
    }
    job.lines.push(line);
    const step = parseStepLine(line);
    if (step) job.steps.push(step);
  };

  void (async () => {
    let client: Client | null = null;
    const timer = setTimeout(() => {
      cancelDeploy(record.id, `nothing finished this deploy within ${Math.round(DEPLOY_TIMEOUT_MS / 60_000)} minutes, so it was stopped`);
    }, DEPLOY_TIMEOUT_MS);
    try {
      // ── the local phase, before one byte leaves this laptop ──────────────
      // A project that has never had an `integration` branch gets one here,
      // cut from wherever its newest work actually lives and pushed - the
      // operator runs no git command, and if this cannot be done honestly the
      // job fails with git's own words BEFORE anything is provisioned, so
      // there is never a half-deploy to explain. See `adopt.ts`.
      let adopted: AdoptOutcome | null = null;
      if (input.projectRoot) {
        // Cancel is threaded IN rather than only checked afterwards. A git
        // subprocess already in flight cannot be taken back, so the honest
        // guarantee is narrower than "Cancel undoes this": adoption asks
        // between its steps and stops before the push, which is the only point
        // where "origin was not touched" is still true.
        adopted = await adoptIntegrationBranch(input.projectRoot, input.branch, append, () =>
          job.cancelled ? (job.cancel_reason ?? "you cancelled this deploy") : null,
        );
        if (!adopted.ok) {
          throw new Error(adopted.error ?? `could not prepare '${input.branch}' in ${input.projectRoot}`);
        }
      }
      // Cancelled after the adoption finished. NOTHING HERE IS ROLLED BACK, and
      // the operator is told so rather than left to assume Cancel meant undo:
      // if the push landed, `<branch>` is on his real origin now. That is safe
      // (it only ever ADDS a branch, never rewrites one) and the next deploy
      // reads it as row 1 of the decision table - already there, nothing to do.
      if (job.cancelled) {
        const landed = adopted?.pushed
          ? ` - '${input.branch}' had already reached origin by then and was left in place; the next deploy will use it`
          : "";
        throw new Error(`${job.cancel_reason ?? "this deploy was cancelled"}${landed}`);
      }

      const privateKey = await readFile(record.key_path, "utf-8");
      append(`connecting to ${record.user}@${record.host}:${record.port}`);
      const seen = { fingerprint: null as string | null };
      client = await connect({
        host: record.host,
        port: record.port,
        user: record.user,
        privateKey,
        readyTimeoutMs: 20_000,
        expectFingerprint: record.host_fingerprint,
        onHostKey: (fingerprint) => {
          seen.fingerprint = fingerprint;
        },
      });
      job.client = client;
      // Cancelled while the connect was still in flight: there was no
      // connection to drop when the button was pressed, so the stop happens
      // here instead and nothing is ever uploaded or run.
      if (job.cancelled) {
        append("cancelled before the bootstrap was uploaded");
        throw new Error(job.cancel_reason ?? "this deploy was cancelled");
      }
      if (seen.fingerprint) {
        await pinHostKey(record, seen.fingerprint);
        append(`host key ${seen.fingerprint} - the one pinned for this machine`);
      }
      const remoteScript = ".sdl-factory-bootstrap.sh";
      // CRLF would make dash choke on the shebang and on every `then`. The
      // script is written LF in the repo; normalising here means a checkout on
      // a Windows laptop with core.autocrlf=true still deploys.
      await sftpWrite(client, remoteScript, input.script.replace(/\r\n/g, "\n"), 0o700);
      append(`uploaded ${remoteScript} (${input.script.length} bytes)`);

      const command = `sh ${shq(remoteScript)} ${shq(input.repoUrl)} ${shq(input.branch)} ${shq(input.dir)}`;
      append(`$ ${command}`);
      const code = await execStream(client, command, append);
      job.exit_code = code;
      const complete = job.lines.some((line) => line.trim() === "DEPLOY COMPLETE");
      job.state = code === 0 && complete ? "done" : "failed";
      if (job.state === "failed" && job.error === null) {
        const failed = job.steps.find((step) => step.state === "fail");
        job.error = job.cancelled
          ? (job.cancel_reason ?? "this deploy was cancelled")
          : failed
            ? `step ${failed.name} failed: ${failed.detail}`
            : `the bootstrap exited ${code} without printing DEPLOY COMPLETE`;
      }
    } catch (error) {
      job.state = "failed";
      job.error = job.cancelled ? (job.cancel_reason ?? (error as Error).message) : (error as Error).message;
      append(`error: ${job.error}`);
    } finally {
      clearTimeout(timer);
      client?.end();
      job.client = null;
      job.finished_at = new Date().toISOString();
    }
  })();

  return job;
}

/**
 * Stop a running deploy: drop the SSH connection, which kills the remote `sh`
 * with it, and let the job settle as `failed` with the reason said out loud.
 *
 * Dropping the connection is the stop that always works - `sshd` may refuse a
 * signal on an exec channel, and a bootstrap that ignored one would leave this
 * machine locked out of "Deploy again" for the life of the process. Nothing on
 * the far end is rolled back: every bootstrap step is idempotent by
 * construction, so the next deploy converges from wherever this one stopped.
 */
export function cancelDeploy(machineId: string, reason?: string): DeployJob | null {
  const job = getDeploy(machineId);
  if (!job) return null;
  if (job.state !== "running") return job;
  job.cancelled = true;
  job.cancel_reason = reason ?? "you cancelled this deploy";
  job.client?.end();
  return job;
}

export function getDeploy(machineId: string): DeployJob | null {
  const id = latestDeploy.get(machineId);
  return id ? (deployJobs.get(id) ?? null) : null;
}

// ── add a machine (connect, install key, save) ──────────────────────────────

export interface AddOutcome {
  ok: boolean;
  error?: string;
  record?: MachineRecord;
  /** the plain-words sentences the modal prints as it goes */
  steps: string[];
}

/**
 * The "I put in the IP together with the password and I click connect" path.
 *
 * Order matters and is the whole point: connect with the password -> generate a
 * key -> install its public half -> **disconnect and reconnect with the key**
 * -> only then write anything to disk. A key that has not been proven to work
 * is never saved, so the registry can never hold a machine this app cannot
 * reach.
 *
 * This is also where the server's host key is pinned. The first connect accepts
 * whatever key the box presents (there is nothing yet to compare it to) and
 * remembers its fingerprint; the key-only reconnect is then required to answer
 * with the SAME key, and so is every connect this app makes afterwards. Adding a
 * machine this app already knows demands the pinned key up front: a box whose
 * host key changed fails here by name rather than being handed a password.
 */
export async function addMachine(request: NewMachineRequest): Promise<AddOutcome> {
  const steps: string[] = [];
  const host = (request.host ?? "").trim();
  if (!host) return { ok: false, error: "a host or IP address is required", steps };
  const user = (request.user ?? "").trim() || "root";
  const port = Number.isFinite(request.port) && (request.port ?? 0) > 0 ? Number(request.port) : 22;
  const name = (request.name ?? "").trim() || host;
  const password = typeof request.password === "string" && request.password.length > 0 ? request.password : null;
  const suppliedKeyPath = (request.key_path ?? "").trim();

  if (!password && !suppliedKeyPath) {
    return {
      ok: false,
      error: "either a password (used once, never stored) or the path to an existing private key is required",
      steps,
    };
  }

  const id = machineId(host, user, port);
  let keyPath = suppliedKeyPath;
  let keyGenerated = false;

  // A machine this app already knows keeps its pinned host key across a re-add;
  // `seen` is filled by the first connect for a machine it does not.
  const known = (await readRegistry()).machines.find((machine) => machine.id === id) ?? null;
  const seen = { fingerprint: known?.host_fingerprint ?? null };
  const remember = (fingerprint: string) => {
    seen.fingerprint = seen.fingerprint ?? fingerprint;
  };

  let client: Client | null = null;
  try {
    if (suppliedKeyPath) {
      if (!existsSync(suppliedKeyPath)) {
        return { ok: false, error: `no private key at ${suppliedKeyPath}`, steps };
      }
      const privateKey = await readFile(suppliedKeyPath, "utf-8");
      client = await connect({
        host,
        port,
        user,
        privateKey,
        expectFingerprint: known?.host_fingerprint ?? null,
        onHostKey: remember,
      });
      steps.push(`Connected to ${user}@${host}:${port} with the key at ${suppliedKeyPath}.`);
      steps.push(`Pinned this server's host key: ${seen.fingerprint ?? "unknown"}.`);
    } else {
      client = await connect({
        host,
        port,
        user,
        password: password!,
        expectFingerprint: known?.host_fingerprint ?? null,
        onHostKey: remember,
      });
      steps.push(`Connected to ${user}@${host}:${port} with the password you typed.`);
      steps.push(
        `Pinned this server's host key: ${seen.fingerprint ?? "unknown"} - every later connection must answer with it.`,
      );

      const pair = generateUsableKeyPair(`sdl-factory-app-${id}`);
      steps.push("Generated an ed25519 key for this app alone.");

      await installKey(client, pair.public);
      steps.push("Installed its public half in the server's ~/.ssh/authorized_keys.");

      // Prove the key before trusting it: a fresh connection, key only.
      client.end();
      client = null;
      const verify = await connect({
        host,
        port,
        user,
        privateKey: pair.private,
        expectFingerprint: seen.fingerprint,
      });
      const echo = await execCapture(verify, "printf 'sdl-factory-key-ok\\n'");
      verify.end();
      if (echo.code !== 0 || !echo.stdout.includes("sdl-factory-key-ok")) {
        return {
          ok: false,
          error:
            "the key was installed but a key-only connection did not come back - check the server's sshd config for PubkeyAuthentication",
          steps,
        };
      }
      steps.push("Reconnected using only that key - the password is done and was never written anywhere.");

      await mkdir(keyDir(), { recursive: true });
      keyPath = join(keyDir(), id);
      await writeFile(keyPath, pair.private, { encoding: "utf-8", mode: 0o600 });
      await writeFile(`${keyPath}.pub`, `${pair.public}\n`, { encoding: "utf-8", mode: 0o644 });
      // Windows ignores the mode on create; chmod is a no-op there and the real
      // protection is the user profile's ACL. On Linux and macOS it matters.
      await chmod(keyPath, 0o600).catch(() => {});
      keyGenerated = true;
      steps.push(`Saved that key at ${keyPath} (0600). It never enters git.`);
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message, steps };
  } finally {
    client?.end();
  }

  // Re-read: the connects above may have taken time, and this is the copy that
  // gets written back.
  const registry = await readRegistry();
  const previous = registry.machines.find((machine) => machine.id === id);
  const record: MachineRecord = {
    id,
    name,
    host,
    port,
    user,
    key_path: keyPath,
    key_generated: keyGenerated || (previous?.key_generated ?? false),
    added_at: previous?.added_at ?? new Date().toISOString(),
    last_connected_at: new Date().toISOString(),
    repo_dir: previous?.repo_dir ?? null,
    host_fingerprint: seen.fingerprint ?? previous?.host_fingerprint ?? null,
  };
  registry.machines = [...registry.machines.filter((machine) => machine.id !== id), record];
  if (registry.default_machine === null) registry.default_machine = id;
  await writeRegistry(registry);
  steps.push(previous ? "Updated this machine in the registry." : "Added this machine to the registry.");

  probeCache.delete(id);
  return { ok: true, record, steps };
}

// ── per-project binding ("Runs on") ─────────────────────────────────────────

/** The manifest's project entry, plus the additive field this file writes.
 * Declared here rather than edited into `manifest.ts` so the binding needs no
 * change to a file this lane does not own; `readManifest` already passes
 * unknown project fields through verbatim, so the value round-trips. */
type BoundProject = ManifestProject & { machine_id?: string | null };

export async function readBindings(): Promise<Record<string, string>> {
  const manifest = await readManifest();
  const out: Record<string, string> = {};
  for (const project of manifest.projects as BoundProject[]) {
    if (typeof project.machine_id === "string" && project.machine_id) out[project.id] = project.machine_id;
  }
  return out;
}

export async function bindProject(projectId: string, machineIdOrNull: string | null): Promise<string | null> {
  const manifest = await readManifest();
  const projects = manifest.projects as BoundProject[];
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) return `no project ${projectId}`;
  project.machine_id = machineIdOrNull;
  await writeManifest({ ...manifest, projects: projects as ManifestProject[] });
  return null;
}

// ── the rows the UI renders ─────────────────────────────────────────────────

/** The constant local row. It is a statement about the model, not a probe:
 * planning happens on the laptop, factory execution happens on a server. */
export function localRow(): MachineRegistryRow {
  return {
    id: "localhost",
    name: hostname() || "localhost",
    kind: "local",
    role: "planning only - no factory",
    host: null,
    port: null,
    user: null,
    key_path: null,
    key_generated: false,
    added_at: null,
    last_connected_at: null,
    repo_dir: null,
    host_fingerprint: null,
    probe: null,
    probe_reason: "this machine runs the app; nothing to reach over the network",
    deploy: null,
    // Providers are synced TO a factory machine. This row is not one, so the
    // field is null rather than an empty run that would read as "nothing
    // landed here yet".
    providers: null,
  };
}

export function toRow(
  record: MachineRecord,
  probe: MachineProbe | null,
  deploy: DeployJobView | null,
  providers: MachineProviderSync | null,
): MachineRegistryRow {
  return {
    id: record.id,
    name: record.name,
    kind: "server",
    role: "factory execution",
    host: record.host,
    port: record.port,
    user: record.user,
    key_path: record.key_path,
    key_generated: record.key_generated,
    added_at: record.added_at,
    last_connected_at: record.last_connected_at,
    repo_dir: record.repo_dir,
    host_fingerprint: record.host_fingerprint,
    probe,
    probe_reason:
      probe === null ? "not probed on this read - ask for it with ?probe=1" : null,
    deploy,
    providers,
  };
}

// ── routes ──────────────────────────────────────────────────────────────────

function boolQuery(req: Request, key: string, fallback: boolean): boolean {
  const raw = new URL(req.url).searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

async function listMachines(req: Request): Promise<Response> {
  const wantProbe = boolQuery(req, "probe", true);
  const refresh = boolQuery(req, "refresh", false);
  const registry = await readRegistry();

  const rows: MachineRegistryRow[] = [localRow()];
  const probes = await Promise.all(
    registry.machines.map(async (record) => (wantProbe ? cachedProbe(record, refresh) : null)),
  );
  // One read for the whole list: the sync log is a single small file, and a
  // per-row read of it would open it once per machine for no new fact.
  const syncLog = await readProviderSyncLog();
  registry.machines.forEach((record, index) => {
    const job = getDeploy(record.id);
    rows.push(toRow(record, probes[index] ?? null, job ? deployView(job) : null, providerSyncSummary(syncLog[record.id])));
  });

  const response: MachinesRegistryResponse = {
    machines: rows,
    default_machine: registry.default_machine,
    bindings: await readBindings(),
    registry_path: registryPath(),
    key_dir: keyDir(),
    reason:
      registry.machines.length === 0
        ? `no server is registered yet (${registryPath()} holds none) - Add server takes an IP, a user and the box's password, uses that password once to install this app's own key, and never writes the password anywhere`
        : null,
  };
  return appJson(response);
}

async function postMachine(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return appError("invalid JSON body");
  }
  const outcome = await addMachine((body ?? {}) as NewMachineRequest);
  if (!outcome.ok) return appJson({ error: outcome.error, steps: outcome.steps }, 400);
  return appJson({ machine: outcome.record, steps: outcome.steps }, 201);
}

async function deleteMachine(req: Request): Promise<Response> {
  const id = param(req, "machine_id");
  const registry = await readRegistry();
  const record = registry.machines.find((machine) => machine.id === id);
  if (!record) return appError(`no machine ${id}`, 404);

  registry.machines = registry.machines.filter((machine) => machine.id !== id);
  if (registry.default_machine === id) registry.default_machine = registry.machines[0]?.id ?? null;
  await writeRegistry(registry);
  probeCache.delete(id);

  // Bindings that pointed here would otherwise name a machine that no longer
  // exists; they are cleared so no project claims to run on a ghost.
  const bindings = await readBindings();
  for (const [projectId, machineIdValue] of Object.entries(bindings)) {
    if (machineIdValue === id) await bindProject(projectId, null);
  }

  return appJson({
    removed: id,
    note: record.key_generated
      ? `Removed from this laptop's registry only. ${record.host} still has this app's public key in ~/.ssh/authorized_keys and the private half is still at ${record.key_path} - this app does not touch a server it has been told to forget.`
      : `Removed from this laptop's registry only. Nothing on ${record.host} was changed.`,
  });
}

async function postDefault(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return appError("invalid JSON body");
  }
  const wanted = (body as { machine_id?: unknown } | null)?.machine_id;
  const registry = await readRegistry();
  if (wanted !== null && typeof wanted !== "string") return appError("machine_id must be a string or null");
  if (typeof wanted === "string" && !registry.machines.some((machine) => machine.id === wanted)) {
    return appError(`no machine ${wanted}`, 404);
  }
  registry.default_machine = (wanted as string | null) ?? null;
  await writeRegistry(registry);
  return appJson({ default_machine: registry.default_machine });
}

async function postBinding(req: Request): Promise<Response> {
  const projectId = param(req, "id");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return appError("invalid JSON body");
  }
  const wanted = (body as { machine_id?: unknown } | null)?.machine_id;
  if (wanted !== null && typeof wanted !== "string") return appError("machine_id must be a string or null");
  if (typeof wanted === "string" && wanted) {
    const registry = await readRegistry();
    if (!registry.machines.some((machine) => machine.id === wanted)) return appError(`no machine ${wanted}`, 404);
  }
  const error = await bindProject(projectId, (wanted as string | null) || null);
  if (error) return appError(error, 404);
  return appJson({ project_id: projectId, machine_id: (wanted as string | null) || null });
}

/** The laptop's own `git remote get-url origin` — the server clones exactly
 * what this checkout already points at, never a URL typed twice. */
export async function originUrl(root: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  const url = stdout.trim();
  return url === "" ? null : url;
}

/**
 * "Does origin have this branch?" lives in `adopt.ts` now, beside the code that
 * ACTS on the answer, and is re-exported here because this module's own tests
 * (and any future caller of the machines plane) ask it by this name.
 */
export { remoteHasBranch } from "./adopt.ts";

/** `https://host/owner/repo.git` -> `repo`; used for the remote checkout dir so
 * two projects on one box do not collide. */
export function repoDirName(url: string): string {
  const trimmed = url.replace(/\/+$/, "").replace(/\.git$/i, "");
  const tail = trimmed.split(/[\\/:]/).pop() ?? "";
  const cleaned = tail.replace(/[^A-Za-z0-9._-]/g, "-");
  return cleaned || "sdl-factory";
}

async function postDeploy(req: Request): Promise<Response> {
  const id = param(req, "machine_id");
  const registry = await readRegistry();
  const record = registry.machines.find((machine) => machine.id === id);
  if (!record) return appError(`no machine ${id}`, 404);

  let body: MachineDeployRequest;
  try {
    body = ((await req.json()) ?? {}) as MachineDeployRequest;
  } catch {
    return appError("invalid JSON body");
  }

  const projectId = (body.project_id ?? "").trim();
  if (!projectId) return appError("project_id is required - the server clones this project's own origin");
  const project = await findProject(projectId);
  if (!project) return appError(`no project ${projectId}`, 404);

  const repoUrl = await originUrl(project.root);
  if (!repoUrl) {
    return appError(
      `${project.root} has no 'origin' remote - the server can only clone what this checkout points at, so add one first`,
      409,
    );
  }
  if (repoUrl.startsWith("/") || /^[A-Za-z]:[\\/]/.test(repoUrl)) {
    return appError(
      `this project's origin is a local path (${repoUrl}) - a server cannot clone it; push the repo somewhere the server can reach first`,
      409,
    );
  }

  const scriptPath = bootstrapPath();
  if (!existsSync(scriptPath)) return appError(`the bootstrap script is missing at ${scriptPath}`, 500);
  const script = await readFile(scriptPath, "utf-8");

  const branch = (body.branch ?? "").trim() || "integration";
  // The one thing about `branch` that IS refused here, at the door. It is a
  // freeform string from a request body that ends up in git's argv, and git
  // reads a leading '-' as an option: `branch: "-f"` would turn the adoption's
  // `git push -u origin <branch>` into `git push -u origin --force` of the
  // current branch - a rewrite of the operator's own remote history, which is
  // the exact loss this whole module exists to prevent. `adopt.ts` also puts
  // `--` in front of every ref it hands git, so this is the second lock, not
  // the only one; it is here because a request refused in milliseconds with a
  // reason beats a job that fails a minute later with git's confusion.
  const badBranch = branchNameProblem(branch);
  if (badBranch) return appError(badBranch);

  // NOTHING IS REFUSED HERE FOR A MISSING BRANCH ANY MORE. This handler used
  // to answer 409 with four git commands for the operator to type when origin
  // had no `integration`; the operator never opens a terminal, so that refusal
  // was a dead end dressed as help. The deploy job now ADOPTS the repository
  // itself (`adopt.ts`): it commits whatever is uncommitted, cuts the branch
  // from the newest work it can find, and pushes - streamed as STEP lines he
  // watches. The two states adoption genuinely cannot fix (no `origin` at all,
  // an `origin` that is a local path no server could clone) are the two
  // refusals above, and they stay.
  //
  // It also has to happen in the JOB and not here: a fetch plus a push can run
  // longer than `Bun.serve`'s 10s idleTimeout, and this response must return in
  // milliseconds with a job id the pane can poll.

  // An explicitly requested directory wins. The default is derived from the
  // user because root's home is `/root`, not `/home/root` - and a deploy that
  // cloned into a directory nobody owns would fail on the first write.
  const remoteDir =
    (body.dir ?? "").trim() ||
    (record.user === "root" ? `/root/${repoDirName(repoUrl)}` : `/home/${record.user}/${repoDirName(repoUrl)}`);

  const job = startDeploy(record, { repoUrl, branch, dir: remoteDir, script, projectRoot: project.root });

  // Remember where the checkout lives so the probe can read its HEAD later.
  if (record.repo_dir !== remoteDir) {
    record.repo_dir = remoteDir;
    await writeRegistry(registry);
  }

  return appJson(deployView(job), 202);
}

async function postDeployCancel(req: Request): Promise<Response> {
  const id = param(req, "machine_id");
  const job = cancelDeploy(id);
  if (!job) return appError(`no deploy has been started for machine ${id} from this app`, 404);
  return appJson(deployView(job));
}

async function getDeployStatus(req: Request): Promise<Response> {
  const id = param(req, "machine_id");
  const job = getDeploy(id);
  if (!job) {
    return appJson({
      machine_id: id,
      state: "none" as const,
      reason: "no deploy has been started for this machine from this app since it last started",
    });
  }
  return appJson(deployView(job));
}

export function machinesRoutes(token: string, selfOrigins: ReadonlySet<string>) {
  return {
    "/api/app/machines": {
      GET: appSafely(listMachines),
      POST: csrfGuard(token, selfOrigins, postMachine),
    },
    // Deliberately NOT `/api/app/machines/default`: that would be a static
    // sibling of `/api/app/machines/:machine_id` and the two would race in the
    // router for any request whose method only one of them declares.
    "/api/app/default-machine": {
      POST: csrfGuard(token, selfOrigins, postDefault),
    },
    "/api/app/machines/:machine_id": {
      DELETE: csrfGuard(token, selfOrigins, deleteMachine),
    },
    "/api/app/machines/:machine_id/deploy": {
      POST: csrfGuard(token, selfOrigins, postDeploy),
    },
    "/api/app/machines/:machine_id/deploy/status": {
      GET: appSafely(getDeployStatus),
    },
    "/api/app/machines/:machine_id/deploy/cancel": {
      POST: csrfGuard(token, selfOrigins, postDeployCancel),
    },
    "/api/app/p/:id/machine": {
      POST: csrfGuard(token, selfOrigins, postBinding),
    },
  };
}
