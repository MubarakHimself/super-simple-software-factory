/**
 * The beat rail (spec 2.5.2): five beats - Plan · Build · Test · Review ·
 * Document - and the one rule that matters more than any of them:
 *
 *   "A run with no beat-bearing phase renders no beat rail at all - not five
 *    empty circles. On the only db that exists today that is *every* run
 *    (24 of 24 phases are `Mubarak` or `scout`), and five ○ would be
 *    structure the factory never recorded, which is the mock-data ban applied
 *    to shape instead of to numbers."
 *
 * So this component returns `null` unless at least one phase came back with a
 * non-null `beat`. The mapping itself is server-side (one fixed owner table);
 * this file never guesses a beat from a phase name, because a phase called
 * `build` owned by `git` is not the Build beat.
 *
 * Liveness is `ended_at IS NULL`, never `phases.status` - the DDL default for
 * that column is `"fail"` (spec's rule-11 trap, stated so nobody "fixes" it).
 */
import type { PhaseWithBeat } from "./types.ts";

const BEATS = ["Plan", "Build", "Test", "Review", "Document"] as const;

type BeatState = "done" | "running" | "failed" | "pending";

interface BeatCell {
  beat: string;
  state: BeatState;
  /** `2/3` when the phase was retried - retries collapse into their beat. */
  attempt: string | null;
}

function stateOf(phases: PhaseWithBeat[]): BeatState {
  if (phases.length === 0) return "pending";
  if (phases.some((p) => p.started_at && !p.ended_at)) return "running";
  if (phases.some((p) => p.ended_at && p.status === "fail")) return "failed";
  if (phases.some((p) => p.ended_at)) return "done";
  return "pending";
}

function attemptOf(phases: PhaseWithBeat[]): string | null {
  const retried = phases.find((p) => (p.retries ?? 0) > 0);
  if (!retried) return null;
  return `${(retried.attempt ?? 0) + 1}/${(retried.retries ?? 0) + 1}`;
}

export function buildBeats(phases: PhaseWithBeat[]): BeatCell[] | null {
  if (!phases.some((p) => p.beat)) return null;
  return BEATS.map((beat) => {
    const own = phases.filter((p) => p.beat === beat);
    return { beat, state: stateOf(own), attempt: attemptOf(own) };
  });
}

const MARK: Record<BeatState, { glyph: string; className: string }> = {
  done: { glyph: "✓", className: "text-ok" },
  running: { glyph: "●", className: "text-accent" },
  failed: { glyph: "✕", className: "text-fail" },
  pending: { glyph: "○", className: "text-t3" },
};

/**
 * The cells only. The run view owns the strip they sit in, because on a
 * narrow window that same strip carries the Diff toggle - and a run with no
 * beats must still not contribute one pixel of beat rail (`buildBeats`
 * returning null is what the caller checks).
 */
export function BeatCells({ beats }: { beats: BeatCell[] }) {
  return (
    <>
      {beats.map((cell) => (
        <span key={cell.beat} className="flex items-center gap-[6px] text-meta">
          <span aria-hidden="true" className={`${MARK[cell.state].className} leading-none`}>
            {MARK[cell.state].glyph}
          </span>
          <span className={cell.state === "pending" ? "text-t3" : "text-t2"}>{cell.beat}</span>
          {cell.attempt ? <span className="font-mono text-t3">{cell.attempt}</span> : null}
        </span>
      ))}
    </>
  );
}
