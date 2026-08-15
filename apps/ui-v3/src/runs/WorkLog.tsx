/**
 * The work log, newest first (the mock's own order). Every row is one entry the
 * server already folded out of the run's events - this file chooses words and
 * nothing else. A kind this vocabulary does not know renders as its own text
 * rather than being dropped, because a silent row is a lie about what ran.
 */
import type { ReactNode } from "react";
import { logTime } from "./model.ts";
import type { WorkLogEntry } from "./types.ts";

function tagTone(entry: WorkLogEntry): string {
  if (entry.kind === "error") return " fail";
  if (entry.kind === "gate") return entry.passed ? " ok" : " fail";
  if (entry.kind === "tool" && entry.status === "fail") return " fail";
  return "";
}

function tagText(entry: WorkLogEntry): string {
  if (entry.agent) return entry.agent;
  if (entry.kind === "commit") return "commit";
  if (entry.kind === "gate") return "gate";
  if (entry.kind === "error") return "error";
  return entry.kind;
}

function bodyOf(entry: WorkLogEntry): ReactNode {
  switch (entry.kind) {
    case "tool":
      return (
        <>
          <strong>{entry.heading ?? "tool"}</strong>
          {entry.preview ? <> — {entry.preview}</> : null}
        </>
      );
    case "commit":
      return (
        <>
          Commit <code>{entry.sha}</code>
          {entry.message ? <> — {entry.message}</> : null}
          {typeof entry.file_count === "number" ? (
            <> · {entry.file_count} file{entry.file_count === 1 ? "" : "s"}</>
          ) : null}
        </>
      );
    case "handoff":
      return (
        <>
          <strong>Handoff</strong>
          {entry.summary ? <> — {entry.summary}</> : null}
          {entry.artifacts && entry.artifacts.length > 0 ? <> · {entry.artifacts.join(", ")}</> : null}
        </>
      );
    case "error":
      return <>{entry.detail}</>;
    case "gate":
      return (
        <>
          Gate <strong>{entry.gate ?? "unnamed"}</strong> {entry.passed ? "passed" : "did not pass"}
        </>
      );
    default:
      return <>{entry.text}</>;
  }
}

export function WorkLog({
  title,
  entries,
  runStart,
  hasMore,
  emptySentence,
}: {
  title: string;
  entries: WorkLogEntry[];
  runStart: string | null;
  hasMore: boolean;
  /** what to say when the record holds no entries at all */
  emptySentence: string;
}) {
  const newestFirst = [...entries].reverse();
  return (
    <div className="log-section">
      <div className="log-section-title">{title}</div>
      {newestFirst.length === 0 ? (
        <p className="record-note">{emptySentence}</p>
      ) : (
        <div className="work-log">
          {newestFirst.map((entry) => (
            <div className={`log-row${entry.indent ? " indent" : ""}`} key={entry.rowid}>
              <span className="log-time">{logTime(entry.started_at, runStart)}</span>
              <div className="log-body">
                <div className="log-text">
                  <span className={`log-tag${tagTone(entry)}`}>{tagText(entry)}</span>
                  {bodyOf(entry)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {hasMore ? (
        <p className="record-note" style={{ marginTop: 12 }}>
          This is the first page of this run's record; entries past it are not on screen.
        </p>
      ) : null}
    </div>
  );
}
