/**
 * The top bar (spec 2.1) - "PyCharm-serious: a working toolbar, not
 * decoration. 40px, flat chrome color, 1px hairline below, no glass, no blur."
 *
 * Left: breadcrumb `project / surface`. The surface noun here is the SAME
 * string the sidebar row uses and the same string the palette uses - spec 2.0
 * is explicit that v1 shipped `Trace` / `SESSIONS` / `trace` on one screen and
 * that this is a structural defect, so the nouns live in one table.
 *
 * Right: contextual actions ONLY (spec 2.9) - Initialize Git / Initialize
 * factory, rendered by `init/InitActions.tsx` when that chunk lands, and
 * nothing at all when it has not or when the project is fully initialized.
 * There is deliberately NO liveness chip anywhere in this bar: a poll or read
 * failure renders as an inline line inside the panel it affected.
 */
import { Suspense, lazy, useMemo, type ComponentType } from "react";
import { useLocation } from "react-router-dom";
import { useShell } from "../App.tsx";

/** One spelling per noun, in every position (spec 2.0's casing rule). */
export const SURFACE_NOUN: Record<string, string> = {
  home: "Home",
  board: "Board",
  runs: "Runs",
  gate: "Gate",
  docs: "Docs",
  settings: "Settings",
  terminal: "Terminal",
};

/**
 * K9 owns `init/InitActions.tsx`. Resolved through `import.meta.glob` rather
 * than a static import so this file builds before that one exists and needs no
 * edit after it does - no two chunks touch the same file (spec 4).
 */
const initModules = import.meta.glob("../init/InitActions.tsx") as Record<
  string,
  () => Promise<{ default: ComponentType }>
>;
const initLoader = initModules["../init/InitActions.tsx"];
const InitActions = initLoader ? lazy(initLoader) : null;

export function TopBar() {
  const { project } = useShell();
  const { pathname } = useLocation();

  const surface = useMemo(() => {
    // /p/:projectId/<surface>/...
    const segment = pathname.split("/")[3] ?? "home";
    return SURFACE_NOUN[segment] ?? SURFACE_NOUN.home;
  }, [pathname]);

  return (
    <header className="flex h-topbar shrink-0 items-center gap-3 border-b border-hairline bg-chrome px-4">
      {/* The breadcrumb is the only text in this bar, so it is set at the
          surface heading's size rather than at a row label's. */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-head">
        <span className="min-w-0 truncate text-t2">{project?.name ?? "…"}</span>
        <span className="text-t3">/</span>
        <span className="truncate font-semibold text-t1">{surface}</span>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        {InitActions ? (
          <Suspense fallback={null}>
            <InitActions />
          </Suspense>
        ) : null}
      </div>
    </header>
  );
}
