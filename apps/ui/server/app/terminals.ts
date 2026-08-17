/**
 * Terminals - a plain shell, over a plain pty, with nothing in between.
 *
 * The KISS correction (`.scratch/app-v2/map.md`) put a bare VS Code-style
 * terminal in the middle of the app. This file is the whole server half of it:
 * spawn a shell in the project root, keep its bytes, stream them to whoever
 * attaches, write keystrokes back. No harness knowledge, no chain, no events,
 * no session log - the Session bridge next door (`sessions/`) still owns all
 * of that and is untouched.
 *
 *   POST /api/app/terminals            {projectId}      -> {id}
 *   GET  /api/app/terminals?project=   list, this project's live shells
 *   GET  /api/app/terminals/:id/raw    SSE: replay, then live bytes
 *   POST /api/app/terminals/:id/input  {text}
 *   POST /api/app/terminals/:id/resize {cols,rows}
 *   POST /api/app/terminals/:id/close
 *
 * Two things are worth knowing before editing this file:
 *
 * 1. **The pty itself lives in a Node child process** (`pty-host.mjs`), not
 *    here. Writing to a pty under Bun on Windows kills the server outright -
 *    see that file's header for the finding and the reproduction. Output-only
 *    would have worked in-process (that is what `sessions/pty.ts` does, and
 *    why its Terminal view is read-only); a terminal you can type into needs
 *    Node. The host is spawned lazily on the first terminal and shared by all
 *    of them.
 *
 * 2. **The ring buffer is never emptied.** Every attach replays it in full and
 *    then streams live, so leaving the surface and coming back shows the same
 *    backscroll - audit F2's lesson, kept honest on the server where the only
 *    complete copy of the bytes exists.
 *
 * Like every Session, a terminal dies with the server (no restart recovery,
 * no persistence). That is the same accepted trade the session bridge makes.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { APP_TOKEN, SELF_ORIGINS, appError, appJson, appSafely, csrfGuard, isLoopbackRequest } from "./guard.ts";
import { findProject } from "./manifest.ts";
import { WIN32, which } from "./sessions/which.ts";

/** Bytes of backscroll kept per terminal, for the life of the terminal. Same
 * bound `sessions/pty.ts` uses - generous for a single-operator loopback app,
 * and it IS the backscroll bound. */
const RING_BUFFER_CAP_CHARS = 512 * 1024;

interface Listener {
  onData(chunk: string): void;
  onExit(code: number): void;
}

interface TerminalRecord {
  id: string;
  projectId: string;
  cwd: string;
  shell: string;
  buffer: string;
  listeners: Set<Listener>;
  exited: boolean;
  exitCode: number | null;
  started_at: string;
}

const terminals = new Map<string, TerminalRecord>();

// ---------------------------------------------------------------------------
// The pty host process
// ---------------------------------------------------------------------------

interface HostProcess {
  write(line: string): void;
}

let host: HostProcess | null = null;

/** Starts the Node pty host if it is not already running. Returns its error
 * sentence instead of throwing, because that sentence is what the operator
 * reads on the empty terminal pane. */
function ensureHost(): { ok: true; host: HostProcess } | { ok: false; error: string } {
  if (host) return { ok: true, host };

  const node = which("node");
  if (!node) {
    return { ok: false, error: "'node' was not found on PATH - the terminal runs its shell through it." };
  }

  const script = join(import.meta.dir, "pty-host.mjs");
  const child = Bun.spawn([node, script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: import.meta.dir,
  });

  const stdin = child.stdin;
  const started: HostProcess = {
    write(line) {
      stdin.write(line);
      stdin.flush();
    },
  };
  host = started;

  void readHost(child.stdout);
  void child.exited.then(() => {
    host = null;
    // Every shell died with it; say so on each pane rather than leaving them
    // silently frozen.
    for (const terminal of terminals.values()) {
      if (terminal.exited) continue;
      emitData(terminal, "\r\n[the terminal host stopped]\r\n");
      emitExit(terminal, 1);
    }
  });

  return { ok: true, host: started };
}

