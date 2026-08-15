/**
 * The shell: sidebar (240px) · topbar (48px) · the surface pane. One layout,
 * ported from home-v2.html, which every surface renders inside.
 *
 * The project is a path segment (`/p/:projectId/...`), never global client
 * state: two projects can drive in two tabs and an action can never land on
 * the wrong project.
 *
 * Everything the shell fetched is handed down through one context. A surface
 * that needs the project, the 2s live poll or the factory's health reads
 * `useShell()` instead of firing its own copy of the same request.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import type { FactoryHealth, Live, Project } from "./lib/api.ts";
import { useFactoryHealth, useLive, type Resource } from "./lib/poll.ts";
import { applyAccent, colorForProject } from "./lib/projectColor.ts";
import { AddProject } from "./shell/AddProject.tsx";
import { EmptyState } from "./shell/EmptyState.tsx";
import { Sidebar } from "./shell/Sidebar.tsx";
import { TopBar } from "./shell/TopBar.tsx";

export interface ShellValue {
  projectId: string;
  project: Project | null;
  projects: Project[];
  /** Re-read `/api/app/projects` (after an add, a rename, a removal). */
  refreshProjects: () => void;
  /** The one 2s poll. Board and Runs read this, never a second copy of it. */
  live: Resource<Live>;
  /** The factory-status endpoint, shared so a surface can render the
   * engine-down banner from the same read the footer used. */
  health: Resource<FactoryHealth>;
  /** Opens the shell's Add-project modal (the switcher's own trigger). */
  openAddProject: () => void;
}

const ShellContext = createContext<ShellValue | null>(null);

export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell() outside the shell");
  return value;
}

export function App({
  projects,
  refreshProjects,
  onProjectAdded,
}: {
  projects: Project[];
  refreshProjects: () => void;
  onProjectAdded: (project: Project) => void;
}) {
  const { projectId = "" } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);

  const project = useMemo(() => projects.find((item) => item.id === projectId) ?? null, [projects, projectId]);
  const live = useLive<Live>(project ? projectId : null);
  const health = useFactoryHealth<FactoryHealth>(project ? projectId : null);

  // The mock repaints --accent on every project switch; so does this, plus the
  // two tokens derived from it (see lib/projectColor.ts).
  useEffect(() => {
    if (project) applyAccent(colorForProject(projects, projectId));
  }, [projects, projectId, project]);

  const openAddProject = useCallback(() => setAddOpen(true), []);

  /** Switching keeps the operator on the surface he was reading. */
  const switchProject = useCallback(
    (id: string) => {
      const surface = pathname.split("/")[3] ?? "home";
      navigate(`/p/${encodeURIComponent(id)}/${surface}`);
    },
    [navigate, pathname],
  );

  const value = useMemo<ShellValue>(
    () => ({ projectId, project, projects, refreshProjects, live, health, openAddProject }),
    [projectId, project, projects, refreshProjects, live, health, openAddProject],
  );

  // A deep link into a project this manifest does not have. Say so, and offer
  // the one honest way out rather than redirecting somewhere unasked.
  if (!project) {
    if (projects.length === 0) return <Navigate to="/" replace />;
    const first = projects[0];
    return (
      <div className="app">
        <EmptyState
          heading="Project not found"
          sentence={`No project with id "${projectId}" is registered on this machine.`}
          action={first ? { label: `Open ${first.name}`, onClick: () => navigate(`/p/${encodeURIComponent(first.id)}/home`) } : undefined}
        />
      </div>
    );
  }

  return (
    <ShellContext.Provider value={value}>
      <div className="app">
        <Sidebar
          projectId={projectId}
          projects={projects}
          live={live}
          health={health}
          onSwitchProject={switchProject}
          onAddProject={openAddProject}
        />
        <div className="main-col">
          <TopBar projectId={projectId} projects={projects} onSwitchProject={switchProject} />
          <div className="surface">
            <Outlet />
          </div>
        </div>
      </div>
      {addOpen ? (
        <AddProject
          onCancel={() => setAddOpen(false)}
          onAdded={(added) => {
            setAddOpen(false);
            onProjectAdded(added);
            navigate(`/p/${encodeURIComponent(added.id)}/home`);
          }}
        />
      ) : null}
    </ShellContext.Provider>
  );
}
