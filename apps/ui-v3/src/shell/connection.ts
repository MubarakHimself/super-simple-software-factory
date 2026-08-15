/**
 * "Where is this app talking to?" — one derivation, two readers (the footer's
 * connection line and the first-run surface's Connect-a-server note), so the
 * two can never say different things about the same machine.
 *
 * Source: `GET /api/app/factory/machines` (`server/app/factory.ts`). That
 * endpoint always returns the localhost row and adds a server row only when
 * `~/.sdl-factory/server.json` names a host. It never says "connected" about a
 * machine this process has not spoken to — the strongest word it will use for
 * a configured-but-unreached server is `configured`, with its own reason
 * attached. This file prints those words; it never upgrades them.
 */
import type { Resource } from "../lib/poll.ts";
import type { Tone } from "../shared/Dot.tsx";

export interface MachineRow {
  id: string;
  name: string;
  kind: "local" | "server";
  role: string;
  host: string | null;
  status: string;
  status_reason: string;
  factory_version: string | null;
  runs: number | null;
}

export interface MachinesResponse {
  machines: MachineRow[];
  server_configured: boolean;
  multi_machine_supported: boolean;
  reason: string | null;
}

export interface ConnectionLine {
  tone: Tone;
  /** The one short truth: "connected · <name>", "not connected · <name>",
   * "this machine · <hostname>". Never a word the server did not earn. */
  text: string;
  /** The server's own longer sentence, for a title or a second line. */
  detail: string | null;
}

export function connectionLine(machines: Resource<MachinesResponse>): ConnectionLine {
  if (!machines.data) {
    if (machines.error) return { tone: "fail", text: "connection unknown", detail: machines.error };
    if (machines.loading) return { tone: "idle", text: "reading connection…", detail: null };
    return { tone: "idle", text: "connection unknown", detail: null };
  }

  const data = machines.data;
  // Defensive on purpose: the machines endpoint is being extended by another
  // lane in this same wave. A reshaped payload must degrade this line to the
  // honest unknown, never take the sidebar down with it.
  const rows = Array.isArray(data.machines) ? data.machines : [];
  const server = rows.find((machine) => machine?.kind === "server") ?? null;
  const local = rows.find((machine) => machine?.kind === "local") ?? null;
  if (!server && !local) {
    return { tone: "idle", text: "connection unknown", detail: data.reason ?? null };
  }

  if (server) {
    const connected = (server.status ?? "").toLowerCase() === "connected";
    return {
      tone: connected ? "ok" : "warn",
      text: `${connected ? "connected" : "not connected"} · ${server.name ?? "server"}`,
      detail: server.status_reason ?? null,
    };
  }

  return {
    tone: "idle",
    text: `this machine · ${local?.name ?? "localhost"}`,
    detail: data.reason ?? local?.status_reason ?? null,
  };
}
