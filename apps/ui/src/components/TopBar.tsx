import { RefreshCw } from "lucide-react";
import type { LiveState } from "@/lib/poll";
import { navigate, settingsPath } from "@/routes";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const LIVE_LABEL: Record<LiveState, string> = { live: "Live", paused: "Paused", stale: "Stale" };
const LIVE_CLASS: Record<LiveState, string> = {
  live: "text-[var(--color-success)]",
  paused: "text-muted-foreground",
  stale: "text-[var(--color-warning)]",
};

function agoLabel(lastUpdatedAt: number | null, now: number): string {
  if (lastUpdatedAt === null) return "never";
  const s = Math.max(0, Math.round((now - lastUpdatedAt) / 1000));
  if (s < 1) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

/** Persistent 28px top bar - wordmark, breadcrumb, live/paused/stale +
 * refresh (T3's "Checked 1m ago" idiom), db path chip (spec 5.1). */
export function TopBar({
  breadcrumb,
  live,
  lastUpdatedAt,
  now,
  dbPath,
  onRefresh,
}: {
  breadcrumb: string[];
  live: LiveState;
  lastUpdatedAt: number | null;
  now: number;
  dbPath: string | null;
  onRefresh: () => void;
}) {
  return (
    <header className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-chrome px-3 text-[11px]">
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        <span className="shrink-0 font-bold tracking-wide text-foreground">SDL FACTORY</span>
        {breadcrumb.length > 0 && (
          <span className="truncate text-muted-foreground">
            {breadcrumb.map((part, i) => (
              <span key={i}>
                {i > 0 && <span className="mx-1 text-[var(--color-text-meta)]">/</span>}
                {part}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={onRefresh}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <span className={cn("font-medium", LIVE_CLASS[live])}>{LIVE_LABEL[live]}</span>
          <span className="text-[var(--color-text-meta)]">. updated {agoLabel(lastUpdatedAt, now)}</span>
          <RefreshCw className="size-3" strokeWidth={1.75} />
        </button>
        {dbPath && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => navigate(settingsPath)}
                className="mono rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                db
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="mono max-w-[420px] break-all">
              {dbPath}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
