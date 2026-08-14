/**
 * The third state (spec 2.5.6): "three states, never two - running / stalled
 * / ended."
 *
 * ── Where the threshold comes from, and why it is fetched rather than typed ──
 * The spec is explicit that stale is defined once: "older than
 * `stale_after_minutes` (the same config key `_guard_live_rejoin` reads - one
 * definition of stale, not two)". No `/api/app/*` endpoint returns that key
 * today - `/config` carries roster/defaults/lanes/observability/paths, and
 * `/worktrees` consumes the key server-side without echoing it (noted to the
 * night's build as a cross-chunk gap). So this module reads the project's own
 * `sssf.config.yaml` through the path-confined file reader and pulls the one
 * line out of it.
 *
 * A hard-coded 30 was the alternative and is rejected on purpose: it equals
 * the shipped default today and silently stops equalling it the moment the
 * operator edits his config - which is exactly the two-definitions-of-stale
 * failure the spec names. When the key cannot be read, this returns null and
 * **no stall line renders at all**: absence, not a guessed threshold.
 */
import { apiGet } from "../lib/api.ts";
import type { ProcessRow, Run, WorkLogEntry } from "./types.ts";
import { lastPhase, openPhase, type Phase } from "./types.ts";

const CONFIG_PATH = "adws/adw_sssf_config/sssf.config.yaml";

/** `worktrees:` block -> `stale_after_minutes:`. One indented key under one
 * top-level key; a two-line scan is honest about a two-line question and
 * costs no yaml parser in the browser bundle. */
export function parseStaleAfterMinutes(yamlText: string): number | null {
  const lines = yamlText.split(/\r?\n/);
  let inWorktrees = false;
  for (const line of lines) {
    if (/^\S/.test(line)) inWorktrees = /^worktrees\s*:/.test(line);
    if (!inWorktrees) continue;
    const match = /^\s+stale_after_minutes\s*:\s*([0-9]+)/.exec(line);
    if (match) {
      const value = Number.parseInt(match[1]!, 10);
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

const cache = new Map<string, number | null>();

/** Per project, read once per page load. The factory is frozen; its config
 * does not move under a session. */
export async function staleAfterMinutes(projectId: string): Promise<number | null> {
  if (cache.has(projectId)) return cache.get(projectId) ?? null;
  let value: number | null = null;
  try {
    const file = await apiGet<{ text: string }>(
      `/api/app/p/${encodeURIComponent(projectId)}/docs/file?path=${encodeURIComponent(CONFIG_PATH)}`,
    );
    value = parseStaleAfterMinutes(file.text);
  } catch {
    // No config, no factory, or the reader is not mounted yet - all of them
    // mean the same thing here: this app does not know what stale means for
    // this project, so it says nothing about staleness.
    value = null;
  }
  cache.set(projectId, value);
  return value;
}

// -- the three states -------------------------------------------------------

export type StallKind = "running" | "stalled" | "stopped";

export interface Stall {
  kind: StallKind;
  /** Whole minutes since the newest recorded event. */
  silentMinutes: number;
  /** `build` - the phase the run was inside when it went quiet. */
  lastStep: string | null;
  /** Timestamps only, never a probe: the pid the factory recorded and when
   * its row was closed (spec 2.5.6's Windows landmine). */
  pid: number | null;
  pidEndedAt: string | null;
}

function minutesSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((now - then) / 60_000);
}

/** The newest thing this run recorded: its last event, else its last phase
 * boundary, else its own start. */
function latestSignal(entries: WorkLogEntry[], phases: Phase[], run: Run): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.started_at) return entries[i]!.started_at;
  }
  for (let i = phases.length - 1; i >= 0; i--) {
    const p = phases[i]!;
    if (p.ended_at) return p.ended_at;
    if (p.started_at) return p.started_at;
  }
  return run.started_at;
}

/**
 * Returns null for a run that ended (the ordinary case - an ended run has no
 * stall state) and for a running run that is still talking, and for every run
 * when the threshold is unknown.
 *
 * `stopped` is the dead-without-phase_end shape: the run never recorded an
 * end, and every process row the factory opened for it is closed. That is a
 * timestamp comparison, not a liveness probe.
 */
export function deriveStall(
  run: Run,
  phases: Phase[],
  processes: ProcessRow[],
  entries: WorkLogEntry[],
  thresholdMinutes: number | null,
  now: number = Date.now(),
): Stall | null {
  if (run.ended_at) return null;
  if (thresholdMinutes === null) return null;

  const silent = minutesSince(latestSignal(entries, phases, run), now);
  if (silent === null || silent <= thresholdMinutes) return null;

  const open = openPhase(phases);
  const lastStep = open?.name ?? lastPhase(phases)?.name ?? null;

  const closed = processes.filter((p) => p.ended_at !== null);
  const believedAlive = processes.length - closed.length;
  const newestClosed = closed.reduce<ProcessRow | null>(
    (best, p) => (best === null || (p.ended_at ?? "") > (best.ended_at ?? "") ? p : best),
    null,
  );

  if (processes.length > 0 && believedAlive === 0) {
    return {
      kind: "stopped",
      silentMinutes: silent,
      lastStep,
      pid: newestClosed?.pid ?? null,
      pidEndedAt: newestClosed?.ended_at ?? null,
    };
  }

  return { kind: "stalled", silentMinutes: silent, lastStep, pid: null, pidEndedAt: null };
}

/** `41m`, `2h 05m` - the silence, in the shortest honest form. */
export function silence(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
