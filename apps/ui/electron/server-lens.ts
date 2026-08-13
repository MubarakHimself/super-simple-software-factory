/**
 * Server lens v1 (spec 5). Configuration lives in a `server.json` in
 * userData, written and read ONLY by main - the Bun server stays GET-only
 * and never learns this file exists (spec 5: "Configuration is written and
 * read by main ... never by the Bun server"). No password, passphrase, or
 * token field, ever (spec 5.1): if a key needs a passphrase, ssh prompts
 * for it in the pty where it belongs.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { which } from "./which.js";

export interface ServerConfig {
  host: string;
  keyPath: string;
  remotePort: number;
  localPort: number;
}

/** `localPort` deliberately not 4700 (spec 5.4) - the different port is what
 * makes the tunnel a different origin, which is what makes the origin gate
 * deny it action capability automatically. */
export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  host: "",
  keyPath: "",
  remotePort: 4700,
  localPort: 4701,
};

export function loadServerConfig(path: string): ServerConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ServerConfig>;
    return {
      host: typeof raw.host === "string" ? raw.host : DEFAULT_SERVER_CONFIG.host,
      keyPath: typeof raw.keyPath === "string" ? raw.keyPath : DEFAULT_SERVER_CONFIG.keyPath,
      remotePort: typeof raw.remotePort === "number" ? raw.remotePort : DEFAULT_SERVER_CONFIG.remotePort,
      localPort: typeof raw.localPort === "number" ? raw.localPort : DEFAULT_SERVER_CONFIG.localPort,
    };
  } catch {
    return { ...DEFAULT_SERVER_CONFIG }; // first launch, or a corrupt/missing file
  }
}

export function saveServerConfig(path: string, config: ServerConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

/** Honest field-level validation - no secret fields to validate (spec 5.1
 * has none), just enough to give ssh a fighting chance of a clear error
 * instead of an opaque one. */
export function validateServerConfig(config: ServerConfig): string | null {
  if (!config.host.trim()) return "host is required, e.g. root@203.0.113.10";
  if (!config.keyPath.trim()) return "keyPath is required (path to a private key file)";
  if (!Number.isInteger(config.remotePort) || config.remotePort <= 0 || config.remotePort > 65535) {
    return "remotePort must be a port number (1-65535)";
  }
  if (!Number.isInteger(config.localPort) || config.localPort <= 0 || config.localPort > 65535) {
    return "localPort must be a port number (1-65535)";
  }
  return null;
}

/** The exact remote command spec 5.2 documents - a fixed literal, never
 * built from operator-supplied text. host/keyPath are separate ssh argv
 * entries (spawned without a shell), never concatenated into this string -
 * there is nowhere for an injection to happen. */
const DEPLOY_REMOTE_COMMAND = "cd ~/sdl-factory && uv run installer/install.py --target server";

export interface SshCommand {
  file: string;
  args: string[];
}

/** null only when `ssh` itself is not on PATH - the caller must fail
 * visibly (spec 3.3's "fail visibly" discipline, same one the Terminal
 * profiles use), never silently. Spec 2.3 already confirmed ssh.exe ships
 * with Windows; this still checks for real rather than assuming it. */
export function findSsh(): string | null {
  return which("ssh");
}

/** spec 5.2: `ssh -tt -i <keyPath> <host> "<remote command>"` - `-tt` forces
 * a remote tty so the wizard's own prompts and Ctrl-C both work end to end
 * over the connection. */
export function deployCommand(sshPath: string, config: ServerConfig): SshCommand {
  return { file: sshPath, args: ["-tt", "-i", config.keyPath, config.host, DEPLOY_REMOTE_COMMAND] };
}

// ---------------------------------------------------------------------------
// Connect: an app-managed ssh port-forward (spec 5.3). Not a pty - `-N`
// opens no shell of its own, so there is no interactive session to give a
// tty to (a passphrase prompt on this path is a known, documented v1 gap;
// spec 5.5: "no ssh-agent handling ... ssh's own prompts stand").
// ---------------------------------------------------------------------------

export type TunnelState = "idle" | "connecting" | "connected" | "closed" | "error";

export interface TunnelStatus {
  state: TunnelState;
  origin: string | null; // e.g. "http://127.0.0.1:4701" once connected
  message: string | null; // last honest line - real error text, never invented
}

/** Owns at most one ssh -N -L child (spec 5.5: "no fleet ... exactly one
 * server config"). Lives in main only, same as PtyManager - the Bun server
 * never sees this process either. */
export class ServerTunnel {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private state: TunnelState = "idle";
  private message: string | null = null;
  private origin: string | null = null;
  private stderrTail = "";

  status(): TunnelStatus {
    return { state: this.state, origin: this.origin, message: this.message };
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  /** Spawns the forward. Resolves the *spawn*, not the tunnel's health - the
   * caller polls the forwarded /api/health separately (spec 5.3) before
   * treating it as usable, since ssh can still fail auth or DNS seconds
   * after a clean spawn. Returns an honest error string instead of
   * throwing when ssh itself is missing or a tunnel is already running. */
  start(config: ServerConfig): string | null {
    if (this.child) return "a tunnel is already running - disconnect first";
    const sshPath = findSsh();
    if (!sshPath) return "'ssh' was not found on PATH";
    this.state = "connecting";
    this.message = null;
    this.stderrTail = "";
    const forward = `127.0.0.1:${config.localPort}:127.0.0.1:${config.remotePort}`;
    const child = spawn(sshPath, ["-N", "-L", forward, "-i", config.keyPath, config.host], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.origin = `http://127.0.0.1:${config.localPort}`;
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf-8")).slice(-2000);
    });
    child.on("error", (error) => {
      if (this.child !== child) return; // superseded by a later start()/stop()
      this.child = null;
      this.origin = null;
      this.state = "error";
      this.message = `could not start ssh: ${error.message}`;
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.origin = null;
      this.state = code === 0 || code === null ? "closed" : "error";
      this.message = this.stderrTail.trim() || (code === 0 ? "tunnel closed" : `ssh exited with code ${code}`);
    });
    return null;
  }

  /** Called once the forwarded /api/health has actually answered - only
   * then is the tunnel "connected" rather than merely "spawned". */
  markConnected(): void {
    if (this.child) this.state = "connected";
  }

  /** Idempotent - killing an already-idle tunnel is a no-op, matching
   * PtyManager.close()'s style. This is the OPERATOR-initiated path
   * (Disconnect) - "not connected" is the honest state to land in, because
   * nothing failed. A CONNECT ATTEMPT that never became healthy must go
   * through fail() instead (spec 5.5's "a dead tunnel is visible, never
   * papered over" - "idle" would read as "never tried"). */
  stop(): void {
    const child = this.child;
    this.child = null;
    this.state = "idle";
    this.message = null;
    this.origin = null;
    if (child && child.exitCode === null) child.kill();
  }

  /** Kills the child (if any) and lands the tunnel in "error" with an
   * explicit, honest reason - never "idle" (spec finding: CONNECT STATUS
   * HONESTY). Used when server:connect's health poll times out: the ssh
   * child may already have exited with its own real error (in which case
   * `message` here is that stderr tail, already set by the exit handler
   * above and left untouched), or it may still be running but the
   * forwarded port never answered - either way the caller supplies the
   * fallback reason and the operator sees "error" plus a Reconnect button
   * on the very next status poll, not a silent reset to "not connected". */
  fail(message: string): void {
    const child = this.child;
    this.child = null;
    this.origin = null;
    this.state = "error";
    this.message = this.message ?? message;
    if (child && child.exitCode === null) child.kill();
  }
}
