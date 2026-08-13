import type { AgentSession, Phase, ProcessRow, Session, SessionUsage } from "@shared/types";
import { tokenCompact, tokenCount } from "@/lib/format";
import { buildStatusTriple } from "@/lib/status";
import { StatusTriple } from "@/components/StatusTriple";
import { Badge } from "@/components/ui/badge";

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="mono inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
      {children}
    </span>
  );
}

/** The status triple, never a bare enum, plus a row of static metadata pills
 * (T3's composer pills, display-only here) - spec 5.2 L2 #1. */
export function RunHeader({
  session,
  phases,
  processes,
  agents,
  usage,
  now,
  latestEventAt,
  branch,
  title,
  baseRefLabel,
}: {
  session: Session;
  phases: Phase[];
  processes: ProcessRow[];
  agents: AgentSession[];
  usage: SessionUsage;
  now: number;
  latestEventAt: string | null | undefined;
  branch: string | null;
  title: string | null;
  baseRefLabel?: string | null;
}) {
  const triple = buildStatusTriple(session, phases, processes, now, latestEventAt);
  const seenAgents = new Map<string, AgentSession>();
  for (const a of agents) seenAgents.set(a.agent, a); // last write wins - most current

  return (
    <div className="border-b border-border bg-chrome px-3 py-2">
      {/* Title first, id small/dim - the same rule as RunList: the human
       * name is the headline, the id is a lookup key, not the label. */}
      <div className="flex items-baseline gap-2">
        <h1 className="min-w-0 truncate text-[13px] font-semibold text-foreground">
          {title || session.request || "(untitled run)"}
        </h1>
        <span className="mono shrink-0 text-[10px] text-[var(--color-text-meta)]">{session.adw_id}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <StatusTriple dot={triple.dot} label={triple.label} sentence={triple.sentence} />
        {session.archived === 1 && (
          <Badge variant="dim" className="text-[10px]">
            archived
          </Badge>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Pill>{session.adw_name ?? "adw"}</Pill>
        <Pill>{session.engineer ?? "unknown"}</Pill>
        {Array.from(seenAgents.values()).map((a) => (
          <Pill key={a.agent}>
            {a.color && <span className="inline-block size-1.5 rounded-full" style={{ background: a.color }} />}
            {a.agent}
            {a.model ? ` ${a.model}` : ""}
          </Pill>
        ))}
        {branch && <Pill>branch {branch}</Pill>}
        <Pill>spend {tokenCount(session.total_tokens)}</Pill>
        <Pill>
          read {tokenCompact(usage.read)} . written {tokenCompact(usage.written)}
        </Pill>
        {baseRefLabel && <Pill>base {baseRefLabel}</Pill>}
      </div>
    </div>
  );
}
