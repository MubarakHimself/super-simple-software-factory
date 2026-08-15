/**
 * Confirm-first, then the truth about what happened.
 *
 * The confirm step shows the operator the exact thing he is about to author:
 * the range, the cards inside the cut, and the report text that BECOMES the
 * squash commit's message (`git commit --cleanup=verbatim -F` on the server —
 * so what is on screen here is what lands in git's log, not a summary of it).
 * For a partial cut the body is the report re-run for `BASE..<cut sha>`, which
 * is exactly what the server will write, so this pane asks for it by range
 * rather than showing the whole line's text and hoping.
 *
 * The result step never rounds anything up. `POST /ship` answers 200 with
 * `pushed:false` when git refused the push — the commit exists locally and
 * saying "shipped" without saying "not pushed" would be a lie — and 409 with
 * git's own sentence for a dirty tree, a diverged main, a missing identity.
 * Both are rendered as they arrive, verbatim.
 */
import { useCallback, useRef, useState } from "react";
import { ApiFailure, apiPost } from "../lib/api.ts";
import { useResource } from "../lib/poll.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import type { QueueRowModel } from "./model.ts";
import type { ShipReport, ShipResult } from "./types.ts";

export function ShipModal({
  projectId,
  cut,
  cards,
  range,
  previewRange,
  fallbackMarkdown,
  onCancel,
  onShipped,
}: {
  projectId: string;
  /** what `POST /ship` is given: a card basename, or "all" for the whole line */
  cut: string;
  /** the cards inside the cut, in integration order */
  cards: QueueRowModel[];
  /** the range this chunk covers, as the report resolved it */
  range: string | null;
  /** non-null only for a partial cut - then the body must be re-read for it */
  previewRange: string | null;
  /** the whole line's report markdown, already read by the surface */
  fallbackMarkdown: string | null;
  onCancel: () => void;
  onShipped: (result: ShipResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ShipResult | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);
  useDismiss(frame, true, close);

  const preview = useResource<ShipReport>(
    previewRange ? `${projectId}|ship-preview|${previewRange}` : null,
    previewRange
      ? `/api/app/p/${encodeURIComponent(projectId)}/ship/report?range=${encodeURIComponent(previewRange)}`
      : null,
  );
  const body = previewRange ? (preview.data?.markdown ?? null) : fallbackMarkdown;

  const ship = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const shipped = await apiPost<ShipResult>(`/api/app/p/${encodeURIComponent(projectId)}/ship`, { cut });
      setResult(shipped);
      onShipped(shipped);
    } catch (error) {
      setRefusal(error instanceof ApiFailure ? error.message : (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal ship-modal" ref={frame} role="dialog" aria-modal="true" aria-label="Merge to main">
        <div className="modal-header">
          <h3>{result ? "The squash landed" : "Merge to main"}</h3>
          <p className="modal-sub">
            {result
              ? "What git did, step by step."
              : `${cards.length} card${cards.length === 1 ? "" : "s"} — one squash commit on main.`}
          </p>
        </div>

        <div className="modal-body">
          {result ? (
            <ShipOutcome result={result} />
          ) : (
            <>
              <div className="ship-what">
                {/* The rail draws the line oldest-first, so the chunk is the
                    cut card plus the rows above it. Same words as the rail's
                    own cut mark - one vocabulary for the one irreversible
                    act. */}
                <span>
                  <strong>{cards[cards.length - 1]?.title ?? cut}</strong> and everything above it in the rail ship as
                  one commit. Nothing below the cut moves, and <code>integration</code> is only read.
                </span>
                <span className="ship-range">{range ? `range ${range}` : "the report resolved no range for this cut"}</span>
              </div>

              <div className="ship-card-list">
                {cards.map((card) => (
                  <div className="ship-card-row" key={card.name}>
                    <span className="scr-name">{card.name}</span>
                    <span className="scr-title">{card.title}</span>
                  </div>
                ))}
              </div>

              <div className="ship-what">
                <span>This report becomes the commit message, verbatim:</span>
              </div>
              {preview.error ? <ReadFailure error={preview.error} /> : null}
              {body ? (
                <pre className="ship-message">{body}</pre>
              ) : (
                <p className="record-note">
                  {previewRange && !preview.error
                    ? "Assembling the report for this cut…"
                    : "The report text for this cut is not on screen; the server assembles it again before it commits."}
                </p>
              )}
              {refusal ? <p className="ship-result-detail failed">{refusal}</p> : null}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={close} disabled={busy}>
            {result ? "Close" : "Cancel"}
          </button>
          {result ? null : (
            <button type="button" className="modal-btn primary" onClick={() => void ship()} disabled={busy}>
              {busy ? "Merging…" : refusal ? "Try again" : "Merge to main"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ShipOutcome({ result }: { result: ShipResult }) {
  return (
    <div className="ship-result">
      <p className="ship-result-line">
        Commit <strong>{result.commit}</strong> is on main, carrying {result.cards.length} card
        {result.cards.length === 1 ? "" : "s"}.
      </p>
      <p className="ship-result-detail">range {result.range}</p>
      <p className="ship-result-detail">cut at {result.cut === "all" ? "the whole line" : result.cut}</p>

      {result.pushed ? (
        <p className="ship-result-detail">pushed to {result.remote ?? "origin"}/main — the engine will notice by itself.</p>
      ) : (
        <p className="ship-result-detail failed">
          not pushed — {result.push_error ?? "no reason given"}. The commit exists in your checkout; push it yourself
          when the hub is ready.
        </p>
      )}

      {result.fetch_note ? <p className="ship-result-detail">{result.fetch_note}</p> : null}

      {result.restored_branch ? (
        <p className="ship-result-detail">your checkout is back on {result.previous_branch}.</p>
      ) : (
        <p className="ship-result-detail failed">
          the checkout is still on main — {result.restore_error ?? "no reason given"}
        </p>
      )}

      <p className="ship-result-detail">the squash body was written to {result.message_file}</p>
    </div>
  );
}
