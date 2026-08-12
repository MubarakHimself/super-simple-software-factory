/**
 * SDL Factory desktop shell (the operator's "ADE") - Electron main process.
 *
 * This is a thin wrapper around the same read-only ui server `just ui` runs.
 * It never embeds a copy of the server or the built SPA: at startup it walks
 * up from its own location to find the sdl-factory repo (a directory holding
 * both `justfile` and `adws/adw_data/sssf.db`), then spawns THAT repo's
 * `bun run server/index.ts --db <resolved path>` exactly as `just ui` does,
 * and opens a BrowserWindow at http://127.0.0.1:4700.
 *
 * If a server is already answering /api/health (operator already ran
 * `just ui`), that server is reused untouched and nothing is spawned or
 * killed by this process. If this process did the spawning, the child is
 * killed on quit - never otherwise, so a manually-started `just ui` keeps
 * running after the window closes.
 *
 *   bunx electron .            normal launch (see justfile: `just ade`)
 *   bunx electron . --smoke    headless-safe boot check: create the window,
 *                              verify health, print ADE_SMOKE_OK, exit 0.
 *                              This is the build's verifier hook.
 */
import { app, BrowserWindow, dialog, nativeTheme, screen } from "electron";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HOSTNAME = "127.0.0.1";
const PORT = 4700;
const HEALTH_URL = `http://${HOSTNAME}:${PORT}/api/health`;
const APP_URL = `http://${HOSTNAME}:${PORT}/`;

const HEALTH_CHECK_TIMEOUT_MS = 1_500; // one probe
const BOOT_TIMEOUT_MS = 20_000; // spawn-and-wait budget; leaves headroom under --smoke's ~30s
const POLL_INTERVAL_MS = 400;

const isSmoke = process.argv.includes("--smoke");

let spawnedChild: ChildProcess | null = null;

function log(message: string): void {
  console.log(`[ade] ${message}`);
}

/** True only when /api/health answers { ok: true } within the timeout. Any
 * network error, non-200, or malformed body is treated as "not healthy" -
 * this function never throws. */
async function checkHealth(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(HEALTH_URL, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  do {
    if (await checkHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (Date.now() - start < deadlineMs);
  return false;
}

/** Walk up from `startDir` looking for the sdl-factory repo root, identified
 * by the same two things `just ui` needs: a `justfile` and the tracer db.
 * Bounded to 8 levels so a wrong start dir fails fast instead of walking to
 * the filesystem root. */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "justfile")) && existsSync(join(dir, "adws", "adw_data", "sssf.db"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not find the sdl-factory repo (a directory with both "justfile" and ` +
      `"adws/adw_data/sssf.db") walking up from ${startDir}. Run the ADE from inside ` +
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
  log(`no healthy server found - spawning: bun run server/index.ts --db ${dbPath}`);
  const child = spawn("bun", ["run", "server/index.ts", "--db", dbPath], {
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

async function createWindow(): Promise<BrowserWindow> {
  const state = loadWindowState();
  const bounds = boundsAreOnScreen(state)
    ? { x: state.x, y: state.y, width: state.width, height: state.height }
    : { width: state.width, height: state.height };

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 1100,
    minHeight: 700,
    title: "SDL Factory",
    backgroundColor: "#0A0A0B", // spec's canvas color - avoids a white flash before load
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (state.isMaximized) win.maximize();

  const persist = () => saveWindowState(win);
  win.on("resize", persist);
  win.on("move", persist);
  win.on("close", persist);

  await win.loadURL(APP_URL);
  return win;
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  // Dark titlebar on Windows: nativeTheme.themeSource drives the native
  // window chrome's dark/light mode, must be set before the window is
  // created.
  nativeTheme.themeSource = "dark";

  log(`checking ${HEALTH_URL} ...`);
  if (await checkHealth()) {
    log("found a healthy server already running - reusing it, spawning nothing");
  } else {
    const startDir = app.isPackaged ? dirname(process.execPath) : app.getAppPath();
    const repoRoot = findRepoRoot(startDir);
    await spawnServer(repoRoot);
    const healthy = await waitForHealth(BOOT_TIMEOUT_MS);
    if (!healthy) {
      const message =
        `The SDL Factory server did not answer ${HEALTH_URL} within ` +
        `${BOOT_TIMEOUT_MS / 1000}s. See the console output above for the server's own error ` +
        `(a common cause: port 4700 already held by something other than a healthy ui server).`;
      log(`ERROR: ${message}`);
      if (!isSmoke) dialog.showErrorBox("SDL Factory", message);
      killSpawnedServer();
      app.exit(1);
      return;
    }
  }

  const win = await createWindow();

  if (isSmoke) {
    console.log("ADE_SMOKE_OK");
    killSpawnedServer();
    app.exit(0);
    return;
  }

  win.once("ready-to-show", () => win.show());
}

app.whenReady().then(() => {
  boot().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ade] fatal: ${message}`);
    if (!isSmoke) dialog.showErrorBox("SDL Factory", message);
    killSpawnedServer();
    app.exit(1);
  });
});

app.on("window-all-closed", () => {
  killSpawnedServer();
  app.quit();
});

app.on("before-quit", killSpawnedServer);
