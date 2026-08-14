/**
 * A ticking duration that never commits React (spec 2.5 / T3 section 5.7:
 * "Elapsed ticks by writing textContent from one shared 1s interval - no React
 * commit. Rows never reflow.").
 *
 * One interval for the whole app, not one per row: a list of forty running
 * rows costs one timer and forty textContent writes per second.
 */
import { useEffect, useRef } from "react";
import { clock, msSince, span } from "../lib/format.ts";

type Tick = () => void;

const subscribers = new Set<Tick>();
let timer: number | undefined;

function subscribe(tick: Tick): () => void {
  subscribers.add(tick);
  if (timer === undefined) {
    timer = window.setInterval(() => {
      for (const fn of subscribers) fn();
    }, 1000);
  }
  return () => {
    subscribers.delete(tick);
    if (subscribers.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

export function Elapsed({
  since,
  until = null,
  format = "clock",
  className = "",
}: {
  /** ISO timestamp the clock starts from. */
  since: string;
  /** ISO timestamp it froze at; while null the value ticks. */
  until?: string | null;
  format?: "clock" | "span";
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const render = format === "clock" ? clock : span;
    const write = () => {
      if (ref.current) ref.current.textContent = render(msSince(since, until));
    };
    write();
    if (until) return; // frozen: one write, no subscription
    return subscribe(write);
  }, [since, until, format]);

  return <span ref={ref} className={`font-mono text-mono tabular-nums ${className}`} />;
}
