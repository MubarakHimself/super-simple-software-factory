/**
 * Hermetic tests for the pty data-race fix (spec 3.4 addendum): no real
 * OS-level pty is ever spawned here - spawnWithPty() injects a fake
 * MinimalPty instead, so "emit before attach" is a deterministic call
 * sequence, not a race to reproduce. Run with `bun test electron/pty.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { WebContents } from "electron";
import { PtyManager, type MinimalPty } from "./pty.js";

/** A MinimalPty stand-in whose onData/onExit callbacks the test drives by
 * hand (fire()/exit()) instead of a real child process ever emitting them. */
function fakePty() {
  let dataCb: ((chunk: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number }) => void) | null = null;
  const writes: string[] = [];
  const pty: MinimalPty = {
    onData: (cb) => {
      dataCb = cb;
      return { dispose: () => {} };
    },
    onExit: (cb) => {
      exitCb = cb;
      return { dispose: () => {} };
    },
    write: (data) => {
      writes.push(String(data));
    },
    resize: () => {},
    kill: () => {},
  };
  return {
    pty,
    writes,
    fire: (chunk: string) => dataCb?.(chunk),
    exit: (exitCode: number) => exitCb?.({ exitCode }),
  };
}

/** Records every ("term:data" | "term:exit", sessionId, payload) send in
 * arrival order - what a real WebContents.send would hand the renderer. */
function fakeSender() {
  const sent: [string, string, unknown][] = [];
  const sender = {
    isDestroyed: () => false,
    send: (channel: string, id: unknown, payload: unknown) => {
      sent.push([channel, String(id), payload]);
    },
  } as unknown as WebContents;
  return { sender, sent };
}

describe("PtyManager replay buffer (finding: PTY DATA RACE)", () => {
  test("data emitted before attach is buffered, not lost, and replayed in order on attach", () => {
    const manager = new PtyManager();
    const { sender, sent } = fakeSender();
    const { pty, fire } = fakePty();

    const id = manager.spawnWithPty(sender, pty);

    // Simulate main emitting output before the renderer has subscribed -
    // exactly the real race (term:open's IPC round trip + React mount
    // effect always lands after this point in practice).
    fire("first\r\n");
    fire("second\r\n");

    // Nothing should have reached the "renderer" yet - it hasn't attached.
    expect(sent.length).toBe(0);

    manager.attach(id);

    // The whole backlog arrives as term:data, in the order it was emitted,
    // BEFORE any live data would.
    expect(sent.length).toBe(1);
    expect(sent[0]![0]).toBe("term:data");
    expect(sent[0]![1]).toBe(id);
    expect(sent[0]![2]).toBe("first\r\nsecond\r\n");

    // Once attached, further data streams live (no more buffering).
    fire("third\r\n");
    expect(sent.length).toBe(2);
    expect(sent[1]).toEqual(["term:data", id, "third\r\n"]);
  });

  test("an exit before attach is buffered too, and replayed AFTER the backlog", () => {
    const manager = new PtyManager();
    const { sender, sent } = fakeSender();
    const { pty, fire, exit } = fakePty();

    const id = manager.spawnWithPty(sender, pty);
    fire("not found\r\n");
    exit(127);

    // Still nothing sent - no attach yet, exactly the spawnNotFound race.
    expect(sent.length).toBe(0);

    manager.attach(id);

    expect(sent.length).toBe(2);
    expect(sent[0]).toEqual(["term:data", id, "not found\r\n"]);
    expect(sent[1]).toEqual(["term:exit", id, 127]);

    // The session is cleaned up once its exit has been replayed.
    expect(manager.size).toBe(0);
  });

  test("attach on an already-live (post-attach) session is a no-op, and data since spawn streams live once attached immediately", () => {
    const manager = new PtyManager();
    const { sender, sent } = fakeSender();
    const { pty, fire } = fakePty();

    const id = manager.spawnWithPty(sender, pty);
    manager.attach(id); // renderer subscribed first, no race this time
    fire("hi\r\n");

    expect(sent).toEqual([["term:data", id, "hi\r\n"]]);

    manager.attach(id); // idempotent - must not re-send or throw
    expect(sent.length).toBe(1);
  });

  test("spawnNotFound's line survives the identical race via the same buffer/attach path", async () => {
    const manager = new PtyManager();
    const { sender, sent } = fakeSender();

    const id = manager.spawnNotFound(sender, "'ghost' was not found on PATH.");

    // The old bug: this microtask fires and sends before a renderer ever
    // subscribes. Give it a turn of the microtask queue - same as the real
    // queueMicrotask - WITHOUT attaching yet.
    await Promise.resolve();
    await Promise.resolve();

    expect(sent.length).toBe(0); // nothing lost, but nothing sent either - buffered

    manager.attach(id);

    expect(sent.length).toBe(2);
    expect(sent[0]).toEqual(["term:data", id, "'ghost' was not found on PATH.\r\n"]);
    expect(sent[1]).toEqual(["term:exit", id, 127]);
  });

  test("unknown session id: attach/write/resize/close are all safe no-ops", () => {
    const manager = new PtyManager();
    expect(() => manager.attach("nope")).not.toThrow();
    expect(() => manager.write("nope", "x")).not.toThrow();
    expect(() => manager.resize("nope", 80, 24)).not.toThrow();
    expect(() => manager.close("nope")).not.toThrow();
  });

  test("close() before attach kills the pty and drops the buffered backlog", () => {
    const manager = new PtyManager();
    const { sender } = fakeSender();
    const { pty, fire } = fakePty();
    let killed = false;
    (pty as unknown as { kill: () => void }).kill = () => {
      killed = true;
    };

    const id = manager.spawnWithPty(sender, pty);
    fire("buffered, never seen\r\n");
    manager.close(id);

    expect(killed).toBe(true);
    expect(manager.size).toBe(0);
    // Attaching after close is a no-op - the session is gone, not replayed.
    expect(() => manager.attach(id)).not.toThrow();
  });
});
