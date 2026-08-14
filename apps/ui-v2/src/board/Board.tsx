/**
 * Board (spec 2.4) - four fixed columns, Ready / Running / Blocked / Done,
 * plus a visually quieter **Unparsed** column rendered only when there is
 * something in it (Open Decision 13: conditional column, so no dead column).
 *
 * Clicking a card opens it in the inspector; the columns never disappear
 * behind a detail view. That is the structural kill of audit F13, and it is
 * why there is no "back to columns" button anywhere here - there is nothing
 * to escape from.
 *
 * ── The width rule, without which F13 comes back in another form ──────────
 * The operator's window is 1360px. Sidebar 240 + inspector 380 leaves 740px
 * for four or five columns - under 190px each, which cannot hold a card's own
 * budget, so opening a card would destroy the columns by SQUEEZING rather
 * than by unmounting. So:
 *
 *   - columns hold a 220px minimum and scroll horizontally inside their own
 *     container (never the page, spec 3.4);
 *   - below 1200px of content width the inspector overlays as a
 *     right-anchored panel instead of taking layout width. The columns keep
 *     their geometry, one of them is covered, and Esc or a click outside
 *     closes it.
 *
 * The measured element is the surface pane itself, which is the same width
 * whether the inspector is open or shut - measuring the columns instead would
 * oscillate: opening the rail would narrow them under the threshold, which
 * would turn the rail into an overlay, which would widen them again.
 *
 * ── Freshness ────────────────────────────────────────────────────────────
 * `/api/app/p/:id/live` is "the one 2s poll" (spec 1.3) and it carries
 * `queue_mtime` precisely so a second poll of the queue is unnecessary: the
 * cards are re-read when that value moves, which is exactly when
 * `dispatch.py` has rewritten a `Status:` line in place. A card therefore
 * moves columns within one poll, and a Board that nothing is happening on
 * costs one request per two seconds for the whole app.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShell } from "../App.tsx";
import { usePaneWidth } from "../lib/measure.ts";
import { useResource } from "../lib/poll.ts";
import { NoFactory, ReadFailure } from "../shell/EmptyState.tsx";
import { Dot } from "../shared/Dot.tsx";
import { Card, UnparsedRow, type BoardCard, type CardRun, type CardStatus, type UnparsedCard } from "./Card.tsx";
import { CardInspector, STATUS_NOUN, STATUS_TONE } from "./CardInspector.tsx";

interface QueueResponse {
  dir: string;
  items: BoardCard[];
  unparsed: UnparsedCard[];
}

/** The four, in this order, always rendered. Spec 2.4's empty state is
 * "columns render with the noun greyed", so an empty Board is still a Board. */
const COLUMNS: CardStatus[] = ["ready-for-agent", "running", "blocked", "done"];

/** Below this much pane width the inspector stops taking layout width.
 * The only breakpoint in the app (spec 3.4) - this is a loopback
 * single-operator app, not a responsive site. */
const INSPECTOR_RAIL_MIN = 1200;

