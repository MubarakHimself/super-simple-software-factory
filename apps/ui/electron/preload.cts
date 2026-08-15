/**
 * contextIsolation-safe bridge (spec 3.2). Deliberately this small: `open`
 * is the only round trip that needs a reply, so it is the only `invoke`.
 * `input`/`resize`/`close` are `send` - fire-and-forget, no promise
 * overhead on the high-frequency keystroke path.
 *
 * `sandbox: true` stays on (main.ts, unchanged) - a sandboxed preload still
 * gets `contextBridge` and `ipcRenderer`, which is all this needs.
 */
// A .cts file forces CommonJS output regardless of the package's own "type":
// "module" (this is the one file in the app that must load as CJS - see
// main.ts's preload path, ".cjs"). verbatimModuleSyntax then requires the
// CJS-native import form for the one value import; `import type` is still
// fine since it is fully erased and never reaches the emitted JS.
import electron = require("electron");
import type { IpcRendererEvent } from "electron";

const { contextBridge, ipcRenderer } = electron;

interface VerifyCheck {
  id: string;
  outcome: string;
  message: string;
}

interface SetupStatus {
  converged: boolean;
  exitCode: number | null;
  target: string | null;
  checks: VerifyCheck[];
  error: string | null;
}

interface ServerConfig {
  host: string;
  keyPath: string;
  remotePort: number;
  localPort: number;
}

interface TunnelStatus {
  state: "idle" | "connecting" | "connected" | "closed" | "error";
  origin: string | null;
  message: string | null;
}

interface FolderPick {
  canceled: boolean;
  path: string | null;
}

interface FactoryBridge {
  isDesktop: true;
  /** L1 - the native directory dialog behind Add project's "Browse…". Resolves
   * `{canceled:true, path:null}` when the operator closed it without choosing;
   * rejects when the page is not this app's own origin. A browser has no such
   * thing, so the modal feature-detects this and falls back to its manual path
   * field rather than drawing a button that cannot work. */
  pickFolder(): Promise<FolderPick>;
  term: {
    open(profileId: string, cwd?: string): Promise<{ sessionId: string }>;
    input(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    close(sessionId: string): void;
    /** Tells main "a renderer is now listening for this session" (spec 3.4
     * addendum's data-race fix) - call once, right after subscribing
     * onData/onExit, and main replays whatever arrived before this point
     * in order, then streams live. Fire-and-forget, same as input/resize/
     * close: there is nothing to await, only a moment to mark. */
    attach(sessionId: string): void;
    onData(cb: (sessionId: string, chunk: string) => void): () => void;
    onExit(cb: (sessionId: string, exitCode: number) => void): () => void;
  };
  // spec 4 - first-run Setup. Present ONLY on the standalone setup.html page
  // in v1 (main only registers these handlers while Setup is on screen), but
  // exposed unconditionally here since the bridge shape must not depend on
  // which page happens to be loaded (spec 3.2: keep the bridge this small
  // and uniform - callers see "not available" as a rejected promise, same
  // as any other honest error state).
  setup: {
    status(): Promise<SetupStatus>;
    run(target: string): Promise<{ sessionId: string }>;
    proceed(): Promise<{ ok: boolean; error?: string }>;
    /** Dashboard-only (spec 4 changelog): swaps the window to the Setup
     * page on demand - what the non-blocking drift banner's "open Setup"
     * action calls. */
    open(): Promise<{ ok: boolean; error?: string }>;
    /** Dashboard-only push: fires once if the background --verify-only
     * check (run after the instant-heuristic launch, spec 4 changelog)
     * comes back unconverged. Never fires on the already-blocking Setup
     * path - that machine is already looking at Setup. */
    onDrift(cb: (status: SetupStatus) => void): () => void;
  };
  // spec 5 - Server lens.
  server: {
    getConfig(): Promise<ServerConfig>;
    setConfig(config: ServerConfig): Promise<{ ok: boolean; error?: string }>;
    deploy(): Promise<{ sessionId: string } | { error: string }>;
    connect(): Promise<{ ok: boolean; error?: string }>;
    disconnect(): Promise<void>;
    status(): Promise<TunnelStatus>;
  };
}

const factory: FactoryBridge = {
  isDesktop: true,
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder") as Promise<FolderPick>,
  term: {
    open: (profileId, cwd) => ipcRenderer.invoke("term:open", profileId, cwd) as Promise<{ sessionId: string }>,
    input: (sessionId, data) => {
      ipcRenderer.send("term:input", sessionId, data);
    },
    resize: (sessionId, cols, rows) => {
      ipcRenderer.send("term:resize", sessionId, cols, rows);
    },
    close: (sessionId) => {
      ipcRenderer.send("term:close", sessionId);
    },
    attach: (sessionId) => {
      ipcRenderer.send("term:attach", sessionId);
    },
    onData: (cb) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, chunk: string) => cb(sessionId, chunk);
      ipcRenderer.on("term:data", listener);
      return () => ipcRenderer.removeListener("term:data", listener);
    },
    onExit: (cb) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, exitCode: number) => cb(sessionId, exitCode);
      ipcRenderer.on("term:exit", listener);
      return () => ipcRenderer.removeListener("term:exit", listener);
    },
  },
  setup: {
    status: () => ipcRenderer.invoke("setup:status") as Promise<SetupStatus>,
    run: (target) => ipcRenderer.invoke("setup:run", target) as Promise<{ sessionId: string }>,
    proceed: () => ipcRenderer.invoke("setup:proceed") as Promise<{ ok: boolean; error?: string }>,
    open: () => ipcRenderer.invoke("setup:open") as Promise<{ ok: boolean; error?: string }>,
    onDrift: (cb) => {
      const listener = (_event: IpcRendererEvent, status: SetupStatus) => cb(status);
      ipcRenderer.on("setup:drift", listener);
      return () => ipcRenderer.removeListener("setup:drift", listener);
    },
  },
  server: {
    getConfig: () => ipcRenderer.invoke("server:getConfig") as Promise<ServerConfig>,
    setConfig: (config) => ipcRenderer.invoke("server:setConfig", config) as Promise<{ ok: boolean; error?: string }>,
    deploy: () => ipcRenderer.invoke("server:deploy") as Promise<{ sessionId: string } | { error: string }>,
    connect: () => ipcRenderer.invoke("server:connect") as Promise<{ ok: boolean; error?: string }>,
    disconnect: () => ipcRenderer.invoke("server:disconnect") as Promise<void>,
    status: () => ipcRenderer.invoke("server:status") as Promise<TunnelStatus>,
  },
};

contextBridge.exposeInMainWorld("factory", factory);
