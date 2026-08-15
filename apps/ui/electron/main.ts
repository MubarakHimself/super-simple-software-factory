/**
 * SDL Factory desktop shell (the operator's "ADE") - Electron main process.
 *
 * This is a thin wrapper around the same read-only ui server `just ui` runs.
 * It never embeds a copy of the server or the built SPA: at startup it walks
 * up from its own location to find the sdl-factory repo (a directory holding
 * both `justfile` and `installer/install.py` - loosened from also requiring
 * sssf.db, spec 4.3: that db is one of the things Setup produces, not a
 * precondition for finding the repo at all), then either shows the Setup
 * screen (spec 4) or spawns THAT repo's `bun run server/index.ts --db
 * <resolved path>` exactly as `just ui` does, and opens a BrowserWindow.
 *
 * If a server is already answering /api/health (operator already ran
 * `just ui`), that server is reused untouched and nothing is spawned or
 * killed by this process. If this process did the spawning, the child is
 * killed on quit - never otherwise, so a manually-started `just ui` keeps
 * running after the window closes.
 *
 *   bunx electron .               normal launch (see justfile: `just ade`)
 *   bunx electron . --smoke       headless-safe boot check: create the
 *                                 window, verify health, print
 *                                 ADE_SMOKE_OK, exit 0. Deliberately skips
 *                                 the Setup gate (see boot()'s comment).
 *   bunx electron . --pty-smoke   spawns a real pty via the shipped
 *                                 PtyManager/profiles code, headless.
 *   bunx electron . --setup-smoke runs the real install.py --verify-only
 *                                 --json drift check, then proves the Setup
 *                                 pty path with a real --dry-run (zero side
 *                                 effects) through the shipped PtyManager.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PtyManager } from "./pty.js";
import { loadUserProfileOverrides, resolveProfile } from "./profiles.js";
import { detectSetup, isInstallTarget } from "./setup.js";
import {
  deployCommand,
  findSsh,
  loadServerConfig,
  saveServerConfig,
  ServerTunnel,
  validateServerConfig,
  type ServerConfig,
} from "./server-lens.js";
import { which } from "./which.js";

const HOSTNAME = "127.0.0.1";
const PORT = 4700;
const HEALTH_URL = `http://${HOSTNAME}:${PORT}/api/health`;
const APP_URL = `http://${HOSTNAME}:${PORT}/`;
const APP_ORIGIN = new URL(APP_URL).origin;

/** v3 desktop mode - explicit opt-in only, mirroring the server's own
 * explicit-flag rule: either the SDL_UI env (the `just app3` dev recipe) or a
 * ui-mode.json marker deliberately written next to the compiled main by
 * `just app3-build` (so the packaged .exe is v3 without anyone setting env
 * vars). A build ARTIFACT, never directory presence. */
function packagedUiModeIsV3(): boolean {
  try {
    const raw = readFileSync(join(import.meta.dirname, "ui-mode.json"), "utf-8");
    return (JSON.parse(raw) as { ui?: string }).ui === "v3";
  } catch {
    return false;
  }
}
const UI_V3 = process.env.SDL_UI === "v3" || packagedUiModeIsV3();

const HEALTH_CHECK_TIMEOUT_MS = 1_500; // one probe
const BOOT_TIMEOUT_MS = 20_000; // spawn-and-wait budget; leaves headroom under --smoke's ~30s
const CONNECT_TIMEOUT_MS = 10_000; // ssh handshake + auth budget for the port-forward (spec 5.3)
const POLL_INTERVAL_MS = 400;

const isSmoke = process.argv.includes("--smoke");
const isPtySmoke = process.argv.includes("--pty-smoke");
const isSetupSmoke = process.argv.includes("--setup-smoke");

let spawnedChild: ChildProcess | null = null;

function log(message: string): void {
  console.log(`[ade] ${message}`);
}

/** True only when the url answers { ok: true } within the timeout. Any
 * network error, non-200, or malformed body is treated as "not healthy" -
 * this function never throws. Defaults to the local dashboard's health url;
 * `server:connect` (spec 5.3) passes the tunnel's forwarded url instead. */
/** Which SPA generation the healthy server on :4700 says it serves ("v1" when
 * the field is absent - servers predating the marker only ever served v1/v2). */
async function servedUiIs(want: string): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ui?: string };
    return (body.ui ?? "v1") === want;
  } catch {
    return false;
  }
}

