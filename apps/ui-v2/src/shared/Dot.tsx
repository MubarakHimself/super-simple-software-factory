/**
 * The status dot. Spec 3.2: "Status is always dot + word, never a bare color
 * (color-blind safety + v1's 'never render a bare enum')" - so this component
 * renders ONLY the dot and every caller puts a word beside it. There is no
 * prop here that draws a label, deliberately: a bare `<Dot/>` in a review is a
 * visible defect rather than an invisible one.
 */
export type Tone = "run" | "ok" | "fail" | "warn" | "neutral" | "accent" | "idle";

const FILL: Record<Tone, string> = {
  run: "bg-run",
  ok: "bg-ok",
  fail: "bg-fail",
  warn: "bg-warn",
  neutral: "bg-neutral",
  accent: "bg-accent",
  idle: "bg-transparent border border-t3",
};

export function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-[6px] shrink-0 rounded-full ${FILL[tone]} ${pulse ? "sdl-pulse" : ""}`}
    />
  );
}
