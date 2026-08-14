/**
 * Owns every live pty for the Terminal raw view (spec 1.3's
 * `GET /api/app/sessions/:id/raw` + `POST /:id/resize`). Ported from
 * `apps/ui/electron/pty.ts` - the buffered-emit-before-attach fix survives
 * verbatim (spawn a pty, buffer its data/exit until something is listening,
 * replay in order, then stream live) - but the sink and the buffer's
 * lifetime both change on purpose, and both changes are load-bearing:
 *
 * 1. **Sink**: Electron's `WebContents.send` becomes two plain callbacks
 *    (`onData`/`onExit`) that bridge.ts wires to an SSE writer. There is no
 *    `isDestroyed()` to check server-side - `detach()` is how a caller says
 *    "stop sending to me", and it is always safe to call twice.
 *
 * 2. **Buffer lifetime**: the Electron original buffers ONLY before the
 *    first attach (a one-shot mount-race fix - Electron's IPC channel never
 *    really disconnects while the window lives, so "attached" only ever
 *    meant "the renderer's effect ran yet"). A browser's SSE connection is a
 *    real network connection that drops and reconnects, and spec 1.3 is
 *    explicit that this must survive it: "Every attach replays the ... replay
 *    buffer first, then streams live - without that, leaving Terminal mode
 *    and coming back loses the backscroll, which is audit F2 reappearing...
 *    The replay buffer's bound IS the backscroll bound." So here the ring
 *    buffer is never emptied on flush - it keeps accumulating for the life
 *    of the session (bounded, oldest bytes drop) and every attach (first or
 *    Nth) replays its current contents non-destructively, then the caller
 *    starts receiving live bytes too. Detaching (tab/surface switch, network
 *    drop) does not stop the buffer from growing - reattaching later still
 *    sees the most recent window, which is the whole point.
 */
import * as nodePty from "@lydell/node-pty";
import { randomUUID } from "node:crypto";

/** The subset of node-pty's IPty this module actually touches. Exported so a
 * hermetic test can inject a fake against exactly this shape, mirroring
 * `apps/ui/electron/pty.test.ts`'s seam. */
export type MinimalPty = Pick<nodePty.IPty, "onData" | "onExit" | "write" | "resize" | "kill">;

/** Bytes retained as backscroll, per session, for the life of the session
 * (spec 1.3: "The replay buffer's bound IS the backscroll bound, and it dies
 * with the server" - Open Decision 6). Generous enough to hold a real
 * Terminal's worth of scrollback without becoming a memory concern for a
 * single-operator loopback app. */
const RING_BUFFER_CAP_CHARS = 512 * 1024;

/** Non-null when this host cannot deliver keystrokes to a pty at all - see
 * `PtyBridge.write`'s header for the finding. The sentence is what the
 * operator reads, so it says what is true rather than naming a library. */
const WRITE_UNAVAILABLE: string | null =
  process.platform === "win32" ? "this terminal takes no input on this host - read-only" : null;

class RingBuffer {
  private data = "";

  push(chunk: string): void {
    this.data += chunk;
    if (this.data.length > RING_BUFFER_CAP_CHARS) {
      this.data = this.data.slice(this.data.length - RING_BUFFER_CAP_CHARS);
    }
  }

  /** Non-destructive - every attach (first or Nth) sees the current
   * contents; the buffer itself is only ever trimmed by `push`. */
  peek(): string {
    return this.data;
  }
}

export interface PtyListener {
  onData(chunk: string): void;
  onExit(code: number): void;
}

interface Session {
  /** null once the pty has exited - the entry itself is kept around so a
   * not-yet-attached (or detached) listener can still be attached/replayed
   * against; write()/resize()/close() all treat a null pty as "nothing left
   * to do" rather than an error. */
  pty: MinimalPty | null;
  buffer: RingBuffer;
  /** Set only while something is actively streaming; null between attaches
   * (detached, or never yet attached). Live bytes go to this listener AND
   * into the buffer, always - so a later reattach still has them. */
  listener: PtyListener | null;
  exited: boolean;
  exitCode: number | null;
}

export interface SpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export class PtyBridge {
  private sessions = new Map<string, Session>();

  /** Spawns a real pty. Session id is minted here (crypto.randomUUID()) -
   * never the OS pid: pty pids are not stable session keys across platforms
   * (the Electron original's landmine 2.4.2 note applies just as much
   * server-side), so pid can never be a session key or a kill target. */
  spawn(opts: SpawnOptions): string {
    const pty = nodePty.spawn(opts.file, opts.args, {
      name: "xterm-color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env as { [key: string]: string },
    });
    return this.spawnWithPty(pty);
  }

  /** Same wiring as spawn(), against an injected pty instead of a real
   * nodePty.spawn() call - the hermetic test seam. */
  spawnWithPty(pty: MinimalPty): string {
    const id = randomUUID();
    this.sessions.set(id, { pty, buffer: new RingBuffer(), listener: null, exited: false, exitCode: null });
    pty.onData((chunk) => this.emitData(id, chunk));
    pty.onExit(({ exitCode }) => this.emitExit(id, exitCode));
    return id;
  }

