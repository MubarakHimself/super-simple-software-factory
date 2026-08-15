/**
 * The sidebar, from home-v2.html (all five mocks carry it identically):
 * project switcher · search · nav with counts · factory-status footer.
 *
 * Three things the mock could not have:
 *   - the counts are real (`/api/app/p/:id/live`) and simply absent when the
 *     read has not answered - never a placeholder zero;
 *   - the search field is drawn but disabled until the search chunk lands, so
 *     it cannot swallow a click and pretend to think;
 *   - each project in the menu can be REMOVED from this machine's list. That
 *     row exists because the server used to auto-register its own repo on
 *     every boot, and there was no way at all to dismiss it. Removal is a
 *     two-step (the row asks first), and the question says what it does:
 *     nothing inside the folder is touched, because a project IS a line in
 *     `~/.sdl-factory/config.json` and nothing more.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { apiPost, type Live, type Project } from "../lib/api.ts";
import type { Resource } from "../lib/poll.ts";
import { colorForIndex } from "../lib/projectColor.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { BoardIcon, ChevronDown, DocsIcon, HomeIcon, RunsIcon, SearchIcon, SettingsIcon } from "../shared/Icons.tsx";
import type { FactoryHealth } from "../lib/api.ts";
import { FactoryStatus } from "./FactoryStatus.tsx";
import "./onboarding.css";

/** The five surfaces, in the mocks' order. Home and Docs and Settings carry no
 * count in the mock either - only Board and Runs do. */
const NAV = [
  { key: "home", label: "Home", Icon: HomeIcon },
  { key: "board", label: "Board", Icon: BoardIcon },
  { key: "runs", label: "Runs", Icon: RunsIcon },
  { key: "docs", label: "Docs", Icon: DocsIcon },
  { key: "settings", label: "Settings", Icon: SettingsIcon },
] as const;

function countFor(key: string, live: Resource<Live>): number | null {
  const counts = live.data?.counts;
  if (!counts) return null;
  if (key === "board") return counts.board_ready;
  if (key === "runs") return counts.runs_running;
  return null;
}

export function Sidebar({
  projectId,
  projects,
  live,
  health,
  onSwitchProject,
  onAddProject,
  onProjectRemoved,
}: {
  projectId: string;
  projects: Project[];
  live: Resource<Live>;
  health: Resource<FactoryHealth>;
  onSwitchProject: (id: string) => void;
  onAddProject: () => void;
  onProjectRemoved: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  useDismiss(switcherRef, open, () => {
    setOpen(false);
    setConfirmId(null);
  });

  const remove = useCallback(
    async (id: string) => {
      setRemoveError(null);
      try {
        await apiPost("/api/app/projects", { intent: "remove", id });
        setConfirmId(null);
        setOpen(false);
        onProjectRemoved(id);
      } catch (failure) {
        setRemoveError((failure as Error).message);
      }
    },
    [onProjectRemoved],
  );

  const current = useMemo(() => projects.find((project) => project.id === projectId) ?? null, [projects, projectId]);
  const currentColor = colorForIndex(projects.findIndex((project) => project.id === projectId));

  return (
    <aside className="sidebar">
      <div
        ref={switcherRef}
        className={`project-switcher${open ? " open" : ""}`}
        onClick={() => setOpen((was) => !was)}
      >
        <div className="proj-dot" style={{ background: currentColor }} />
        <span className="proj-name">{current?.name ?? "No project"}</span>
        <ChevronDown className="proj-chev" />
        <div className="project-menu">
          {projects.map((project, index) =>
            confirmId === project.id ? (
              <div className="pm-confirm" key={project.id} onClick={(event) => event.stopPropagation()}>
                <span className="pm-confirm-q">
                  Remove {project.name} from this list? The folder itself is not touched.
                </span>
                <div className="pm-confirm-actions">
                  <button type="button" className="pm-word danger" onClick={() => void remove(project.id)}>
                    Remove
                  </button>
                  <button type="button" className="pm-word" onClick={() => setConfirmId(null)}>
                    Keep
                  </button>
                </div>
                {removeError ? <span className="pm-confirm-error">{removeError}</span> : null}
              </div>
            ) : (
              <div className="project-menu-row" key={project.id}>
                <button
                  type="button"
                  className={`project-menu-item${project.id === projectId ? " active" : ""}`}
                  title={project.root}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen(false);
                    onSwitchProject(project.id);
                  }}
                >
                  <span className="pm-dot" style={{ background: colorForIndex(index) }} />
                  {project.name}
                </button>
                <button
                  type="button"
                  className="pm-word pm-remove"
                  title="Remove this project from this machine's list"
                  onClick={(event) => {
                    event.stopPropagation();
                    setRemoveError(null);
                    setConfirmId(project.id);
                  }}
                >
                  Remove
                </button>
              </div>
            ),
          )}
          {projects.length > 0 ? <div className="project-menu-sep" /> : null}
          <button
            type="button"
            className="project-menu-item add"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onAddProject();
            }}
          >
            <span className="pm-dot" style={{ background: "transparent", border: "1px dashed var(--accent)" }} />
            Add project…
          </button>
        </div>
      </div>

      <button type="button" className="sidebar-search" disabled title="Search lands with its own chunk">
        <SearchIcon />
        <span>Search…</span>
      </button>

      <nav className="sidebar-nav">
        {NAV.map(({ key, label, Icon }) => {
          const count = countFor(key, live);
          return (
            <NavLink
              key={key}
              to={`/p/${encodeURIComponent(projectId)}/${key}`}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
            >
              <Icon className="nav-icon" />
              <span>{label}</span>
              {count === null ? null : <span className="nav-count">{count}</span>}
            </NavLink>
          );
        })}
      </nav>

      <FactoryStatus health={health} />
    </aside>
  );
}
