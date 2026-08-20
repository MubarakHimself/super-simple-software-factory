/**
 * Diff summary + file list.
 *
 * Two records answer this question and they are not the same record, so both
 * are named where they are used: the shipping report counts the CARD's park
 * commit (files/insertions/deletions - what the chunk will carry to main), and
 * `runs/:adw_id/diff` lists the files of the RUN. When the report counted
 * nothing it prints its own note (`diff_note`) and that note is shown verbatim
 * rather than replaced with a zero.
 */
import type { Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { diffStat } from "./model.ts";
import type { DiffResponse, ShipCard } from "./types.ts";

export function DiffSection({
  card,
  diff,
  sha,
  machine,
}: {
  /** the report's card, when this run's card is in the shipping report */
  card: ShipCard | null;
  diff: Resource<DiffResponse>;
  /** the park commit, shown as the chunk's cut point when the report named one */
  sha?: string | null;
  /** "on 155.133.27.86" when the run was read off a machine - its file list is
   * in that machine's record and this app does not ask for it, so the section
   * says where it is instead of leaving a bare heading */
  machine?: string | null;
}) {
  const files = diff.data?.files ?? [];
  const reportStat = card ? diffStat(card.insertions, card.deletions) : null;
  const runStat = diff.data ? diffStat(diff.data.added, diff.data.deleted) : null;
  const fileCount = card?.files_changed ?? (diff.data && !diff.data.empty ? files.length : null);

  return (
    <div className="diff-section">
      <div className="log-section-title">Diff summary</div>

      {fileCount !== null || reportStat || runStat || sha ? (
        <div className="diff-summary">
          {fileCount !== null ? (
            <span className="diff-stat">
              <span className="ds-label">files</span>
              <span>{fileCount}</span>
            </span>
          ) : null}
          {(reportStat ?? runStat) ? (
            <span className="diff-stat">
              <span className="ds-add">+{(card ? card.insertions : diff.data?.added) ?? 0}</span>
              <span className="ds-del">−{(card ? card.deletions : diff.data?.deleted) ?? 0}</span>
            </span>
          ) : null}
          {sha ? (
            <span className="diff-stat">
              <span className="ds-label">cut</span>
              <span className="ds-sha">{sha}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {card?.diff_note && !reportStat ? <p className="record-note">{card.diff_note}</p> : null}
      {diff.error ? <ReadFailure error={diff.error} /> : null}

      {machine && !diff.data ? (
        <p className="record-note">
          This run's file list stays {machine} — the card's own numbers above come from the shipping report, which
          reads git here.
        </p>
      ) : null}

      {files.length > 0 ? (
        <div className="diff-files">
          {files.map((file) => (
            <div className="diff-file" key={file.path}>
              <span className="df-path">{file.path}</span>
              <span className="df-add">+{file.added}</span>
              <span className="df-del">−{file.deleted}</span>
            </div>
          ))}
        </div>
      ) : null}

      {files.length === 0 && diff.data ? (
        <p className="record-note">
          This run's record lists no changed files{diff.data.base ? ` (${diff.data.base})` : ""} — the file list comes
          from the run's own commits, and there are none to read.
        </p>
      ) : null}

      {diff.data?.truncated ? (
        <p className="record-note" style={{ marginTop: 10 }}>
          The file list is longer than one page of the record; what is above is the start of it.
        </p>
      ) : null}
    </div>
  );
}
