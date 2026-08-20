/**
 * Home's own copy of the JSON shapes it reads. Each surface owns its own
 * types (lib/api.ts's own rule) - these mirror `apps/ui/shared/types.ts`
 * field-for-field but only the fields this surface actually looks at, so a
 * server field neither of us reads can be added or dropped without an edit
 * here.
 */

/** `GET /api/app/p/:id/ship/report` - only the fields the report card reads.
 * `markdown` IS the summary (`ship_report.py --pr`'s own text) - there is no
 * separate short-form field, which is why the card shows it verbatim rather
 * than a paraphrase this file would have to keep in sync by hand. */
export interface ShipReportPayload {
  markdown: string;
  empty: boolean;
  available: boolean;
  /** ONE plain sentence when `available` is false; null otherwise. */
  reason: string | null;
  /** the script's full text when `reason` summarizes it - a tooltip, never a
   * line on the card. */
  detail: string | null;
  /** the factory has never run in this project, so there is no integration
   * branch to ship from. Normal, and never drawn as a failure. */
  not_started: boolean;
}

/** `GET /api/app/p/:id/cards` - the card lifecycle (server/app/cards.ts).
 * `state_reason` is always set and is already the one honest sentence a row
 * needs, so nothing here is recomputed from `state` alone. */
export type CardState = "ready" | "running" | "blocked" | "done" | "integrated" | "shipped" | "unknown";

export interface HomeCard {
  name: string;
  title: string;
  state: CardState;
  state_reason: string;
  adw_id: string | null;
}

export interface CardsPayload {
  items: HomeCard[];
}

/** `GET /api/app/p/:id/live`'s `running[]` - a live session in flight.
 * `lib/api.ts`'s own `Live.running` is deliberately `unknown[]` (it belongs
 * to no one surface), so this is where the shape actually gets read. */
export interface HomeLiveRun {
  adw_id: string;
  title: string | null;
  adw_name: string | null;
  started_at: string | null;
  phase: { name: string | null } | null;
  model: string | null;
  coding_agent: string | null;
}

/** `GET /api/app/p/:id/runs` - only a failed run needs anything from here;
 * everything in flight is read from `live` instead (see Home.tsx). A project
 * with no factory installed 200s `{factory:"absent"}` (scoped.ts), which has
 * no `runs` key - `runs` is optional here for exactly that reason, never
 * because the server might omit it on a normal read. */
export interface HomeSession {
  adw_id: string;
  adw_name: string | null;
  title: string | null;
  status: "running" | "success" | "fail" | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface RunsPayload {
  runs?: HomeSession[];
  /**
   * Present only on the `{factory:"absent"}` shape, which `scoped.ts` answers
   * from ONE fact: this checkout has no `adws/adw_data/sssf.db`.
   *
   * That is emphatically NOT "this folder has no factory in it". A project can
   * be fully installed - `adws/`, the roster, the queue seam, the config - and
   * still have no db, because only a RUN writes one, and on this operator's
   * setup the runs happen on a VPS. Home used to gate its "No factory here"
   * banner on this field, which is why that banner rendered directly above its
   * own checklist reading "Factory initialized: yes". It gates on `/readiness`
   * now - the checklist's own source. This field is left declared because the
   * shape still arrives; nothing on Home reads it any more.
   */
  factory?: "present" | "absent";
}

/**
 * `GET /api/app/projects/:id/readiness` - the two facts the "No factory here"
 * banner and the Initialize-factory checklist inside it BOTH now read, so the
 * two can no longer contradict each other. `factory.config` is the whole
 * question "is a factory installed in this folder" (it is the file the
 * installer stamps, and the file `InitializeFactory` treats as done).
 */
export interface ReadinessPayload {
  git: { is_repo: boolean; branch: string | null };
  factory: { config: boolean; adws: boolean; db: boolean };
}
