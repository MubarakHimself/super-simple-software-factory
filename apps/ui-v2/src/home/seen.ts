/**
 * The overnight window's anchor: `seen.json`, advanced **at most once per
 * server process** (spec 2.2, the paragraph headed "When the snapshot advances
 * (load-bearing, and the obvious design is wrong)").
 *
 * Home renders against the PREVIOUS snapshot. The first Home open of a server
 * process POSTs `/seen`; the server writes the new snapshot and returns the
 * previous one, and every later POST in that same process returns that same
 * previous value again. So a browser refresh at 07:05 shows the same overnight
 * window it showed at 07:00 - a POST that advanced on every open would erase
 * the exact thing W2-C3 ("reopen at 07:00, nothing lost") exists to preserve.
 *
 * The guarantee is the SERVER's (`server/app/seen.ts` holds the once-per-
 * process map), not this file's. The promise cache below only spares the app a
 * second identical round trip when the operator navigates back to Home; if it
 * were deleted, the surface would still show the same window, because a repeat
 * POST is a no-op that hands back the same previous value.
 */
import { useEffect, useState } from "react";
import { apiPost } from "../lib/api.ts";

/** `~/.sdl-factory/projects/<id>/seen.json` (spec 1.4). */
export interface SeenSnapshot {
  at: string;
  /** `{ "queue/001-….md": "ready-for-agent", … }` - the last visit's statuses. */
  cards: Record<string, string>;
}

interface SeenResponse {
  previous: SeenSnapshot | null;
}

const inFlight = new Map<string, Promise<SeenSnapshot | null>>();

/** The one POST. Resolved values are cached for the life of the tab; a
 * rejection is not, so a failed first open can be retried by navigating back
 * (the server is idempotent per process either way). */
export function advanceSeen(projectId: string): Promise<SeenSnapshot | null> {
  const held = inFlight.get(projectId);
  if (held) return held;
  const request = apiPost<SeenResponse>(`/api/app/p/${encodeURIComponent(projectId)}/seen`)
    .then((response) => response.previous ?? null)
    .catch((error: unknown) => {
      inFlight.delete(projectId);
      throw error;
    });
  inFlight.set(projectId, request);
  return request;
}

export interface Seen {
  /** The previous snapshot - `null` when this project has no recorded visit. */
  previous: SeenSnapshot | null;
  error: string | null;
  loading: boolean;
}

export function useSeen(projectId: string): Seen {
  const [seen, setSeen] = useState<Seen>({ previous: null, error: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    // A project switch empties the panel before anything is asked for, so no
    // row of the previous project can survive it (spec 2.1, W3-A3).
    setSeen({ previous: null, error: null, loading: true });
    advanceSeen(projectId).then(
      (previous) => {
        if (!cancelled) setSeen({ previous, error: null, loading: false });
      },
      (error: unknown) => {
        if (!cancelled) setSeen({ previous: null, error: (error as Error).message, loading: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return seen;
}