  /** No real pty behind this session - used when a profile's binary was not
   * found (mirrors spec 1.3's "missing binary -> the exact profiles.ts line
   * as the only event", applied to the raw pty view too: it must fail
   * visibly, never silently, and never pretend to have started). One plain
   * line, then exits 127 (shell convention for "command not found"). Goes
   * through the same buffered path as a real pty, via queueMicrotask so the
   * very first attach (which, in practice, races this by a full HTTP round
   * trip) still gets it from the buffer rather than a lost live emit. */
  spawnNotFound(message: string): string {
    const id = randomUUID();
    this.sessions.set(id, { pty: null, buffer: new RingBuffer(), listener: null, exited: false, exitCode: null });
    queueMicrotask(() => {
      this.emitData(id, `${message}\r\n`);
      this.emitExit(id, 127);
    });
    return id;
  }

  private emitData(id: string, chunk: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.buffer.push(chunk);
    session.listener?.onData(chunk);
  }

  private emitExit(id: string, exitCode: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.pty = null;
    session.exited = true;
    session.exitCode = exitCode;
    session.listener?.onExit(exitCode);
    // Unlike the Electron original (which deletes the session once its exit
    // has been replayed to the one renderer that will ever ask), a session
    // here stays in the map after exit - a late or repeat attach must still
    // be able to replay the buffer and learn the process has ended. Nothing
    // ever deletes an exited entry except close()/killAll() being called
    // again is a no-op, and process death drops the whole map anyway
    // (Open Decision 6).
  }

  /** Registers `listener` as the live sink for this session and immediately
   * replays the current backscroll (spec 1.3: "Every attach replays the ...
   * replay buffer first, then streams live"). Safe to call repeatedly -
   * each call replaces the previous listener (a stale SSE connection is
   * expected to have already been dropped by its own caller first) and each
   * replay is the buffer's current contents, which only grows over time.
   * If the session has already exited, the exit is replayed too, right
   * after the backlog. Unknown session id: no-op, returns false. */
  attach(id: string, listener: PtyListener): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.listener = listener;
    const backlog = session.buffer.peek();
    if (backlog) listener.onData(backlog);
    if (session.exited) listener.onExit(session.exitCode ?? 0);
    return true;
  }

  /** Stops sending live bytes to whichever listener is currently attached
   * (if any) - called when an SSE connection closes. The buffer keeps
   * growing from any further pty output regardless, so a future attach()
   * still sees it. Idempotent. */
  detach(id: string, listener: PtyListener): void {
    const session = this.sessions.get(id);
    if (session?.listener === listener) session.listener = null;
  }

  /**
   * Writes to a pty, and on Windows-under-Bun refuses to, with a reason.
   *
   * **Landmine, found live (K12, 2026-08-14) and reproduced outside this
   * repo's code entirely.** `@lydell/node-pty`'s Windows terminal writes
   * through `new net.Socket({ fd: <conin fd>, writable: true })`
   * (`windowsPtyAgent.js`:87). Under Bun 1.3.14 on Windows that socket is
   * never writable: the first `pty.write()` fails with `ERR_SOCKET_CLOSED`,
   * emitted **out of band** - not thrown to the caller, so no `try/catch`
   * anywhere on the call path can hold it - and Bun turns it into an uncaught
   * exception that takes the whole server down. A four-line script that only
   * spawns `cmd.exe` and writes `echo hi\r` reproduces it with none of this
   * repo's code involved; the same node-pty version drives the v1 Electron
   * app perfectly, because Electron runs it on Node.
   *
   * Pty OUTPUT is unaffected (it comes through a different socket), so the
   * Terminal raw view streams a real TUI exactly as spec 1.3 describes; it is
   * only input that has nowhere to go. Refusing here with a reason the caller
   * can show is the F6/F14 trust rule applied to a platform limit: never a
   * silently swallowed keystroke, and never a dead server (spec 1.3).
   */
  write(id: string, data: string): { ok: true } | { ok: false; reason: string } {
    const session = this.sessions.get(id);
    if (!session?.pty) return { ok: false, reason: "this terminal has ended" };
    if (WRITE_UNAVAILABLE !== null) return { ok: false, reason: WRITE_UNAVAILABLE };
    try {
      session.pty.write(data);
      return { ok: true };
    } catch {
      return { ok: false, reason: "this terminal has ended" };
    }
  }

  /** Landmine: resize() on an exited pty throws ("Cannot resize a pty that
   * has already exited"). Every resize goes through the session map first
   * and no-ops if the pty is already gone; the try/catch also survives the
   * exit-race window between the lookup and the call itself. */
  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session?.pty) return;
    try {
      session.pty.resize(cols, rows);
    } catch {
      /* exited between the lookup and the call - nothing to do */
    }
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (!session.pty) return; // already exited
    try {
      session.pty.kill();
    } catch {
      /* already dead */
    }
  }

  /** Called on server shutdown paths that want a clean kill (spec's
   * "Sessions across server restarts" - Open Decision 6 accepts that
   * processes die with the server; this just makes that deliberate rather
   * than leaking child processes past the parent). Idempotent. */
  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** One bridge for the whole server process - every Session's raw pty (when
 * its mode is "terminal") lives here, keyed by sessionId. */
export const ptyBridge = new PtyBridge();
