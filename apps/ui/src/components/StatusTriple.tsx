import { cn } from "@/lib/utils";
import type { DotColor } from "@/lib/status";

const DOT_CLASS: Record<DotColor, string> = {
  running: "bg-[var(--color-running)]",
  success: "bg-[var(--color-success)]",
  fail: "bg-[var(--color-fail)]",
  warning: "bg-[var(--color-warning)]",
  dim: "bg-[var(--color-text-meta)]",
};

const TEXT_CLASS: Record<DotColor, string> = {
  running: "text-[var(--color-running)]",
  success: "text-[var(--color-success)]",
  fail: "text-[var(--color-fail)]",
  warning: "text-[var(--color-warning)]",
  dim: "text-muted-foreground",
};

/**
 * Dot + bold identifier + one plain sentence - never a bare enum (spec 1.4,
 * 7). Used for run headers, phase rows, Gate cards, Settings roster/lanes.
 */
export function StatusDot({ color, className }: { color: DotColor; className?: string }) {
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_CLASS[color], className)} />;
}

export function StatusTriple({
  dot,
  label,
  sentence,
  className,
}: {
  dot: DotColor;
  label: string;
  sentence: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline gap-1.5 text-[12px]", className)}>
      <StatusDot color={dot} className="relative top-[-1px]" />
      <span className={cn("font-semibold", TEXT_CLASS[dot])}>{label}</span>
      <span className="text-muted-foreground">- {sentence}</span>
    </div>
  );
}
