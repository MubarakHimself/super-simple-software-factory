/**
 * The left column: every run this project's record holds, in flight first.
 *
 * A row is the status triple in the mock's own three lines - dot + the run's
 * name + the plain sentence about where it stands (line 2), with the adw id
 * beneath it (line 3). No row ever prints a bare state word: "in the merge
 * queue", "lane cooldown", "failed · test" are sentences, not enums.
 *
 * "This project's record" is now either checkout's: when this laptop holds no
 * rows and the project names a machine, the server reads THAT machine's
 * sssf.db and stamps each row with the host it came from - which line 2 already
 * renders as its muted chip. The empty case is `runsEmptyState` in model.ts,
 * because "no factory here", "nothing recorded yet", "nothing on that machine
 * yet" and "that machine did not answer" are four different sentences and this
 * column must never print the wrong one.
 */
import { Dot } from "../shared/Dot.tsx";
import { EmptyState, ReadFailure } from "../shell/EmptyState.tsx";
import { modelName, runsEmptyState, type RunRowModel } from "./model.ts";
import type { RunsSource } from "./types.ts";

export function RunList({
  rows,
  selectedAdwId,
  onSelect,
  hiddenSelfChecks,
  error,
  loading,
  factoryAbsent,
  source,
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
  /** where these rows came from; when it is a machine, that machine's own
   * sentence is what an empty list says */
  source: RunsSource | null;
}) {
  const active = rows.filter((row) => row.status.state === "running" || row.status.state === "cooldown").length;
  const empty = runsEmptyState(source, factoryAbsent);

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

        {/* Rows read off a machine say so ONCE, here, in the server's own
            sentence — which names the host AND the checkout they came out of.
            The per-row chip is short ("on 155.133.27.86"); a machine can hold
            more than one factory checkout, so the path is what makes these rows
            unambiguously attributable, and it must not be visible only in the
            empty case. */}
        {rows.length > 0 && source?.origin === "machine" && source.reason ? (
          <p className="run-list-note">{source.reason}</p>
        ) : null}

        {rows.length === 0 && !loading ? <EmptyState heading={empty.heading} sentence={empty.sentence} /> : null}

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
