/**
 * Settings (spec 2.8) - "Sidebar nav inside Settings: **Project · Roster ·
 * Providers · Appearance · Paths and data**. No Keybindings (ratified out).
 * No Usage in v1."
 *
 * The nav is the surface's own second column (spec 2.1: "Per-surface lists
 * are a second column the surface owns"), which is why it is 280px like the
 * run list and the docs tree, and why it does not wear the chrome color -
 * two columns are never both chrome.
 *
 * The pane is a route segment (`/p/:id/settings/:pane`), not `useState`, so a
 * pane is linkable and survives a reload - and so navigation cannot destroy
 * it (audit F5's lesson, applied at the smallest scale it has).
 *
 * One config read is held here and handed down: Roster, Providers' lanes,
 * Project's db path and Paths' server facts are four views of the same
 * `/api/app/p/:id/config` body, and four copies of one request would be four
 * chances to disagree.
 */
import { Navigate, NavLink, useParams } from "react-router-dom";
import { useShell } from "../App.tsx";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { IconFolder, IconPanel, IconRuns } from "../shared/Icons.tsx";
import { AppearancePane } from "./AppearancePane.tsx";
import { factoryAbsent, useProjectConfig, type ConfigBody } from "./config.ts";
import { Field, Pane, Section, SectionColumns } from "./parts.tsx";
import { PathsSections } from "./PathsPane.tsx";
import { RosterPane } from "./RosterPane.tsx";

/** Sentence case, one spelling per noun, in every position (spec 2.0).
 *
 * **Paths and data** was a fifth row here until the 2026-08-14 layout pass.
 * It is gone as a destination, not as content: every fact it carried now sits
 * in **Project**, beside the four project facts it was always describing. Two
 * read-only panes about one project were one pane with a nav row in the middle
 * of it, and the operator's word for that nav row was "for show".
 *
 * **Providers** went the same way in the same pass, for the same reason in the
 * operator's own words: "there is providers then there is roster, can't you
 * just combine the two? What's the point of having two different ones." A
 * roster row names a lane; Providers said whether that lane and its harness are
 * real. Roster now carries both. */
const PANES = [
  { id: "project", label: "Project", icon: IconFolder },
  { id: "roster", label: "Roster", icon: IconRuns },
  { id: "appearance", label: "Appearance", icon: IconPanel },
] as const;

type PaneId = (typeof PANES)[number]["id"];

/** Panes that are gone but whose links are not. A `/settings/providers` or
 * `/settings/paths` link the operator already has lands on the pane that
 * absorbed it, rather than bouncing to the first tab as an unknown id. */
const MERGED: Record<string, PaneId> = { providers: "roster", paths: "project" };

/** Everything this app knows about the open project, in one pane: "root, db
 * path, branch, remote - facts, one line each" (spec 2.8), then the server,
 * data and machine sections that used to be a pane of their own. Every field
 * is absent when the record does not carry it: a bare folder shows one line,
 * and that is the honest picture of a bare folder. */
function ProjectPane({ config }: { config: ConfigBody | null }) {
  const { project, readiness } = useShell();
  const git = readiness.data?.git ?? null;
  const db = config && !factoryAbsent(config) ? config.observability.db : null;

  return (
    <Pane heading="Project">
      <SectionColumns>
        <Section label="This project">
          <Field label="Root" value={project?.root ?? null} />
          <Field label="Db" value={db} />
          <Field label="Branch" value={git?.branch ?? null} />
          <Field label="Remote" value={git?.remote ?? null} />
        </Section>
        <PathsSections config={config} />
      </SectionColumns>
    </Pane>
  );
}

export default function Settings() {
  const { projectId } = useShell();
  const { pane } = useParams();
  const config = useProjectConfig(projectId);

  // Absolute, because the project is a path segment and an action must never
  // land on another project's settings (spec 2.1).
  const first = `/p/${projectId}/settings/project`;
  if (!pane) return <Navigate to={first} replace />;
  if (pane in MERGED) return <Navigate to={`/p/${projectId}/settings/${MERGED[pane]}`} replace />;
  if (!PANES.some((entry) => entry.id === pane)) return <Navigate to={first} replace />;

  const active = pane as PaneId;

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Settings" className="w-column shrink-0 overflow-y-auto border-r border-hairline p-2">
        {PANES.map((entry) => (
          <NavLink
            key={entry.id}
            to={`/p/${projectId}/settings/${entry.id}`}
            className={({ isActive }) =>
              `flex h-row items-center gap-2 rounded-chip px-2 text-body ${
                isActive
                  ? "bg-row-active text-t1 shadow-[inset_2px_0_0_var(--accent)]"
                  : "text-t2 hover:bg-row-hover hover:text-t1"
              }`
            }
          >
            <entry.icon className="size-3.5" />
            <span>{entry.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* A failed read keeps whatever the pane already had and says what the
            server said, at the position it happened - never a banner. */}
        {config.error ? <ReadFailure error={config.error} /> : null}
        <div className="min-h-0 flex-1">
          {active === "project" ? <ProjectPane config={config.data} /> : null}
          {active === "roster" ? <RosterPane config={config.data} /> : null}
          {active === "appearance" ? <AppearancePane /> : null}
        </div>
      </div>
    </div>
  );
}
