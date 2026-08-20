/**
 * The shapes Runs reads, declared here because a surface owns its own types
 * (lib/api.ts holds only what the shell itself fetches). Every field below is
 * named exactly as the server names it - these are transcriptions of
 * `apps/ui/shared/types.ts` and `apps/ui/server/app/{live,worklog,cards,ship}.ts`,
 * narrowed to what this surface actually renders. A field this file does not
 * declare is a field this surface does not paint.
 *
 * Endpoints, all under `/api/app/p/:id/`:
 *   runs                     -> RunsResponse       (the left column)
 *   runs/:adw_id             -> RunDetail          (header, beat rail)
 *   runs/:adw_id/worklog     -> WorkLogPage        (running / cooldown / failed)
 *   runs/:adw_id/diff        -> DiffResponse       (the file list)
 *   cards                    -> CardsResponse      (state, Blocked-reason)
 *   ship/report[?range=A..B] -> ShipReport         (the merge queue + the walk)
 *   ship            (POST)   -> ShipResult         (the one squash on main)
 */

/* ── the answer a project without a factory gives ───────────────────────── */

/**
 * Every db-backed read on this surface (`runs`, `runs/:adw_id`, `worklog`,
 * `diff`) answers **200 `{"factory":"absent"}`** - not an error - for a project
 * whose `sssf.db` does not exist yet (`server/app/scoped.ts`'s
 * `factoryAbsent()`). It is a first-class state: nothing failed, there is
 * simply no factory record here. Read as a normal response it would look like
 * an empty run list, which is a different (and untrue) sentence - so every
 * read of these four endpoints is typed as this union and narrowed by
 * `isFactoryAbsent` in model.ts.
 */
export interface FactoryAbsent {
  factory: "absent";
}

/* ── runs ───────────────────────────────────────────────────────────────── */

export type SessionStatus = "running" | "success" | "fail";
export type PhaseStatus = "queued" | "running" | "success" | "fail";

export interface RunPhase {
  phase_id: string;
  seq: number | null;
  name: string | null;
  kind: string | null;
  owner: string | null;
  description: string | null;
  status: PhaseStatus | null;
  attempt: number | null;
  retries: number | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** only on `runs/:adw_id`: the fixed beat table's name for this phase's
   * owner (Plan/Build/Test/Review/Document), null for every other owner */
  beat?: string | null;
}

export interface RunAgent {
  agent: string;
  coding_agent: string | null;
  /** `provider/model` - the provider half IS the lane (one account, one pool) */
  model: string | null;
  color: string | null;
}

export interface RunSummary {
  adw_id: string;
  adw_name: string | null;
  request: string | null;
  status: SessionStatus | null;
  engineer: string | null;
  started_at: string | null;
  ended_at: string | null;
  total_tokens: number | null;
  total_cost: number | null;
  phases: RunPhase[];
  agents: RunAgent[];
  /** the run's human name, stamped at worktree entry; null when it never cut
   * a branch - never invented, so the row falls back to the adw id */
  title: string | null;
  /** the machine this row was read from ("on 155.133.27.86"), set only on runs
   * the server fetched off a registered machine. `model.ts:machineOf` has
   * always read this field defensively; the server now fills it, which is why
   * the muted chip appears with no other change here. */
  machine?: string | null;
}

/**
 * Where the rows came from (`shared/types.ts:RunsSource`). `origin: "local"` is
 * this checkout's own sssf.db and says nothing more. `origin: "machine"` means
 * the server read a registered machine over SSH, and `reason` is then always
 * one plain sentence naming the host - including when there is nothing to show,
 * so "no runs" is never a blank shrug.
 */
export interface RunsSource {
  origin: "local" | "machine";
  host: string | null;
  repo_dir: string | null;
  reachable: boolean | null;
  reason: string | null;
}

export interface RunsResponse {
  runs: RunSummary[];
  /** `adw_prompt` self-checks the list hides; said out loud rather than
   * silently dropped, so an empty list is never a mystery */
  hidden_self_checks: number;
  /** optional only for a server that predates it - every shipped one sends it */
  source?: RunsSource;
}

