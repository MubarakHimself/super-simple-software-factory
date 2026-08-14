/**
 * The Session store (spec 1.3/1.4): owns every live Session's process(es),
 * its durable `events.ndjson` + `meta.json` under `~/.sdl-factory/sessions/
 * <id>/`, and the in-memory registry `bridge.ts`'s route handlers read.
 *
 * One process (this Bun server) holds every live Session - "Switching
 * projects or surfaces never kills a Session: the process lives in the
 * server, the browser holds only a cursor" (spec 2.3). Sessions do NOT
 * survive a server restart (Open Decision 6, accepted): the in-memory
 * registry is gone the instant the process exits, but `events.ndjson` is
 * written synchronously on every event, so it survives - a stream request
 * against an unknown-but-persisted id after a restart replays the file from
 * disk and reports the session as ended (`server restarted`), never a 404
 * pretending the run never happened.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appHome, findProject } from "../manifest.ts";
import { startClaude } from "./adapters/claude.ts";
import { startCodex } from "./adapters/codex.ts";
import { startPi } from "./adapters/pi.ts";
import type { AdapterHandle } from "./adapter.ts";
import { ptyBridge, type PtyListener } from "./pty.ts";
import { resolveProfile } from "./profiles.ts";
import type {
  ChainState,
  HarnessId,
  SessionMeta,
  SessionMode,
  SessionState,
  SessionSummary,
  StoredEvent,
} from "./types.ts";

function sessionsRoot(): string {
  return join(appHome(), "sessions");
}

function sessionDir(id: string): string {
  return join(sessionsRoot(), id);
}

function metaPath(id: string): string {
  return join(sessionDir(id), "meta.json");
}

function eventsPath(id: string): string {
  return join(sessionDir(id), "events.ndjson");
}

interface LiveSession {
  meta: SessionMeta;
  events: StoredEvent[]; // this process's copy, source of truth for in-process replay
  nextSeq: number;
  subscribers: Set<(e: StoredEvent) => void>;
  adapter: AdapterHandle | null; // null for terminal-mode sessions (raw pty only)
  ptySessionId: string | null; // set for terminal-mode sessions
  queuedTexts: string[]; // "queue" mode backlog, drained on the adapter's onIdle
  /** Asks recorded and not yet answered, oldest first - the session is
   * `asking` (blocked on the operator) while this is non-empty. Kept here
   * rather than inside an adapter because the sidebar and the one toast ask
   * the STORE what a session is doing, and every harness answers the same
   * way (spec 2.3's harness parity). */
  pendingAsks: { requestId: string; question: string; options: { id: string; label: string }[] }[];
  /** True between turns - the adapter has reported a turn boundary and
   * nothing has been sent since. A `queue`-mode input arriving while this is
   * true is sent immediately: "queue drains at the next turn boundary" (spec
   * 1.3) is already satisfied when the boundary has been reached, and the
   * alternative found live is a prompt that waits for a boundary that will
   * never come because nothing is running to produce one. */
  idle: boolean;
  ended: boolean;
}

const live = new Map<string, LiveSession>();

function nowIso(): string {
  return new Date().toISOString();
}

function persistMeta(session: LiveSession): void {
  mkdirSync(sessionDir(session.meta.id), { recursive: true });
  writeFileSync(metaPath(session.meta.id), `${JSON.stringify(session.meta, null, 2)}\n`, "utf-8");
}

/** Appends one line and fans out to every live subscriber, in that order -
 * a subscriber attaching mid-write never sees the write racing its own
 * replay because JS is single-threaded and this function does both
 * synchronously before yielding. `appendFileSync` (not a buffered stream) on
 * purpose: spec 1.3's own K11 done-when is "kill server -> events.ndjson
 * survives", and a synchronous write handed to the OS before this call
 * returns is what makes that true regardless of when the kill lands. */
function record(session: LiveSession, event: StoredEvent["event"]): StoredEvent {
  // The two events that change what the session IS, tracked as they are
  // written so `listSessions()` never has to re-scan the log.
  if (event.kind === "ask") {
    session.pendingAsks.push({
      requestId: event.requestId,
      question: event.question,
      options: event.options.map((o) => ({ id: o.id, label: o.label })),
    });
  } else if (event.kind === "answer") {
    session.pendingAsks = session.pendingAsks.filter((a) => a.requestId !== event.requestId);
  }
  const stored: StoredEvent = { seq: session.nextSeq++, at: nowIso(), event };
  session.events.push(stored);
  mkdirSync(sessionDir(session.meta.id), { recursive: true });
  appendFileSync(eventsPath(session.meta.id), `${JSON.stringify(stored)}\n`, "utf-8");
  for (const sub of session.subscribers) sub(stored);
  return stored;
}

function markEnded(session: LiveSession): void {
  if (session.ended) return;
  session.ended = true;
  session.meta.ended_at = nowIso();
  persistMeta(session);
}

