/**
 * The shell (spec 2.1): one sidebar (240px, collapsible to 0), one flat top
 * bar (40px), the surface pane. The sidebar is the only navigation - no top
 * tabs, no icon rail, no docks (binding).
 *
 * `App` is mounted at `/p/:projectId`, so the project is a path segment and
 * never global client state: two projects drive in two tabs and an action can
 * never land on the wrong project (spec 2.1, W3 cross-cutting).
 *
 * Everything the shell fetched is handed down through one context. Surfaces
 * that need the project, its readiness or the 2s live poll read `useShell()`
 * instead of firing their own copy of the same request - spec 1.3 calls the
 * live endpoint "the one 2s poll" and means it.
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Outlet, useLocation, useParams } from "react-router-dom";
import type { Live, Project, Readiness } from "./lib/api.ts";
import { useLive, useResource } from "./lib/poll.ts";
import type { Resource } from "./lib/poll.ts";
import { TerminalDeck } from "./terminal/TerminalDeck.tsx";
import { Palette } from "./shell/Palette.tsx";
import { Sidebar } from "./shell/Sidebar.tsx";
import { TopBar } from "./shell/TopBar.tsx";

/** Readiness feeds the top bar's contextual actions and the sidebar's dimming,
 * so it re-reads on a cadence slow enough to be invisible: spec 2.9 says the
 * Initialize buttons "disappear on the next readiness poll". */
const READINESS_INTERVAL_MS = 10_000;

export interface ShellValue {
  projectId: string;
  project: Project | null;
  projects: Project[];
  refreshProjects: () => void;
  readiness: Resource<Readiness>;
  live: Resource<Live>;
  paletteOpen: boolean;
  openPalette: (mode?: PaletteMode) => void;
  closePalette: () => void;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

export type PaletteMode = "commands" | "files" | "search";

const ShellContext = createContext<ShellValue | null>(null);

export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell() outside the shell");
  return value;
}

export function App({ projects, refreshProjects }: { projects: Project[]; refreshProjects: () => void }) {
  const { projectId = "" } = useParams();
  const { pathname } = useLocation();
  // The Terminal is the one surface that is mounted rather than routed - see
  // `terminal/TerminalDeck.tsx`'s header (audit F2: backscroll has to survive
  // a SURFACE switch, not only a tab switch).
  const onTerminal = pathname.split("/")[3] === "terminal";
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);

  const readiness = useResource<Readiness>(
    projectId ? `${projectId}|readiness` : null,
    projectId ? `/api/app/projects/${encodeURIComponent(projectId)}/readiness` : null,
    READINESS_INTERVAL_MS,
  );
  const live = useLive<Live>(projectId || null);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("commands");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const openPalette = useCallback((mode: PaletteMode = "commands") => {
    setPaletteMode(mode);
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);

  // There was a Ctrl/Cmd+K here. The KISS correction removed it: **no
  // keybindings anywhere - buttons and word-links only**. The palette's one
  // way in is the sidebar's `Search` button, which is also the only place it
  // is advertised. (Escape still closes an open popover or panel; dismissing
  // a transient is not a command binding, and nothing invokes a command from
  // the keyboard any more.)

  const value = useMemo<ShellValue>(
    () => ({
      projectId,
      project,
      projects,
      refreshProjects,
      readiness,
      live,
      paletteOpen,
      openPalette,
      closePalette,
      sidebarOpen,
      toggleSidebar,
    }),
    [projectId, project, projects, refreshProjects, readiness, live, paletteOpen, openPalette, closePalette, sidebarOpen, toggleSidebar],
  );

  return (
    <ShellContext.Provider value={value}>
      <div className="flex h-full w-full overflow-hidden bg-canvas">
        {sidebarOpen ? <Sidebar /> : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-h-0 flex-1 overflow-hidden">
            {/* Mounted always, shown only on /terminal: the shells keep
                running and the backscroll stays on screen while the operator
                is off looking at the Board. Keyed by project so two projects
                never share a deck. */}
            <div className={onTerminal ? "h-full" : "hidden"}>
              {projectId ? <TerminalDeck key={projectId} projectId={projectId} /> : null}
            </div>
            {onTerminal ? null : <Outlet />}
          </main>
        </div>
      </div>
      <Palette mode={paletteMode} />
    </ShellContext.Provider>
  );
}

// `isTypingTarget` lived here: the guard that let a focused pty or text field
// keep a keystroke the shell's Ctrl+K would otherwise have taken. With the
// binding gone there is nothing left to guard against - the shell listens for
// no keys at all, so a terminal keeps every keystroke by construction.
