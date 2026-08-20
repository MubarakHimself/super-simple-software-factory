/**
 * The detail pane: one frame, six bodies.
 *
 * The frame is always the same (banner · header · beat rail · scroll · actions
 * · export bar) so the operator's eye never has to re-learn the surface; what
 * changes is which body the run's state earns:
 *
 *   running     work log, live, with the beat rail from the run's own phases
 *   cooldown    the pause said plainly + the record's own rate-limit line, and
 *               the ONE autonomous promise engine v1 can keep: it auto-resumes.
 *               (Auto-switching lanes is the balancer round - change-list #9 -
 *               so this pane never promises it.)
 *   integrated  the merge-queue view: diff, the acceptance walk with the
 *               report's two verdicts, the park commit, and Park-for-later,
 *               which LOWERS THE CUT (change-list #3) rather than plucking a
 *               card out of a line that is linear by construction.
 *   shipped     chunk-aware: the chunk this app shipped when it shipped it,
 *               and the card's own git-derived sentence when it did not.
 *   failed      the failure, its phase, and the failure log.
 *   blocked     the Blocked-reason first and largest - a blocked card is the
 *               one state that is a question to the operator (J7).
 *
 * Every body ends in the same export bar, because the handoff to /ship-check is
 * available from every state, not only from the ones that are ready to ship.
 */
import type { Resource } from "../lib/poll.ts";
import { Dot } from "../shared/Dot.tsx";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { modelName, type RunRowModel, type RunStatus } from "./model.ts";
import type { DiffResponse, RunPhase, ShipCard, WorkLogPage } from "./types.ts";
import { Acceptance } from "./Acceptance.tsx";
import { BeatRail } from "./BeatRail.tsx";
import { DiffSection } from "./DiffSection.tsx";
import { ExportBar } from "./ExportBar.tsx";
import { CheckIcon, ClockIcon } from "./icons.tsx";
import { WorkLog } from "./WorkLog.tsx";

/** The short word beside the dot. The plain sentence always follows it on the
 * line below, so this is one half of a status triple and never a bare enum. */
const STATE_WORD: Record<RunStatus["state"], string> = {
  running: "running",
  cooldown: "paused",
  integrated: "in the merge queue",
  shipped: "shipped",
  failed: "failed",
  blocked: "blocked",
  done: "finished",
  unknown: "no status recorded",
};

export interface DetailProps {
  row: RunRowModel;
  status: RunStatus;
  /** the detail read's phases when it has answered, the list's own until then */
  phases: RunPhase[];
  branch: string | null;
  runStart: string | null;
  detailError: string | null;
  worklog: Resource<WorkLogPage>;
  diff: Resource<DiffResponse>;
  /** this run's card as the shipping report holds it, when it is in the queue */
  shipCard: ShipCard | null;
  /** Park lowers the cut; null when this card is not in the current report */
  onPark: (() => void) | null;
  /** the chunk this app shipped in this session, when it shipped this card */
  shippedChunk: { commit: string; count: number } | null;
  prompt: string;
}

