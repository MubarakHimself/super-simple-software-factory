import { useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import type { SessionSummary } from "@shared/types";
import { relativeTime, truncate } from "@/lib/format";
import { sessionDotColor } from "@/lib/status";
import { navigate, tracePath } from "@/routes";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/StatusTriple";

/** Trace L1: one row per session, chips only for running/failed so the eye
 * finds what needs attention; two concurrent "Running" rows read as
 * concurrency with zero extra chrome (spec 5.2, 7's "sidebar-as-run-board"). */
export function RunList({
  sessions,
  selectedId,
  now,
  filter,
}: {
  sessions: SessionSummary[];
  selectedId: string | null;
  now: number;
  filter: string;
}) {
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? sessions.filter(
        (s) =>
          s.adw_id.toLowerCase().includes(q) ||
          (s.title ?? "").toLowerCase().includes(q) ||
          (s.request ?? "").toLowerCase().includes(q),
      )
    : sessions;

  if (filtered.length === 0) {
    return <div className="p-3 text-[11px] text-muted-foreground">no matching sessions</div>;
  }

  return (
    <div className="flex flex-col">
      {filtered.map((s) => (
        <RunRow key={s.adw_id} session={s} selected={s.adw_id === selectedId} now={now} />
      ))}
    </div>
  );
}

function RunRow({ session, selected, now }: { session: SessionSummary; selected: boolean; now: number }) {
  const [hover, setHover] = useState(false);
  const dot = sessionDotColor(session.status, false);
  const showChip = session.status === "running" || session.status === "fail";
  const chipLabel = session.status === "running" ? "Running" : session.status === "fail" ? "Failed" : "";
  const chipClass =
    session.status === "running" ? "text-[var(--color-running)]" : "text-[var(--color-fail)]";

  return (
    <button
      type="button"
      onClick={() => navigate(tracePath(session.adw_id))}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-selected={selected || undefined}
      className={cn(
        "group flex w-full flex-col gap-0 border-l-2 border-transparent px-2 py-1 text-left transition-colors",
        "hover:bg-elevated-hover",
        selected && "border-primary bg-elevated-hover",
      )}
    >
      <div className="flex h-[22px] items-center gap-1.5">
        <StatusDot color={dot} />
        {/* Title first, id small/dim - "an id tells me nothing, I want to
         * know which worktree ran which ticket". Falls back to the raw
         * request for a run with no title (adw_prompt/adw_scout/adw_quality
         * never cut a branch, so never stamp one). */}
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
          {session.title || truncate(session.request, 60) || "(no request captured)"}
        </span>
        {showChip && <span className={cn("shrink-0 text-[10px] font-semibold", chipClass)}>{chipLabel}</span>}
        <span className="mono shrink-0 text-[10px] text-[var(--color-text-meta)]">{session.adw_id}</span>
        {!hover ? (
          <span className="shrink-0 text-[10px] text-[var(--color-text-meta)]">
            {relativeTime(session.started_at, now)}
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1">
            <RowAction
              icon={Copy}
              label="copy id"
              onClick={(e) => {
                e.stopPropagation();
                void navigator.clipboard.writeText(session.adw_id);
              }}
            />
            <RowAction
              icon={ExternalLink}
              label="open trace"
              onClick={(e) => {
                e.stopPropagation();
                navigate(tracePath(session.adw_id));
              }}
            />
          </span>
        )}
      </div>
      <div className="truncate pl-[15px] text-[10.5px] text-[var(--color-text-meta)]">
        {session.adw_name ?? "adw"} . {session.engineer ?? "unknown"} . {session.phases.length} phase
        {session.phases.length === 1 ? "" : "s"}
        {session.agents.length > 0 ? ` . ${session.agents.map((a) => a.agent).join(", ")}` : ""}
      </div>
    </button>
  );
}

function RowAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <span
      role="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
    >
      <Icon className="size-3" strokeWidth={1.75} />
    </span>
  );
}
