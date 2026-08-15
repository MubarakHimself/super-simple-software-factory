/**
 * Board's own shapes, mirroring `apps/ui/server/app/cards.ts`'s
 * `CardItem`/`CardsResponse`/`CardState` and `live.ts`'s (unexported)
 * `LiveRun` field-for-field. Declared locally rather than imported, same
 * pattern `lib/api.ts` already uses for `Project`/`Live`/`FactoryHealth`: a
 * surface owns its own types in its own directory, decoupled from the
 * server module that happens to produce the same JSON today.
 *
 * Plus the handful of pure, board-only derivations (which column a card
 * lands in, a priority's colour, a live run's lane) - no I/O, so they are
 * trivially testable and never re-derive something the server already
 * decided (state / state_reason / waiting_on all arrive pre-computed).
 */
import type { Tone } from "../shared/Dot.tsx";

export type CardState = "ready" | "running" | "blocked" | "done" | "integrated" | "shipped" | "unknown";

export interface CardCriterion {
  text: string;
  done: boolean;
}

export interface CardItem {
  path: string;
  name: string;
  slug: string;
  title: string;
  status: string | null;
  state: CardState;
  state_reason: string;
  parked: boolean;
  adw: string | null;
  adw_id: string | null;
  created: string | null;
  context: string | null;
  category: string | null;
  feature: string | null;
  priority: string | null;
  needs: string[];
  waiting_on: string[];
  blocked_reason: string | null;
  blocks: string[];
  criteria_done: number;
  criteria_total: number;
  criteria: CardCriterion[];
  body: string;
}

export interface UnparsedCard {
  path: string;
  reason: string;
}

export interface CardsResponse {
  dir: string;
  done_dir: string;
  items: CardItem[];
  unparsed: UnparsedCard[];
  shipped_source: "git-tree" | "unavailable";
  shipped_reason: string | null;
  main_ref: string;
}

/** `GET /api/app/p/:id/live`'s per-run row - only the fields the Board's
 * Running column reads. `phase`/`model` are null exactly when the server
 * could not derive them (no open phase, no active agent) - never guessed. */
export interface LiveRun {
  adw_id: string;
  started_at: string | null;
  phase: { name: string | null; seq: number | null; owner: string | null } | null;
  model: string | null;
  coding_agent: string | null;
}

export type BoardColumn = "ready" | "running" | "done";

const COLUMN_LABEL: Record<BoardColumn, string> = { ready: "Ready", running: "Running", done: "Done" };

export function columnLabel(column: BoardColumn): string {
  return COLUMN_LABEL[column];
}

/** The CSS custom property a `Tone` paints with - for the one spot (the
 * Priority row) that colours plain text instead of drawing a dot. */
const TONE_VAR: Record<Tone, string> = {
  run: "var(--run)",
  ok: "var(--ok)",
  fail: "var(--fail)",
  warn: "var(--warn)",
  neutral: "var(--t3)",
  accent: "var(--accent)",
  idle: "var(--t3)",
};

export function toneVar(tone: Tone): string {
  return TONE_VAR[tone];
}

/**
 * Which of the three drawn columns (docs/user-journeys.md's screens table:
 * "Board: Kanban: Ready / Running / Done columns") a card belongs in.
 *
 * `blocked` has no column of its own in the ratified model, and J7 still
 * requires it stay visible ("a first-class visible state, not a vanished
 * run"): a card blocked before any run ever claimed it (no `adw_id`) reads
 * as a held queue item, so it joins Ready; a card blocked after a run
 * happened (rebase conflict / red gate - J4.3) reads as an interrupted
 * finish, so it joins Done. `unknown` only ever occurs on a parked card
 * (cards.ts: `main` could not be read), which is Done-family by
 * construction.
 */
export function columnOf(card: CardItem): BoardColumn {
  switch (card.state) {
    case "ready":
      return "ready";
    case "running":
      return "running";
    case "blocked":
      return card.adw_id ? "done" : "ready";
    case "done":
    case "integrated":
    case "shipped":
    case "unknown":
      return "done";
  }
}

/** The mock's three named buckets; anything else is rendered verbatim
 * (the header field is free text - "passed through verbatim", types.ts) in
 * a neutral chip rather than hidden. */
export function priorityTone(priority: string): Tone {
  const value = priority.trim().toLowerCase();
  if (value === "high") return "fail";
  if (value === "med" || value === "medium") return "warn";
  if (value === "low") return "neutral";
  return "neutral";
}

/** `CardState` -> the dot tone + word the Done column badges with (status
 * triple rule: dot + bold id + plain sentence, never a bare enum). Blue for
 * still in-flight (the run finished but the engine has not integrated it
 * yet), green for integrated, amber for shipped - the operator's own
 * highest-value act - red for blocked, neutral for unknown. */
export function stateTone(state: CardState): Tone {
  switch (state) {
    case "ready":
      return "idle";
    case "running":
      return "run";
    case "done":
      return "run";
    case "integrated":
      return "ok";
    case "shipped":
      return "accent";
    case "blocked":
      return "fail";
    case "unknown":
      return "neutral";
  }
}

/** A `provider/model` string's lane, the same split `readLanes` (factory.ts)
 * uses: the part before the first `/`. Null when the model names no
 * provider - never guessed at. */
export function laneOf(model: string | null): string | null {
  if (!model || !model.includes("/")) return null;
  const lane = model.split("/", 1)[0]!.trim();
  return lane || null;
}

/** `**Summary:** one line` from the Agent Brief body, the same
 * `**Label:**` grammar `cards.ts:extractField` reads server-side for
 * Category - read again here, client-side, because the inspector wants a
 * one-line description and the body is already on hand. Null, never "", so
 * a caller can fall back to `context` cleanly. */
export function extractSummary(body: string): string | null {
  const match = /\*\*Summary:\*\*\s*(.+)/i.exec(body);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/** Elapsed seconds since an ISO timestamp, clamped to 0 so a clock a few ms
 * ahead of the server never prints a negative duration. Null when the
 * timestamp itself is absent or unparsable - `formatUptime(null)` already
 * renders that as the em dash. */
export function elapsedSeconds(startedAt: string | null): number | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, (Date.now() - started) / 1000);
}