async function checkHealth(url: string = HEALTH_URL): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(deadlineMs: number, url: string = HEALTH_URL): Promise<boolean> {
  const start = Date.now();
  do {
    if (await checkHealth(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (Date.now() - start < deadlineMs);
  return false;
}

/** Walk up from `startDir` looking for the sdl-factory repo root, identified
 * by `justfile` + `installer/install.py` (spec 4.3.2 - loosened from also
 * requiring the tracer db, which does not exist yet on a genuinely fresh
 * clone and is one of the things Setup itself produces). Bounded to 8
 * levels so a wrong start dir fails fast instead of walking to the
 * filesystem root. */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "justfile")) && existsSync(join(dir, "installer", "install.py"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not find the sdl-factory repo (a directory with both "justfile" and ` +
      `"installer/install.py") walking up from ${startDir}. Run the ADE from inside ` +
      `the repo, or place the packaged .exe inside it.`,
  );
}

/** Same command `just ui` runs, spawned as a direct child (no shell) so
 * `child.kill()` on Windows terminates bun.exe itself rather than an
 * intermediate cmd.exe wrapper. */
async function spawnServer(repoRoot: string): Promise<void> {
  const uiDir = join(repoRoot, "apps", "ui");
  const dbPath = join(repoRoot, "adws", "adw_data", "sssf.db");
  if (!existsSync(dbPath)) {
    throw new Error(`sssf.db not found at ${dbPath}`);
  }
  const serverArgs = ["run", "server/index.ts", "--db", dbPath];
  if (UI_V3) serverArgs.push("--ui-v3"); // explicit flag only - never dir presence
  log(`no healthy server found - spawning: bun ${serverArgs.join(" ")}`);
  const child = spawn("bun", serverArgs, {
    cwd: uiDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedChild = child;
  child.stdout?.on("data", (chunk: Buffer) => log(`server: ${chunk.toString("utf-8").trimEnd()}`));
  child.stderr?.on("data", (chunk: Buffer) => log(`server: ${chunk.toString("utf-8").trimEnd()}`));
  child.on("exit", (code) => {
    if (spawnedChild === child) {
      log(`server process exited (code ${code})`);
      spawnedChild = null;
    }
  });
}

/** Kill the server ONLY if this process spawned it. A server the operator
 * started by hand (`just ui`) is never touched. */
function killSpawnedServer(): void {
  if (spawnedChild && spawnedChild.exitCode === null) {
    log("stopping the server this process spawned");
    spawnedChild.kill();
  }
  spawnedChild = null;
}

// ---------------------------------------------------------------------------
// Window state - stdlib approach: a tiny json file in userData, no library.
// ---------------------------------------------------------------------------

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = { width: 1280, height: 800 };

function windowStatePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(windowStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    if (typeof parsed.width === "number" && typeof parsed.height === "number") {
      return { ...DEFAULT_WINDOW_STATE, ...parsed };
    }
  } catch {
    // first launch, or a corrupt/missing file - fall back to defaults
  }
  return { ...DEFAULT_WINDOW_STATE };
}

function saveWindowState(win: BrowserWindow): void {
  try {
    if (win.isDestroyed()) return;
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    const state: WindowState = { ...bounds, isMaximized: win.isMaximized() };
    mkdirSync(dirname(windowStatePath()), { recursive: true });
    writeFileSync(windowStatePath(), JSON.stringify(state), "utf-8");
  } catch (error) {
    log(`could not save window state: ${(error as Error).message}`);
  }
}

/** A remembered position is only honored if it still lands on a currently
 * connected display - otherwise a since-removed monitor would strand the
 * window off-screen. */
function boundsAreOnScreen(state: WindowState): boolean {
  if (state.x === undefined || state.y === undefined) return false;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      state.x! >= area.x &&
      state.y! >= area.y &&
      state.x! < area.x + area.width &&
      state.y! < area.y + area.height
    );
  });
}

/** Creates and configures the window but does NOT navigate it anywhere -
 * boot() decides the first URL (Setup or the dashboard) once it knows
 * whether this box has converged (spec 4.1). */
async function createWindow(): Promise<BrowserWindow> {
  const state = loadWindowState();
  const bounds = boundsAreOnScreen(state)
    ? { x: state.x, y: state.y, width: state.width, height: state.height }
    : { width: state.width, height: state.height };

  // The mark (three rising amber bars) as the window/taskbar icon in dev;
  // the packaged .exe carries the same mark via build/icon.ico. Guarded so a
  // checkout without the generated icon still boots.
  const iconPath = join(import.meta.dirname, "..", "build", "icon.png");

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 1100,
    minHeight: 700,
    title: "SDL Factory",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    backgroundColor: "#0A0A0B", // spec's canvas color - avoids a white flash before load
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(import.meta.dirname, "preload.cjs"),
    },
  });

  if (state.isMaximized) win.maximize();

  const persist = () => saveWindowState(win);
  win.on("resize", persist);
  win.on("move", persist);
  win.on("close", persist);
  // Sessions die with the app (spec 3.5) - killed here too, not only on
  // before-quit, since window-all-closed fires before before-quit and a
  // lingering pty/tunnel should not survive the window that owned it.
  win.on("closed", () => {
    ptyManager.killAll();
    serverTunnel.stop();
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

// ---------------------------------------------------------------------------
// Terminal surface (spec 3) - ptys live ONLY here in the main process. Every
// handler origin-gates first (spec 0.5 / 3.2): the calling frame must be
// this app's own local UI origin, never a remote SPA reached through the
// server-lens tunnel on a different port/origin.
// ---------------------------------------------------------------------------

const ptyManager = new PtyManager();
const serverTunnel = new ServerTunnel();
// Terminal's default cwd (spec 3.3) and the repo root used by Setup/Server.
// Set once boot() resolves it; process.cwd() is only a placeholder for the
// brief window before that.
let terminalCwd = process.cwd();
let currentRepoRoot = process.cwd();
let mainWindow: BrowserWindow | null = null;
// The exact file:// URL Setup was loaded from (spec 4.3) - set only while
// Setup is showing. Used as the second trusted origin for setup:* IPC.
let setupUrl: string | null = null;
let serverConfigPath = "";

function isAppOrigin(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return frame !== null && !frame.isDestroyed() && frame.origin === APP_ORIGIN;
}

/** Setup's own page (spec 4.3: a local loadFile() page, not a route on the
 * SPA) is exactly as trusted as the dashboard - main is the one that loaded
 * it from disk, and it is never reachable through the tunnel, so the
 * remote-origin concern spec 0.5 is guarding against cannot apply to it. */
function isSetupOrigin(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return frame !== null && !frame.isDestroyed() && setupUrl !== null && frame.url === setupUrl;
}

/** Terminal's own gate (spec 3.2) - dashboard origin only. Setup has its own
 * separate pty entrypoint (setup:run) and never offers the 4-profile
 * Terminal surface, so this deliberately does NOT accept isSetupOrigin. */
function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isAppOrigin(event);
}

function isSetupOrDashboardSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isAppOrigin(event) || isSetupOrigin(event);
}

/** The one deliberate, narrow exception to spec 5.4's "denies ... server IPC
 * to the remote SPA": once Connect has navigated the window to the tunnel's
 * own origin, that page's Settings > Server pane must still be able to
 * report status and disconnect - otherwise there is no way back except
 * quitting the app (spec 5.5 promises a "Reconnect"/disconnect affordance,
 * which requires this). Only status/disconnect get this exception - both
 * are idempotent, take no operator-supplied data, and cannot initiate a NEW
 * action. getConfig/setConfig/deploy/connect stay APP_ORIGIN-only exactly
 * as spec 5.4 states: the remote SPA can never configure, deploy to, or
 * open a new tunnel to anything. */
function isDashboardOrActiveTunnelOrigin(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (isAppOrigin(event)) return true;
  const activeOrigin = serverTunnel.status().origin;
  if (!activeOrigin) return false;
  const frame = event.senderFrame;
  return frame !== null && !frame.isDestroyed() && frame.origin === activeOrigin;
}

ipcMain.handle("term:open", (event, profileId: unknown, cwd?: unknown) => {
  if (!isTrustedSender(event)) throw new Error("term:open: untrusted origin");
  if (typeof profileId !== "string") throw new Error("term:open: profileId must be a string");
  const resolved = resolveProfile(profileId);
  const sender = event.sender;
  if (!resolved.ok) {
    // Fail visibly IN the tab (spec 3.3) - never a rejected promise that
    // leaves the renderer to invent its own wording.
    return { sessionId: ptyManager.spawnNotFound(sender, resolved.message) };
  }
  const sessionId = ptyManager.spawn(sender, {
    file: resolved.command.file,
    args: resolved.command.args,
    cwd: typeof cwd === "string" && cwd.trim() ? cwd : terminalCwd,
    cols: 80,
    rows: 24,
    env: process.env,
  });
  return { sessionId };
});

// term:input/resize/close accept BOTH legitimate pty-rendering origins
// (dashboard Terminal tabs AND Setup's embedded wizard pty) - the shared
// PtyPane sends keystrokes through these same channels from both pages.
// Gating them dashboard-only silently dropped every keystroke typed into
// Setup, so "Press Enter to converge" could never work (verifier-caught
// 2026-08-13). term:open stays dashboard-only on purpose: Setup's pty is
// opened by main via setup:run, never by the page - the Setup page has no
// business opening free shells.
ipcMain.on("term:input", (event, sessionId: unknown, data: unknown) => {
  if (!isSetupOrDashboardSender(event)) return;
  if (typeof sessionId !== "string" || typeof data !== "string") return;
  ptyManager.write(sessionId, data);
});

ipcMain.on("term:resize", (event, sessionId: unknown, cols: unknown, rows: unknown) => {
  if (!isSetupOrDashboardSender(event)) return;
  if (typeof sessionId !== "string" || typeof cols !== "number" || typeof rows !== "number") return;
  ptyManager.resize(sessionId, cols, rows);
});

ipcMain.on("term:close", (event, sessionId: unknown) => {
  if (!isSetupOrDashboardSender(event)) return;
  if (typeof sessionId !== "string") return;
  ptyManager.close(sessionId);
});

// PTY DATA RACE fix (spec 3.4 addendum): PtyPane calls this once, right
// after it subscribes term:data/term:exit, for EVERY session it renders -
// Terminal profiles, Setup's embedded pty (setup:run), and Deploy tabs
// (server:deploy) alike; the gate accepts both legitimate origins.
ipcMain.on("term:attach", (event, sessionId: unknown) => {
  if (!isSetupOrDashboardSender(event)) return;
  if (typeof sessionId !== "string") return;
  ptyManager.attach(sessionId);
});

// ---------------------------------------------------------------------------
// First-run Setup (spec 4). setup:run's command line is fully built here
// (uv path resolved on disk, target matched against the fixed 3-value
// enum) - the renderer only ever picks a target, exactly the profiles.ts
// discipline the Terminal surface already uses (spec 3.2).
// ---------------------------------------------------------------------------

ipcMain.handle("setup:status", (event) => {
  if (!isSetupOrDashboardSender(event)) throw new Error("setup:status: untrusted origin");
  return detectSetup(currentRepoRoot);
});

ipcMain.handle("setup:run", (event, target: unknown) => {
  if (!isSetupOrDashboardSender(event)) throw new Error("setup:run: untrusted origin");
  if (!isInstallTarget(target)) throw new Error("setup:run: invalid target");
  const sender = event.sender;
  const uvPath = which("uv");
  if (!uvPath) {
    return { sessionId: ptyManager.spawnNotFound(sender, "'uv' was not found on PATH. Install uv, then retry.") };
  }
  const sessionId = ptyManager.spawn(sender, {
    file: uvPath,
    args: ["run", "installer/install.py", "--target", target],
    cwd: currentRepoRoot,
    cols: 100,
    rows: 30,
    env: process.env,
  });
  return { sessionId };
});

ipcMain.handle("setup:proceed", async (event) => {
  if (!isSetupOrDashboardSender(event)) throw new Error("setup:proceed: untrusted origin");
  const win = mainWindow;
  if (!win || win.isDestroyed()) return { ok: false, error: "the window is gone" };
  const ok = await enterDashboard(win, currentRepoRoot, { fatalOnFailure: false });
  return ok ? { ok: true } : { ok: false, error: "the local server did not become healthy in time - see the console" };
});

/** Dashboard-only (spec 4 changelog): what the non-blocking drift banner's
 * "open Setup" button calls - swaps the window over to the same Setup page
 * a not-converged boot would have shown, on demand instead of hijacking the
 * launch. Symmetric to setup:proceed (Setup -> dashboard); this is
 * dashboard -> Setup. */
ipcMain.handle("setup:open", async (event) => {
  if (!isAppOrigin(event)) throw new Error("setup:open: untrusted origin");
  const win = mainWindow;
  if (!win || win.isDestroyed()) return { ok: false, error: "the window is gone" };
  const ok = await enterSetup(win, currentRepoRoot);
  return ok ? { ok: true } : { ok: false, error: "could not open Setup - see the console" };
});

// ---------------------------------------------------------------------------
// Server lens v1 (spec 5). Config lives in userData/server.json, read and
// written ONLY here - the Bun server never learns this file exists.
// ---------------------------------------------------------------------------

function coerceServerConfig(raw: unknown): ServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.host !== "string" || typeof r.keyPath !== "string") return null;
  if (typeof r.remotePort !== "number" || typeof r.localPort !== "number") return null;
  return { host: r.host, keyPath: r.keyPath, remotePort: r.remotePort, localPort: r.localPort };
}

ipcMain.handle("server:getConfig", (event) => {
  if (!isAppOrigin(event)) throw new Error("server:getConfig: untrusted origin");
  return loadServerConfig(serverConfigPath);
});

ipcMain.handle("server:setConfig", (event, raw: unknown) => {
  if (!isAppOrigin(event)) throw new Error("server:setConfig: untrusted origin");
  const config = coerceServerConfig(raw);
  if (!config) return { ok: false, error: "malformed config" };
  const problem = validateServerConfig(config);
  if (problem) return { ok: false, error: problem };
  saveServerConfig(serverConfigPath, config);
  return { ok: true };
});

ipcMain.handle("server:deploy", (event) => {
  if (!isAppOrigin(event)) throw new Error("server:deploy: untrusted origin");
  const config = loadServerConfig(serverConfigPath);
  const problem = validateServerConfig(config);
  if (problem) return { error: problem };
  const sshPath = findSsh();
  const sender = event.sender;
  if (!sshPath) {
    return { sessionId: ptyManager.spawnNotFound(sender, "'ssh' was not found on PATH.") };
  }
  const cmd = deployCommand(sshPath, config);
  const sessionId = ptyManager.spawn(sender, {
    file: cmd.file,
    args: cmd.args,
    cwd: currentRepoRoot,
    cols: 100,
    rows: 30,
    env: process.env,
  });
  return { sessionId };
});

ipcMain.handle("server:connect", async (event) => {
  if (!isAppOrigin(event)) throw new Error("server:connect: untrusted origin");
  const config = loadServerConfig(serverConfigPath);
  const problem = validateServerConfig(config);
  if (problem) return { ok: false, error: problem };
  const startError = serverTunnel.start(config);
  if (startError) return { ok: false, error: startError };
  const localHealthUrl = `http://127.0.0.1:${config.localPort}/api/health`;
  const healthy = await waitForHealth(CONNECT_TIMEOUT_MS, localHealthUrl);
  if (!healthy) {
    // CONNECT STATUS HONESTY (spec 5.5): fail(), never stop() - a failed
    // attempt must land on "error" with the reason visible and Reconnect
    // offered, never silently reset to "not connected" as if nothing had
    // been tried.
    const fallback = "the forwarded port did not answer in time";
    serverTunnel.fail(fallback);
    return { ok: false, error: serverTunnel.status().message ?? fallback };
  }
  serverTunnel.markConnected();
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    // The window's origin is about to change (spec 5.3/5.4) - local ptys
    // belong to the renderer that is about to be torn down by the
    // navigation and cannot be reached from the new origin either way, so
    // clean them up now rather than leaking them.
    ptyManager.killAll();
    await win.loadURL(`http://127.0.0.1:${config.localPort}/`);
  }
  return { ok: true };
});

