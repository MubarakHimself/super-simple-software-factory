import type { Phase } from "@shared/types";
import { phaseDisplayStatus } from "@/lib/status";
import { cn } from "@/lib/utils";

const DOT_BG: Record<string, string> = {
  running: "bg-[var(--color-running)]",
  success: "bg-[var(--color-success)]",
  fail: "bg-[var(--color-fail)]",
  queued: "bg-[var(--color-text-meta)]",
};
const TEXT_COLOR: Record<string, string> = {
  running: "text-[var(--color-running)]",
  success: "text-foreground",
  fail: "text-[var(--color-fail)]",
  queued: "text-muted-foreground",
};

/** T3's STEP stepper doing an honest job (spec 7): a horizontal strip of
 * "NN name" chips, colored by status, the current one ringed. Click scrolls
 * the log and loads the inspector. */
export function PhaseTimeline({
  phases,
  activePhaseId,
  onSelect,
}: {
  phases: Phase[];
  activePhaseId: string | null;
  onSelect: (phaseId: string) => void;
}) {
  if (phases.length === 0) return null;
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-chrome px-3 py-1.5">
      {phases.map((phase) => {
        const status = phaseDisplayStatus(phase);
        const active = phase.phase_id === activePhaseId;
        return (
          <button
            key={phase.phase_id}
            type="button"
            onClick={() => onSelect(phase.phase_id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px] transition-colors",
              active ? "border-primary" : "border-transparent hover:border-border",
            )}
          >
            <span className={cn("inline-block size-1.5 rounded-full", DOT_BG[status])} />
            <span className="mono text-muted-foreground">{phase.seq !== null ? String(phase.seq).padStart(2, "0") : "??"}</span>
            <span className={cn("font-medium", TEXT_COLOR[status])}>{phase.name ?? phase.phase_id}</span>
          </button>
        );
      })}
    </div>
  );
}
