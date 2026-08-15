/**
 * Settings — the scope pane, the five tabs, the auto-save bar
 * (settings-v3.html; journeys J1/J2/J6; change-list 5, 10, 11, 12).
 *
 * ── Scope is the route, not a piece of state ───────────────────────────────
 * The mock's `selectScope()` flips a variable. Here the project is already a
 * path segment (`/p/:projectId/settings/:pane`), so scope is DERIVED from the
 * pane: `roster` and `lanes` are per-project, `providers`, `machines` and
 * `appearance` are the factory's own. That is the mock's own rule
 * (`PER_PROJECT_TABS` / `GLOBAL_TABS`) expressed as routing, which means a
 * settings tab is linkable, survives a reload, and can never disagree with the
 * project the rest of the window has open.
 *
 * Switching scope in the list therefore navigates: another project keeps the
 * tab you were on when that tab exists in the new scope, and lands on Roster
 * when it does not — exactly what the mock's "if the active tab is now hidden,
 * switch to the first allowed tab" does.
 *
 * ── One read per fact ──────────────────────────────────────────────────────
 * The four reads that both the tab counts and the panes need are fired HERE
 * and handed down, so opening Settings costs one read each rather than one per
 * pane — and the counts on the tab strip are real numbers from real responses,
 * absent (not zero) until a response lands. Roster's own model catalog stays
 * inside Roster: nothing else reads it.
 *
 * ── The add-project modal ──────────────────────────────────────────────────
 * `./AddProject.tsx` is the full journey the mock draws (name, path, live
 * detection, sync mode, roster inheritance, and a step list that reports what
 * each endpoint actually did). It is mounted here, from the scope list's "Add
 * project…", because this chunk owns `src/settings/**`. The sidebar switcher's
 * own "Add project…" still opens the shell's minimal modal
 * (`shell/AddProject.tsx`); pointing that trigger at this one is a single-line
 * change in the shell's file, which belongs to the shell chunk, not this one.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useShell } from "../App.tsx";
import type { Project } from "../lib/api.ts";
import { useResource } from "../lib/poll.ts";
import { colorForIndex } from "../lib/projectColor.ts";
import { AddProject } from "./AddProject.tsx";
import { Appearance } from "./Appearance.tsx";
import { Lanes } from "./Lanes.tsx";
import { Machines } from "./Machines.tsx";
import { Providers } from "./Providers.tsx";
import { Roster } from "./Roster.tsx";
import { saveLine, useSaveReporter } from "./save.ts";
import "./settings.css";
import {
  isFactoryAbsent,
  type ConfigRead,
  type LanesResponse,
  type MachinesResponse,
  type ProviderDefinitionsResponse,
} from "./types.ts";

type Pane = "roster" | "lanes" | "providers" | "machines" | "appearance";

/** The mock's own two lists, verbatim (`PER_PROJECT_TABS` / `GLOBAL_TABS`). */
const PER_PROJECT: Pane[] = ["roster", "lanes"];
const GLOBAL: Pane[] = ["providers", "machines", "appearance"];

const LABEL: Record<Pane, string> = {
  roster: "Roster",
  lanes: "Lanes",
  providers: "Providers",
  machines: "Machines",
  appearance: "Appearance",
};

/**
 * What the save bar says before anything has been changed. It is per pane
 * because the panes differ in what they can write, and one blanket "edits save
 * as you make them" would be false on three of the five.
 */
const IDLE_LINE: Record<Pane, string> = {
  roster: "Nothing changed yet — model and thinking level save into the config file as you pick them.",
  lanes: "Nothing to save here — this tab has no writes; the lane switches move on screen only.",
  providers: "Nothing to save here — every write on this tab needs the factory machine's connection.",
  machines: "Nothing to save here — the server row is read from this machine's own settings file.",
  appearance: "Nothing changed yet — these preferences save in this browser profile only.",
};

function isPane(value: string | undefined): value is Pane {
  return value === "roster" || value === "lanes" || value === "providers" || value === "machines" || value === "appearance";
}

