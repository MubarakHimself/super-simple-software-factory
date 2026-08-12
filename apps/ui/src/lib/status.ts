import type { Phase, ProcessRow, Session } from "@shared/types";
import { elapsedLabel, toMs } from "./format";

/** phases.status defaults to "fail" in the DDL but a live phase has
 * ended_at NULL - derive liveness from that, never from the string alone
 * (spec 3, trap #1). */
export function phaseIsRunning(phase: Phase): boolean {
  return phase.started_at !== null && phase.ended_at === null;
}

export function phaseDisplayStatus(phase: Phase): "running" | "success" | "fail" | "queued" {
  if (phase.started_at === null) return "queued";
  if (phaseIsRunning(phase)) return "running";
  return phase.status === "success" ? "success" : "fail";
}

export type DotColor = "running" | "success" | "fail" | "warning" | "dim";

export function sessionDotColor(status: string | null, stalled: boolean): DotColor {
  if (stalled) return "warning";
  if (status === "running") return "running";
  if (status === "success") return "success";
  if (status === "fail") return "fail";
  return "dim";
}

const STALL_MS = 5 * 60 * 1000;

export interface StatusTripleResult {
  dot: DotColor;
  label: string;
  sentence: string;
}

/** Pull an "exited N" style code out of a phase error string, so the
 * sentence can say what actually happened instead of a generic verb. */
function exitPhrase(error: string | null): string | null {
  if (!error) return null;
  const m = /exited (-?\d+)/.exec(error);
  return m ? `exited ${m[1]}` : null;
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The run-header status triple (spec 5.2 L2 #1 and 7's "status triple"
 * pattern): dot + bold identifier + one plain sentence, never a bare enum.
 *
 * `latestEventAt` is optional - the sidebar (L1) does not carry full event
 * history per row, so stall detection only activates where it's known (the
 * L2 run header, which has already loaded the event tail).
 */
export function buildStatusTriple(
  session: Session,
  phases: Phase[],
  processes: ProcessRow[],
  now: number,
  latestEventAt?: string | null,
): StatusTripleResult {
  const aliveProcesses = processes.filter((p) => p.ended_at === null).length;

  if (session.status === "running") {
    const lastEventMs = latestEventAt !== undefined ? toMs(latestEventAt) : null;
    const stalled =
      latestEventAt !== undefined && lastEventMs !== null && now - lastEventMs > STALL_MS && aliveProcesses === 0;

    if (stalled) {
      const lastPhase = [...phases].reverse().find((p) => p.started_at !== null);
      const idleFor = elapsedLabel(now - (lastEventMs as number));
      return {
        dot: "warning",
        label: "Stalled",
        sentence: `no events for ${idleFor}, no live process. Last phase: ${lastPhase?.name ?? "unknown"}.`,
      };
    }

    const current = [...phases].reverse().find((p) => p.started_at !== null) ?? null;
    const startedMs = toMs(session.started_at) ?? now;
    const elapsed = elapsedLabel(now - startedMs);
    const phaseLabel = current
      ? `phase ${current.seq !== null ? String(current.seq).padStart(2, "0") : "??"} ${current.name ?? "?"}`
      : "starting";
    return {
      dot: "running",
      label: "Running",
      sentence: `${phaseLabel}, ${elapsed} elapsed, ${pluralize(aliveProcesses, "process")} alive`,
    };
  }

  if (session.status === "fail") {
    const failed = [...phases].reverse().find((p) => phaseDisplayStatus(p) === "fail") ?? null;
    if (failed) {
      const startedMs = toMs(failed.started_at) ?? toMs(session.started_at) ?? now;
      const endedMs = toMs(failed.ended_at) ?? now;
      const dur = elapsedLabel(endedMs - startedMs);
      const exit = exitPhrase(failed.error);
      const verb = exit ? exit : "failed";
      return {
        dot: "fail",
        label: "Failed",
        sentence: `${failed.name ?? "phase"} phase ${verb} after ${dur}, ${pluralize(
          Math.max(failed.attempt ?? 0, 1),
          "attempt",
        )}`,
      };
    }
    return { dot: "fail", label: "Failed", sentence: "run failed" };
  }

  // success
  const startedMs = toMs(session.started_at) ?? now;
  const endedMs = toMs(session.ended_at) ?? now;
  const dur = elapsedLabel(endedMs - startedMs);
  return {
    dot: "success",
    label: "Success",
    sentence: `${pluralize(phases.length, "phase")}, worked ${dur}`,
  };
}
