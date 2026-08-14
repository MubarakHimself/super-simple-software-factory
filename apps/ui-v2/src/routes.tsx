/**
 * Routes (spec 2.1, as corrected):
 *   /p/:projectId/{home|board|runs|runs/:adw_id|gate|docs/*|settings|terminal}
 *
 * `terminal` is the one route with no surface module behind it: the deck is
 * mounted by `App.tsx` above this switch so its shells and their backscroll
 * survive going to another surface and back (see TerminalDeck's header). The
 * route exists so the address bar, the sidebar and the breadcrumb all agree
 * on where the operator is.
 *
 * The project is a path segment, never global client state - two projects
 * drive in two tabs and an action can never land on the wrong project.
 *
 * Default route: no projects -> Add project; else /p/<first>/home.
 * **The default is never Runs** - that is the structural kill of audit F1, so
 * that the app can never open onto the installer's own smoke test (W1-A1).
 *
 * ── The surface seam ──────────────────────────────────────────────────────
 * K1 owns this file; K4-K10 own one directory each and no two chunks touch
 * the same file (spec 4). So surfaces are resolved through `import.meta.glob`
 * rather than static imports: a directory that has not been built yet simply
 * does not appear in the glob's keys, the shell still builds and runs, and the
 * surface starts rendering the moment its chunk lands - with no edit here.
 *
 * Each surface names its root component in priority order below. A chunk that
 * wants a different entry file only has to name it one of these.
 */
import { Suspense, lazy, type ComponentType } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
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
  "./gate/*.tsx",
  "./docs/*.tsx",
  "./settings/*.tsx",
]) as Record<string, Loader>;

/** First existing file wins. Spec 4's own file names come first. */
const SURFACE_ROOTS: Record<string, string[]> = {
  home: ["./home/Home.tsx", "./home/Overnight.tsx"],
  board: ["./board/Board.tsx"],
  runs: ["./runs/Runs.tsx", "./runs/RunList.tsx"],
  gate: ["./gate/Gate.tsx"],
  docs: ["./docs/Docs.tsx", "./docs/DocsTree.tsx"],
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
    // Honest, and short: the noun this route is, and the one true sentence
    // about it. Never a mocked-up version of the surface that is missing.
    return <EmptyState heading={SURFACE_NOUN[name] ?? name} sentence="Not built yet." />;
  }
  return (
    <Suspense fallback={null}>
      <Component />
    </Suspense>
  );
}

export function AppRoutes() {
  const { data, error, loading, refresh } = useResource<Project[]>("projects", "/api/app/projects");
  const projects = data ?? [];

  if (loading) return null;
  if (!data && error) {
    return (
      <div className="flex h-full items-center justify-center">
        <ReadFailure error={error} />
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            projects.length === 0 ? (
              <AddProject onAdded={refresh} />
            ) : (
              <Navigate to={`/p/${projects[0]!.id}/home`} replace />
            )
          }
        />
        <Route path="/add" element={<AddProject onAdded={refresh} />} />
        <Route path="/p/:projectId" element={<App projects={projects} refreshProjects={refresh} />}>
          <Route index element={<Navigate to="home" replace />} />
          <Route path="home" element={<Surface name="home" />} />
          <Route path="board" element={<Surface name="board" />} />
          <Route path="runs" element={<Surface name="runs" />} />
          <Route path="runs/:adwId" element={<Surface name="runs" />} />
          <Route path="gate" element={<Surface name="gate" />} />
          <Route path="docs" element={<Surface name="docs" />} />
          <Route path="docs/*" element={<Surface name="docs" />} />
          <Route path="settings" element={<Surface name="settings" />} />
          <Route path="settings/:pane" element={<Surface name="settings" />} />
          {/* Deliberately empty: App.tsx renders the deck itself. */}
          <Route path="terminal" element={<></>} />
          <Route path="*" element={<Navigate to="home" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
