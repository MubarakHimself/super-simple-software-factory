/**
 * The topbar, from home-v2.html: breadcrumb (project dropdown / surface name)
 * on the left, Sync on the right.
 *
 * ── Sync ───────────────────────────────────────────────────────────────────
 * Publishing is the sync in this model - the button does not push, pull or
 * dispatch anything. It re-reads every data source currently on screen and
 * then says what happened: `synced 19:42`, or `2 of 7 reads failed`, or
 * `nothing to re-read`. A button that spins and ends in silence is the one
 * outcome that is not allowed.
 *
 * ── The slot ───────────────────────────────────────────────────────────────
 * A surface that owns a topbar indicator (Board's "Auto-pick from Ready", for
 * instance) portals it into `TOPBAR_SLOT_ID` with `useTopbarSlot()`. The slot
 * sits left of Sync, exactly where board-v3.html draws it. That keeps this
 * file the shell's and the indicator the surface's.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { Project } from "../lib/api.ts";
import { clockTime } from "../lib/format.ts";
import { requestSyncAll, useSyncState } from "../lib/poll.ts";
import { colorForIndex } from "../lib/projectColor.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { ChevronDown, SyncIcon } from "../shared/Icons.tsx";

/** One spelling of each surface's name, for the breadcrumb, the sidebar and
 * any surface heading. Nothing in the app may spell them a second way. */
export const SURFACE_NOUN: Record<string, string> = {
  home: "Home",
  board: "Board",
  runs: "Runs",
  docs: "Docs",
  settings: "Settings",
};

export const TOPBAR_SLOT_ID = "sdl-topbar-slot";

/** The host element a surface portals its topbar indicator into. Null until
 * the shell has mounted, so callers render nothing on the first pass. */
export function useTopbarSlot(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.getElementById(TOPBAR_SLOT_ID));
  }, []);
  return host;
}

function syncNote(state: ReturnType<typeof useSyncState>): { text: string; failed: boolean } | null {
  if (state.status === "syncing") return { text: "syncing…", failed: false };
  if (state.status === "failed") return { text: `${state.failed} of ${state.sources} reads failed`, failed: true };
  if (state.status === "done") {
    if (state.sources === 0) return { text: "nothing to re-read", failed: false };
    return { text: `synced ${state.at ? clockTime(state.at) : ""}`.trim(), failed: false };
  }
  return null;
}

export function TopBar({
  projectId,
  projects,
  onSwitchProject,
}: {
  projectId: string;
  projects: Project[];
  onSwitchProject: (id: string) => void;
}) {
  const { pathname } = useLocation();
  const surface = pathname.split("/")[3] ?? "home";
  const [open, setOpen] = useState(false);
  const crumbRef = useRef<HTMLSpanElement>(null);
  useDismiss(crumbRef, open, () => setOpen(false));
  const sync = useSyncState();
  const note = syncNote(sync);

  const current = projects.find((project) => project.id === projectId) ?? null;
  const currentColor = colorForIndex(projects.findIndex((project) => project.id === projectId));

  return (
    <div className="topbar">
      <div className="breadcrumb">
        <span
          ref={crumbRef}
          className={`crumb-dim crumb-project${open ? " open" : ""}`}
          onClick={() => setOpen((was) => !was)}
        >
          <span className="cp-dot" style={{ background: currentColor }} />
          {current?.name ?? "No project"}
          <ChevronDown className="cp-chev" />
          <div className="crumb-dropdown">
            {projects.map((project, index) => (
              <button
                type="button"
                key={project.id}
                className={`crumb-dropdown-item${project.id === projectId ? " active" : ""}`}
                title={project.root}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  onSwitchProject(project.id);
                }}
              >
                <span className="cpd-dot" style={{ background: colorForIndex(index) }} />
                {project.name}
              </button>
            ))}
          </div>
        </span>
        <span className="crumb-sep">/</span>
        <span className="crumb-here">{SURFACE_NOUN[surface] ?? SURFACE_NOUN.home}</span>
      </div>

      <div className="topbar-right">
        <div id={TOPBAR_SLOT_ID} className="topbar-slot" />
        {note ? (
          <div className={`topbar-note${note.failed ? " failed" : ""}`}>
            <span className={`dot${sync.status === "syncing" ? " pulse" : ""}`} />
            <span>{note.text}</span>
          </div>
        ) : null}
        <button
          type="button"
          className="topbar-btn"
          onClick={() => void requestSyncAll()}
          disabled={sync.status === "syncing"}
        >
          <SyncIcon />
          Sync
        </button>
      </div>
    </div>
  );
}
