/**
 * What Overnight is, computed - and nothing about how it reads.
 *
 * Two derivations, both from spec 2.2's Data line:
 *   runs  = `/api/app/p/:id/runs` filtered by `seen.at`
 *   cards = current `queue/*.md` statuses diffed against `seen.json`'s snapshot
 *           (`dispatch.py` rewrites `Status:` in place and never moves a file,
 *            so movement is observable only through the app's own snapshot)
 *
 * Every value here traces to a db row or a file on disk. A field the record
 * does not carry is absent, never padded and never invented (spec's binding
 * constraint, restated at the top of the spec).
 */
import { clip } from "../lib/format.ts";

/** The subset of the `/runs` row this surface reads. Surfaces own their own
 * types (`lib/api.ts`'s rule); the server's shape is `SessionSummary`
 * (`server/app/sessions/types.ts`). */
export interface RunRow {
  adw_id: string;
  adw_name: string | null;
  request: string | null;
  status: "running" | "success" | "fail" | null;
  started_at: string | null;
  ended_at: string | null;
  title: string | null;
  agents?: { coding_agent: string | null; model: string | null }[];
}

export interface RunsResponse {
  runs?: RunRow[];
  hidden_self_checks?: number;
  /** A project with no factory installed answers this way, and is not an error
   * (spec 2.5's "a missing db is a state, not a throw"). */
  factory?: "absent";
}

export interface QueueItemRow {
  path: string;
  status: string;
}

export interface QueueResponseRow {
  items?: QueueItemRow[];
  factory?: "absent";
}

/** Runs that ended after the last visit, newest first. A run still running has
 * no `ended_at` and is not part of the window - Overnight reports what landed,
 * and the Runs surface reports what is still going. */
export function overnightRuns(runs: RunRow[], since: string): RunRow[] {
  const from = Date.parse(since);
  if (Number.isNaN(from)) return [];
  return runs
    .filter((run) => {
      const ended = run.ended_at ? Date.parse(run.ended_at) : Number.NaN;
      return !Number.isNaN(ended) && ended > from;
    })
    .sort((a, b) => Date.parse(b.ended_at ?? "") - Date.parse(a.ended_at ?? ""));
}

/**
 * What to call a run, in spec 3.7's own order - title, then branch, then lane -
 * with `request` standing in for the title exactly the way spec 2.5's run
 * header does ("fallback: `sessions.request` clipped, saying nothing extra").
 * `/runs` carries no branch, so the order that survives here is
 * title -> request -> lane -> adw name. `adw_id` is never a primary label; it
 * is the row's hover/copy affordance instead (spec 2.0, audit F8/F14).
 */
export function runLabel(run: RunRow): string | null {
  if (run.title?.trim()) return clip(run.title, 60);
  if (run.request?.trim()) return clip(run.request, 60);
  const lane = (run.agents ?? []).map((a) => a.model ?? a.coding_agent).find((name) => name?.trim());
  if (lane) return lane;
  if (run.adw_name?.trim()) return run.adw_name;
  return null;
}

/** `41s` / `6m` / `1h 04m` - spec 2.2's own `6m`, which is one token where
 * `lib/format.ts`'s `span()` is two. A line here has ten words for everything. */
export function compactSpan(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt || !endedAt) return null;
  const from = Date.parse(startedAt);
  const to = Date.parse(endedAt);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  const seconds = Math.floor((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export interface CardMovement {
  /** The card's own numeral, `001` - its file name's prefix. */
  id: string;
  path: string;
  status: string;
}

/**
 * Cards whose `Status:` differs from the snapshot, plus cards the snapshot had
 * never seen. With no previous snapshot there is no last visit to compare
 * against, so nothing has "moved" - reporting every card as movement on a
 * first-ever open would invent a window the app never observed.
 */
export function cardMovements(previous: Record<string, string> | null, items: QueueItemRow[]): CardMovement[] {
  if (!previous) return [];
  const moved: CardMovement[] = [];
  for (const item of items) {
    const before = previous[item.path];
    if (before === item.status) continue;
    moved.push({ id: cardId(item.path), path: item.path, status: item.status });
  }
  return moved.sort((a, b) => a.id.localeCompare(b.id));
}

/** `queue/001-add-health-endpoint.md` -> `001`; a card without a numeral keeps
 * its file name, because that is what the operator would grep for. */
export function cardId(path: string): string {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  return /^(\d+)/.exec(name)?.[1] ?? name.replace(/\.md$/i, "");
}
