/**
 * The left column: every run this project's record holds, in flight first.
 *
 * A row is the status triple in the mock's own three lines - dot + the run's
 * name + the plain sentence about where it stands (line 2), with the adw id
 * beneath it (line 3). No row ever prints a bare state word: "in the merge
 * queue", "lane cooldown", "failed · test" are sentences, not enums.
 */
import { Dot } from "../shared/Dot.tsx";
import { EmptyState, ReadFailure } from "../shell/EmptyState.tsx";
import { modelName, type RunRowModel } from "./model.ts";

export function RunList({
  rows,
  selectedAdwId,
  onSelect,
  hiddenSelfChecks,
  error,
  loading,
  factoryAbsent,
}: {
  rows: RunRowModel[];
  selectedAdwId: string | null;
  onSelect: (adwId: string) => void;
  hiddenSelfChecks: number;
  error: string | null;
  loading: boolean;
  /** the server's own 200 `{factory:"absent"}` - no record here, not an empty
   * one, and the two say completely different things to an operator */
  factoryAbsent: boolean;
}) {
  const active = rows.filter((row) => row.status.state === "running" || row.status.state === "cooldown").length;

  return (
    <div className="run-list-col">
      <div className="run-list-header">
        <h2>All runs</h2>
        <span className="filter-pill">
          {factoryAbsent ? "no record" : active > 0 ? `${active} in flight` : `${rows.length} recorded`}
        </span>
      </div>

      {error ? <ReadFailure error={error} /> : null}

      <div className="run-list">
        {hiddenSelfChecks > 0 ? (
          <p className="run-list-note">
            {hiddenSelfChecks} self-check run{hiddenSelfChecks === 1 ? "" : "s"} hidden — they only prove a lane answers.
          </p>
        ) : null}

        {rows.length === 0 && !loading && factoryAbsent ? (
          <EmptyState
            heading="No factory record"
            sentence="This project has no sssf.db on this machine — the engine writes one the first time it runs a card here."
          />
        ) : null}

        {rows.length === 0 && !loading && !factoryAbsent ? (
          <EmptyState
            heading="No runs yet"
            sentence="The engine records a run when it picks up a ready card; nothing here needs dispatching."
          />
        ) : null}

        {rows.map((row) => {
          const model = modelName(row.model);
          return (
            <button
              type="button"
              key={row.adwId}
              className={`run-row${row.adwId === selectedAdwId ? " selected" : ""}`}
              onClick={() => onSelect(row.adwId)}
            >
              <span className="run-row-line1">
                <Dot tone={row.status.tone} pulse={row.status.state === "running" || row.status.state === "cooldown"} />
                <span className="run-row-title">{row.title}</span>
                <span className="run-row-elapsed">{row.clock}</span>
              </span>
              <span className="run-row-line2">
                <span className="step">{row.status.step}</span>
                {model ? (
                  <span className="lane" title={row.lane ? `lane ${row.lane} · ${row.model}` : (row.model ?? undefined)}>
                    {model}
                  </span>
                ) : null}
                {row.machine ? <span className="machine-chip">{row.machine}</span> : null}
                {row.status.state === "integrated" ? <span className="gate-badge">merge</span> : null}
              </span>
              <span className="run-row-line3">{row.adwId}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