ipcMain.handle("server:disconnect", async (event) => {
  if (!isDashboardOrActiveTunnelOrigin(event)) throw new Error("server:disconnect: untrusted origin");
  serverTunnel.stop();
  const win = mainWindow;
  if (win && !win.isDestroyed()) await win.loadURL(APP_URL);
});

ipcMain.handle("server:status", (event) => {
  if (!isDashboardOrActiveTunnelOrigin(event)) throw new Error("server:status: untrusted origin");
  return serverTunnel.status();
});

/** `bunx electron . --pty-smoke` - a second, narrower verifier alongside
 * `--smoke`: proves the real shipped PtyManager + profile resolution (not
 * the spec 2's scratch probe) spawns a real pty and round-trips data under
 * a genuine Electron main process, headless, no window. No server, no
 * repo detection - this only exercises the Terminal surface's own code. */
async function runPtySmoke(): Promise<void> {
  const marker = `PTY_SMOKE_${Date.now()}`;
  const resolved = resolveProfile("shell");
  if (!resolved.ok) {
    console.error(`[pty-smoke] shell profile did not resolve: ${resolved.message}`);
    app.exit(1);
    return;
  }
  let buffer = "";
  let seen = false;
  const fakeSender = {
    isDestroyed: () => false,
    send: (channel: string, _id: unknown, chunk: unknown) => {
      if (channel === "term:data" && typeof chunk === "string") {
        buffer += chunk;
        if (buffer.includes(marker)) seen = true;
      }
    },
  } as unknown as WebContents;

  const manager = new PtyManager();
  const id = manager.spawn(fakeSender, {
    file: resolved.command.file,
    args: resolved.command.args,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    env: process.env,
  });
  // Simulates a renderer that was already listening when output started -
  // the non-race case. runNotFoundReplayCheck() below exercises the
  // opposite (attach AFTER output has already been emitted).
  manager.attach(id);
  manager.write(id, `echo ${marker}\r`);

  const deadline = Date.now() + 8_000;
  while (!seen && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  manager.close(id);

  const replayOk = await runNotFoundReplayCheck();

  if (seen && replayOk) {
    console.log("PTY_SMOKE_OK");
    app.exit(0);
  } else {
    if (!seen) console.error(`[pty-smoke] marker not seen within budget. tail=${JSON.stringify(buffer.slice(-300))}`);
    if (!replayOk) console.error("[pty-smoke] not-found replay check failed - see above");
    app.exit(1);
  }
}

/** Second check within --pty-smoke (finding: PTY DATA RACE). Proves a
 * not-found profile's one honest line actually reaches the tab even when
 * main emits it (spawnNotFound's queueMicrotask) well before anything
 * attaches - which, before the replay-buffer fix, was the normal case: the
 * line was already gone by the time term:open's IPC round trip resolved and
 * PtyPane's mount effect subscribed, so a dead profile failed silently
 * about half the time. Goes through the real resolveProfile() path (a
 * terminals.json override pointing at a binary that provably does not
 * exist), not a shortcut straight to spawnNotFound - this is the exact code
 * main's term:open handler runs. */
async function runNotFoundReplayCheck(): Promise<boolean> {
  const stamp = Date.now();
  const overridesPath = join(app.getPath("temp"), `pty-smoke-terminals-${stamp}.json`);
  const ghostFile = join(app.getPath("temp"), `pty-smoke-ghost-binary-${stamp}.exe`);
  const fakeProfileId = "pty_smoke_ghost_profile";
  writeFileSync(overridesPath, JSON.stringify([{ id: fakeProfileId, file: ghostFile }]), "utf-8");
  loadUserProfileOverrides(overridesPath);

  const resolved = resolveProfile(fakeProfileId);
  if (resolved.ok) {
    console.error(`[pty-smoke] expected the ghost profile to fail resolution, it did not`);
    return false;
  }

  let buffer = "";
  const fakeSender = {
    isDestroyed: () => false,
    send: (channel: string, _id: unknown, payload: unknown) => {
      if (channel === "term:data" && typeof payload === "string") buffer += payload;
    },
  } as unknown as WebContents;

  const manager = new PtyManager();
  const id = manager.spawnNotFound(fakeSender, resolved.message);

  // The race, on purpose: let spawnNotFound's queueMicrotask actually run
  // BEFORE anything attaches.
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (buffer.length > 0) {
    console.error("[pty-smoke] not-found line reached the sender before attach() - the replay buffer is not working");
    return false;
  }

  manager.attach(id);
  const arrived = buffer.includes(resolved.message);
  console.log(
    `[pty-smoke] not-found replay: message=${JSON.stringify(resolved.message)} arrivedAfterAttach=${arrived}`,
  );
  return arrived;
}

/** `bunx electron . --setup-smoke` - proves the Setup path end to end with
 * ZERO side effects: a real `install.py --verify-only --json` drift check
 * (the same call setup:status makes), then a real setup pty run through the
 * shipped PtyManager using `--dry-run` (install.py's own guarantee: "print
 * the full plan, change nothing") in place of a genuine `--target X`
 * converge - proving the pty-embedding wiring works without installing or
 * changing anything on this box. Headless, no window. */
async function runSetupSmoke(): Promise<void> {
  const startDir = app.isPackaged ? dirname(process.execPath) : app.getAppPath();
  let repoRoot: string;
  try {
    repoRoot = findRepoRoot(startDir);
  } catch (error) {
    console.error(`[setup-smoke] ${(error as Error).message}`);
    app.exit(1);
    return;
  }
  console.log(`[setup-smoke] repoRoot=${repoRoot}`);

  const status = await detectSetup(repoRoot);
  console.log(
    `[setup-smoke] detectSetup: converged=${status.converged} exitCode=${status.exitCode} ` +
      `target=${status.target} checks=${status.checks.length}${status.error ? ` error=${status.error}` : ""}`,
  );

  const uvPath = which("uv");
  if (!uvPath) {
    console.error("[setup-smoke] 'uv' not on PATH - cannot exercise the setup pty path");
    app.exit(1);
    return;
  }

  const target = status.target && isInstallTarget(status.target) ? status.target : "laptop";
  let buffer = "";
  let exitCode: number | null = null;
  const fakeSender = {
    isDestroyed: () => false,
    send: (channel: string, _id: unknown, payload: unknown) => {
      if (channel === "term:data" && typeof payload === "string") buffer += payload;
      if (channel === "term:exit" && typeof payload === "number") exitCode = payload;
    },
  } as unknown as WebContents;

  const manager = new PtyManager();
  const setupSmokeId = manager.spawn(fakeSender, {
    file: uvPath,
    args: ["run", "installer/install.py", "--target", target, "--dry-run"],
    cwd: repoRoot,
    cols: 100,
    rows: 30,
    env: process.env,
  });
  manager.attach(setupSmokeId); // this check cares about the pty's output, not the race fix

  const deadline = Date.now() + 30_000;
  while (exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const sawPlan = buffer.includes("PLAN");
  const sawDryRunLine = /exit 0\s+\(dry-run: nothing was changed\)/.test(buffer);
  console.log(`[setup-smoke] pty run: exitCode=${exitCode} sawPLAN=${sawPlan} sawDryRunNoChange=${sawDryRunLine}`);

  if (exitCode === 0 && sawPlan && sawDryRunLine) {
    console.log("SETUP_SMOKE_OK");
    app.exit(0);
  } else {
    console.error(`[setup-smoke] tail=${JSON.stringify(buffer.slice(-500))}`);
    app.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

/** Boots (or reuses) the local Bun server and points `win` at the local
 * dashboard origin. On failure, `fatalOnFailure` decides whether this is a
 * hard app-exit (the very first boot, spec-original behaviour, unchanged)
 * or a soft failure the caller can show inline and let the operator retry
 * (spec 4.2's "Exit 0 -> the app moves on" path via setup:proceed - a
 * transient health-check miss there should not kill the whole app). Either
 * way the return value alone tells the caller what happened; a false
 * fatalOnFailure caller need not know why. */
async function enterDashboard(
  win: BrowserWindow,
  repoRoot: string,
  opts: { fatalOnFailure: boolean },
): Promise<boolean> {
  log(`checking ${HEALTH_URL} ...`);
  if (await checkHealth()) {
    // v3 mode never silently reuses a server showing another UI generation -
    // the operator would see v1/v2 in a window titled v3. Same explicit-flag
    // spirit as the server's own never-dir-presence rule.
    if (UI_V3 && !(await servedUiIs("v3"))) {
      log(
        "ERROR: a healthy server on :4700 is serving a different UI generation. " +
          "Stop it (the `just ui`/`just ui2` window or its bun process) and relaunch `just app3`.",
      );
      return false;
    }
    log("found a healthy server already running - reusing it, spawning nothing");
  } else {
    let healthy = false;
    try {
      await spawnServer(repoRoot);
      healthy = await waitForHealth(BOOT_TIMEOUT_MS);
    } catch (error) {
      // spawnServer() itself can throw synchronously (e.g. sssf.db still
      // missing) - caught here so this is always an honest false return,
      // never an unhandled rejection surfacing as a silent stuck spinner on
      // the setup:proceed caller's side (spec: honest error states, always).
      log(`ERROR: could not start the server: ${(error as Error).message}`);
    }
    if (!healthy) {
      const message =
        `The SDL Factory server did not answer ${HEALTH_URL} within ` +
        `${BOOT_TIMEOUT_MS / 1000}s. See the console output above for the server's own error ` +
        `(a common cause: port 4700 already held by something other than a healthy ui server).`;
      log(`ERROR: ${message}`);
      killSpawnedServer();
      if (opts.fatalOnFailure) {
        if (!isSmoke) dialog.showErrorBox("SDL Factory", message);
        app.exit(1);
      }
      return false;
    }
  }
  setupUrl = null; // leaving Setup for good this boot - its trust window closes
  await win.loadURL(APP_URL);
  return true;
}

/** Setup is a local loadFile()-style page (spec 4.3: "its own tiny bundle,
 * xterm plus the checklist, no server, no network"), loaded via loadURL
 * with the exact file:// string this module then compares IPC senders
 * against - never win.loadFile(), so there is exactly one source of truth
 * for what "Setup's own origin" means (see isSetupOrigin). */
async function enterSetup(win: BrowserWindow, repoRoot: string): Promise<boolean> {
  // A no-op at initial boot (nothing has opened a pty yet). Not a no-op when
  // reached via setup:open (spec 4 changelog's drift banner) mid-session:
  // the window's origin is about to change away from the dashboard, so any
  // open Terminal-tab ptys become unreachable from the page that replaces
  // it either way - same reasoning as server:connect's identical cleanup.
  ptyManager.killAll();
  // dist-setup/, not dist/ (spec 4.3 changelog: SETUP.HTML SURVIVAL) - a
  // plain `vite build` (what `just ui` runs) empties `dist/` with
  // emptyOutDir, which used to take setup.html down with it. The two pages
  // now own separate output directories precisely so `just ui` and `just
  // app` can each rebuild what they own without destroying the other's.
  const setupHtmlPath = join(repoRoot, "apps", "ui", "dist-setup", "setup.html");
  if (!existsSync(setupHtmlPath)) {
    const message =
      `Setup UI not built: ${setupHtmlPath} is missing. Run "vite build --config ` +
      `vite.setup.config.ts" in apps/ui first (\`just app\` does this automatically).`;
    log(`ERROR: ${message}`);
    dialog.showErrorBox("SDL Factory", message);
    app.exit(1);
    return false;
  }
  setupUrl = pathToFileURL(setupHtmlPath).href;
  log(`not converged - loading Setup: ${setupUrl}`);
  await win.loadURL(setupUrl);
  return true;
}

/** INSTANT LAUNCH (spec 4 changelog): a pure filesystem check, no subprocess,
 * no network - "does this repo look like it has already been through
 * Setup at least once". `.env` is what `install.py` writes out and what
 * every ADW then reads (justfile's own `set dotenv-load` comment: "reaches
 * every ADW ... so keys work"); `adws/adw_data/` is where the tracer db and
 * every run's data live. Neither exists on a genuinely fresh clone, and
 * install.py itself produces both - so together they are a fast, honest
 * proxy for "this machine converged, at least once, at some point". It is
 * deliberately NOT the same claim `detectSetup`'s real verify[] makes
 * (drift since then is possible) - that real check still runs, just after
 * the window is already on screen (see runBackgroundSetupCheck). */
function looksAlreadySetUp(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".env")) && existsSync(join(repoRoot, "adws", "adw_data"));
}

/** Runs the wizard's real `--verify-only --json` drift check in the
 * background, strictly AFTER the window has already been shown - never
 * blocking first paint (spec 4 changelog). A converged result is silent
 * (the common case: nothing to tell the operator). An unconverged one
 * pushes a `setup:drift` event to the renderer instead of hijacking the
 * launch back to Setup - the dashboard shows a small dismissible banner
 * ("Setup found N issues - open Setup") and the operator decides whether to
 * act on it now or keep working. */
async function runBackgroundSetupCheck(win: BrowserWindow, repoRoot: string): Promise<void> {
  const status = await detectSetup(repoRoot);
  if (status.converged) return;
  if (win.isDestroyed()) return;
  log(`background setup check: not converged (exit ${status.exitCode}) - notifying the dashboard, not hijacking it`);
  win.webContents.send("setup:drift", status);
}

async function boot(): Promise<void> {
  // Dark titlebar on Windows: nativeTheme.themeSource drives the native
  // window chrome's dark/light mode, must be set before the window is
  // created.
  nativeTheme.themeSource = "dark";

  const startDir = app.isPackaged ? dirname(process.execPath) : app.getAppPath();
  const repoRoot = findRepoRoot(startDir);
  terminalCwd = repoRoot;
  currentRepoRoot = repoRoot;
  serverConfigPath = join(app.getPath("userData"), "server.json");

  loadUserProfileOverrides(join(app.getPath("userData"), "terminals.json"));

  const win = await createWindow();
  mainWindow = win;

  if (isSmoke) {
    // --smoke is the build's boot/health verifier (unchanged contract): it
    // deliberately skips the Setup gate. It proves THIS process can
    // spawn-or-reuse the server and reach health - a fact about this code,
    // not about whether this particular box currently reports converged
    // (a real, per-box, sometimes-drifting fact - see --setup-smoke).
    const ok = await enterDashboard(win, repoRoot, { fatalOnFailure: true });
    if (!ok) return;
    console.log("ADE_SMOKE_OK");
    killSpawnedServer();
    app.exit(0);
    return;
  }

  // INSTANT LAUNCH (spec 4 changelog): only a machine that FAILS the local
  // heuristic pays for the blocking --verify-only round trip before first
  // paint. Everything else opens the dashboard immediately and gets the
  // real check afterwards, in the background.
  if (looksAlreadySetUp(repoRoot)) {
    const ok = await enterDashboard(win, repoRoot, { fatalOnFailure: true });
    if (!ok) return; // already dialog'd + app.exit(1)'d inside enterDashboard
    win.once("ready-to-show", () => win.show());
    win.once("show", () => {
      void runBackgroundSetupCheck(win, repoRoot);
    });
    return;
  }

  const status = await detectSetup(repoRoot);
  if (status.converged) {
    const ok = await enterDashboard(win, repoRoot, { fatalOnFailure: true });
    if (!ok) return; // already dialog'd + app.exit(1)'d inside enterDashboard
  } else {
    const ok = await enterSetup(win, repoRoot);
    if (!ok) return; // already dialog'd + app.exit(1)'d inside enterSetup
  }

  win.once("ready-to-show", () => win.show());
}

app.whenReady().then(() => {
  const run = isPtySmoke ? runPtySmoke() : isSetupSmoke ? runSetupSmoke() : boot();
  run.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ade] fatal: ${message}`);
    if (!isSmoke) dialog.showErrorBox("SDL Factory", message);
    killSpawnedServer();
    app.exit(1);
  });
});

app.on("window-all-closed", () => {
  ptyManager.killAll();
  serverTunnel.stop();
  killSpawnedServer();
  app.quit();
});

app.on("before-quit", () => {
  ptyManager.killAll();
  serverTunnel.stop();
  killSpawnedServer();
});
