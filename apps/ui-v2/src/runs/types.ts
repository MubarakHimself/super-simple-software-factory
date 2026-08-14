/**
 * The shapes the Runs surface reads, plus the handful of pure derivations
 * every file in this directory shares.
 *
 * `lib/api.ts` deliberately carries only the shell's own types ("surfaces own
 * their own types"), so these mirror the server modules this surface reads -
 * `server/app/live.ts`, `server/app/worklog.ts`, `server/app/worktrees.ts` -
 * field for field. Nothing here is wider than what the server actually sends:
 * a field that is nullable in `sssf.db` is nullable here, because the whole
 * point of this surface is that a null renders as absence, never as `-`.
 */
import { clip } from "../lib/format.ts";

// -- sssf.db mirror (the subset Runs reads) --------------------------------

export type RunStatus = "running" | "success" | "fail";

export interface Phase {
  phase_id: string;
  adw_id: string;
  seq: number | null;
  name: string | null;
  kind: string | null;
  owner: string | null;
  description: string | null;
  /** The DDL default is `"fail"` - liveness is `ended_at IS NULL`, never
   * this string (spec 2.5.2's rule-11 trap, restated so nobody "fixes" it). */
  status: string | null;
  attempt: number | null;
  retries: number | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

/** `/runs/:adw_id` adds this to every phase: the beat this phase contributes,
 * or null. Derived server-side from ONE fixed owner table (spec 2.5.2). */
export interface PhaseWithBeat extends Phase {
  beat: string | null;
}

export interface AgentSession {
  adw_id: string;
  agent: string;
  coding_agent: string | null;
  model: string | null;
  color: string | null;
  session_id: string | null;
  context_tokens: number | null;
  context_window: number | null;
  created_at: string | null;
  last_used_at: string | null;
}

export interface ProcessRow {
  id: number;
  adw_id: string;
  kind: string | null;
  name: string | null;
  pid: number | null;
  command: string | null;
  started_at: string | null;
  /** NULL = believed alive. Never probed - `os.kill(pid, 0)` terminates the
   * process on Windows (spec 2.5.6's named landmine). Timestamps only. */
  ended_at: string | null;
}

export interface Run {
  adw_id: string;
  adw_name: string | null;
  request: string | null;
  status: RunStatus | null;
  engineer: string | null;
  started_at: string | null;
  ended_at: string | null;
  total_tokens: number | null;
  /** Genuinely `0.0` on every row of this box's db - a flat-rate lane. It
   * renders as `0` because that is the recorded value (spec's preamble). */
  total_cost: number | null;
  archived: number | null;
  phases: Phase[];
  agents: AgentSession[];
  /** Null on all 12 runs in this db - a run that never cut a branch has no
   * title to derive one from. Never invented. */
  title: string | null;
}

export interface RunsResponse {
  runs: Run[];
  hidden_self_checks: number;
}

/** One row of `/live`'s `running[]` - the only place a run's branch and
 * worktree path exist while it is still running (both come from the run's own
 * `branch` trace event). Runs reads the shell's poll rather than opening a
 * second one: spec 1.3 calls `/live` "the one 2s poll" and means it. */
export interface LiveRun {
  adw_id: string;
  title: string | null;
  adw_name: string | null;
  started_at: string | null;
  latest_event_at: string | null;
  latest_event_rowid: number | null;
  phase: { name: string | null; seq: number | null; owner: string | null } | null;
  model: string | null;
  coding_agent: string | null;
  branch: string | null;
  worktree_path: string | null;
  open_processes: number;
}

export interface RunDetail {
  session: Run;
  usage: { read: number; written: number };
  phases: PhaseWithBeat[];
  agents: AgentSession[];
  processes: ProcessRow[];
  branch: string | null;
  title: string | null;
}

// -- worklog ----------------------------------------------------------------

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
  args?: Record<string, unknown>;
  result_snippet?: string | null;
  duration_ms?: number | null;
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

export interface WorkLogResponse {
  entries: WorkLogEntry[];
  cursor: number;
  has_more: boolean;
}

// -- quality ----------------------------------------------------------------

/** `passed` is the trap field (false for incomplete too); this surface reads
 * `status` and never collapses a missing answer into a failure (spec 2.5.5). */
export type QualityStatus = "pass" | "fail" | "incomplete" | "unknown";

export interface QualityCheck {
  area: string | null;
  operation: string | null;
  command: string | null;
  returncode: number | null;
  status: QualityStatus;
  output_artifact: string | null;
}

// -- diff -------------------------------------------------------------------

export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
}

