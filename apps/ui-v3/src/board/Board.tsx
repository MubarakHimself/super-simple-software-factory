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
 *
 * ── Why the poll is also the sync ──────────────────────────────────────────
 * The cards this reads come from the project's LOCAL `queue/` folder, and the
 * factory pushes its card-status commits from a server. So the cards endpoint
 * kicks a background `git fetch` + fast-forward of its own when the checkout
 * has gone a minute without one, and reports what the last one concluded in
 * the payload's `sync` field. Nothing here triggers or waits for that - the
 * only Board-side consequence is one muted line, beside the auto-pick
 * indicator, on the days the server REFUSED to pull (see `SYNC_REFUSAL`).
 */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useShell } from "../App.tsx";
import { LIVE_INTERVAL_MS, useResource } from "../lib/poll.ts";
import { EmptyState, ReadFailure } from "../shell/EmptyState.tsx";
import { useTopbarSlot } from "../shell/TopBar.tsx";
import { AutoPickIndicator } from "./AutoPickIndicator.tsx";
import "./board.css";
import { Inspector } from "./Inspector.tsx";
import { TicketCard } from "./TicketCard.tsx";
import type { BoardColumn, CardItem, CardsResponse, CardsSync, CardsSyncState, LiveRun } from "./types.ts";
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

/**
 * The auto-sync outcomes worth one line, and the word that leads it. The three
 * missing states are missing on purpose: `pulled` and `up-to-date` mean the
 * Board is showing the server's own truth (a working sync is silent), and
 * `no-remote` is the ordinary state of a project not yet deployed anywhere -
 * nagging about it every two seconds is the UI scolding the operator for
 * something that is not wrong.
 *
 * What is left is the honest case: the server REFUSED to pull, so these cards
 * may be older than the factory's, and only the operator can fix it.
 */
const SYNC_REFUSAL: Partial<Record<CardsSyncState, string>> = {
  dirty: "auto-sync skipped",
  diverged: "auto-sync skipped",
  detached: "auto-sync skipped",
  "not-a-repo": "auto-sync off",
  failed: "auto-sync failed",
};

/** One muted line in the Board's own header area (the topbar slot, beside the
 * auto-pick indicator this surface already portals there). No box, no colour
 * alarm, and the server's own sentence verbatim - never one this app invented
 * over one git actually wrote. */
function SyncNote({ sync }: { sync: CardsSync | null | undefined }) {
  const host = useTopbarSlot();
  const lead = sync ? SYNC_REFUSAL[sync.state] : undefined;
  if (!host || !sync || !lead) return null;
  const line = `${lead}: ${sync.detail}`;
  return createPortal(
    <div className="board-sync-note" title={`${line} (checked ${sync.at})`}>
      <span className="dot" />
      <span className="bsn-text">{line}</span>
    </div>,
    host,
  );
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
      <SyncNote sync={cards.data.sync} />
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
