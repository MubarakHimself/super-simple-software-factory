/**
 * The job log strip (spec 2.9: "stdout streams into a short log strip via
 * `/api/app/jobs/:id`"; spec 1.3's job shape).
 *
 * The server keeps the **last 500 lines only** and counts what it dropped,
 * because the installer's real log is long and "never a dead server" is an
 * invariant. When `dropped > 0` this renders exactly one line saying so - not
 * a warning, not a tooltip, one line in the log at the position the loss
 * happened, which is the same honest-inline-entry rule connection state and
 * staleness follow (spec 3.6).
 *
 * **Why this owns its poll instead of using `lib/poll.ts`.** `useResource` is
 * built for a collection that is re-read on a fixed cadence forever; a job is
 * read until it ends and then never again, and it ends *while* the component
 * is re-rendering on the shell's own 2s beat. Measured against the real
 * installer, the shared hook's interval stopped after the first read and the
 * strip sat on `running` while the server had already reported `exit 0` -
 * so the log the operator is watching would have frozen mid-install. The loop
 * below is self-scheduling: exactly one request in flight at a time, the next
 * one scheduled only after the previous answer, and no timer at all once the
 * job is over. `onFinished` lives in a ref so a caller that re-creates the
 * callback every render (the shell does) cannot restart the loop.
 */
import { useEffect, useRef, useState } from "react";
import { apiGet } from "../lib/api.ts";

export interface JobStatus {
  state: "running" | "done" | "failed";
  exit_code: number | null;
  lines: string[];
  dropped: number;
}

const POLL_MS = 700;

export function JobStrip({
  jobId,
  title,
  onFinished,
  onClose,
}: {
  jobId: string;
  /** The command in three words, so the strip says what it is showing. */
  title: string;
  onFinished: (exitCode: number | null) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const next = await apiGet<JobStatus>(`/api/app/jobs/${encodeURIComponent(jobId)}`);
        if (stopped) return;
        setStatus(next);
        setError(null);
        if (next.state === "running") {
          timer = window.setTimeout(() => void tick(), POLL_MS);
        } else {
          // The end of the job is the end of the poll, and the one moment
          // readiness is worth re-reading (spec 2.9: the button disappears
          // on the next readiness poll).
          finishedRef.current(next.exit_code);
        }
      } catch (failure) {
        if (stopped) return;
        // Keep the lines already on screen and say what the server said -
        // the read-failure rule (spec 2.1), then keep trying.
        setError((failure as Error).message);
        timer = window.setTimeout(() => void tick(), POLL_MS);
      }
    };

    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [jobId]);

  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight });
  }, [status?.lines.length]);

  const running = status === null || status.state === "running";

  return (
    <div className="w-[560px] overflow-hidden rounded-control border border-hairline bg-raised shadow-[var(--shadow-overlay)]">
      <div className="flex items-center gap-2 border-b border-hairline px-2 py-1 text-body">
        <span className="text-t2">{title}</span>
        <span className="font-mono text-mono text-t3">
          {running ? "running" : status.state === "done" ? "exit 0" : `exit ${status.exit_code ?? "?"}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-chip px-1.5 text-meta text-t3 hover:bg-row-hover hover:text-t1"
        >
          Close
        </button>
      </div>
      {status && (status.lines.length > 0 || status.dropped > 0) ? (
        <div ref={tail} className="max-h-48 overflow-auto px-2 py-1">
          {status.dropped > 0 ? (
            <p className="whitespace-pre font-mono text-mono text-warn">{status.dropped} earlier lines dropped</p>
          ) : null}
          {status.lines.map((line, index) => (
            // Installer output has no stable id; the index is the line number,
            // and the list only ever grows at the tail.
            <p key={index} className="whitespace-pre font-mono text-mono text-t2">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="flex items-baseline gap-2 border-t border-hairline px-2 py-1 text-meta text-t3">
          <span>read failed</span>
          <span className="font-mono text-mono text-fail">{error}</span>
        </p>
      ) : null}
    </div>
  );
}
