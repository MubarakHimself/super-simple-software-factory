/**
 * The merge queue rail — the one place in this app where a human act moves
 * `main`.
 *
 * The mock drew checkboxes and let any subset be picked. That interaction
 * cannot survive linear integration (change-list #2): you cannot ship the card
 * above without the card below, because the card below is already in the tree
 * the card above sits on. So the checkbox LOOK is kept exactly and the meaning
 * is corrected: clicking row N cuts the line at N, which selects rows 1..N —
 * always a contiguous prefix, never a basket. The hint under the button says
 * that in words, every time.
 *
 * Select all = the whole line. Clicking the row that already holds the cut
 * clears the selection, which is the only way to unselect and is therefore the
 * behaviour a second click has to have.
 */
import { ReadFailure } from "../shell/EmptyState.tsx";
import type { QueueRowModel } from "./model.ts";
import { modelName } from "./model.ts";
import type { ShipReport } from "./types.ts";

export function MergeQueue({
  rows,
  report,
  reportError,
  loading,
  cutName,
  onCut,
  highlightAdwId,
  onMerge,
  busy,
}: {
  rows: QueueRowModel[];
  report: ShipReport | null;
  reportError: string | null;
  loading: boolean;
  cutName: string | null;
  /** the new cut, or null to select nothing */
  onCut: (name: string | null) => void;
  /** the run the detail pane is showing, so its card reads as the current one */
  highlightAdwId: string | null;
  onMerge: () => void;
  /** true while the confirm modal is open or a ship is in flight - the rail's
   * button is the way in, and there is only ever one way in at a time */
  busy: boolean;
}) {
  const cutIndex = rows.findIndex((row) => row.name === cutName);
  const selected = cutIndex + 1;
  const allSelected = rows.length > 0 && selected === rows.length;

  return (
    <div className="merge-queue-rail">
      <div className="merge-queue-rail-header">
        <span className="mq-title">Merge queue</span>
        {rows.length > 0 ? <span className="mq-count">{rows.length} in line</span> : null}
        {rows.length > 0 ? (
          <button
            type="button"
            className="mq-select-all"
            onClick={() => onCut(allSelected ? null : (rows[rows.length - 1]?.name ?? null))}
          >
            <span className={`mq-checkbox${allSelected ? " checked" : ""}`} />
            <span>Select all</span>
          </button>
        ) : null}
      </div>

      {rows.length > 0 ? <div className="mq-subheader">Integration order · oldest first</div> : null}

      <div className="merge-queue-list">
        {rows.map((row, index) => {
          const isCut = index === cutIndex;
          const inChunk = cutIndex >= 0 && index <= cutIndex;
          return (
            <button
              type="button"
              key={row.name}
              className={`merge-queue-row${inChunk ? " selected" : ""}${
                row.adwId && row.adwId === highlightAdwId ? " highlighted" : ""
              }`}
              onClick={() => onCut(isCut ? null : row.name)}
            >
              <span className="mq-row-line1">
                <span className="mq-checkbox" />
                <span className="mq-row-id">{row.adwId ?? row.name}</span>
                <span className="mq-row-title">{row.title}</span>
              </span>
              <span className="mq-row-line2">
                {row.lane ? <span className="mq-row-lane">{modelName(row.model) ?? row.lane}</span> : null}
                <span className="mq-row-files">{row.stat ?? row.note ?? "no diff counted"}</span>
              </span>
              {/* The list is oldest-first, so the chunk is this row plus the
                  rows ABOVE it. One vocabulary, matching the highlight, here
                  and in the confirm modal. */}
              {isCut ? (
                <span className="mq-row-cutmark">cut here — ships this card and everything earlier, the rows above</span>
              ) : null}
            </button>
          );
        })}

        {rows.length === 0 && loading ? (
          <p className="merge-queue-empty">Assembling the shipping report…</p>
        ) : null}

        {rows.length === 0 && !loading && reportError ? (
          <div className="merge-queue-empty">
            <div className="mq-empty-icon">!</div>
            The shipping report could not be read on this machine.
            <ReadFailure error={reportError} />
          </div>
        ) : null}

        {/* A project the factory has never run in has no `integration` branch
            for the report to read - the normal state of a new project. It is
            drawn exactly like "nothing waiting", never as a failure. */}
        {rows.length === 0 && !loading && report && !report.available && report.not_started ? (
          <div className="merge-queue-empty">
            <div className="mq-empty-icon">·</div>
            {report.reason}
          </div>
        ) : null}

        {rows.length === 0 && !loading && report && !report.available && !report.not_started ? (
          <div className="merge-queue-empty">
            <div className="mq-empty-icon">!</div>
            The shipping report could not be assembled here.
            {/* One sentence; the script's full text is the tooltip. */}
            <p className="mq-empty-reason" title={report.detail ?? undefined}>
              {report.reason ?? "the script gave no reason"}
            </p>
          </div>
        ) : null}

        {rows.length === 0 && !loading && report?.available && report.empty ? (
          <div className="merge-queue-empty">
            <div className="mq-empty-icon">·</div>
            Nothing is waiting to ship. Integration holds no card that main does not already have.
          </div>
        ) : null}

        {/* `report.gaps` is the report's own `## Gaps` section: one line per
            problem with the RECORD — an acceptance box the record cannot
            confirm, a card that could not be read, a run branch that is not in
            this checkout. It says nothing about commits, and it is the one
            honesty signal the ship gate exists to surface, so it is printed as
            the report wrote it. */}
        {rows.length > 0 && report && report.gaps.length > 0 ? (
          <div className="mq-gaps">
            <p>
              {report.gaps.length} thing{report.gaps.length === 1 ? "" : "s"} the record cannot confirm — the report
              names {report.gaps.length === 1 ? "it" : "them"} and ships them as they are:
            </p>
            <ul className="mq-gap-list">
              {report.gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="merge-queue-action">
        <button type="button" className="mq-bulk-btn" onClick={onMerge} disabled={selected === 0 || busy}>
          <span>Merge to main</span>
          <span className="mq-btn-count">{selected} selected</span>
        </button>
        <p className="mq-hint">
          {selected === 0
            ? "Pick a card: selection is a cut point, not a basket."
            : "Ships the cut card and the rows above it — one squash commit on main."}
        </p>
      </div>
    </div>
  );
}