export interface RunDetail {
  session: Omit<RunSummary, "phases" | "agents" | "title">;
  phases: RunPhase[];
  agents: RunAgent[];
  branch: string | null;
  title: string | null;
}

/* ── work log ───────────────────────────────────────────────────────────── */

export type WorkLogKind = "tool" | "commit" | "log" | "handoff" | "error" | "gate";

export interface WorkLogEntry {
  rowid: number;
  kind: WorkLogKind;
  phase_id: string | null;
  agent: string | null;
  agent_color: string | null;
  indent: boolean;
  started_at: string | null;
  heading?: string;
  preview?: string | null;
  status?: "ok" | "fail" | "neutral";
  sha?: string;
  message?: string;
  file_count?: number | null;
  text?: string;
  level?: string | null;
  summary?: string;
  artifacts?: string[];
  detail?: string;
  gate?: string | null;
  passed?: boolean | null;
}

export interface WorkLogPage {
  entries: WorkLogEntry[];
  cursor: number;
  has_more: boolean;
}

/* ── diff ───────────────────────────────────────────────────────────────── */

export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
}

export interface DiffResponse {
  base: string;
  files: DiffFile[];
  added: number;
  deleted: number;
  truncated: boolean;
  empty: boolean;
}

/* ── cards ──────────────────────────────────────────────────────────────── */

export type CardState = "ready" | "running" | "blocked" | "done" | "integrated" | "shipped" | "unknown";

export interface CardItem {
  path: string;
  name: string;
  title: string;
  state: CardState;
  /** the plain sentence behind `state` - always set, always the server's own
   * words, which is why no view here writes a sentence of its own for it */
  state_reason: string;
  parked: boolean;
  adw_id: string | null;
  feature: string | null;
  blocked_reason: string | null;
  needs: string[];
  waiting_on: string[];
  criteria_done: number;
  criteria_total: number;
}

export interface CardsResponse {
  dir: string;
  done_dir: string;
  items: CardItem[];
  shipped_source: "git-tree" | "unavailable";
  shipped_reason: string | null;
  main_ref: string;
}

/* ── ship (the merge queue) ─────────────────────────────────────────────── */

export interface ShipCriterion {
  text: string;
  /** the box `render_pr` printed, which is the VERDICT (`- [x]` = confirmed),
   * not the card's own checkbox - the card's checkbox is stated inside
   * `evidence`. Restating this as the card's tick contradicts that line, so no
   * view here does (see Acceptance.tsx). */
  checked: boolean;
  verdict: "confirmed-by-record" | "cannot-confirm-from-record";
  evidence: string;
}

export interface ShipCard {
  /** `003-slug.md` - what `POST /ship`'s `cut` takes */
  name: string;
  title: string;
  /** the park commit: THIS is the cut point */
  sha: string | null;
  date: string | null;
  detected_by: "commit-message" | "diff" | null;
  branch: string | null;
  files_changed: number | null;
  insertions: number | null;
  deletions: number | null;
  diff_note: string | null;
  criteria: ShipCriterion[];
  gap: string | null;
}

export interface ShipReport {
  /** the report verbatim - it IS the squash body, so it is never edited here */
  markdown: string;
  /** integration order, oldest first (ship_report.py sorts by park date) */
  cards: ShipCard[];
  commit_count: number;
  empty: boolean;
  range: string | null;
  base: string | null;
  tip: string | null;
  gaps: string[];
  available: boolean;
  /** ONE plain sentence when `available` is false (server/app/ship.ts's
   * `refusalFrom`), never the script's raw stderr. */
  reason: string | null;
  /** the script's full text when `reason` summarizes it - the tooltip. */
  detail: string | null;
  /** no `integration` branch here: the factory has never run in this project.
   * A quiet empty state, not a failure. */
  not_started: boolean;
  generated_at: string;
}

export interface ShipResult {
  shipped: true;
  cut: string;
  cut_sha: string;
  range: string;
  cards: string[];
  commit: string;
  message_file: string;
  integration_ref: string;
  fetched: boolean;
  fetch_note: string | null;
  pushed: boolean;
  push_error: string | null;
  remote: string | null;
  previous_branch: string;
  restored_branch: boolean;
  restore_error: string | null;
}
