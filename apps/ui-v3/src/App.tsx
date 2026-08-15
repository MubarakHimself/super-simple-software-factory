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
  /** What a surface that just added a project should call INSTEAD of
   * `refreshProjects()` + navigate. The list read is asynchronous, so
   * navigating straight to the new id lands on a project the list does not
   * carry yet; this holds the server's own answer until the read catches up,
   * so the first paint after an add is the project, never "project not
   * found". (Settings' own add modal still calls `refreshProjects` — see this
   * lane's report.) */
  onProjectAdded: (project: Project) => void;
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
  projectsReading,
  refreshProjects,
  onProjectAdded,
}: {
  projects: Project[];
  /** True while a re-read of the project list is in flight — the difference
   * between "this id is not registered" and "the list has not answered yet". */
  projectsReading: boolean;
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

  /** A project left this machine's list. Re-read, then leave the id that is
   * gone: the next project if there is one, the first-run surface if there is
   * not. Never sit on a route whose project no longer exists. */
  const onProjectRemoved = useCallback(
    (removedId: string) => {
      refreshProjects();
      if (removedId !== projectId) return;
      const next = projects.find((entry) => entry.id !== removedId);
      navigate(next ? `/p/${encodeURIComponent(next.id)}/home` : "/", { replace: true });
    },
    [navigate, projectId, projects, refreshProjects],
  );

  const value = useMemo<ShellValue>(
    () => ({ projectId, project, projects, refreshProjects, onProjectAdded, live, health, openAddProject }),
    [projectId, project, projects, refreshProjects, onProjectAdded, live, health, openAddProject],
  );

  // A deep link into a project this manifest does not have. Say so, and offer
  // the one honest way out rather than redirecting somewhere unasked - but
  // only once a completed read has failed to find it. While the list is being
  // re-read (the moment right after an add, or after a removal), the honest
  // word is "opening", not "not found".
  if (!project) {
    if (projects.length === 0 && !projectsReading) return <Navigate to="/" replace />;
    const first = projects[0];
    if (projectsReading) {
      return (
        <div className="app">
          <EmptyState heading="Opening project" sentence="Reading this machine's project list." />
        </div>
      );
    }
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
          onProjectRemoved={onProjectRemoved}
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
