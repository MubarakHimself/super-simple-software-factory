/**
 * The factory-status footer: the strip at the bottom of the sidebar that says
 * whether the factory is alive, what the queue holds, and how long it has been
 * up. Drawn in home-v2.html as pulse line / Queue / Uptime / Help.
 *
 * Its source of truth is `GET /api/app/p/:id/factory/health` (see the
 * `FactoryHealth` shape in lib/api.ts, which accepts both the nested and the
 * flat queue-count forms).
 *
 * Four honest states, and no fifth:
 *   - the read has not answered yet      -> "Reading factory status…"
 *   - the read failed (or 404s, because  -> "Factory status unavailable" plus
 *     the endpoint is not deployed)         the server's own error string
 *   - engine unknown                     -> says exactly that, with the
 *                                           server's own reason underneath
 *   - engine running / stopped           -> the mock's own sentence, plus the
 *                                           machine that reported it
 *
 * That last clause is the whole of "things are happening in the vps, but i do
 * not know": the engine has never run on this laptop, so the strip used to say
 * "Factory status unknown - no engine runs on this machine" while the factory
 * was busy on a VPS. `/factory/health` now asks the machine the project names
 * (server/app/remote.ts), and when it answers, `source_host` is on the line -
 * "Factory running on 155.133.27.86". A machine that could NOT be reached
 * still reads unknown, with the SSH error as the reason: this strip never
 * upgrades silence into a state.
 *
 * Below Help sits the CONNECTION line: the mark, small, beside the machine
 * this app is actually talking to - "this machine · <hostname>", "connected ·
 * <server>", "not connected · <server>", or the honest unknown while the read
 * is out. Its source is `GET /api/app/factory/machines`, derived once in
 * `connection.ts` so the footer and the first-run surface cannot disagree.
 *
 * A count the server could not know is NEVER printed as a zero. `lanes_active:
 * null` means the clause about lanes is dropped from the sentence, and the
 * reason line carries why. `source: "local-derived"` is stated inline rather
 * than hidden: a number this machine worked out is a weaker claim than one a
 * running engine reported.
 */
import { useState } from "react";
import type { FactoryHealth } from "../lib/api.ts";
import { formatUptime, plural } from "../lib/format.ts";
import { useResource, type Resource } from "../lib/poll.ts";
import { Dot, type Tone } from "../shared/Dot.tsx";
import { HelpIcon } from "../shared/Icons.tsx";
import { connectionLine, type MachinesResponse } from "./connection.ts";
import { Help } from "./Help.tsx";
import "./onboarding.css";

const NOTHING = "—";

interface Strip {
  tone: Tone;
  pulse: boolean;
  text: string;
  /** The server's own sentence about why something is unknown. */
  reason: string | null;
  /** True when `reason` is a failed read rather than an explanation. */
  reasonIsFailure: boolean;
  queue: string;
  uptime: string;
  uptimeTitle: string | undefined;
}

/** "2 ready · 3 running" from whichever shape the server sent; the em dash
 * when it sent neither. */
function queueLine(data: FactoryHealth): string {
  const ready = data.queue?.ready ?? data.queue_ready;
  const running = data.queue?.running ?? data.queue_running;
  if (typeof ready !== "number" && typeof running !== "number") return NOTHING;
  return `${ready ?? NOTHING} ready · ${running ?? NOTHING} running`;
}

