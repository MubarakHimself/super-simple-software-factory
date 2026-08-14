/**
 * Runs (spec 2.5) - the surface root: second column (the run list, with the
 * Worktrees strip under it), main pane (the run view), right rail (Diff).
 *
 * Three things this file exists to get right:
 *
 * 1. **The self-check filter is visible, never silent.** The server excludes
 *    the installer's smoke rows by exact string and reports how many it hid;
 *    this surface prints that count as a footer line that toggles them. On
 *    this repo today that is all 12 rows, so the list is empty and the pane
 *    says so - three distinct empty states, never merged (spec 2.5).
 *
 * 2. **One poll.** `/live` is the shell's, already running. The run list and
 *    the open run re-read when it reports a new event, and never on a timer of
 *    their own.
 *
 * 3. **Spec 3.4's one responsive rule.** The operator's window is 1360px:
 *    240 sidebar + 280 list + 380 rail leaves 460px for the run itself, so
 *    below 1200px of surface width the Diff rail becomes a right-anchored
 *    overlay instead of taking layout width, and the run view keeps its
 *    geometry.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { useShell } from "../App.tsx";
import type { Live } from "../lib/api.ts";
import { usePaneWidth } from "../lib/measure.ts";
import { useResource } from "../lib/poll.ts";
import { EmptyState, NoFactory } from "../shell/EmptyState.tsx";
import { RunList } from "./RunList.tsx";
import { RunView } from "./RunView.tsx";
import { staleAfterMinutes as readStaleAfterMinutes } from "./stall.ts";
import { WorktreeStrip } from "./WorktreeStrip.tsx";
import { isFactoryAbsent, type FactoryAbsent, type LiveRun, type RunsResponse } from "./types.ts";

/** Spec 3.4: the rail survives above this, overlays below it. */
const RAIL_MIN_WIDTH = 1200;

export default function Runs() {
  const { projectId, live } = useShell();
  const { adwId } = useParams();
  const [showSelfChecks, setShowSelfChecks] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  // Width is measured, not guessed: the sidebar collapses to 0 and the window
  // is the operator's own, so a media query would be measuring the wrong box.
  // `usePaneWidth` owns both traps this measurement has (a zero reading, and
  // an element that only appears after the `/runs` -> `/runs/:adw_id` redirect
  // below) - see its header. Unmeasured reads as wide, so the rail is never
  // withheld from a screen that has room for it.
  const [surfaceRef, surfaceWidth] = usePaneWidth<HTMLDivElement>();
  const wide = surfaceWidth === null || surfaceWidth >= RAIL_MIN_WIDTH;

  useEffect(() => {
    if (!diffOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDiffOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [diffOpen]);

  const runsRes = useResource<RunsResponse | FactoryAbsent>(
    `${projectId}|runs|${showSelfChecks ? 1 : 0}`,
    `/api/app/p/${encodeURIComponent(projectId)}/runs?self_checks=${showSelfChecks ? 1 : 0}`,
  );

  // The live poll's own change signature. When it moves, the list is stale.
  const liveData = live.data as Live | null;
  const runningRows = useMemo<LiveRun[]>(() => (liveData?.running as LiveRun[] | undefined) ?? [], [liveData]);
  const signature = runningRows.map((r) => `${r.adw_id}:${r.latest_event_rowid ?? ""}`).join(",");
  const { refresh: refreshRuns } = runsRes;
  useEffect(() => {
    refreshRuns();
  }, [signature, refreshRuns]);

  // `worktrees.stale_after_minutes`, read from the project's own config -
  // null until it lands, and null forever when it cannot be read, in which
  // case no stall line renders (see stall.ts's header).
  const [staleMinutes, setStaleMinutes] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setStaleMinutes(null);
    void readStaleAfterMinutes(projectId).then((value) => {
      if (!cancelled) setStaleMinutes(value);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const toggleSelfChecks = useCallback(() => setShowSelfChecks((v) => !v), []);
  const toggleDiff = useCallback(() => setDiffOpen((v) => !v), []);

  const body = runsRes.data;
  const factoryAbsent = body ? isFactoryAbsent(body) : false;
  const response = body && !isFactoryAbsent(body) ? body : null;
  const runs = response?.runs ?? [];
  const hidden = response?.hidden_self_checks ?? 0;

  // A missing db is a state, not a throw (spec 2.5's empty-state table). The
  // `Initialize factory` action for it is the top bar's, per spec 2.9 - it
  // renders there the moment readiness says the project has no factory, and
  // printing a second copy of one button is not what "at most one action"
  // means.
  if (factoryAbsent) {
    return <NoFactory surface="Runs" />;
  }

  const selected = adwId ?? null;
  // With runs visible and none named, open the newest. The route can still
  // never *land* here by default - spec 2.1 keeps Runs off the default route,
  // which is what makes the installer's smoke test unreachable at startup.
  if (!selected && runs.length > 0) {
    return <Navigate to={`/p/${projectId}/runs/${runs[0]!.adw_id}`} replace />;
  }

  const liveRun = selected ? (runningRows.find((r) => r.adw_id === selected) ?? null) : null;

  return (
    <div ref={surfaceRef} className="relative flex h-full min-h-0">
      <div className="flex w-column shrink-0 flex-col border-r border-hairline">
        <RunList
          projectId={projectId}
          runs={runs}
          hiddenSelfChecks={hidden}
          showSelfChecks={showSelfChecks}
          onToggleSelfChecks={toggleSelfChecks}
          selectedAdwId={selected}
          error={runsRes.error}
        />
        <WorktreeStrip projectId={projectId} />
      </div>

      <div className="min-w-0 flex-1">
        {selected ? (
          <RunView
            projectId={projectId}
            adwId={selected}
            liveRun={liveRun}
            staleAfterMinutes={staleMinutes}
            wide={wide}
            diffOpen={diffOpen}
            onToggleDiff={toggleDiff}
          />
        ) : runs.length === 0 && hidden > 0 ? (
          <p className="flex h-full items-center justify-center text-body text-t2">No runs match this filter.</p>
        ) : runsRes.loading ? null : (
          <EmptyState heading="No runs yet" sentence="Dispatch a card with just work-next." />
        )}
      </div>
    </div>
  );
}
