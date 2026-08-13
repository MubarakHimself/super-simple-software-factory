import { Activity, Columns3, GitPullRequest, Settings as SettingsIcon, SquareTerminal } from "lucide-react";
import { navigate, surfacePath, type Surface } from "@/routes";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const ITEMS: { surface: Surface; icon: typeof Activity; label: string }[] = [
  { surface: "board", icon: Columns3, label: "Board" },
  { surface: "trace", icon: Activity, label: "Trace" },
  { surface: "gate", icon: GitPullRequest, label: "Gate" },
  { surface: "settings", icon: SettingsIcon, label: "Settings" },
  { surface: "terminal", icon: SquareTerminal, label: "Terminal" },
];

/** The whole navigation: four icon buttons, count badge each, 2px left
 * accent bar on the active one (spec 5.1). No tabs, no other chrome. */
export function ActivityRail({
  active,
  counts,
}: {
  active: Surface;
  counts: Partial<Record<Surface, number>>;
}) {
  return (
    <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-chrome py-2">
      {ITEMS.map(({ surface, icon: Icon, label }) => {
        const isActive = active === surface;
        const count = counts[surface];
        return (
          <Tooltip key={surface}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => navigate(surfacePath(surface))}
                aria-label={label}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex h-9 w-9 flex-col items-center justify-center rounded-md text-muted-foreground transition-colors",
                  "hover:bg-elevated-hover hover:text-foreground",
                  isActive && "bg-elevated-hover text-foreground",
                )}
              >
                {isActive && (
                  <span className="absolute left-0 top-1.5 h-6 w-0.5 rounded-full bg-primary" aria-hidden />
                )}
                <Icon className="size-4" strokeWidth={1.5} />
                {typeof count === "number" && count > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold text-primary-foreground">
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
