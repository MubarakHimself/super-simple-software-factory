/**
 * Board — Ready / Running / Done, with the card inspector rail
 * (board-v3.html, J3/J4, change-list #4/#6/#7).
 *
 * Reads `GET /api/app/p/:id/cards` (S2's whole card truth: state, the two
 * holding hints, Blocks/Blocked-by, the git-derived integrated/shipped
 * split) at the same cadence as the shell's one 2s live poll, and joins the
 * Running column against `useShell().live` for lane/phase/elapsed - never a
 * second copy of that read (S1's own rule).
 *
 * No dispatch button anywhere, by design: the auto-pick indicator this file
 * portals into the topbar (`AutoPickIndicator`) is the only thing this
 * surface says about starting a run, and it only ever describes, never
 * triggers.
 */
import { useMemo, useState } from "react";
import { useShell } from "../App.tsx";
import { LIVE_INTERVAL_MS, useResource } from "../lib/poll.ts";
import { EmptyState, ReadFailure } from "../shell/EmptyState.tsx";
import { AutoPickIndicator } from "./AutoPickIndicator.tsx";
import "./board.css";
import { Inspector } from "./Inspector.tsx";
import { TicketCard } from "./TicketCard.tsx";
import type { BoardColumn, CardItem, CardsResponse, LiveRun } from "./types.ts";
import { columnLabel, columnOf } from "./types.ts";

const COLUMNS: BoardColumn[] = ["ready", "running", "done"];

const EMPTY_COPY: Record<BoardColumn, { heading: string; sentence: string }> = {
  ready: {
    heading: "No ready cards",
    sentence: "Ready fills up once a batch is published from your planning session and every Needs: is satisfied.",
  },
  running: {
    heading: "No running cards",
    sentence: "Nothing is running right now — the factory auto-picks from Ready the moment a lane frees up.",
  },
  done: {
    heading: "No done cards",
    sentence: "Finished cards land here once a run completes, the engine integrates it, or a chunk ships.",
  },
};

function groupByColumn(items: CardItem[]): Record<BoardColumn, CardItem[]> {
  const grouped: Record<BoardColumn, CardItem[]> = { ready: [], running: [], done: [] };
  for (const item of items) grouped[columnOf(item)].push(item);
  return grouped;
}

export default function Board() {
  const { projectId, live, health } = useShell();
  const cards = useResource<CardsResponse>(
    `${projectId}|cards`,
    `/api/app/p/${encodeURIComponent(projectId)}/cards`,
    LIVE_INTERVAL_MS,
  );
  const [selected, setSelected] = useState<string | null>(null);

  // `Live.running` is typed `unknown[]` at the shell (lib/api.ts: "a surface
  // owns its own types") - board/types.ts's `LiveRun` names the fields this
  // surface actually reads.
  const liveByAdwId = useMemo(() => {
    const rows = (live.data?.running ?? []) as LiveRun[];
    return new Map(rows.map((row) => [row.adw_id, row]));
  }, [live.data]);

  const grouped = useMemo(() => groupByColumn(cards.data?.items ?? []), [cards.data]);
  const selectedCard = useMemo(
    () => cards.data?.items.find((item) => item.name === selected) ?? null,
    [cards.data, selected],
  );
  const selectedColumn = selectedCard ? columnOf(selectedCard) : null;
  const selectedLive = selectedCard?.adw_id ? (liveByAdwId.get(selectedCard.adw_id) ?? null) : null;

  if (!cards.data) {
    if (cards.error) {
      return (
        <EmptyState heading="Board" sentence="The card read failed.">
          <ReadFailure error={cards.error} />
        </EmptyState>
      );
    }
    return null; // first load - avoid a flash of three empty columns
  }

  return (
    <>
      <AutoPickIndicator health={health} />
      <div className="board">
        {COLUMNS.map((column) => {
          const items = grouped[column];
          return (
            <div className="board-col" key={column}>
              <div className="board-col-header">
                <span className={`col-dot ${column}${column === "running" && items.length > 0 ? " pulse" : ""}`} />
                <h3>{columnLabel(column)}</h3>
                <span className="col-count">{items.length}</span>
              </div>
              <div className="board-col-body">
                {items.length === 0 ? (
                  <EmptyState heading={EMPTY_COPY[column].heading} sentence={EMPTY_COPY[column].sentence} />
                ) : (
                  items.map((card) => (
                    <TicketCard
                      key={card.name}
                      card={card}
                      column={column}
                      live={column === "running" && card.adw_id ? (liveByAdwId.get(card.adw_id) ?? null) : null}
                      selected={selected === card.name}
                      onSelect={() => setSelected(card.name)}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      <Inspector card={selectedCard} column={selectedColumn} live={selectedLive} onClose={() => setSelected(null)} />
    </>
  );
}
