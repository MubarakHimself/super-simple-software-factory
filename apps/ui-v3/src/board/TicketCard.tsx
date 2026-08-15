/**
 * One card face, board-v3.html's `.ticket-card` - the same markup for all
 * three columns, with the meta row swapped per column:
 *
 *   Ready    lane "unassigned" + priority chip (only when the card carries
 *            one) + the waiting-on hint (change-list #6) when it has one
 *   Running  lane dot + phase, elapsed - read from the matching `/live` run
 *            when the engine has one; the card's own `state_reason`
 *            otherwise (a card can say Status: running before the poll
 *            catches the session, or after the engine has gone quiet)
 *   Done     the status-triple badge for done / integrated / shipped /
 *            blocked / unknown - never a bare enum
 */
import { formatUptime } from "../lib/format.ts";
import { StatusTriple } from "../shared/StatusTriple.tsx";
import type { BoardColumn, CardItem, LiveRun } from "./types.ts";
import { elapsedSeconds, laneOf, priorityTone, stateTone } from "./types.ts";

function ReadyMeta({ card }: { card: CardItem }) {
  return (
    <>
      <div className="tc-meta">
        <span className="tc-lane">
          <span className="lane-dot idle" />
          unassigned
        </span>
        {card.priority ? <span className={`tc-priority ${priorityTone(card.priority)}`}>{card.priority}</span> : null}
      </div>
      {card.waiting_on.length > 0 ? <div className="tc-hint" title={`waiting on ${card.waiting_on.join(", ")}`}>waiting on {card.waiting_on.join(", ")}</div> : null}
    </>
  );
}

function RunningMeta({ card, live }: { card: CardItem; live: LiveRun | null }) {
  if (!live) {
    return (
      <div className="tc-meta">
        <span className="tc-phase">{card.state_reason}</span>
      </div>
    );
  }
  const lane = laneOf(live.model);
  const phaseText = live.phase?.name ?? live.phase?.owner ?? null;
  const elapsed = elapsedSeconds(live.started_at);
  return (
    <>
      <div className="tc-meta">
        <span className="tc-lane">
          <span className={`lane-dot${lane ? "" : " idle"}`} />
          {lane ?? "unassigned"}
        </span>
        {phaseText ? <span className="tc-phase">{phaseText}</span> : null}
      </div>
      {elapsed !== null ? (
        <div className="tc-meta">
          <span className="tc-elapsed">{formatUptime(elapsed)}</span>
        </div>
      ) : null}
    </>
  );
}

function DoneMeta({ card }: { card: CardItem }) {
  return (
    <div className="tc-meta">
      <StatusTriple tone={stateTone(card.state)} identifier={card.state} sentence={card.state_reason} />
    </div>
  );
}

export function TicketCard({
  card,
  column,
  live,
  selected,
  onSelect,
}: {
  card: CardItem;
  column: BoardColumn;
  /** The matching `/live` run, when `column === "running"` and the engine
   * still has one open. */
  live: LiveRun | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const idLine = column === "ready" ? card.slug : (card.adw_id ?? card.slug);
  return (
    <button type="button" className={`ticket-card${selected ? " selected" : ""}`} onClick={onSelect}>
      <div className="tc-id">{idLine}</div>
      <div className="tc-title">{card.title}</div>
      {column === "ready" ? <ReadyMeta card={card} /> : null}
      {column === "running" ? <RunningMeta card={card} live={live} /> : null}
      {column === "done" ? <DoneMeta card={card} /> : null}
    </button>
  );
}
