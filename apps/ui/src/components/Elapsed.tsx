import { useEffect, useState } from "react";
import { elapsedLabel, toMs } from "@/lib/format";

/**
 * One component, two tenses, same row position (spec 7): running ticks with
 * an animated ellipsis, ended freezes into a summary. No progress bar, no
 * percent, ever - nothing in the system knows how far along a run is.
 */
export function Elapsed({
  startedAt,
  endedAt,
  chevron,
  className,
}: {
  startedAt: string | null;
  endedAt: string | null;
  /** Rendered after the frozen "Worked for" label, e.g. a `>` collapse toggle. */
  chevron?: React.ReactNode;
  className?: string;
}) {
  const startMs = toMs(startedAt);
  const endMs = toMs(endedAt);
  const running = startMs !== null && endMs === null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  if (startMs === null) return null;

  if (running) {
    return (
      <span className={`inline-flex items-center gap-1 text-[11px] text-muted-foreground ${className ?? ""}`}>
        <span className="animate-ellipsis">...</span>
        <span>Working for {elapsedLabel(now - startMs)}</span>
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1 text-[11px] text-muted-foreground ${className ?? ""}`}>
      <span>
        Worked for {elapsedLabel((endMs as number) - startMs)}
        {chevron}
      </span>
    </span>
  );
}