export default function Settings() {
  const { projectId, project, projects, refreshProjects } = useShell();
  const params = useParams();
  const navigate = useNavigate();
  const report = useSaveReporter();
  const [addOpen, setAddOpen] = useState(false);

  const pane: Pane = isPane(params.pane) ? params.pane : "roster";
  const scope: "project" | "global" = GLOBAL.includes(pane) ? "global" : "project";
  const encoded = encodeURIComponent(projectId);
  const projectName = project?.name ?? projectId;
  const scopeName = scope === "global" ? "Factory defaults" : projectName;

  const config = useResource<ConfigRead>(`${projectId}|config`, `/api/app/p/${encoded}/config`);
  const lanes = useResource<LanesResponse>(`${projectId}|lanes`, `/api/app/p/${encoded}/lanes`);
  const definitions = useResource<ProviderDefinitionsResponse>(
    `${projectId}|provider-definitions`,
    `/api/app/p/${encoded}/factory/providers`,
  );
  const machines = useResource<MachinesResponse>("machines", "/api/app/factory/machines");

  // A sentence about the roster must not still be on screen while the operator
  // reads Appearance. Changing pane or project clears the bar.
  const { reset } = report;
  useEffect(() => {
    reset();
  }, [pane, projectId, reset]);

  const goPane = useCallback((next: Pane) => navigate(`/p/${encoded}/settings/${next}`), [encoded, navigate]);

  const goProject = useCallback(
    (id: string) => {
      const keep: Pane = scope === "project" ? pane : "roster";
      navigate(`/p/${encodeURIComponent(id)}/settings/${keep}`);
    },
    [navigate, pane, scope],
  );

  const goGlobal = useCallback(() => {
    if (scope !== "global") navigate(`/p/${encoded}/settings/providers`);
  }, [encoded, navigate, scope]);

  const onAdded = useCallback(
    (added: Project) => {
      setAddOpen(false);
      refreshProjects();
      navigate(`/p/${encodeURIComponent(added.id)}/settings/roster`);
    },
    [navigate, refreshProjects],
  );

  // A count is a fact from a landed response. Before one lands (or after one
  // fails) the tab carries no number rather than a zero it did not read.
  const rosterCount = config.data && !isFactoryAbsent(config.data) ? config.data.roster.length : null;
  const counts: Record<Pane, number | null> = {
    roster: rosterCount,
    lanes: lanes.data?.lanes.length ?? null,
    providers: definitions.data?.providers.length ?? null,
    machines: machines.data?.machines.length ?? null,
    appearance: null,
  };

  const line = saveLine(report.state, scopeName, IDLE_LINE[pane]);
  const tabs = scope === "global" ? GLOBAL : PER_PROJECT;

  return (
    <>
      <div className="scope-pane">
        <div className="scope-header">
          <div className="label">Editing scope</div>
          <h2>Settings for</h2>
        </div>

        <div className="scope-list">
          <div className="scope-section-label">Per project</div>
          {projects.map((entry, index) => (
            <button
              type="button"
              key={entry.id}
              className={`scope-item${entry.id === projectId && scope === "project" ? " active" : ""}`}
              onClick={() => goProject(entry.id)}
            >
              <span className="si-dot" style={{ background: colorForIndex(index) }} />
              <span className="si-name">{entry.name}</span>
              {entry.id === projectId ? <span className="si-badge">open</span> : null}
            </button>
          ))}

          <button type="button" className="scope-add" onClick={() => setAddOpen(true)}>
            <span className="si-dot" style={{ background: "transparent", border: "1px dashed var(--accent)" }} />
            <span>Add project…</span>
          </button>

          <div className="scope-section-label" style={{ marginTop: 12 }}>
            Global
          </div>
          <button type="button" className={`scope-item${scope === "global" ? " active" : ""}`} onClick={goGlobal}>
            <span className="si-dot" style={{ background: "var(--t3)" }} />
            <span className="si-name">Factory defaults</span>
          </button>
        </div>

        <div className="scope-footer">
          <span className="global">Roster and lanes</span> belong to one project&apos;s config file. Providers, machines and
          appearance are the same for every project on this machine.
        </div>
      </div>

      <div className="form-pane">
        <div className="form-tabs">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab}
              className={`form-tab${tab === pane ? " active" : ""}`}
              onClick={() => goPane(tab)}
            >
              {LABEL[tab]}
              {counts[tab] === null ? null : <span className="tab-count">{counts[tab]}</span>}
            </button>
          ))}
        </div>

        <div className="form-body">
          {pane === "roster" ? (
            <Roster projectId={projectId} projectName={projectName} report={report} config={config} definitions={definitions} />
          ) : null}
          {pane === "lanes" ? <Lanes projectName={projectName} report={report} lanes={lanes} /> : null}
          {pane === "providers" ? <Providers projectName={projectName} definitions={definitions} /> : null}
          {pane === "machines" ? <Machines machines={machines} /> : null}
          {pane === "appearance" ? <Appearance report={report} /> : null}
        </div>

        <div className={`save-status-bar ${line.className}`}>
          <span className="dot" />
          <span className="save-text" title={line.text}>
            {line.text}
          </span>
        </div>
      </div>

      {addOpen ? <AddProject onClose={() => setAddOpen(false)} onAdded={onAdded} /> : null}
    </>
  );
}
