/**
 * The topbar, from home-v2.html: breadcrumb (project name / surface) on the
 * left, Sync on the right.
 *
 * ── The breadcrumb ─────────────────────────────────────────────────────────
 * L6 interpretation, flagged for veto: the operator's own read of the mock
 * was "remove these things at the top" — the breadcrumb used to carry a
 * second, full project-switcher dropdown (dot, chevron, the whole project
 * list), duplicating the sidebar's own switcher pixel for pixel. That
 * dropdown is gone; the breadcrumb is now what its name says — a plain
 * project name (still dot-coloured, matching the sidebar and every other
 * project reference in this app) and the current surface. The sidebar
 * switcher is the one place a project switch happens. `onSwitchProject`
 * stays in this component's prop type (so `App.tsx`, which this lane does
 * not own, keeps compiling unchanged) but is no longer called from here.
 *
 * ── Sync ───────────────────────────────────────────────────────────────────
 * The operator's own words: "that button does a lot - providers, machines,
 * kanban, docs... it's like a status update." It is now two things:
 *
 *   1. A REAL write — `POST /api/app/p/:id/sync` (`server/app/sync.ts`): git
 *      fetch + a fast-forward-only merge in the project's own checkout. Never
 *      pushes, never forces; a dirty or diverged checkout is reported by
 *      name, not silently skipped.
 *   2. A re-read of everything mounted on screen (`lib/poll.ts`'s Sync bus,
 *      unchanged in spirit — Publishing is still the sync for cards/docs
 *      content; this button's job is freshness, not authorship).
 *
 * A click opens the popover AND runs the sync; the popover renders directly
 * from `useSyncState()`, so it is live while syncing and settles into the
 * same honest result the topbar note already showed. Machines and providers
 * are named with a link to their own panes rather than a number this bus
 * cannot honestly produce — their freshness lives there, not here.
 *
 * ── The slot ───────────────────────────────────────────────────────────────
 * A surface that owns a topbar indicator (Board's "Auto-pick from Ready", for
 * instance) portals it into `TOPBAR_SLOT_ID` with `useTopbarSlot()`. The slot
 * sits left of Sync, exactly where board-v3.html draws it. That keeps this
 * file the shell's and the indicator the surface's.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Project } from "../lib/api.ts";
import { clockTime } from "../lib/format.ts";
import { requestSyncAll, useSyncState, type AreaState, type SyncState } from "../lib/poll.ts";
import { colorForIndex } from "../lib/projectColor.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { Dot, type Tone } from "../shared/Dot.tsx";
import { SyncIcon } from "../shared/Icons.tsx";

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

function syncNote(state: SyncState): { text: string; failed: boolean } | null {
  if (state.status === "syncing") return { text: "syncing…", failed: false };
  if (state.status === "failed") return { text: `${state.failed} of ${state.sources} reads failed`, failed: true };
  if (state.status === "done") {
    if (state.sources === 0) return { text: "nothing to re-read", failed: false };
    return { text: `synced ${state.at ? clockTime(state.at) : ""}`.trim(), failed: false };
  }
  return null;
}

const REPO_TONE: Record<string, Tone> = {
  pulled: "ok",
  "up-to-date": "ok",
  dirty: "warn",
  diverged: "warn",
  detached: "warn",
  "no-remote": "neutral",
  "not-a-repo": "fail",
  failed: "fail",
};

function repoLine(state: SyncState): { tone: Tone; text: string } {
  if (state.status === "syncing" && !state.repo) return { tone: "idle", text: "checking…" };
  if (!state.repo) return { tone: "idle", text: "not synced yet" };
  return { tone: REPO_TONE[state.repo.status] ?? "neutral", text: state.repo.detail };
}

function areaLine(area: AreaState, syncing: boolean): { tone: Tone; text: string } {
  if (syncing && area.at === null) return { tone: "idle", text: "checking…" };
  if (area.at === null) return { tone: "idle", text: "not open right now" };
  return { tone: area.failed ? "fail" : "ok", text: `refreshed ${clockTime(area.at)}` };
}

function AreaRow({ label, area, syncing }: { label: string; area: AreaState; syncing: boolean }) {
  const line = areaLine(area, syncing);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
      <Dot tone={line.tone} pulse={syncing && area.at === null} />
      <span style={{ color: "var(--t2)", minWidth: 46 }}>{label}</span>
      <span style={{ color: "var(--t3)", fontFamily: "var(--font-mono)", fontSize: "var(--text-meta)" }}>{line.text}</span>
    </div>
  );
}

function PaneLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      style={{
        display: "block",
        padding: "6px 0",
        color: "var(--accent)",
        fontSize: "var(--text-meta)",
        textDecoration: "none",
      }}
    >
      {label} — see its own pane
    </Link>
  );
}

function SyncPopover({ projectId, state }: { projectId: string; state: SyncState }) {
  const repo = repoLine(state);
  const syncing = state.status === "syncing";
  return (
    <div
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        right: 0,
        minWidth: 260,
        background: "var(--overlay)",
        border: "1px solid var(--hairline-2)",
        borderRadius: "var(--r-control)",
        boxShadow: "var(--shadow)",
        padding: "10px 14px",
        zIndex: 200,
        fontSize: "var(--text-body)",
      }}
    >
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-meta)", color: "var(--t3)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>
        Status update
      </div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0" }}>
        <div style={{ marginTop: 5 }}>
          <Dot tone={repo.tone} pulse={syncing && !state.repo} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "var(--t2)" }}>Repo</div>
          <div style={{ color: "var(--t3)", fontFamily: "var(--font-mono)", fontSize: "var(--text-meta)", wordBreak: "break-word" }}>{repo.text}</div>
        </div>
      </div>
      <AreaRow label="Board" area={state.areas.board} syncing={syncing} />
      <AreaRow label="Docs" area={state.areas.docs} syncing={syncing} />
      <div style={{ height: 1, background: "var(--hairline)", margin: "6px 0" }} />
      <PaneLink to={`/p/${encodeURIComponent(projectId)}/settings/machines`} label="Machines" />
      <PaneLink to={`/p/${encodeURIComponent(projectId)}/settings/providers`} label="Providers" />
    </div>
  );
}

export function TopBar({
  projectId,
  projects,
}: {
  projectId: string;
  projects: Project[];
  /** No longer called from here — see this file's header. Kept so callers
   * that still pass it (App.tsx) need no edit. */
  onSwitchProject?: (id: string) => void;
}) {
  const { pathname } = useLocation();
  const surface = pathname.split("/")[3] ?? "home";
  const [popoverOpen, setPopoverOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismiss(wrapRef, popoverOpen, () => setPopoverOpen(false));
  const sync = useSyncState();
  const note = syncNote(sync);

  const current = projects.find((project) => project.id === projectId) ?? null;
  const currentColor = colorForIndex(projects.findIndex((project) => project.id === projectId));

  return (
    <div className="topbar">
      <div className="breadcrumb">
        <span className="crumb-dim" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="cp-dot" style={{ background: currentColor }} />
          {current?.name ?? "No project"}
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
        <div ref={wrapRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="topbar-btn"
            onClick={() => {
              setPopoverOpen(true);
              void requestSyncAll(projectId);
            }}
            disabled={sync.status === "syncing"}
          >
            <SyncIcon />
            Sync
          </button>
          {popoverOpen ? <SyncPopover projectId={projectId} state={sync} /> : null}
        </div>
      </div>
    </div>
  );
}
