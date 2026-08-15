/**
 * The status triple, from the design system's own note in the mock packet's
 * index: **dot + bold id + plain sentence (never bare enums)**.
 *
 * Every status row in v3 is this component, so the app cannot grow three
 * idioms for the same fact. `sentence` is optional because some triples
 * honestly have nothing more to say; it is never padded to make a column line
 * up.
 */
import { Dot, type Tone } from "./Dot.tsx";

export function StatusTriple({
  tone,
  identifier,
  sentence,
  pulse = false,
  mono = false,
}: {
  tone: Tone;
  /** The thing being described: an adw id, a lane, a provider, a card. */
  identifier: string;
  /** One plain sentence about it. Never an enum, never a code. */
  sentence?: string | null;
  pulse?: boolean;
  /** Ids that are data (adw-0473, a sha, a branch) set this. */
  mono?: boolean;
}) {
  return (
    <div className="status-triple">
      <span className="st-dot">
        <Dot tone={tone} pulse={pulse} />
      </span>
      <span className={`st-id${mono ? " mono" : ""}`}>{identifier}</span>
      {sentence ? <span className="st-sentence">{sentence}</span> : null}
    </div>
  );
}
