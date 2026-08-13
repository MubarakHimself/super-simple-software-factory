import type { ConfigResponse } from "@shared/types";
import { relativeTime, tokenCount } from "@/lib/format";
import { StatusTriple } from "@/components/StatusTriple";
import { ServerPane } from "@/components/ServerPane";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-3 py-4 first:pt-0">
      <h2 className="mb-2 text-[13px] font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5 text-[11px]">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className="mono min-w-0 flex-1 break-words text-foreground">{value}</span>
    </div>
  );
}

/** Read-only in v1 (spec 5.5): roster cards from sssf.config.yaml, lane
 * status derived only from real round trips in the db, observability and
 * process paths. Never reads .env, never returns a key/token/secret. */
export function SettingsPanes({ config }: { config: ConfigResponse }) {
  return (
    <div className="mx-auto max-w-[640px] px-4 py-2">
      <Section id="roster" title="Roster">
        <div className="mb-3 rounded-md border border-border bg-elevated p-2.5">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            defaults (applied unless an agent overrides)
          </div>
          <Field label="coding_agent" value={config.defaults.coding_agent ?? "-"} />
          <Field label="model" value={config.defaults.model ?? "-"} />
          <Field label="thinking" value={config.defaults.thinking ?? "-"} />
          <Field label="tools" value={config.defaults.tools.join(", ") || "(none)"} />
          <Field label="protected_files" value={config.defaults.protected_files.join(", ") || "(none)"} />
        </div>
        <div className="space-y-2">
          {config.roster.map((agent) => (
            <div key={agent.name} className="rounded-md border border-border bg-elevated p-2.5">
              <div className="flex items-center gap-1.5">
                {agent.color && <span className="inline-block size-2 rounded-full" style={{ background: agent.color }} />}
                <span className="text-[12px] font-semibold text-foreground">{agent.name}</span>
                <span className="mono text-[10.5px] text-muted-foreground">
                  {agent.model}
                  {agent.model_inherited && <span className="text-[var(--color-text-meta)]"> (inherited)</span>}
                </span>
              </div>
              {agent.purpose && <div className="mt-1 text-[11px] text-foreground">{agent.purpose}</div>}
              <div className="mt-1.5">
                <Field
                  label="thinking"
                  value={
                    <>
                      {agent.thinking}
                      {agent.thinking_inherited && <span className="text-[var(--color-text-meta)]"> (inherited)</span>}
                    </>
                  }
                />
                <Field label="tools" value={agent.tools.join(", ") || "(none)"} />
                <Field
                  label="writes"
                  value={
                    agent.writes === null
                      ? "unrestricted"
                      : agent.writes.length === 0
                        ? "read-only with respect to the repo"
                        : agent.writes.join(", ")
                  }
                />
                <Field label="harness_engineering" value={agent.harness_engineering.join(", ") || "(none)"} />
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Separator />

      <Section id="lanes" title="Lanes">
        <p className="mb-2 text-[11px] text-muted-foreground">
          Derived only from real round trips in this db - `pi auth check` lies in both directions, so there is no
          liveness probe here.
        </p>
        <div className="space-y-1.5">
          {config.lanes.length === 0 && (
            <div className="text-[11px] text-muted-foreground">no round trips recorded in this db yet.</div>
          )}
          {config.lanes.map((lane) => (
            <div key={lane.provider_model} className="rounded-md border border-border bg-elevated px-2.5 py-1.5">
              {lane.exercised ? (
                <StatusTriple
                  dot="success"
                  label={lane.provider_model}
                  sentence={`last real round trip ${relativeTime(lane.last_round_trip_at)}, ${tokenCount(lane.last_round_trip_tokens)} tokens, ${lane.run_count} run${lane.run_count === 1 ? "" : "s"}`}
                />
              ) : (
                <StatusTriple
                  dot="dim"
                  label={lane.provider_model}
                  sentence="never exercised on this box. A lane is verified only by a round trip returning non-zero tokens."
                />
              )}
            </div>
          ))}
        </div>
      </Section>

      <Separator />

      <Section id="observability" title="Observability">
        <Field label="db" value={config.observability.db} />
        <Field label="journal_mode" value={config.observability.journal_mode} />
        <Field label="poll_ms" value={config.observability.poll_ms} />
        <Field label="session count" value={config.observability.session_count} />
        <Field label="data_dir" value={config.observability.data_dir} />
        <Field label="sessions_dir" value={config.observability.sessions_dir} />
        <Field label="protected_files" value={config.observability.protected_files.join(", ") || "(none)"} />
      </Section>

      <Separator />

      <Section id="server" title="Server">
        <p className="mb-2 text-[11px] text-muted-foreground">
          Desktop-only (spec 5): deploy this factory to a remote host over ssh, or connect through a port-forward to
          view its live data. Read-only stays read-only across the tunnel - the far end is the same GET-only server.
        </p>
        <ServerPane />
      </Section>

      <Separator />

      <Section id="paths" title="Paths and process">
        <Field label="bind address" value={config.paths.bind} />
        <Field label="port" value={config.paths.port} />
        <Field label="build time" value={config.paths.build_time ?? "no build found (dev mode)"} />
        <Field label="mode" value={<Badge variant="dim">read-only</Badge>} />
      </Section>
    </div>
  );
}