export type CreateSessionInput = {
  projectId: string;
  harness: HarnessId;
  mode: SessionMode;
  /** The composer's initial text (chain mode). Ignored for terminal mode. */
  prompt?: string;
  /** App-owned Chain state, derived by the client from the invoked skill -
   * spec 2.3: "Chain state is app-owned, derived from the invoked skill -
   * identical across harnesses", and spec 1.4 puts `chain` in meta.json. The
   * server stores and returns it; it never computes one, because the harness
   * has no opinion about the Chain and neither does this file. */
  chain?: ChainState | null;
};

export type CreateSessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string; status: number };

export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  const project = await findProject(input.projectId);
  if (!project) return { ok: false, error: `no project ${input.projectId}`, status: 404 };

  const id = randomUUID();
  const meta: SessionMeta = {
    id,
    projectId: input.projectId,
    harness: input.harness,
    mode: input.mode,
    chain: input.chain ?? null,
    prompt: input.prompt ?? "",
    started_at: nowIso(),
    ended_at: null,
  };
  const session: LiveSession = {
    meta,
    events: [],
    // Starts at 1, not 0: the default `after=0` (spec's own example query
    // shape, "GET .../stream?after=") must mean "everything so far", and
    // `seq > afterSeq` with a 0-valued first seq would silently swallow the
    // very first event on a fresh replay.
    nextSeq: 1,
    subscribers: new Set(),
    adapter: null,
    ptySessionId: null,
    queuedTexts: [],
    pendingAsks: [],
    idle: false, // the first turn is the prompt, sent by the adapter at start
    ended: false,
  };
  live.set(id, session);
  mkdirSync(sessionDir(id), { recursive: true });
  persistMeta(session);

  const resolved = resolveProfile(input.harness);
  if (!resolved.ok) {
    // "missing binary -> the exact profiles.ts line as the only event"
    // (K11 done-when). No process spawned at all.
    record(session, { kind: "error", detail: resolved.message });
    markEnded(session);
    return { ok: true, sessionId: id };
  }

  if (input.mode === "terminal") {
    const ptyId = ptyBridge.spawn({
      file: resolved.command.file,
      args: resolved.command.args,
      cwd: project.root,
      cols: 80,
      rows: 24,
      env: process.env,
    });
    session.ptySessionId = ptyId;
    return { ok: true, sessionId: id };
  }

  const onEvent = (event: StoredEvent["event"]) => {
    record(session, event);
    if (event.kind === "exit") markEnded(session);
  };
  const onIdle = () => {
    const next = session.queuedTexts.shift();
    if (next === undefined) {
      session.idle = true;
      // The boundary on the durable log, not only in this process's memory:
      // the Session header reads what the session is doing from the record,
      // so the record has to say when the harness stopped doing it (see the
      // `idle` event in types.ts). Nothing is recorded on the branch below -
      // a boundary spent immediately on a queued prompt is not a pause.
      record(session, { kind: "idle" });
      return;
    }
    session.idle = false;
    session.adapter?.input(next);
  };
  const start = input.harness === "claude" ? startClaude : input.harness === "codex" ? startCodex : startPi;
  session.adapter = start({
    file: resolved.command.file,
    baseArgs: resolved.command.args,
    cwd: project.root,
    prompt: input.prompt ?? "",
    onEvent,
    onIdle,
  });

  return { ok: true, sessionId: id };
}

export function listSessions(): SessionSummary[] {
  return [...live.values()].map((s) => ({
    id: s.meta.id,
    projectId: s.meta.projectId,
    harness: s.meta.harness,
    mode: s.meta.mode,
    state: (s.ended ? "ended" : s.pendingAsks.length > 0 ? "asking" : "running") as SessionState,
    chain: s.meta.chain,
    prompt: s.meta.prompt,
    pending_ask: s.ended ? null : (s.pendingAsks[0] ?? null),
    queued: s.queuedTexts.length,
    // The same test `rawStreamHandler` runs before it attaches, so the
    // header's Terminal toggle and the endpoint can never disagree.
    raw: !!s.ptySessionId && ptyBridge.has(s.ptySessionId),
    started_at: s.meta.started_at,
  }));
}

export function hasLiveSession(id: string): boolean {
  return live.has(id);
}

export function getMeta(id: string): SessionMeta | null {
  const s = live.get(id);
  if (s) return s.meta;
  // Not in this process's memory - either unknown, or a session from before
  // a restart. Its meta.json still answers honestly (Open Decision 6).
  const path = metaPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SessionMeta;
  } catch {
    return null;
  }
}

/** Reads persisted events after `afterSeq` straight from disk - the path
 * used both for a session this process never held live (post-restart) and
 * as the durability check itself (spec's K11 done-when: "kill server ->
 * events.ndjson survives" means this function, pointed at the same id after
 * a fresh process boot, must return everything that was ever recorded). */
