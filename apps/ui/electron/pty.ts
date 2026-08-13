/**
 * Owns every live pty for the Terminal surface (spec 3.1/3.2). Nothing in
 * this file is reachable from the renderer directly - main.ts's IPC
 * handlers are the only callers, and they origin-gate first.
 *
 * Data-race fix (spec 3.4 addendum): main starts emitting `pty.onData`
 * (or, for a not-found profile, the one honest "not found" line) the
 * instant a session is minted - which is well before the renderer's
 * `await term.open()` round trip resolves and PtyPane's own mount effect
 * subscribes `term.onData`/`onExit`. Every byte and the eventual exit are
 * therefore buffered per-session until a renderer actually attaches
 * (`attach()`, called once by PtyPane on mount), then replayed in order -
 * buffer first, exit last - before switching to live streaming. Nothing is
 * ever silently lost between spawn and attach.
 */
import * as nodePty from "@lydell/node-pty";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

/** The subset of node-pty's IPty this module actually touches. Exported so
 * pty.test.ts can inject a fake against exactly this shape - hermetic tests
 * never spawn a real OS-level pty. */
export type MinimalPty = Pick<nodePty.IPty, "onData" | "onExit" | "write" | "resize" | "kill">;

/** Bytes retained per not-yet-attached session before the oldest are
 * dropped. Generous relative to any realistic pre-attach window (a spawn
 * banner, a not-found line) - this is a replay buffer, not a scrollback. */
const RING_BUFFER_CAP_CHARS = 256 * 1024;

class RingBuffer {
  private data = "";

  push(chunk: string): void {
    this.data += chunk;
    if (this.data.length > RING_BUFFER_CAP_CHARS) {
      this.data = this.data.slice(this.data.length - RING_BUFFER_CAP_CHARS);
    }
  }

  /** Returns everything buffered and empties it - a one-shot replay, not a
   * peek, so a session can only ever be flushed once per attach. */
  flush(): string {
    const out = this.data;
    this.data = "";
    return out;
  }
}

interface Session {
  /** null once the pty has exited - the entry itself is kept around (not
   * yet deleted from `sessions`) only so a still-unattached replay has
   * something to attach to; `close()`/`write()`/`resize()` all treat a null
   * pty as "nothing left to do" rather than an error. */
  pty: MinimalPty | null;
  sender: WebContents;
  buffer: RingBuffer;
  /** True once a renderer has called attach() - from then on, data streams
   * live and the buffer is never touched again. */
  attached: boolean;
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

export class PtyManager {
  private sessions = new Map<string, Session>();

  /** Spawns a real pty and wires its data/exit into the buffered-emit path
   * below. Session id is minted here (crypto.randomUUID()) - never the OS
   * pid: `pty.pid` reads 0 under Electron main (spec landmine 2.4.2), so pid
   * can never be a session key or a kill target. */
  spawn(sender: WebContents, opts: SpawnOptions): string {
    const pty = nodePty.spawn(opts.file, opts.args, {
      name: "xterm-color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env as { [key: string]: string },
    });
    return this.spawnWithPty(sender, pty);
  }

  /** Same wiring as spawn(), against an injected pty instead of a real
   * nodePty.spawn() call. This is the hermetic test seam (pty.test.ts): no
   * OS process, no scheduler timing, so "emit before attach, then attach"
   * is deterministic instead of a race to reproduce. */
  spawnWithPty(sender: WebContents, pty: MinimalPty): string {
    const id = randomUUID();
    this.sessions.set(id, { pty, sender, buffer: new RingBuffer(), attached: false, exited: false, exitCode: null });
    pty.onData((chunk) => this.emitData(id, chunk));
    pty.onExit(({ exitCode }) => this.emitExit(id, exitCode));
    return id;
  }

  /** No real pty behind this tab - used when a profile's binary was not
   * found (spec 3.3: "must fail visibly in the tab ... never silently
   * closes, never pretends to have started"). One plain line, then exits
   * 127 (shell convention for "command not found") so the tab's own exit
   * handling takes over normally. Goes through the same emit path as a real
   * pty, so this line is buffered-and-replayed exactly like real pty output
   * if the renderer has not attached yet - which, via queueMicrotask, it
   * essentially never has. */
  spawnNotFound(sender: WebContents, message: string): string {
    const id = randomUUID();
    this.sessions.set(id, { pty: null, sender, buffer: new RingBuffer(), attached: false, exited: false, exitCode: null });
    queueMicrotask(() => {
      this.emitData(id, `${message}\r\n`);
      this.emitExit(id, 127);
    });
    return id;
  }

  private emitData(id: string, chunk: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.attached) {
      if (!session.sender.isDestroyed()) session.sender.send("term:data", id, chunk);
    } else {
      session.buffer.push(chunk);
    }
  }

  private emitExit(id: string, exitCode: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.pty = null;
    session.exited = true;
    session.exitCode = exitCode;
    // Attached: forward and clean up now, exactly as before. Not attached:
    // leave the (now pty-less) entry in the map - attach() replays the
    // buffer, then this exit, then cleans up.
    if (session.attached) this.finishExit(id, session);
  }

  private finishExit(id: string, session: Session): void {
    this.sessions.delete(id);
    if (!session.sender.isDestroyed()) session.sender.send("term:exit", id, session.exitCode ?? 0);
  }

  /** Called once by the renderer (PtyPane's mount effect) right after it has
   * subscribed term.onData/onExit. Flushes whatever arrived before this
   * moment, in order, then - if the pty had already exited too - replays
   * the exit and cleans up. From here on the session streams live.
   * Idempotent: attaching an already-attached or unknown session is a
   * no-op. */
  attach(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.attached) return;
    session.attached = true;
    const backlog = session.buffer.flush();
    if (backlog && !session.sender.isDestroyed()) session.sender.send("term:data", id, backlog);
    if (session.exited) this.finishExit(id, session);
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty?.write(data);
  }

  /** Landmine 2.4.1: resize() on an exited pty throws
   * ("Cannot resize a pty that has already exited"). Every resize goes
   * through the session map first and no-ops if the pty is already gone;
   * the try/catch also survives the exit-race window between the lookup
   * and the call itself. */
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
    if (!session.pty) return; // already exited (and possibly never attached)
    try {
      session.pty.kill();
    } catch {
      /* already dead */
    }
  }

  /** Called on before-quit and window close (spec 3.2: "Sessions are
   * killed on before-quit and when their window closes"). Idempotent - a
   * second call after the map is already empty is a no-op. */
  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}