export function Detail(props: DetailProps) {
  const { row, status, phases, worklog, diff, shipCard, prompt } = props;
  const state = status.state;

  return (
    <div className="detail-pane">
      {state === "cooldown" ? (
        <div className="cooldown-banner">
          <span className="cd-badge">
            <ClockIcon />
            Lane cooldown
          </span>
          <span className="cd-banner-text">
            {row.lane ? (
              <>
                Lane <strong>{row.lane}</strong> hit its rate limit — the run is paused.
              </>
            ) : (
              <>The run is paused: its lane hit a rate limit.</>
            )}
          </span>
        </div>
      ) : null}

      {state === "integrated" ? (
        <div className="gate-banner">
          <span className="gate-type-badge g2">
            <CheckIcon />
            Merge queue
          </span>
          <span className="gate-banner-text">
            <strong>On integration, not yet on main.</strong> Ship it from the merge queue on the right.
          </span>
        </div>
      ) : null}

      {state === "blocked" ? (
        <div className="gate-banner blocked">
          <span className="gate-type-badge blocked">Blocked</span>
          <span className="gate-banner-text">
            <strong>The engine could not integrate this card.</strong> It is waiting on you, not on a lane.
          </span>
        </div>
      ) : null}

      {state === "shipped" ? (
        <div className="gate-banner">
          <span className="gate-type-badge shipped">Shipped</span>
          <span className="gate-banner-text">
            <strong>This card is inside a chunk on main.</strong>
          </span>
        </div>
      ) : null}

      {state === "failed" ? (
        <div className="gate-banner">
          <span className="gate-type-badge failed">Failed</span>
          <span className="gate-banner-text">
            <strong>The run stopped before it finished.</strong> Its card stays where the engine left it.
          </span>
        </div>
      ) : null}

      <RunHeader {...props} />
      <BeatRail phases={phases} />

      <div className="detail-scroll">
        {props.detailError ? <ReadFailure error={props.detailError} /> : null}
        {worklog.error ? <ReadFailure error={worklog.error} /> : null}

        {state === "blocked" ? (
          <div className="log-section">
            <div className="log-section-title">Blocked reason</div>
            <p className="blocked-reason">
              {row.card?.blocked_reason ?? "The card is blocked but carries no Blocked-reason line for this app to read."}
            </p>
          </div>
        ) : null}

        {state === "failed" && status.evidence ? (
          <div className="log-section">
            <div className="log-section-title">What the record says</div>
            <p className="blocked-reason">{status.evidence}</p>
          </div>
        ) : null}

        {state === "cooldown" ? (
          <div className="log-section">
            <div className="log-section-title">The rate limit, as the record wrote it</div>
            <p className="record-note">{status.evidence}</p>
          </div>
        ) : null}

        {state === "shipped" ? (
          <div className="completed-view">
            <div className="cv-icon" />
            <h2>Shipped to main</h2>
            <p>{status.sentence}</p>
            <p className="cv-meta">
              {props.shippedChunk
                ? `shipped in chunk of ${props.shippedChunk.count} · ${props.shippedChunk.commit}`
                : "this app did not perform that squash, so it cannot name the chunk's commit — it reads the card out of main's tree"}
            </p>
          </div>
        ) : null}

        {state === "integrated" || state === "shipped" || state === "done" ? (
          <DiffSection card={shipCard} diff={diff} sha={shipCard?.sha ?? null} machine={row.machine} />
        ) : null}

        {state === "integrated" && shipCard ? <Acceptance card={shipCard} /> : null}

        {state === "integrated" && !shipCard ? (
          <div className="acceptance-section">
            <div className="log-section-title">Acceptance criteria</div>
            <p className="record-note">
              The shipping report does not list this card, so there is no acceptance walk to show for it here.
            </p>
          </div>
        ) : null}

        {state === "integrated" && shipCard?.sha ? (
          <div className="commit-row">
            <span className="commit-sha">{shipCard.sha}</span>
            <span className="commit-msg">
              the commit that parked {shipCard.name} into queue/done/ — the cut point for this card
            </span>
            {shipCard.branch ? <span className="commit-author">{shipCard.branch}</span> : null}
          </div>
        ) : null}

        {state === "running" || state === "cooldown" || state === "failed" || state === "blocked" || state === "done" || state === "unknown" ? (
          <WorkLog
            title={workLogTitle(state)}
            entries={worklog.data?.entries ?? []}
            runStart={props.runStart}
            hasMore={worklog.data?.has_more ?? false}
            // A run read off a machine (row.machine is set) has its work log on
            // THAT machine. "nothing has been written for it yet" would be a
            // flat untruth about a run that is writing entries right now, four
            // thousand kilometres away - so the sentence says where they are.
            emptySentence={
              row.machine
                ? `This run's work log stays ${row.machine} — this app reads the run list from that machine, not each run's log.`
                : "This run's record holds no work-log entries — nothing has been written for it yet."
            }
          />
        ) : null}
      </div>

      {state === "cooldown" ? (
        <div className="cooldown-actions">
          <p className="cd-hint">
            <strong>The factory is autonomous.</strong> It resumes this run by itself when the lane's limit clears. No
            action is required, and nothing here can hurry it.
          </p>
        </div>
      ) : null}

      {state === "integrated" ? (
        <div className="merge-action">
          <p className="merge-hint">
            <strong>Ship = cut a point on a line.</strong> Integration is linear, so selecting this card in the rail
            ships it and everything under it — as one squash commit on main.
          </p>
          <p className="merge-queue-note">
            Merging happens in the <strong>merge queue</strong> on the right. Park for later does not pluck this card
            out of the line; it lowers the cut to the card below it.
          </p>
          <button type="button" className="park-btn" onClick={() => props.onPark?.()} disabled={props.onPark === null}>
            {props.onPark === null
              ? "Park for later — this card is not in the current report"
              : "Park for later — lower the cut below this card"}
          </button>
        </div>
      ) : null}

      <ExportBar prompt={prompt} />
    </div>
  );
}

function workLogTitle(state: RunStatus["state"]): string {
  if (state === "cooldown") return "Last activity";
  if (state === "failed") return "Failure log";
  if (state === "blocked") return "What the run recorded";
  return "Work log";
}

function RunHeader({ row, status, branch }: DetailProps) {
  const model = modelName(row.model);
  return (
    <div className="run-header">
      <div className="run-header-line1">
        <h1>{row.title}</h1>
        <span className="run-header-id">{row.adwId}</span>
      </div>
      <div className="run-header-line2">
        <span className="rh-meta">
          <Dot tone={status.tone} pulse={status.state === "running" || status.state === "cooldown"} />
          {STATE_WORD[status.state]}
        </span>
        {status.step ? <span className="rh-meta rh-phase">{status.step}</span> : null}
        <span className="rh-meta rh-elapsed">
          {status.state === "running" || status.state === "cooldown" ? `${row.clock} elapsed` : row.clock}
        </span>
        {row.lane ? <span className="rh-meta">lane: {row.lane}</span> : null}
        {model ? <span className="rh-meta">model: {model}</span> : null}
        {row.machine ? <span className="rh-meta machine-chip">{row.machine}</span> : null}
        {branch ? <span className="rh-meta">branch: {branch}</span> : null}
        {row.card ? <span className="rh-meta">card: {row.card.name}</span> : null}
      </div>
      {/* A blocked card's sentence IS its Blocked-reason, and the body prints
          that in full, first and largest. Printing it here too would say the
          same paragraph twice on one screen. */}
      {status.state === "blocked" ? null : <p className="run-header-sentence">{status.sentence}</p>}
    </div>
  );
}
