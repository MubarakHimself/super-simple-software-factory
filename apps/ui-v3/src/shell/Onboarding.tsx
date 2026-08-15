/**
 * First run — no projects are registered on this machine, so this is the whole
 * app (J1.1: "nothing blocks on network; empty states are honest and
 * directive").
 *
 * The rules this surface is built to keep:
 *  · No sidebar, no nav, no counts. A nav row reading "Board 0" would be
 *    pretending there is something to count.
 *  · ONE primary action. Adding a project is the only thing that can move this
 *    machine forward, so it is the only button.
 *  · One secondary word-link, "Connect a server". It does not route: Settings
 *    lives at `/p/:projectId/settings`, and with zero projects there is no
 *    project id to route with — a link that lands on "project not found" is a
 *    dead link wearing a live one's clothes. It opens the same connection
 *    truth the footer reads (`/api/app/factory/machines`), in place, and says
 *    where a server is added once a project exists.
 *
 * This surface exists only at zero projects. The moment one is registered the
 * normal shell takes over (see routes.tsx), so nothing here is a permanent
 * screen the operator has to dismiss.
 */
import { useState } from "react";
import type { Project } from "../lib/api.ts";
import { useResource } from "../lib/poll.ts";
import { Dot } from "../shared/Dot.tsx";
import { AddProject } from "./AddProject.tsx";
import { connectionLine, type MachinesResponse } from "./connection.ts";
import "./onboarding.css";

export function Onboarding({ onAdded }: { onAdded: (project: Project) => void }) {
  const [addOpen, setAddOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const machines = useResource<MachinesResponse>("machines", "/api/app/factory/machines");
  const connection = connectionLine(machines);

  return (
    <div className="onboarding">
      <div className="ob-card fade-in">
        <img className="ob-mark" src="/mark.svg" alt="" width={40} height={40} />
        <h1>SDL Factory</h1>
        <p className="ob-line">
          The factory runs coding work on your repositories by itself; you review what it built and decide what ships.
        </p>

        <button type="button" className="ob-primary" onClick={() => setAddOpen(true)}>
          Add your first project
        </button>

        <button type="button" className="ob-secondary" onClick={() => setConnectionOpen((was) => !was)}>
          Connect a server
        </button>

        {connectionOpen ? (
          <div className="ob-connection">
            <div className="ob-conn-line">
              <Dot tone={connection.tone} />
              <span className="ob-conn-text">{connection.text}</span>
            </div>
            {connection.detail ? <p className="ob-conn-detail">{connection.detail}</p> : null}
            <p className="ob-conn-detail">
              A server is added in Settings › Machines, which opens inside a project — so the project comes first, then
              the machine it runs on.
            </p>
          </div>
        ) : null}
      </div>

      {addOpen ? <AddProject onAdded={onAdded} onCancel={() => setAddOpen(false)} /> : null}
    </div>
  );
}
