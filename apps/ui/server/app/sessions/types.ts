/**
 * The normalized event union and session shapes for the pty bridge (spec
 * 1.3). One adapter file per harness produces `SessionEvent`s; the UI (K12)
 * renders them identically regardless of which harness emitted them - "the
 * declared escape hatch is the header's Terminal toggle onto the raw TUI"
 * for anything this union cannot express.
 */

/** `kind:"text"` carries the harness's own prose to the operator verbatim -
 * it is the actual reply, not UI chrome, so it is NOT one of the two fields
 * spec 1.3 rule (a) clips ("title/summary 120 chars, detail 180"). Those two
 * numbers name `tool.title`/`tool.detail` specifically; clipping the
 * conversation itself would contradict "less text" being about density, not
 * about truncating what the operator asked to read. */
export type SessionEvent =
  | { kind: "text"; text: string; streaming: boolean }
  | { kind: "tool"; title: string; detail?: string; files?: string[]; status: "ok" | "fail" | "neutral" }
  | { kind: "ask"; requestId: string; question: string; options: { id: string; label: string; description?: string }[] }
  /**
   * K12 addition to spec 1.3's union, and the reason is the one thing K12 is
   * measured on: "navigation away and back loses nothing". An `ask` is
   * answered through `POST /:id/answer`, which no adapter echoes back as an
   * event - so without this line the operator's own answer lives only in the
   * browser tab that made it, and a reload re-renders an already-answered ask
   * as still pending (spec 2.3's "Answered -> one line: `checkmark <chosen
   * label>`" would be lost). It carries the label the operator actually
   * clicked, never a re-derivation.
   */
  | { kind: "answer"; requestId: string; label: string }
  /**
   * K12 addition, same reason as `answer` above: the operator's own turns
   * (spec 2.3's steer and queue) are sent through `POST /:id/input` and no
   * adapter echoes them, so without this line a Session reloaded after a
   * steer shows the harness's half of the conversation and not the
   * operator's. `mode` is kept because a queued turn and a steered one are
   * different events - one interrupted the step, the other waited for it.
   */
  | { kind: "turn"; text: string; mode: "steer" | "queue" }
  /**
   * The harness reached a turn boundary: it finished its reply and nothing is
   * running until the operator (or a queued prompt) sends the next turn. This
   * is the one fact claude's `result` line and codex's per-turn process exit
   * actually carry, and dropping it was a defect rather than restraint - with
   * no record of a turn ENDING, the Session header went on reading `Working`
   * against a harness that had stopped minutes earlier, and said so again
   * after every reload. Recorded once, by `store.ts`'s `onIdle`, so every
   * harness that reports a boundary reports it identically (spec 2.3's
   * harness parity) - and NOT recorded when the boundary is immediately spent
   * on a queued prompt, because then the harness never stopped.
   *
   * Not `exit`: the process is alive and the next turn goes straight into it.
   */
  | { kind: "idle" }
  | { kind: "status"; step: "spec" | "tickets" | "triage" | "queue"; state: "pending" | "running" | "done" | "failed" | "skipped" }
  | { kind: "conn"; attempt: number; of: number }
  | { kind: "error"; detail: string }
  | { kind: "exit"; code: number };

export type HarnessId = "claude" | "codex" | "pi";
export type SessionMode = "chain" | "terminal";
/** `asking` is a running session that is blocked on the operator - spec 2.1's
 * sidebar rule ("live dot = chain running; amber dot = asking", W1-C4), which
 * the sidebar already renders and had nothing to render it from. */
export type SessionState = "running" | "asking" | "ended";

export interface ChainState {
  entered_at_step: string;
  steps: string[];
}

export interface SessionMeta {
  id: string;
  projectId: string;
  harness: HarnessId;
  mode: SessionMode;
  chain: ChainState | null;
  /** The operator's own first turn, verbatim. Spec 1.4's meta.json sketch does
   * not list it; it is here because the prompt is never an event (adapters
   * emit what the HARNESS says) and a Session the operator navigates back to
   * must still show what he asked for. Real data, typed by him, stored once. */
  prompt: string;
  started_at: string;
  ended_at: string | null;
}

/** One line of `events.ndjson` (spec 1.4): the envelope around each stored
 * `SessionEvent`, carrying the monotonic cursor `GET .../stream?after=`
 * replays from and a wall-clock timestamp for anything that wants to show
 * one later. The envelope is what's on disk; `event` alone is what's on the
 * wire (SSE `data:`). */
export interface StoredEvent {
  seq: number;
  at: string;
  event: SessionEvent;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  harness: HarnessId;
  mode: SessionMode;
  state: SessionState;
  chain: ChainState | null;
  prompt: string;
  /** The question the session is blocked on, when `state === "asking"`. The
   * sidebar's amber dot and the one toast spec 2.3 allows ("toasts are
   * reserved for 'the chain is blocked on you'") both need the question's
   * first line without opening the session's stream. */
  pending_ask: { requestId: string; question: string } | null;
  /** How many `queue`-mode inputs are still waiting for a turn boundary.
   * Spec 2.3 chips queued prompts and collapses them past one (`2 queued`);
   * the count has to come from the side that actually drains them, or the
   * chip is a number the UI made up and can never clear. */
  queued: number;
  /** Whether `GET /:id/raw` would attach to something - i.e. this session has
   * a live pty. The header's `Terminal` toggle (spec 2.3's declared escape
   * hatch) needs this to be a fact from the side that owns the pty: a chain
   * Session's adapter is a stdio child process with no TUI behind it, and a
   * toggle that guessed would either hide the escape hatch or open an empty
   * one. Never hidden, disabled with its reason (the F6/F14 trust rule). */
  raw: boolean;
  started_at: string;
}