/** One JSON object per line, out of the host: `data` and `exit`. */
async function readHost(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (!line.trim()) continue;
      let message: { t?: string; id?: string; chunk?: string; code?: number };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue; // a torn line; the next one carries its own object
      }
      const terminal = message.id ? terminals.get(message.id) : undefined;
      if (!terminal) continue;
      if (message.t === "data" && typeof message.chunk === "string") emitData(terminal, message.chunk);
      else if (message.t === "exit") emitExit(terminal, message.code ?? 0);
    }
  }
}

function emitData(terminal: TerminalRecord, chunk: string): void {
  terminal.buffer += chunk;
  if (terminal.buffer.length > RING_BUFFER_CAP_CHARS) {
    terminal.buffer = terminal.buffer.slice(terminal.buffer.length - RING_BUFFER_CAP_CHARS);
  }
  for (const listener of terminal.listeners) listener.onData(chunk);
}

function emitExit(terminal: TerminalRecord, code: number): void {
  if (terminal.exited) return;
  terminal.exited = true;
  terminal.exitCode = code;
  for (const listener of terminal.listeners) listener.onExit(code);
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/** PowerShell on Windows (the operator's box), `$SHELL` everywhere else. A
 * fixed server-side table, exactly like `sessions/profiles.ts`: the browser
 * never sends a command line, it asks for "a terminal" and gets this one. */
function shellCommand(): { file: string; args: string[] } {
  if (WIN32) {
    const powershell = which("pwsh") ?? which("powershell");
    if (powershell) return { file: powershell, args: ["-NoLogo"] };
    return { file: process.env.ComSpec || "cmd.exe", args: [] };
  }
  return { file: process.env.SHELL || "/bin/sh", args: [] };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function param(req: Request, key: string): string {
  return decodeURIComponent((req as Request & { params: Record<string, string> }).params[key] ?? "");
}

function summary(terminal: TerminalRecord) {
  return {
    id: terminal.id,
    projectId: terminal.projectId,
    cwd: terminal.cwd,
    shell: terminal.shell,
    exited: terminal.exited,
    started_at: terminal.started_at,
  };
}

async function createTerminal(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return appError("invalid JSON body");
  }
  const projectId = typeof (body as { projectId?: unknown })?.projectId === "string"
    ? (body as { projectId: string }).projectId
    : "";
  if (!projectId) return appError("projectId is required");

  const project = await findProject(projectId);
  if (!project) return appError(`no project ${projectId}`, 404);

  const ready = ensureHost();
  if (!ready.ok) return appError(ready.error, 500);

  const shell = shellCommand();
  const id = randomUUID();
  const terminal: TerminalRecord = {
    id,
    projectId,
    cwd: project.root,
    shell: shell.file,
    buffer: "",
    listeners: new Set(),
    exited: false,
    exitCode: null,
    started_at: new Date().toISOString(),
  };
  terminals.set(id, terminal);
  ready.host.write(
    `${JSON.stringify({ t: "spawn", id, file: shell.file, args: shell.args, cwd: project.root, cols: 80, rows: 24 })}\n`,
  );
  return appJson(summary(terminal));
}

function listTerminals(req: Request): Response {
  const project = new URL(req.url).searchParams.get("project");
  const rows = [...terminals.values()]
    .filter((terminal) => !terminal.exited && (!project || terminal.projectId === project))
    .map(summary);
  return appJson(rows);
}

/** SSE, one JSON object per frame: `{"kind":"data","chunk":...}` or
 * `{"kind":"exit","code":N}`. The buffer replays first, then live bytes. */
function rawStream(req: Request, server: { timeout(req: Request, seconds: number): void }): Response {
  // Bun force-closes an idle request after 10s by default, and a terminal
  // nobody is typing into is idle by definition (the same finding
  // `sessions/bridge.ts` records for its own streams).
  server.timeout(req, 0);
  const id = param(req, "id");
  const terminal = terminals.get(id);
  if (!terminal) return appError(`no terminal ${id}`, 404);

  const encoder = new TextEncoder();
  const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

  let listener: Listener | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (event: unknown): boolean => {
        try {
          controller.enqueue(frame(event));
          return true;
        } catch {
          // The connection is gone (tab closed, network drop). Stop feeding a
          // dead controller rather than throwing from inside a pty callback
          // no request's try/catch can see.
          if (listener) terminal.listeners.delete(listener);
          return false;
        }
      };
      const attached: Listener = {
        onData: (chunk) => void push({ kind: "data", chunk }),
        onExit: (code) => {
          push({ kind: "exit", code });
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      };
      listener = attached;
      if (terminal.buffer) {
        if (!push({ kind: "data", chunk: terminal.buffer })) return;
      }
      if (terminal.exited) {
        push({ kind: "exit", code: terminal.exitCode ?? 0 });
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }
      terminal.listeners.add(attached);
    },
    cancel() {
      if (listener) terminal.listeners.delete(listener);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

/** `appSafely` forwards only `(req)`, and the stream route needs Bun's second
 * `server` argument for `server.timeout` - so it wraps itself the same way. */
function safeStreamRoute(
  handler: (req: Request, server: { timeout(req: Request, seconds: number): void }) => Response,
): (req: Request, server: { timeout(req: Request, seconds: number): void }) => Response {
  return (req, server) => {
    try {
      // The same loopback-host check `appSafely` applies to every other
      // `/api/app/*` route. It matters MOST here: this route streams a live
      // shell's entire ring buffer, with no token, to whoever asks.
      if (!isLoopbackRequest(req)) return appError("this server answers on loopback only", 403);
      return handler(req, server);
    } catch (error) {
      console.error(`[ui] app ${req.method} ${new URL(req.url).pathname}:`, error);
      return appError((error as Error).message, 500);
    }
  };
}

async function writeInput(req: Request): Promise<Response> {
  const id = param(req, "id");
  const terminal = terminals.get(id);
  if (!terminal) return appError(`no terminal ${id}`, 404);
  if (terminal.exited) return appError("this terminal has ended", 409);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return appError("invalid JSON body");
  }
  const text = typeof (body as { text?: unknown })?.text === "string" ? (body as { text: string }).text : "";
  // Emptiness, not blankness: Enter is "\r" and a `trim()` test would reject
  // the most-pressed key on the surface.
  if (text.length === 0) return appError("text is required");
  if (!host) return appError("the terminal host is not running", 409);
  host.write(`${JSON.stringify({ t: "write", id, data: text })}\n`);
  return appJson({ ok: true });
}

async function resizeTerminal(req: Request): Promise<Response> {
  const id = param(req, "id");
  const terminal = terminals.get(id);
  if (!terminal) return appError(`no terminal ${id}`, 404);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return appError("invalid JSON body");
  }
  const b = (body ?? {}) as { cols?: unknown; rows?: unknown };
  const cols = typeof b.cols === "number" ? b.cols : NaN;
  const rows = typeof b.rows === "number" ? b.rows : NaN;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
    return appError("cols and rows must be positive numbers");
  }
  if (!terminal.exited && host) host.write(`${JSON.stringify({ t: "resize", id, cols, rows })}\n`);
  return appJson({ ok: true });
}

async function closeTerminal(req: Request): Promise<Response> {
  const id = param(req, "id");
  const terminal = terminals.get(id);
  if (!terminal) return appError(`no terminal ${id}`, 404);
  if (host && !terminal.exited) host.write(`${JSON.stringify({ t: "kill", id })}\n`);
  emitExit(terminal, terminal.exitCode ?? 0);
  terminals.delete(id);
  return appJson({ ok: true });
}

export const terminalRoutes = {
  "/api/app/terminals": {
    GET: appSafely(async (req: Request) => listTerminals(req)),
    POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, createTerminal),
  },
  "/api/app/terminals/:id/raw": { GET: safeStreamRoute(rawStream) },
  "/api/app/terminals/:id/input": { POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, writeInput) },
  "/api/app/terminals/:id/resize": { POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, resizeTerminal) },
  "/api/app/terminals/:id/close": { POST: csrfGuard(APP_TOKEN, SELF_ORIGINS, closeTerminal) },
};
