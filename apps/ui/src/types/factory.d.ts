/**
 * The desktop bridge's shape (spec 3.2, 4, 5), mirrored from
 * electron/preload.cts. Duplicated on purpose rather than imported: the
 * electron/ program and the app/ program are separate tsconfig projects
 * with different lib sets (this one needs DOM, that one must not), and the
 * bridge is small enough that keeping two short copies in sync beats a
 * cross-project import.
 *
 * `window.factory` is undefined in a plain browser (spec 0.4: capability is
 * detected by the bridge's presence, never by user-agent sniffing) - every
 * caller must check for that before use. A rejected promise from any of
 * these (e.g. an action IPC denied by the main-process origin gate) is
 * itself an honest state to render, never something to swallow silently.
 */
export {};

export interface VerifyCheck {
  id: string;
  outcome: string;
  message: string;
}

export interface SetupStatus {
  converged: boolean;
  exitCode: number | null;
  target: string | null;
  checks: VerifyCheck[];
  error: string | null;
}

export interface ServerConfig {
  host: string;
  keyPath: string;
  remotePort: number;
  localPort: number;
}

export type TunnelState = "idle" | "connecting" | "connected" | "closed" | "error";

export interface TunnelStatus {
  state: TunnelState;
  origin: string | null;
  message: string | null;
}

declare global {
  interface Window {
    factory?: {
      readonly isDesktop: true;
      term: {
        open(profileId: string, cwd?: string): Promise<{ sessionId: string }>;
        input(sessionId: string, data: string): void;
        resize(sessionId: string, cols: number, rows: number): void;
        close(sessionId: string): void;
        /** Call once, right after subscribing onData/onExit - main replays
         * whatever this session emitted before this point, in order, then
         * streams live (the pty data-race fix). */
        attach(sessionId: string): void;
        onData(cb: (sessionId: string, chunk: string) => void): () => void;
        onExit(cb: (sessionId: string, exitCode: number) => void): () => void;
      };
      setup: {
        status(): Promise<SetupStatus>;
        run(target: string): Promise<{ sessionId: string }>;
        proceed(): Promise<{ ok: boolean; error?: string }>;
        open(): Promise<{ ok: boolean; error?: string }>;
        onDrift(cb: (status: SetupStatus) => void): () => void;
      };
      server: {
        getConfig(): Promise<ServerConfig>;
        setConfig(config: ServerConfig): Promise<{ ok: boolean; error?: string }>;
        deploy(): Promise<{ sessionId: string } | { error: string }>;
        connect(): Promise<{ ok: boolean; error?: string }>;
        disconnect(): Promise<void>;
        status(): Promise<TunnelStatus>;
      };
    };
  }
}
