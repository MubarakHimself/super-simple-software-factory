/**
 * The shared shape every `adapters/*.ts` file returns to store.ts. store.ts
 * only ever talks to a Session through this interface - it does not know or
 * care whether a harness keeps one persistent process open for the whole
 * Session (claude) or spawns one process per turn and threads them together
 * itself (codex's `exec` / `exec resume`, since `codex exec` has no
 * persistent stdin-duplex mode - see adapters/codex.ts's header for why that
 * is a deliberate, flagged departure from "one long-lived process" read
 * literally).
 */
import type { SessionEvent } from "./types.ts";

export interface AdapterStartOptions {
  /** Resolved binary/launcher from profiles.ts's `resolveProfile()`. */
  file: string;
  /** Any launcher-required leading args from profiles.ts (e.g. pi's
   * `[scriptPath]`) - the adapter appends its own protocol args after these. */
  baseArgs: string[];
  cwd: string;
  /** The first turn's text - queued the instant the process/turn is ready. */
  prompt: string;
  /** Called for every normalized event this adapter produces, in emission
   * order. store.ts is the only subscriber; it persists to events.ndjson and
   * fans out to SSE listeners. */
  onEvent: (event: SessionEvent) => void;
  /** Called whenever the adapter reaches a turn boundary - the current turn
   * has fully finished and a new one could start. store.ts uses this to
   * drain its `queue`-mode backlog (spec 1.3: "queue drains at the next
   * turn boundary") rather than store.ts having to guess at each harness's
   * internal turn state. `steer` never waits for this - it calls `input()`
   * immediately, on the caller's own head. */
  onIdle: () => void;
}

export interface AdapterHandle {
  /** Whether this harness can accept a new turn while the current one is
   * still in flight (spec 1.3's steer) - claude/codex: true; pi: false per
   * Open Decision 2, mirroring readiness.ts's `can_steer` for the same
   * harness. store.ts surfaces this on `/input` so a `steer` request against
   * a harness that cannot is refused with a reason, never silently
   * downgraded to `queue` (spec 2.3's steer-vs-queue rule, W1-C5). */
  readonly canSteer: boolean;
  /** Queues (or, if the harness is between turns and idle, immediately
   * sends) the next turn's text. Returns false if the session has already
   * been stopped and can never accept another turn. */
  input(text: string): boolean;
  /** Answers a pending `ask` event by requestId - resumes the harness's own
   * tool-result protocol for that ask (adapter-specific; see claude.ts).
   * Returns false if requestId is not the adapter's current pending ask. */
  answer(requestId: string, value: { optionId?: string; text?: string }): boolean;
  /** Ends the session: closes stdin / kills whatever is currently running,
   * and guarantees an `{kind:"exit"}` event is eventually emitted through
   * onEvent (adapters emit it themselves; store.ts never synthesizes one on
   * the adapter's behalf, so a still-open child that ignores stop() is
   * visible as "never exited" rather than falsely reported as ended). */
  stop(): void;
}
