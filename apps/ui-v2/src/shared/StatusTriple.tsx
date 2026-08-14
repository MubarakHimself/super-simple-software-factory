/**
 * StatusTriple (spec 3.6): `dot - bold identifier - one plain sentence`.
 * Carried from v1. Providers, machine probes, stall lines and read-failure
 * rows are all this component, so they cannot drift into three idioms.
 *
 * `sentence` is optional because some triples honestly have nothing to say;
 * it is never padded with an em-dash to make the column line up (spec's
 * "absent when null" rule applied to layout).
 */
import { Dot, type Tone } from "./Dot.tsx";

export function StatusTriple({
  tone,
  identifier,
  sentence,
  mono = false,
}: {
  tone: Tone;
  identifier: string;
  sentence?: string | null;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-body">
      <span className="translate-y-[-2px]">
        <Dot tone={tone} />
      </span>
      <span className={`shrink-0 font-semibold text-t1 ${mono ? "font-mono text-mono" : ""}`}>{identifier}</span>
      {sentence ? <span className="min-w-0 truncate text-t2">{sentence}</span> : null}
    </div>
  );
}
