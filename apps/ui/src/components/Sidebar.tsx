import { ScrollArea } from "@/components/ui/scroll-area";

/** Surface-scoped sidebar shell (spec 5.1): a label + count header, then
 * whatever list the active surface owns - run list, status filter, waiting
 * runs, or a settings section nav. */
export function Sidebar({
  title,
  count,
  headerExtra,
  children,
}: {
  title: string;
  count?: number;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
          {typeof count === "number" && <span className="ml-1.5 text-[var(--color-text-meta)]">{count}</span>}
        </span>
        {headerExtra}
      </div>
      <ScrollArea className="min-h-0 flex-1">{children}</ScrollArea>
    </div>
  );
}