export interface DiffResponse {
  /** `resolveDiff`'s own base string - rendered verbatim, nothing added
   * (spec 2.5.4's honest empty: `no diff available`). */
  base: string;
  files: DiffFile[];
  added: number;
  deleted: number;
  patch: string;
  truncated: boolean;
  empty: boolean;
}

export interface DiffScope {
  id: string;
  label: string;
}

// -- worktrees --------------------------------------------------------------

/** The exact words `just worktrees` prints, copied from `worktrees.py`
 * `classify()`. The word is `alive`; `live` is not a state this factory has. */
export type WorktreeState = "alive" | "orphan" | "unmerged" | "merged" | "no-tree";

export interface WorktreeItem {
  adw_id: string;
  branch: string;
  path: string;
  state: WorktreeState;
  dirty: boolean;
  title: string;
  ahead: number;
  note: string;
}

// -- the factory-absent body every scoped route can return ------------------

export interface FactoryAbsent {
  factory: "absent";
}

export function isFactoryAbsent(body: unknown): body is FactoryAbsent {
  return typeof body === "object" && body !== null && (body as FactoryAbsent).factory === "absent";
}

// -- shared derivations -----------------------------------------------------

/**
 * What a run is called. Spec 3.7: "naming a run by `adw_id` in a primary
 * label -> title, branch, lane, in that order". `adw_id` is the last resort
 * and only because a row nobody can click is worse than a hex label; every
 * run in this db lands on `request`, which is the header's stated fallback
 * ("`sessions.request` clipped, saying nothing extra").
 */
export function runTitle(run: { title: string | null; request: string | null; adw_id: string }): {
  text: string;
  mono: boolean;
} {
  if (run.title) return { text: run.title, mono: false };
  if (run.request) return { text: clip(run.request, 90), mono: false };
  return { text: run.adw_id, mono: true };
}

/** `pi · kimi-k2.7-code` - the lane, from the agent that actually ran. The
 * newest agent row wins; a run with no agent row has no lane and renders
 * none. */
export function laneOf(agents: AgentSession[]): { coding_agent: string | null; model: string | null } {
  const agent = agents[agents.length - 1];
  return { coding_agent: agent?.coding_agent ?? null, model: agent?.model ?? null };
}

/** `41.2k` / `12,769` - tokens read the way the factory's own console prints
 * them under 10k and abbreviated above, so a fixed-height row cannot grow. */
export function tokens(n: number | null): string | null {
  if (n === null || !Number.isFinite(n)) return null;
  if (n < 10_000) return n.toLocaleString("en-US");
  return `${(n / 1000).toFixed(1)}k`;
}

/** The phase that is open right now: started, not ended. Retried phases can
 * leave more than one candidate, so the last match wins (phases arrive
 * seq-ordered) - the same rule `server/app/live.ts` applies. */
export function openPhase<T extends Phase>(phases: T[]): T | null {
  for (let i = phases.length - 1; i >= 0; i--) {
    const p = phases[i]!;
    if (p.started_at && !p.ended_at) return p;
  }
  return null;
}

/** The phase a finished-looking run last touched, for `last step: build`. */
export function lastPhase<T extends Phase>(phases: T[]): T | null {
  return phases.length > 0 ? phases[phases.length - 1]! : null;
}