export function readPersistedEvents(id: string, afterSeq: number): StoredEvent[] | null {
  const path = eventsPath(id);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf-8");
  const out: StoredEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const stored = JSON.parse(line) as StoredEvent;
      if (stored.seq > afterSeq) out.push(stored);
    } catch {
      /* a torn last line from a mid-write kill - ignore it, everything
       * before it is intact */
    }
  }
  return out;
}

/**
 * Subscribes `onEvent` to a live session's future events and returns the
 * backlog after `afterSeq` to replay first (in-memory, always consistent
 * with what was persisted since this process started). Returns null if the
 * session is not live in this process (caller falls back to
 * `readPersistedEvents` + "ended: server restarted").
 */
export function subscribeLive(
  id: string,
  afterSeq: number,
  onEvent: (e: StoredEvent) => void,
): { backlog: StoredEvent[]; ended: boolean; unsubscribe: () => void } | null {
  const session = live.get(id);
  if (!session) return null;
  const backlog = session.events.filter((e) => e.seq > afterSeq);
  if (!session.ended) session.subscribers.add(onEvent);
  return {
    backlog,
    ended: session.ended,
    unsubscribe: () => session.subscribers.delete(onEvent),
  };
}

export type InputResult = { ok: true } | { ok: false; error: string };

export function sendInput(id: string, text: string, mode: "steer" | "queue"): InputResult {
  const session = live.get(id);
  if (!session) return { ok: false, error: `no live session ${id}` };
  if (session.ended) return { ok: false, error: "session has ended" };
  if (!session.adapter && session.ptySessionId) {
    // Terminal mode: the Session IS the pty, so its keystrokes are raw bytes
    // written straight through - there is no turn to queue against, which is
    // why `queue` is refused with a reason rather than silently treated as a
    // write (the same never-silently-degrade rule steer follows). Spec 1.3's
    // Terminal escape hatch lists `raw` + `resize` and no third endpoint, so
    // this is the endpoint it has; flagged in K12's notes.
    if (mode === "queue") return { ok: false, error: "a terminal has no turn boundary to queue against" };
    const written = ptyBridge.write(session.ptySessionId, text);
    return written.ok ? { ok: true } : { ok: false, error: written.reason };
  }
  if (!session.adapter) return { ok: false, error: "session has no chain to steer or queue into (terminal mode)" };
  if (mode === "steer") {
    if (!session.adapter.canSteer) {
      return { ok: false, error: `${session.meta.harness} cannot steer a running turn` };
    }
    session.idle = false;
    session.adapter.input(text);
    record(session, { kind: "turn", text, mode });
    return { ok: true };
  }
  if (session.idle) {
    // Already at a turn boundary - queueing here would wait for a boundary
    // that has already happened. See LiveSession.idle.
    session.idle = false;
    session.adapter.input(text);
    record(session, { kind: "turn", text, mode });
    return { ok: true };
  }
  session.queuedTexts.push(text);
  record(session, { kind: "turn", text, mode });
  return { ok: true };
}

export type AnswerResult = { ok: true } | { ok: false; error: string };

export function answer(id: string, requestId: string, value: { optionId?: string; text?: string }): AnswerResult {
  const session = live.get(id);
  if (!session) return { ok: false, error: `no live session ${id}` };
  if (!session.adapter) return { ok: false, error: "session has no chain (terminal mode)" };
  // The label the operator actually read on the row, not the id the harness
  // asked to be told - spec 2.3's answered form is "checkmark <chosen label>".
  const asked = session.pendingAsks.find((a) => a.requestId === requestId);
  const label =
    asked?.options.find((o) => o.id === value.optionId)?.label ?? value.optionId ?? value.text ?? "";
  const accepted = session.adapter.answer(requestId, value);
  if (!accepted) return { ok: false, error: `no pending ask ${requestId}` };
  // Recorded only after the adapter took it - the log says the operator
  // answered exactly when the harness was actually resumed, never before.
  record(session, { kind: "answer", requestId, label });
  return { ok: true };
}

export function stop(id: string): InputResult {
  const session = live.get(id);
  if (!session) return { ok: false, error: `no live session ${id}` };
  if (session.adapter) session.adapter.stop();
  if (session.ptySessionId) ptyBridge.close(session.ptySessionId);
  if (!session.adapter) markEnded(session); // terminal mode: nothing else marks it ended
  return { ok: true };
}

export function hasRaw(id: string): boolean {
  const session = live.get(id);
  return !!session?.ptySessionId && ptyBridge.has(session.ptySessionId);
}

export function attachRaw(id: string, listener: PtyListener): boolean {
  const session = live.get(id);
  if (!session?.ptySessionId) return false;
  return ptyBridge.attach(session.ptySessionId, listener);
}

export function detachRaw(id: string, listener: PtyListener): void {
  const session = live.get(id);
  if (!session?.ptySessionId) return;
  ptyBridge.detach(session.ptySessionId, listener);
}

export function resizeRaw(id: string, cols: number, rows: number): boolean {
  const session = live.get(id);
  if (!session?.ptySessionId) return false;
  ptyBridge.resize(session.ptySessionId, cols, rows);
  return true;
}
