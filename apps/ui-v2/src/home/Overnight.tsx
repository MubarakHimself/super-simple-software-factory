/**
 * Home - Overnight (spec 2.2). The per-project landing.
 *
 * One section. One line per run that ended since the last visit, one line for
 * cards that moved, and below it nothing above the fold: no welcome text, no
 * "here's what your factory did" paragraph. Ten words a line is the budget, and
 * the budget is a requirement ("too much text makes it look like mock data").
 *
 * The window is anchored by `seen.json`, advanced at most once per server
 * process - see `./seen.ts`. Refreshing the browser at 07:05 shows the same
 * summary it showed at 07:00, because the server hands back the same previous
 * snapshot every time this surface asks (W2-C3, W2-D1).
 *
 * Empty, and exactly this: `Nothing ran since your last visit.`
 */
import { Link } from "react-router-dom";
import { useShell } from "../App.tsx";
import { useResource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { useDiffTotals, type DiffTotals } from "./diff.ts";
import {
  cardMovements,
  compactSpan,
  overnightRuns,
  runLabel,
  type CardMovement,
  type QueueResponseRow,
  type RunRow,
  type RunsResponse,
} from "./derive.ts";
import { useSeen } from "./seen.ts";

/** Spec 1.2: checks and dots are drawn, never shipped as glyphs to a console.
 * These two are local because `shared/Icons.tsx` belongs to another chunk. */
function Check() {
  return (
    <svg viewBox="0 0 12 12" className="size-3 shrink-0 text-ok" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m2.2 6.3 2.6 2.6 5-6" />
    </svg>
  );
}

function Cross() {
  return (
    <svg viewBox="0 0 12 12" className="size-3 shrink-0 text-fail" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="m3 3 6 6M9 3l-6 6" />
    </svg>
  );
}

function Sep() {
  return <span className="shrink-0 text-t3">&#183;</span>;
}

/** `+84 −0` - additions in the success color, deletions in the failure one
 * (spec 3.2's own roles for `--ok` / `--fail`). U+2212, the spec's character. */
function DiffPair({ totals }: { totals: DiffTotals }) {
  return (
    <span className="shrink-0 font-mono text-mono">
      <span className="text-ok">+{totals.added}</span> <span className="text-fail">&#8722;{totals.deleted}</span>
    </span>
  );
}

function RunLine({ projectId, run, totals }: { projectId: string; run: RunRow; totals: DiffTotals | undefined }) {
  const label = runLabel(run);
  const elapsed = compactSpan(run.started_at, run.ended_at);
  return (
    <Link
      to={`/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(run.adw_id)}`}
      title={run.adw_id}
      className="flex h-row shrink-0 items-center gap-2 rounded-chip px-2 hover:bg-row-hover"
    >
      {run.status === "success" ? <Check /> : null}
      {run.status === "fail" ? <Cross /> : null}
      {label ? (
        <span className="min-w-0 truncate text-body text-t1">{label}</span>
      ) : (
        // Title, request, lane and adw name were all null on this row - the
        // whole of spec 3.7's order is exhausted before an id is ever a label.
        <span className="min-w-0 truncate font-mono text-mono text-t2">{run.adw_id}</span>
      )}
      {elapsed ? (
        <>
          <Sep />
          <span className="shrink-0 font-mono text-mono text-t3">{elapsed}</span>
        </>
      ) : null}
      {totals ? (
        <>
          <Sep />
          <DiffPair totals={totals} />
        </>
      ) : null}
    </Link>
  );
}

/** One line for cards, whatever their number: `001 → done · 002 → blocked`.
 * Past four the rest collapse to a count - the app's own collapse-and-count
 * idiom (spec 3.6), so the line stays a line. */
const VISIBLE_MOVEMENTS = 4;

function CardLine({ movements }: { movements: CardMovement[] }) {
  const shown = movements.slice(0, VISIBLE_MOVEMENTS);
  const rest = movements.length - shown.length;
  return (
    <div className="flex h-row shrink-0 items-center gap-2 px-2 text-body">
      {shown.map((movement, index) => (
        <span key={movement.path} className="flex shrink-0 items-center gap-2" title={movement.path}>
          {index > 0 ? <Sep /> : null}
          <span className="font-mono text-mono text-t2">{movement.id}</span>
          <span className="text-t3">&#8594;</span>
          <span className="font-mono text-mono text-t1">{movement.status}</span>
        </span>
      ))}
      {rest > 0 ? <span className="shrink-0 text-meta text-t3">+{rest} more</span> : null}
    </div>
  );
}

export default function Overnight() {
  const { projectId } = useShell();
  const seen = useSeen(projectId);

  const runs = useResource<RunsResponse>(
    `${projectId}|runs`,
    `/api/app/p/${encodeURIComponent(projectId)}/runs`,
  );
  const queue = useResource<QueueResponseRow>(
    `${projectId}|queue`,
    `/api/app/p/${encodeURIComponent(projectId)}/queue`,
  );

  // No previous snapshot means no recorded last visit, so there is no window
  // to report - never the whole history relabelled "overnight".
  const landed = seen.previous ? overnightRuns(runs.data?.runs ?? [], seen.previous.at) : [];
  const moved = cardMovements(seen.previous?.cards ?? null, queue.data?.items ?? []);
  const totals = useDiffTotals(projectId, landed.map((run) => run.adw_id));

  const settled = !seen.loading && !runs.loading && !queue.loading;
  const nothing = landed.length === 0 && moved.length === 0;

  return (
    <section className="h-full overflow-y-auto px-4 py-3">
      <h1 className="text-head font-semibold text-t1">Overnight</h1>
      <div className="mt-2 flex flex-col">
        {landed.map((run) => (
          <RunLine key={run.adw_id} projectId={projectId} run={run} totals={totals.get(run.adw_id)} />
        ))}
        {moved.length > 0 ? <CardLine movements={moved} /> : null}
        {settled && nothing ? (
          <p className="px-2 text-body text-t2">Nothing ran since your last visit.</p>
        ) : null}
        {/* Read failures are inline lines at the position they happened - the
            panel keeps whatever it already had (spec 2.1, 3.6). */}
        {seen.error ? <ReadFailure error={seen.error} /> : null}
        {runs.error ? <ReadFailure error={runs.error} /> : null}
        {queue.error ? <ReadFailure error={queue.error} /> : null}
      </div>
    </section>
  );
}
