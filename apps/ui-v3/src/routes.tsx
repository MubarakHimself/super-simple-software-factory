/**
 * Routes:
 *   /p/:projectId/{home | board | runs | runs/:adwId | docs | docs/* |
 *                  settings | settings/:pane}
 *
 * There is no Terminal route and no Gate route: v3 drops the Terminal by
 * design, and the merge queue lives inside Runs as its right-hand rail.
 *
 * Default: no projects -> Add project; otherwise /p/<first>/home. **The
 * default is never Runs** - the app must never open onto a run in flight.
 *
 * ── The surface seam ───────────────────────────────────────────────────────
 * The shell owns this file; each Phase 2 chunk owns one surface directory and
 * no two chunks touch the same file. So surfaces are resolved through
 * `import.meta.glob` rather than static imports: a surface that has not been
 * built yet simply does not appear in the glob's keys, the shell still builds
 * and runs, and the surface starts rendering the moment its chunk lands - with
 * no edit here.
 *
 * Each surface names its root component in priority order in SURFACE_ROOTS. A
 * chunk that wants a different entry file only has to name it one of these.
 * The stubs shipped with the shell already occupy the first name in each list.
 */
import { Suspense, lazy, useCallback, useMemo, useState, type ComponentType } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { App } from "./App.tsx";
import type { Project } from "./lib/api.ts";
import { useResource } from "./lib/poll.ts";
import { AddProject } from "./shell/AddProject.tsx";
import { EmptyState, ReadFailure } from "./shell/EmptyState.tsx";
import { SURFACE_NOUN } from "./shell/TopBar.tsx";

type Loader = () => Promise<{ default: ComponentType }>;

const surfaceModules = import.meta.glob([
  "./home/*.tsx",
  "./board/*.tsx",
  "./runs/*.tsx",
  "./docs/*.tsx",
  "./settings/*.tsx",
]) as Record<string, Loader>;

/** First existing file wins. */
const SURFACE_ROOTS: Record<string, string[]> = {
  home: ["./home/Home.tsx"],
  board: ["./board/Board.tsx"],
  runs: ["./runs/Runs.tsx"],
  docs: ["./docs/Docs.tsx"],
  settings: ["./settings/Settings.tsx"],
};

const resolved = new Map<string, ComponentType | null>();

function surfaceComponent(name: string): ComponentType | null {
  if (resolved.has(name)) return resolved.get(name) ?? null;
  const path = (SURFACE_ROOTS[name] ?? []).find((candidate) => candidate in surfaceModules);
  const component = path ? lazy(surfaceModules[path]!) : null;
  resolved.set(name, component);
  return component;
}

function Surface({ name }: { name: keyof typeof SURFACE_ROOTS }) {
  const Component = surfaceComponent(name);
  if (!Component) {
    // Honest and short: the noun this route is, and the one true sentence
    // about it. Never a mocked-up version of the surface that is missing.
    return <EmptyState heading={SURFACE_NOUN[name] ?? name} sentence="Not built yet." />;
  }
  return (
    <Suspense fallback={null}>
      <Component />
    </Suspense>
  );
}

/** First run: no projects on this machine, so the only thing to do is add one. */
function FirstRun({ onAdded }: { onAdded: (project: Project) => void }) {
  const navigate = useNavigate();
  return (
    <AddProject
      onAdded={(project) => {
        onAdded(project);
        navigate(`/p/${encodeURIComponent(project.id)}/home`, { replace: true });
      }}
    />
  );
}

export function AppRoutes() {
  const { data, error, loading, refresh } = useResource<Project[]>("projects", "/api/app/projects");
  // A project the server just handed back from POST /api/app/projects, held
  // until the list read catches up - so the first paint after an add is the
  // new project, not "project not found".
  const [pending, setPending] = useState<Project | null>(null);
  const projects = useMemo(() => {
    const listed = data ?? [];
    return pending && !listed.some((project) => project.id === pending.id) ? [...listed, pending] : listed;
  }, [data, pending]);

  const onProjectAdded = useCallback(
    (project: Project) => {
      setPending(project);
      refresh();
    },
    [refresh],
  );

  if (loading) return null;
  if (!data && error) {
    return (
      <div className="app">
        <EmptyState heading="No projects read" sentence="The app could not read its project list from the server.">
          <ReadFailure error={error} />
        </EmptyState>
      </div>
    );
  }

  const first = projects[0];

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={first ? <Navigate to={`/p/${encodeURIComponent(first.id)}/home`} replace /> : <FirstRun onAdded={onProjectAdded} />}
        />
        <Route path="/add" element={<FirstRun onAdded={onProjectAdded} />} />
        <Route
          path="/p/:projectId"
          element={<App projects={projects} refreshProjects={refresh} onProjectAdded={onProjectAdded} />}
        >
          <Route index element={<Navigate to="home" replace />} />
          <Route path="home" element={<Surface name="home" />} />
          <Route path="board" element={<Surface name="board" />} />
          <Route path="runs" element={<Surface name="runs" />} />
          <Route path="runs/:adwId" element={<Surface name="runs" />} />
          <Route path="docs" element={<Surface name="docs" />} />
          <Route path="docs/*" element={<Surface name="docs" />} />
          <Route path="settings" element={<Surface name="settings" />} />
          <Route path="settings/:pane" element={<Surface name="settings" />} />
          <Route path="*" element={<Navigate to="home" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
