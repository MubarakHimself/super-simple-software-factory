/**
 * Providers - no longer a pane of its own.
 *
 * The operator, looking at the settings nav: "there is providers then there is
 * roster, can't you just combine the two? What's the point of having two
 * different ones." He is right: a roster row names a lane, and this pane
 * existed to say whether that lane and its harness are real. Two pages to read
 * one answer. So this file keeps the two SECTIONS and `RosterPane` composes
 * them under the single Roster heading - the agents on top, what they run on
 * below.
 *
 * The sections themselves are unchanged in substance (spec 2.8, W3-C2):
 *
 *   "one `StatusTriple` row each - `● pi 0.9.4 - on PATH` / `○ codex - not on
 *    PATH; ...` - plus the lanes table (model, last round trip, tokens, run
 *    count): the only proof a model actually answers. **Nothing claims
 *    authentication** - we have no auth signal without reading credentials,
 *    and we must not. Refresh on page open + explicit control; no background
 *    poll."
 *
 * The sentence beside each identifier is the server's own `detail` string,
 * verbatim - including `'codex' was not found on PATH.`, which is
 * `electron/profiles.ts`'s exact wording and the same sentence a Session will
 * print for a missing harness. One honest sentence about a missing binary in
 * the whole app, not two.
 *
 * There is no auth column, no "signed in" chip and no key state anywhere -
 * not hidden, not blurred: the code path that would know does not exist here
 * (spec 2.8's rule kept from `specs/ui.md`:367).
 */
import { useShell } from "../App.tsx";
import { useResource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { StatusTriple } from "../shared/StatusTriple.tsx";
import type { Tone } from "../shared/Dot.tsx";
import type { LaneStatus } from "./config.ts";
import { Section } from "./parts.tsx";

export interface ProviderRow {
  id: string;
  bin: string;
  resolved_path: string | null;
  version: string | null;
  state: "ready" | "missing" | "error";
  detail: string;
}

/** `error` is a probe that ran and failed - a different fact from a binary
 * that is not there, and it keeps its own color rather than collapsing into
 * "missing" (the same rule Quality's `incomplete` follows, spec 2.5). */
export function providerTone(state: ProviderRow["state"]): Tone {
  if (state === "ready") return "ok";
  if (state === "error") return "fail";
  return "neutral";
}

function whenLocal(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/** The lanes that have actually answered, widest thing on the pane - a table
 * of machine output, so it goes wide rather than sitting in a prose column. */
export function LanesSection({ lanes }: { lanes: LaneStatus[] }) {
  return (
    <Section label="Lanes">
      {lanes.length === 0 ? (
        <p className="text-body text-t2">No lane has answered yet. The first run writes the first row here.</p>
      ) : (
        // Wide, but not stretched: four short columns spread across a metre of
        // window are the same dead space read sideways.
        <div className="w-full max-w-[1040px] overflow-x-auto">
          <table className="w-full border-collapse text-mono">
            <thead>
              <tr className="text-left text-meta text-t3">
                <th className="py-1.5 pr-6 font-normal">Lane</th>
                <th className="py-1.5 pr-6 font-normal">Last round trip</th>
                <th className="py-1.5 pr-6 text-right font-normal">Tokens</th>
                <th className="py-1.5 text-right font-normal">Runs</th>
              </tr>
            </thead>
            <tbody>
              {lanes.map((lane) => (
                <tr key={lane.provider_model} className="border-t border-hairline font-mono text-mono">
                  <td className="py-1.5 pr-6 text-t1">{lane.provider_model}</td>
                  <td className="py-1.5 pr-6 whitespace-nowrap text-t2">{whenLocal(lane.last_round_trip_at)}</td>
                  <td className="py-1.5 pr-6 text-right tabular-nums text-t2">{lane.last_round_trip_tokens ?? ""}</td>
                  <td className="py-1.5 text-right tabular-nums text-t2">{lane.run_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The honest answer to "add a provider here": this file has no place to
          put one. `sssf.config.yaml` names lanes (`provider/id` strings in
          `defaults.model` and each agent's `model:`); the catalog they resolve
          against is pi's, and `adws/adw_modules/agent_pi.py` resolves them at
          run time. A form here would be a form over a table this app does not
          own. */}
      <p className="max-w-[92ch] pt-3 text-body text-t3">
        A lane is a <span className="font-mono text-mono">provider/id</span> pair, and the rows above are where one
        is chosen. There is no provider list in{" "}
        <span className="font-mono text-mono">sssf.config.yaml</span> to add to - register the provider with pi
        itself, then name its lane on the agent that should run it.
      </p>
    </Section>
  );
}

/**
 * The provider harnesses, and only those - the four words the Terminal's
 * quick-links type into a shell.
 *
 * `uv`, `just` and `pi` are deliberately NOT here: they are the toolchain, they
 * already have their row in **Project > Machine** (`PathsSections`), and the
 * merge that folded Providers into Roster must not also duplicate three probes
 * onto two panes. The split is by question, not by endpoint - "can this machine
 * run the factory" is Project's, "does the harness behind this lane exist" is
 * this one's - even though both read `/api/app/providers`.
 */
const HARNESSES = ["claude", "codex", "grok", "agy"] as const;

export function MachineSection() {
  const { projectId } = useShell();
  // `projectId` is in the key so a project switch cannot leave the previous
  // project's read on screen (spec 2.1) - even though the endpoint itself is
  // machine-scoped, the pane is not.
  const providers = useResource<ProviderRow[]>(`${projectId}|providers`, "/api/app/providers");
  // Every harness keeps its slot in this order, with whatever the response
  // carried for it - a probe the server did not report says so rather than
  // vanishing, which is a different fact from a probe that failed (DEF-7).
  const rows = HARNESSES.map((id) => ({ id, row: (providers.data ?? []).find((row) => row.id === id) ?? null }));

  return (
    <Section label="Harnesses">
      <div className="flex flex-col gap-1.5">
        {providers.data
          ? rows.map(({ id, row }) =>
              row ? (
                <StatusTriple
                  key={id}
                  tone={providerTone(row.state)}
                  identifier={row.version ? `${row.id} ${row.version}` : row.id}
                  sentence={row.detail}
                />
              ) : (
                <StatusTriple key={id} tone="neutral" identifier={id} sentence="Not reported by the server." />
              ),
            )
          : null}
      </div>
      {providers.error ? <ReadFailure error={providers.error} /> : null}
      <button
        type="button"
        onClick={providers.refresh}
        className="mt-3 h-7 rounded-control border border-hairline bg-raised px-2.5 text-body text-t2 hover:border-accent hover:text-accent"
      >
        Refresh
      </button>
      <p className="pt-2 text-body text-t3">
        These are the words the Terminal's quick-links type. A missing one will fail in the shell; it is not a lane
        that is down.
      </p>
    </Section>
  );
}
