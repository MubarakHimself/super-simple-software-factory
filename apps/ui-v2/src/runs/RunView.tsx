/**
 * The run view (spec 2.5) - header, beat rail, work log, diff rail, quality,
 * stall. Observe-only by construction: this component takes no callbacks that
 * write, mounts no composer, and every child it renders is a reader.
 *
 * Reads, in order: `/runs/:adw_id` (header + phases + beats), `/worklog`
 * (the folded event stream), `/quality`, and `/diff` (inside the rail). None
 * of them polls: they refresh when the shell's one 2s `/live` poll says this
 * run recorded a new event, which is the only thing that can change them.
 */
import { useEffect, useMemo } from "react";
import { useResource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { BeatCells, buildBeats } from "./BeatRail.tsx";
import { DiffRail } from "./DiffRail.tsx";
import { QualityBlock } from "./QualityBlock.tsx";
import { RunHeader } from "./RunHeader.tsx";
import { deriveStall } from "./stall.ts";
import { WorkLog } from "./WorkLog.tsx";
import {
  isFactoryAbsent,
  type FactoryAbsent,
  type LiveRun,
  type QualityCheck,
  type RunDetail,
  type WorkLogResponse,
} from "./types.ts";

export function RunView({
  projectId,
  adwId,
  liveRun,
  staleAfterMinutes,
  wide,
  diffOpen,
  onToggleDiff,
}: {
  projectId: string;
  adwId: string;
  /** This run's row in the live poll, when it is running - the only source of
   * a running run's branch and worktree path. */
  liveRun: LiveRun | null;
  /** `worktrees.stale_after_minutes` for this project, or null when the app
   * cannot read it - in which case no stall line renders at all. */
  staleAfterMinutes: number | null;
  wide: boolean;
  diffOpen: boolean;
  onToggleDiff: () => void;
}) {
  const key = `${projectId}|run|${adwId}`;
  const detailRes = useResource<RunDetail | FactoryAbsent>(
    key,
    `/api/app/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(adwId)}`,
  );
  const worklogRes = useResource<WorkLogResponse | FactoryAbsent>(
    `${key}|worklog`,
    `/api/app/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(adwId)}/worklog`,
  );
  const qualityRes = useResource<QualityCheck[] | FactoryAbsent>(
    `${key}|quality`,
    `/api/app/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(adwId)}/quality`,
  );

  // The one poll drives every re-read: a new event rowid is the only thing
  // that can have changed this run's header, log or quality rows.
  const signal = liveRun?.latest_event_rowid ?? null;
  const { refresh: refreshDetail } = detailRes;
  const { refresh: refreshWorklog } = worklogRes;
  const { refresh: refreshQuality } = qualityRes;
  useEffect(() => {
    if (signal === null) return;
    refreshDetail();
    refreshWorklog();
    refreshQuality();
  }, [signal, refreshDetail, refreshWorklog, refreshQuality]);

  const detail = detailRes.data && !isFactoryAbsent(detailRes.data) ? detailRes.data : null;
  const worklog = worklogRes.data && !isFactoryAbsent(worklogRes.data) ? worklogRes.data : null;
  const quality = Array.isArray(qualityRes.data) ? qualityRes.data : [];
  const entries = useMemo(() => worklog?.entries ?? [], [worklog]);

  const beats = detail ? buildBeats(detail.phases) : null;
  const stall = useMemo(
    () =>
      detail
        ? deriveStall(detail.session, detail.phases, detail.processes, entries, staleAfterMinutes)
        : null,
    [detail, entries, staleAfterMinutes],
  );

  if (!detail) {
    return (
      <div className="flex h-full flex-col justify-center">
        {detailRes.error ? <ReadFailure error={detailRes.error} /> : null}
      </div>
    );
  }

  const strip = beats !== null || !wide;

  return (
    <div className="flex h-full min-h-0">
      <div
        className="flex min-w-0 flex-1 flex-col"
        // Spec 2.4's rule for an overlaid rail, applied here: "Esc or a click
        // outside closes it". The toggle itself sits under the overlay once
        // it is open, so the click-outside is not a convenience.
        onPointerDownCapture={!wide && diffOpen ? onToggleDiff : undefined}
      >
        <RunHeader detail={detail} worktreePath={liveRun?.worktree_path ?? null} />
        {strip ? (
          <div className="flex h-chain shrink-0 items-center gap-4 border-b border-hairline px-5">
            {beats ? <BeatCells beats={beats} /> : null}
            {!wide ? (
              <button
                type="button"
                onClick={onToggleDiff}
                aria-expanded={diffOpen}
                className={`ml-auto font-mono text-meta ${diffOpen ? "text-accent" : "text-t3 hover:text-t2"}`}
              >
                Diff
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {worklogRes.error ? <ReadFailure error={worklogRes.error} /> : null}
          <WorkLog entries={entries} phases={detail.phases} stall={stall} />
          <QualityBlock checks={quality} />
        </div>
      </div>

      {wide ? (
        <aside className="w-inspector shrink-0">
          <DiffRail projectId={projectId} adwId={adwId} entries={entries} phases={detail.phases} />
        </aside>
      ) : diffOpen ? (
        // Spec 3.4's one responsive rule: below 1200px of content width the
        // rail becomes a right-anchored overlay rather than taking layout
        // width - the run view keeps its geometry and one part of it is
        // covered.
        <aside className="absolute inset-y-0 right-0 z-20 w-inspector shadow-[var(--shadow-overlay)]">
          <DiffRail projectId={projectId} adwId={adwId} entries={entries} phases={detail.phases} />
        </aside>
      ) : null}
    </div>
  );
}
