/**
 * The `+84 −0` half of spec 2.2's run line.
 *
 * `/runs` carries no diff totals, so the numbers come from the run's own
 * `/runs/:adw_id/diff` - the same handler the Runs surface's diff rail reads,
 * asked once per run in the overnight window and never on a poll. A run whose
 * diff is empty (`resolveDiff` reports its own `no diff available`) renders
 * without the pair rather than with `+0 −0`: absent when the record has
 * nothing, which is the same rule as "never mock data".
 */
import { useEffect, useState } from "react";
import { apiGet } from "../lib/api.ts";

/** Each lookup is a `git diff` in the request path. The overnight window is
 * normally a handful of runs; this is the ceiling that keeps a first-ever open
 * on a long-lived project from firing eighty of them. */
const MAX_LOOKUPS = 12;

export interface DiffTotals {
  added: number;
  deleted: number;
}

interface DiffResponse {
  added: number;
  deleted: number;
  empty: boolean;
}

/**
 * @param adwIds the runs in the window, in render order. Results arrive one at
 *               a time so the first lines fill in without waiting for the last.
 */
export function useDiffTotals(projectId: string, adwIds: string[]): Map<string, DiffTotals> {
  const [totals, setTotals] = useState<Map<string, DiffTotals>>(new Map());
  // The effect depends on the ids themselves, not on the array's identity.
  const wanted = adwIds.join(",");

  useEffect(() => {
    // A project switch (or an emptied window) clears the map first, so no
    // number of the previous project can paint under the new one (W3-A3).
    setTotals(new Map());
    const ids = wanted ? wanted.split(",") : [];
    if (ids.length === 0) return;

    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      const found = new Map<string, DiffTotals>();
      for (const adwId of ids.slice(0, MAX_LOOKUPS)) {
        try {
          const diff = await apiGet<DiffResponse>(
            `/api/app/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(adwId)}/diff`,
            controller.signal,
          );
          if (cancelled) return;
          if (!diff.empty) found.set(adwId, { added: diff.added, deleted: diff.deleted });
        } catch {
          // One run's diff failing is one run rendered without its totals, not
          // a failed surface. The line above it still says what ran.
          if (cancelled) return;
        }
        setTotals(new Map(found));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [projectId, wanted]);

  return totals;
}
