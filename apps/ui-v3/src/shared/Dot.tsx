/**
 * The status dot. Status is always dot + word, never a bare colour
 * (colour-blind safety, and v1's standing rule: never render a bare enum) - so
 * this component renders ONLY the dot and every caller puts a word beside it.
 * There is deliberately no prop here that draws a label: a bare `<Dot/>` in a
 * review is then a visible defect rather than an invisible one.
 *
 * Tones are the mocks' status colours: run (#6ba4e8), ok (#6dbb6e), fail
 * (#e06464), warn (#d9a441), neutral (#7d7568), accent, and idle (a hollow
 * ring for "nothing is claimed here").
 */
export type Tone = "run" | "ok" | "fail" | "warn" | "neutral" | "accent" | "idle";

export function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return <span aria-hidden="true" className={`dot ${tone}${pulse ? " pulse" : ""}`} />;
}
