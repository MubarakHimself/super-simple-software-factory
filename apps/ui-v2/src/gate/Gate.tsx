/**
 * Gate (spec 2.6) - the pre-merge surface, observe-only.
 *
 * One card per shippable run: `status='success'` + an `adw/<id>_*` branch +
 * not an ancestor of `main`. That rule is `computeGateItems()`'s, unchanged and
 * server-side; this surface decides nothing about eligibility. A failed run is
 * Runs work, not Gate work, and never appears here.
 *
 * Two actions live on the card, and only there: the compare link, and - since
 * the KISS correction - `Merge`, which fast-forwards the run's branch into
 * `main` in the main checkout and moves the run's queue card into `queue/done/`
 * in the same request (that move IS the merge event, per `adws/dispatch.py`).
 * There is still no Push and no PR-create anywhere in this directory, and the
 * absence is not explained in prose - those buttons simply aren't there.
 */
import { useShell } from "../App.tsx";
import { useResource } from "../lib/poll.ts";
import { EmptyState, NoFactory, ReadFailure } from "../shell/EmptyState.tsx";
import { GateCard, type GateItem } from "./GateCard.tsx";

/** `/api/app/p/:id/gate` answers with the run list, or with the honest
 * "there is no factory in this project" state - a missing db is a state, not a
 * throw (spec 2.5's rule, applied by `scoped.ts` to every scoped route). */
type GateBody = { items: GateItem[] } | { factory: "absent" };

export default function Gate() {
  const { projectId } = useShell();
  const { data, error, loading } = useResource<GateBody>(
    projectId ? `${projectId}|gate` : null,
    projectId ? `/api/app/p/${encodeURIComponent(projectId)}/gate` : null,
  );

  // Nothing paints until the first response for THIS project lands - a row
  // from the previous project is invented data here (spec 2.1, W3-A3).
  if (loading) return null;

  if (!data && error) {
    return (
      <div className="flex h-full items-center justify-center">
        <ReadFailure error={error} />
      </div>
    );
  }

  if (data && "factory" in data) {
    return <NoFactory surface="Gate" />;
  }

  const items = data?.items ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        heading="Gate"
        sentence="Nothing to ship yet — a run lands here when it succeeds on its branch."
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      {/* A failed poll keeps the last good cards and says so inline, at the
          position it happened - never a banner, never a toast (spec 2.1/3.6). */}
      {error ? <ReadFailure error={error} /> : null}
      {/* The cards take the pane's width, capped only where a line of a
          reviewer's summary would otherwise run past a readable measure. */}
      <div className="flex max-w-[1400px] flex-col gap-4">
        {items.map((item) => (
          // A merged card keeps its place and says what happened; the list is
          // re-read the next time this surface mounts, by which point the run
          // is no longer gate work (its branch is an ancestor of main). No
          // auto-refresh, because refreshing would erase the one line that
          // tells the operator the merge landed.
          <GateCard key={item.adw_id} projectId={projectId} item={item} />
        ))}
      </div>
    </div>
  );
}