function strip(health: Resource<FactoryHealth>): Strip {
  const blank = { queue: NOTHING, uptime: NOTHING, uptimeTitle: undefined, reason: null, reasonIsFailure: false };
  if (!health.data) {
    if (health.error) {
      return { tone: "fail", pulse: false, text: "Factory status unavailable", ...blank, reason: health.error, reasonIsFailure: true };
    }
    if (health.loading) return { tone: "idle", pulse: false, text: "Reading factory status…", ...blank };
    return { tone: "idle", pulse: false, text: "No factory connected", ...blank };
  }

  const data = health.data;
  // A stale read after a good one keeps the good data and still says so;
  // otherwise the server's own reason for what it could not know.
  const reason = health.error ?? data.engine_reason ?? data.lanes_reason ?? null;
  // "derived here" is only worth a clause when no reason line is carrying that
  // same nuance already - the strip is 240px wide and every word costs a wrap.
  const derived = data.source === "local-derived" && !reason ? " · derived here" : "";
  // The engine lives on a machine, not here. When the server asked one, its
  // name goes on the line - "Factory stopped on 155.133.27.86" is the whole
  // fix for "things are happening in the vps, but i do not know". The longer
  // sentence (why, since when, what the journal said) is the reason line
  // underneath, which is already the server's own words.
  const where = data.source_host ? ` on ${data.source_host}` : "";
  const lanes = typeof data.lanes_active === "number" ? ` · ${plural(data.lanes_active, "active lane")}` : "";
  const common = {
    reason,
    reasonIsFailure: health.error !== null,
    queue: queueLine(data),
    uptime: formatUptime(data.uptime_seconds),
    uptimeTitle: data.uptime_seconds === null ? (data.uptime_reason ?? undefined) : undefined,
  };

  if (data.engine === "running") {
    return { tone: "ok", pulse: true, text: `Factory running${where}${lanes}${derived}`, ...common };
  }
  if (data.engine === "stopped") {
    // With a host on the line, "· nothing is running" is a second way of
    // saying the same thing in a 240px strip, so it is dropped there.
    const tail = where === "" ? " · nothing is running" : "";
    return { tone: "fail", pulse: false, text: `Factory stopped${where}${tail}${derived}`, ...common };
  }
  return { tone: "idle", pulse: false, text: `Factory status unknown${derived}`, ...common };
}

export function FactoryStatus({ health }: { health: Resource<FactoryHealth> }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const view = strip(health);
  // The row under Help used to be the app's own name — a caption that told the
  // operator nothing he did not already know, in the one place where "which
  // machine am I looking at?" belongs. It is the connection now, from the same
  // machines read Settings > Machines renders (see connection.ts), including
  // the honest unknown.
  const machines = useResource<MachinesResponse>("machines", "/api/app/factory/machines");
  const connection = connectionLine(machines);

  return (
    <div className="factory-status">
      <div className="fs-pulse">
        <Dot tone={view.tone} pulse={view.pulse} />
        <span className="fs-text">{view.text}</span>
      </div>
      {view.reason ? (
        <div className={`fs-reason${view.reasonIsFailure ? "" : " muted"}`} title={view.reason}>
          {view.reason}
        </div>
      ) : null}
      <div className="fs-line">
        <span className="fs-label">Queue</span>
        <span className="fs-val">{view.queue}</span>
      </div>
      <div className="fs-line" title={view.uptimeTitle}>
        <span className="fs-label">Uptime</span>
        <span className="fs-val">{view.uptime}</span>
      </div>
      {/* The mock's row reads "Help & shortcuts". There are no keyboard
          shortcuts in this app - by standing rule, every action is a button or
          a word-link - so advertising them would be a lie. The row says Help,
          and the panel behind it says that plainly. */}
      <button type="button" className="fs-help" onClick={() => setHelpOpen(true)}>
        <HelpIcon />
        <span>Help</span>
      </button>
      {/* The operator's mark - three rising amber bars (the parked
          sdl-factory-mark, ratified into the app 2026-08-15) - now beside the
          connection rather than beside the app's own name. The title carries
          the server's own longer sentence; the strip is 240px wide and the
          short truth is what has to fit. */}
      <div className="fs-connection" title={connection.detail ?? undefined}>
        <img src="/mark.svg" alt="" width={14} height={14} aria-hidden="true" />
        <span className="fs-conn-text">{connection.text}</span>
      </div>
      {helpOpen ? <Help onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}
