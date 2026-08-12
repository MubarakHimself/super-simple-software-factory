import type { QueueItem } from "@shared/types";
import { cn } from "@/lib/utils";

/** A dense 3-line card: title bold; Adw . Category . created dim;
 * acceptance-criteria progress counted from checkboxes, not invented
 * (spec 5.3). */
export function QueueCard({
  item,
  selected,
  onClick,
}: {
  item: QueueItem;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-sm border px-2 py-1.5 text-left transition-colors",
        selected ? "border-primary bg-elevated-hover" : "border-border bg-elevated hover:bg-elevated-hover",
      )}
    >
      <span className="truncate text-[11.5px] font-semibold text-foreground">{item.title}</span>
      <span className="truncate text-[10.5px] text-muted-foreground">
        {item.adw ?? "no adw"}
        {item.category ? ` . ${item.category}` : ""}
        {item.created ? ` . ${item.created}` : ""}
      </span>
      <span className="mono text-[10px] text-[var(--color-text-meta)]">
        {item.criteria_total > 0 ? `${item.criteria_done}/${item.criteria_total} criteria` : "no criteria listed"}
        {item.adw_id ? ` . adw ${item.adw_id}` : ""}
      </span>
    </button>
  );
}
