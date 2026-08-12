import type { QueueItem, QueueStatus, UnparsedQueueItem } from "@shared/types";
import { QueueCard } from "@/components/QueueCard";

const COLUMNS: { status: QueueStatus; label: string }[] = [
  { status: "ready-for-agent", label: "Ready for agent" },
  { status: "running", label: "Running" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

/** Four Status columns plus Unparsed - a malformed item is visible, never
 * silently dropped (spec 5.3). */
export function BoardColumns({
  items,
  unparsed,
  selectedPath,
  onSelect,
}: {
  items: QueueItem[];
  unparsed: UnparsedQueueItem[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 gap-2 overflow-x-auto p-2">
      {COLUMNS.map((col) => {
        const colItems = items.filter((i) => i.status === col.status);
        return (
          <div key={col.status} className="flex h-full w-[230px] shrink-0 flex-col rounded-md border border-border bg-chrome">
            <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-2">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{col.label}</span>
              <span className="text-[10.5px] text-[var(--color-text-meta)]">{colItems.length}</span>
            </div>
            <div className="flex-1 space-y-1.5 overflow-y-auto p-1.5">
              {colItems.map((item) => (
                <QueueCard key={item.path} item={item} selected={item.path === selectedPath} onClick={() => onSelect(item.path)} />
              ))}
              {colItems.length === 0 && <div className="px-1 py-2 text-[10.5px] text-[var(--color-text-meta)]">empty</div>}
            </div>
          </div>
        );
      })}
      <div className="flex h-full w-[230px] shrink-0 flex-col rounded-md border border-[var(--color-warning)]/40 bg-chrome">
        <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-warning)]">Unparsed</span>
          <span className="text-[10.5px] text-[var(--color-text-meta)]">{unparsed.length}</span>
        </div>
        <div className="flex-1 space-y-1.5 overflow-y-auto p-1.5">
          {unparsed.map((u) => (
            <div key={u.path} className="rounded-sm border border-border bg-elevated px-2 py-1.5">
              <div className="mono truncate text-[11px] text-foreground">{u.path}</div>
              <div className="text-[10.5px] text-[var(--color-warning)]">{u.reason}</div>
            </div>
          ))}
          {unparsed.length === 0 && <div className="px-1 py-2 text-[10.5px] text-[var(--color-text-meta)]">empty</div>}
        </div>
      </div>
    </div>
  );
}