export default function Board() {
  const { projectId, live, readiness } = useShell();

  const queue = useResource<QueueResponse>(
    projectId ? `${projectId}|queue` : null,
    projectId ? `/api/app/p/${encodeURIComponent(projectId)}/queue` : null,
  );

  // Re-read the cards when the newest queue/*.md mtime moves (see header).
  const mtime = live.data?.queue_mtime ?? null;
  const seenMtime = useRef<{ project: string; value: string | null } | null>(null);
  const refreshQueue = queue.refresh;
  useEffect(() => {
    const seen = seenMtime.current;
    seenMtime.current = { project: projectId, value: mtime };
    if (!seen || seen.project !== projectId) return; // first read already covers it
    if (seen.value !== mtime) refreshQueue();
  }, [projectId, mtime, refreshQueue]);

  const items = queue.data?.items ?? [];
  const unparsed = queue.data?.unparsed ?? [];

  /** The live Runs, by adw_id: the card -> Run join, and the only one. */
  const runs = useMemo(() => {
    const rows = ((live.data as { running?: CardRun[] } | null)?.running ?? []) as CardRun[];
    return new Map(rows.map((run) => [run.adw_id, run]));
  }, [live.data]);

  const [openPath, setOpenPath] = useState<string | null>(null);
  // Derived, not stored: a card whose file vanished takes its inspector with it.
  const openCard = openPath ? (items.find((item) => item.path === openPath) ?? null) : null;

  // The same measurement Runs makes, with the same two traps, from the same
  // hook rather than from a second copy of the rule (see `lib/measure.ts`).
  const [paneRef, paneWidth] = usePaneWidth<HTMLDivElement>();
  const asRail = paneWidth === null || paneWidth >= INSPECTOR_RAIL_MIN;

  // Esc closes; a click outside the panel closes. No scrim and no click
  // catcher: the columns behind an overlaid inspector stay visible AND
  // clickable, which is the whole point of not routing to a detail view.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openCard) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenPath(null);
    };
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpenPath(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [openCard]);

  const isEmpty = items.length === 0 && unparsed.length === 0;

  // Spec 2.4's `No cards yet - start one with +.` is the empty state of a
  // Board that HAS a factory. In a project without one there is no queue/ to
  // put a card in, so that line invites the operator into a door that is not
  // there - and it is a third spelling of an answer Runs and Gate already
  // give (audit F9 / DEF-6). One string, one component, all three surfaces.
  //
  // The trigger is readiness' `factory.config`, which is the same predicate
  // the sidebar dims Board/Runs/Gate with (spec 2.9) - not the db, because
  // `/queue` deliberately does not gate on the db: a project can hold cards
  // before its first run. And only once the queue read has landed AND came
  // back empty, so real cards are never hidden behind this state.
  const factoryAbsent = readiness.data !== null && !readiness.data.factory.config;
  if (queue.data !== null && isEmpty && factoryAbsent) return <NoFactory surface="Board" />;

  const inspector = openCard ? (
    <CardInspector card={openCard} projectId={projectId} onClose={() => setOpenPath(null)} />
  ) : null;

  return (
    <div ref={paneRef} className="relative flex h-full min-h-0 w-full">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The Board was also an entry way (W1-D2: a `+` that opened a
            Session with `/triage ` pre-typed). The composer is gone with the
            KISS correction, so the Board is a display again - `/triage` is
            typed in the Terminal like every other command, and the header
            that held nothing but that button went with it. */}
        {queue.error ? <ReadFailure error={queue.error} /> : null}

        {/* One row of columns, edge to edge, each divided from the next by a
            hairline that runs the full height of the surface (the operator's
            note: "no line between the columns"). The row stretches rather than
            hugging its content, so the dividers are there on an empty Board
            too - a Board is its four columns whether or not it has cards. */}
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex min-h-full items-stretch">
            {COLUMNS.map((status, index) => {
              const cards = items.filter((item) => item.status === status);
              return (
                <Column key={status} noun={STATUS_NOUN[status]} status={status} count={cards.length} dim={isEmpty}>
                  {cards.map((card) => (
                    <Card
                      key={card.path}
                      card={card}
                      run={card.adw_id ? (runs.get(card.adw_id) ?? null) : null}
                      selected={card.path === openPath}
                      onOpen={() => setOpenPath(card.path)}
                    />
                  ))}
                  {/* The direction has to name a door that exists, and it
                      belongs where the card it asks for would appear: the
                      first column, not a paragraph under the whole Board. */}
                  {isEmpty && index === 0 ? (
                    <p className="text-body text-t2">
                      No cards yet — add a file to <span className="font-mono text-mono">queue/</span>, or type{" "}
                      <span className="font-mono text-mono">/triage</span> in the Terminal.
                    </p>
                  ) : null}
                </Column>
              );
            })}

            {unparsed.length > 0 ? (
              <Column noun="Unparsed" count={unparsed.length} quiet>
                {unparsed.map((item) => (
                  <UnparsedRow key={item.path} item={item} />
                ))}
              </Column>
            ) : null}
          </div>
        </div>
      </div>

      {inspector && asRail ? (
        <aside ref={panelRef} className="flex h-full w-inspector shrink-0 border-l border-hairline">
          <div className="min-w-0 flex-1">{inspector}</div>
        </aside>
      ) : null}

      {inspector && !asRail ? (
        <aside
          ref={panelRef}
          className="absolute inset-y-0 right-0 z-20 w-inspector max-w-full border-l border-hairline shadow-[var(--shadow-overlay)]"
        >
          {inspector}
        </aside>
      ) : null}
    </div>
  );
}

/**
 * One column: header is noun + count and nothing else, and the count is
 * absent at zero. 260px minimum, a hairline divider on its left edge (never on
 * the first), and the row of columns is what scrolls - never the page
 * (spec 3.4). The columns share the pane's whole width: four equal shares of
 * 1920 is 400px each, which is a card that can hold a real title.
 */
function Column({
  noun,
  status,
  count,
  dim = false,
  quiet = false,
  children,
}: {
  noun: string;
  status?: CardStatus;
  count: number;
  /** The whole Board is empty: the noun greys, and no column says a word. */
  dim?: boolean;
  /** Unparsed: present, and visibly the quieter column. */
  quiet?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`flex min-w-[260px] flex-1 flex-col border-l border-hairline px-4 py-3 first:border-l-0 ${
        quiet ? "opacity-80" : ""
      }`}
    >
      <header className="mb-3 flex h-row items-center gap-2 border-b border-hairline">
        {status ? <Dot tone={dim ? "idle" : STATUS_TONE[status]} /> : null}
        <span className={`text-body ${dim || quiet ? "text-t3" : "text-t2"}`}>{noun}</span>
        {count > 0 ? <span className="ml-auto font-mono text-meta tabular-nums text-t3">{count}</span> : null}
      </header>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}
