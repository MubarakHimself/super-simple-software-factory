/**
 * The sidebar, from home-v2.html (all five mocks carry it identically):
 * project switcher · search · nav with counts · factory-status footer.
 *
 * Two things the mock could not have:
 *   - the counts are real (`/api/app/p/:id/live`) and simply absent when the
 *     read has not answered - never a placeholder zero;
 *   - the search field is drawn but disabled until the search chunk lands, so
 *     it cannot swallow a click and pretend to think.
 */
import { useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import type { Live, Project } from "../lib/api.ts";
import type { Resource } from "../lib/poll.ts";
import { colorForIndex } from "../lib/projectColor.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { BoardIcon, ChevronDown, DocsIcon, HomeIcon, RunsIcon, SearchIcon, SettingsIcon } from "../shared/Icons.tsx";
import type { FactoryHealth } from "../lib/api.ts";
import { FactoryStatus } from "./FactoryStatus.tsx";

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
}: {
  projectId: string;
  projects: Project[];
  live: Resource<Live>;
  health: Resource<FactoryHealth>;
  onSwitchProject: (id: string) => void;
  onAddProject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  useDismiss(switcherRef, open, () => setOpen(false));

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
          {projects.map((project, index) => (
            <button
              type="button"
              key={project.id}
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
          ))}
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
