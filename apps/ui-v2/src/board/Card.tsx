/**
 * The Board card (spec 2.4) - a FIXED-HEIGHT row, and the height is fixed
 * *per column*, not per app:
 *
 *   line 1  title (the H1), one line, ellipsis
 *   line 2  two metadata tokens - `0/4 - simple-sdlc`
 *   line 3  Running column ONLY: live elapsed + lane
 *
 * So Ready / Blocked / Done cards are two-line and Running cards are
 * three-line, and *within a column no card ever changes height as its data
 * changes*: the elapsed timer writes `textContent` (shared/Elapsed.tsx, one
 * interval for the whole app), and a null lane token is ABSENT rather than
 * blank-padded. A card that gains its third line is a card that moved
 * columns - a real event, not a reflow.
 *
 * No description, no status sentence, no column-count duplication: the column
 * this card sits in is the only place its status is spelled.
 */
import type { ReactNode } from "react";
import { Dot } from "../shared/Dot.tsx";
import { Elapsed } from "../shared/Elapsed.tsx";

/** The four statuses `queue.ts` accepts, unchanged - machine strings. */
export type CardStatus = "ready-for-agent" | "running" | "blocked" | "done";

export interface Criterion {
  text: string;
  done: boolean;
}

/** One `queue/*.md` file, as `/api/app/p/:id/queue` serves it (spec 1.3). */
export interface BoardCard {
  path: string;
  slug: string;
  title: string;
  status: CardStatus;
  adw: string | null;
  adw_id: string | null;
  created: string | null;
  context: string | null;
  category: string | null;
  criteria_done: number;
  criteria_total: number;
  body: string;
  criteria: Criterion[];
}

export interface UnparsedCard {
  path: string;
  reason: string;
}

/**
 * A running Run from the one 2s poll (`/api/app/p/:id/live`). The join is
 * `QueueItem.adw_id` x `sessions.adw_id` - the only link that exists (W2-A3).
 */
export interface CardRun {
  adw_id: string;
  started_at: string | null;
  model: string | null;
  coding_agent: string | null;
}

/**
 * Two heights, stated once. Both are exact: padding (2 x 11) + the line boxes
 * this card's own type scale gives it (body 20, meta 16) + the 3px gaps -
 * re-derived when the 2026-08-14 layout pass raised the scale, because a
 * height that is not arithmetic is a height that clips its own last line.
 */
export const CARD_HEIGHT = {
  /** Ready / Blocked / Done: title + metadata. */
  two: 61,
  /** Running: title + metadata + live line. */
  three: 80,
  /** An unparsed file: one line, filename + the parser's own reason. */
  unparsed: 34,
} as const;

/** Joins the tokens that are actually present with a middot. A null field
 * leaves no separator behind it - "absent when null", applied to punctuation
 * as well as to values. */
function Tokens({ children }: { children: ReactNode[] }) {
  const present = children.filter((child) => child !== null && child !== false && child !== undefined);
  return (
    <>
      {present.map((child, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1.5">
          {index > 0 ? <span aria-hidden="true" className="text-t3/70">·</span> : null}
          {child}
        </span>
      ))}
    </>
  );
}

export function Card({
  card,
  run,
  selected,
  onOpen,
}: {
  card: BoardCard;
  /** The live Run this card is claimed by, when there is one. */
  run: CardRun | null;
  selected: boolean;
  onOpen: () => void;
}) {
  const isRunning = card.status === "running";
  return (
    <button
      type="button"
      onClick={onOpen}
      title={card.title}
      aria-pressed={selected}
      style={{ height: isRunning ? CARD_HEIGHT.three : CARD_HEIGHT.two }}
      className={[
        "flex w-full shrink-0 flex-col justify-center gap-[3px] overflow-hidden rounded-control border px-3 text-left",
        selected
          ? "border-accent bg-accent-surface"
          : "border-hairline bg-raised hover:border-t3 hover:bg-row-hover",
      ].join(" ")}
    >
      <span className="truncate text-body text-t1">{card.title}</span>

      <span className="flex min-w-0 items-center gap-1.5 font-mono text-meta text-t3">
        <Tokens>
          {[
            card.criteria_total > 0 ? (
              <span className="tabular-nums">
                {card.criteria_done}/{card.criteria_total}
              </span>
            ) : null,
            card.adw ? <span className="truncate">{card.adw}</span> : null,
          ]}
        </Tokens>
      </span>

      {isRunning ? (
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-meta text-t3">
          <Tokens>
            {[
              run?.started_at ? (
                <span className="flex items-center gap-1.5">
                  <Dot tone="run" pulse />
                  <Elapsed since={run.started_at} />
                </span>
              ) : null,
              run?.coding_agent ? <span className="truncate">{run.coding_agent}</span> : null,
              run?.model ? <span className="truncate">{run.model}</span> : null,
            ]}
          </Tokens>
        </span>
      ) : null}
    </button>
  );
}

/**
 * An `unparsed` row (spec 2.4): filename + the parser's own `reason`
 * VERBATIM, one line. We never rewrite the reason into friendlier words - the
 * parser already said the true thing, and a second sentence would be a second
 * story about the same file.
 */
export function UnparsedRow({ item }: { item: UnparsedCard }) {
  return (
    <div
      style={{ height: CARD_HEIGHT.unparsed }}
      title={`${item.path} - ${item.reason}`}
      className="flex w-full shrink-0 items-center gap-1.5 overflow-hidden rounded-control border border-dashed border-hairline px-3 font-mono text-meta text-t3"
    >
      <span className="shrink-0 truncate">{item.path}</span>
      <span aria-hidden="true" className="text-t3/70">
        ·
      </span>
      <span className="min-w-0 truncate">{item.reason}</span>
    </div>
  );
}
