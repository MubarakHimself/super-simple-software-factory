/**
 * Machines (global — "Factory defaults") — J1 and change-list #11: v1 is ONE
 * server plus localhost. The default-machine and failover selects stay drawn
 * and are disabled with that reason.
 *
 * Reads `GET /api/app/factory/machines`. That endpoint always returns the
 * localhost row ("planning only - no factory", exactly as drawn) and adds the
 * server row only when `~/.sdl-factory/server.json` names a host. It never
 * invents one, and it never says "connected" about a machine this process has
 * not spoken to — `status: "configured"` is as far as it goes, with the reason
 * attached. This pane prints those words rather than upgrading them.
 */
import type { Resource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { PlusIcon } from "./icons.tsx";
import type { MachineRow, MachinesResponse } from "./types.ts";

function Row({ machine }: { machine: MachineRow }) {
  const isLocal = machine.kind === "local";
  return (
    <div className="machine-row">
      <div
        className="mc-icon"
        style={
          isLocal
            ? { background: "var(--raised)", color: "var(--t2)" }
            : { background: "var(--accent-surface)", color: "var(--accent)" }
        }
      >
        {machine.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="mc-body">
        <div className="mc-name">
          {machine.name}
          {isLocal ? <span className="mc-tag dim">planning only</span> : <span className="mc-tag">factory</span>}
        </div>
        <div className="mc-meta">{machine.status_reason}</div>
      </div>
      <div className="mc-ip">{machine.host ?? "—"}</div>
      <div className="mc-factory">
        <span className="dot" style={{ background: "var(--t3)" }} />
        {machine.factory_version
          ? `factory · ${machine.factory_version}`
          : isLocal
            ? "no factory"
            : "factory version unknown here"}
      </div>
      <div className="mc-status" title={machine.status_reason}>
        <span className="dot" style={{ background: "var(--t3)" }} />
        {machine.status}
        {machine.runs === null ? "" : ` · ${machine.runs} runs`}
      </div>
      <div className="mc-actions">
        {isLocal ? (
          <button type="button" className="pr-btn" disabled title="there is nothing to test: the app already runs here, and the engine does not">
            Test
          </button>
        ) : (
          <>
            <button type="button" className="pr-btn" disabled title="opening a shell on the server needs the SSH connection, which lands with the server plane">
              SSH
            </button>
            <button type="button" className="pr-btn danger" disabled title="removing the server means rewriting ~/.sdl-factory/server.json — a write this app does not make yet">
              Remove
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function Machines({
  machines,
}: {
  /** Fired once by the Settings surface (the tab count reads the same
   * response), handed down so this tab costs no second request. */
  machines: Resource<MachinesResponse>;
}) {
  const rows = machines.data?.machines ?? [];

  return (
    <div className="form-body-content fade-in">
      <div className="form-panel-title">
        Machines · <span className="scope-name-inline">Factory defaults</span>
      </div>
      <div className="form-panel-sub">
        VPS servers that run factory instances. Each project dispatches its work to one machine. Plan locally, run
        remotely.
      </div>

      {machines.error ? <ReadFailure error={machines.error} /> : null}

      <div className="form-section">
        <div className="form-section-title">
          <span>
            Connected servers <span className="section-plain">— where factory instances run</span>
          </span>
          <button
            type="button"
            className="section-action"
            disabled
            title="adding a server writes ~/.sdl-factory/server.json and provisions over SSH — it lands with the server connection"
          >
            <PlusIcon /> Add server
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="section-empty">
            {machines.loading
              ? "Reading this machine's server settings…"
              : machines.error && !machines.data
                ? "The machines read failed, so not even this machine's own row could be drawn — the line above carries the server's own words."
                : machines.data?.reason}
          </p>
        ) : (
          <div className="machine-list">
            {rows.map((machine) => (
              <Row key={machine.id} machine={machine} />
            ))}
          </div>
        )}

        {machines.data && !machines.data.server_configured ? (
          <p className="section-note">
            <strong>No factory server is configured on this machine.</strong> {machines.data.reason}
          </p>
        ) : null}
        <p className="section-note">
          A server row says <strong>configured</strong>, never <strong>connected</strong>: this app has not spoken to that
          machine from here, so its engine, its factory version and its run count are unknown until the connection lands.
          Add server, SSH and Remove all need that same connection, which is why they are drawn and disabled.
        </p>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          <span>Default dispatch</span>
        </div>
        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Default machine for new projects</div>
            <div className="form-hint">Where a project runs if no machine is explicitly set</div>
          </div>
          <select className="form-select compact" disabled value="v1">
            <option value="v1">one server in v1</option>
          </select>
        </div>
        <div className="form-row">
          <div className="form-label-group">
            <div className="form-label">Failover</div>
            <div className="form-hint">If the primary machine is unreachable, fall back to…</div>
          </div>
          <select className="form-select compact" disabled value="v1">
            <option value="v1">one server in v1</option>
          </select>
        </div>
        <p className="section-note">
          Both selects are drawn for the multi-machine round and disabled today: v1 is <strong>one server plus
          localhost</strong>, so there is no second machine to default to or fall back on.
        </p>
      </div>

      <div className="lane-callout">
        <div className="lc-title">Why machines matter</div>
        <div className="lc-body">
          Planning happens on your laptop. Factory execution happens on a VPS so runs don&apos;t compete with your local
          tools for CPU and RAM. Each project binds to one machine — you can see which one in the Runs and Board views.
        </div>
      </div>
    </div>
  );
}
