import { useEffect, useState } from "react";
import type { AgentPrompts, DiffScope, Envelope, GateCheck, GateResult, Phase } from "@shared/types";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DiffView } from "@/components/DiffView";
import { EmptyState } from "@/components/EmptyState";

function DetailTab({ phase }: { phase: Phase | null }) {
  if (!phase) return <EmptyState message="Select a phase in the timeline above to inspect it." />;
  const rows: [string, string][] = [
    ["phase", `${phase.seq ?? "?"} ${phase.name ?? ""}`],
    ["kind", phase.kind ?? "-"],
    ["owner", phase.owner ?? "-"],
    ["status", phase.status ?? "-"],
    ["attempt", String(phase.attempt ?? 0)],
    ["retries", String(phase.retries ?? 0)],
    ["started", phase.started_at ?? "-"],
    ["ended", phase.ended_at ?? "still running"],
  ];
  return (
    <div className="p-3 text-[11.5px]">
      <div className="mb-2 font-medium text-foreground">{phase.description}</div>
      <table className="w-full">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b border-border/60 last:border-b-0">
              <td className="py-1 pr-2 align-top text-muted-foreground">{k}</td>
              <td className="mono py-1 text-foreground">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {phase.error && (
        <div className="mt-2 rounded-sm border-l-2 border-[var(--color-fail)] bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-2">
          <div className="mb-1 text-[11px] font-medium text-[var(--color-fail)]">error</div>
          <pre className="mono whitespace-pre-wrap break-all text-[10.5px] text-muted-foreground">{phase.error}</pre>
        </div>
      )}
    </div>
  );
}

function EnvelopesTab({ phase, envelopes }: { phase: Phase | null; envelopes: Envelope[] }) {
  if (!phase) return <EmptyState message="Envelopes are per-phase - select an agent phase above." />;
  const forPhase = envelopes.filter((e) => e.phase_id === phase.phase_id);
  if (phase.kind !== "agent" && forPhase.length === 0) {
    return <EmptyState message="Only agent phases produce envelopes - this is a code/engineer phase." />;
  }
  if (forPhase.length === 0) return <EmptyState message="No envelope recorded for this phase yet." />;
  return (
    <div className="space-y-2 p-3">
      {forPhase.map((e) => {
        let pretty = e.payload_json ?? "";
        try {
          pretty = JSON.stringify(JSON.parse(e.payload_json ?? "{}"), null, 2);
        } catch {
          /* keep raw */
        }
        return (
          <div key={e.envelope_id} className="rounded-md border border-border bg-elevated p-2">
            <div className="mb-1 flex items-center gap-2 text-[11px]">
              <span className="font-medium text-foreground">
                attempt {e.attempt} {e.valid ? "valid" : "invalid"}
              </span>
              <Badge variant={e.valid ? "success" : "fail"}>{e.output_type ?? "output"}</Badge>
            </div>
            <pre className="mono max-h-[360px] overflow-auto whitespace-pre-wrap break-all text-[10.5px] text-muted-foreground">
              {pretty}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

function GatesTab({ phase, gates }: { phase: Phase | null; gates: GateResult[] }) {
  if (!phase) return <EmptyState message="Gates are per-phase - select an agent phase above." />;
  const forPhase = gates.filter((g) => g.phase_id === phase.phase_id);
  if (forPhase.length === 0) {
    return <EmptyState message="Gates verify agent-phase claims (e.g. artifacts_exist). None ran for this phase." />;
  }
  return (
    <div className="space-y-2 p-3">
      {forPhase.map((g) => {
        let checks: GateCheck[] = [];
        try {
          checks = g.checks_json ? (JSON.parse(g.checks_json) as GateCheck[]) : [];
        } catch {
          /* no checks recorded */
        }
        let violations: string[] = [];
        try {
          violations = g.violations_json ? (JSON.parse(g.violations_json) as string[]) : [];
        } catch {
          /* none */
        }
        return (
          <div key={g.id} className="rounded-md border border-border bg-elevated p-2">
            <div className="mb-1 flex items-center gap-2 text-[11px]">
              <span className="font-medium text-foreground">{g.gate}</span>
              <Badge variant={g.passed ? "success" : "fail"}>{g.passed ? "passed" : "failed"}</Badge>
              <span className="text-muted-foreground">attempt {g.attempt}</span>
            </div>
            {checks.map((c, i) => (
              <div key={i} className="mono flex items-start gap-1.5 py-0.5 text-[10.5px]">
                <span className={c.ok ? "text-[var(--color-success)]" : "text-[var(--color-fail)]"}>
                  {c.ok ? "ok" : "fail"}
                </span>
                <span className="min-w-0 flex-1 break-all text-muted-foreground">
                  {c.item} - {c.note}
                </span>
              </div>
            ))}
            {violations.length > 0 && (
              <div className="mt-1 text-[10.5px] text-[var(--color-fail)]">
                {violations.map((v, i) => (
                  <div key={i}>{v}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PromptsTab({ adwId, phase }: { adwId: string; phase: Phase | null }) {
  const [prompts, setPrompts] = useState<AgentPrompts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agent = phase?.kind === "agent" ? phase.owner : null;

  useEffect(() => {
    setPrompts(null);
    setError(null);
    if (!agent) return;
    let cancelled = false;
    api
      .prompts(adwId, agent)
      .then((p) => {
        if (!cancelled) setPrompts(p);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [adwId, agent]);

  if (!phase) return <EmptyState message="Prompts are per-agent-phase - select one above." />;
  if (!agent) return <EmptyState message="Only agent phases have prompts - this is a code/engineer phase." />;
  if (error) return <div className="p-3 text-[11px] text-[var(--color-fail)]">{error}</div>;
  if (!prompts) return <div className="p-3 text-[11px] text-muted-foreground">loading...</div>;
  if (!prompts.system && !prompts.user) {
    return <EmptyState message={`${agent} never ran in this session - no prompt files on disk.`} />;
  }
  return (
    <div className="space-y-3 p-3">
      {prompts.system && (
        <div>
          <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">system.md</div>
          <pre className="mono max-h-[280px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-elevated p-2 text-[10.5px] text-foreground">
            {prompts.system}
          </pre>
        </div>
      )}
      {prompts.user && (
        <div>
          <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">user.md</div>
          <pre className="mono max-h-[280px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-elevated p-2 text-[10.5px] text-foreground">
            {prompts.user}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Right inspector, phase-scoped: Detail, Envelopes, Gates, Prompts, Diff
 * (spec 5.2 L2 #4). */
export function Inspector({
  adwId,
  phase,
  envelopes,
  gates,
  diffScopes,
}: {
  adwId: string;
  phase: Phase | null;
  envelopes: Envelope[];
  gates: GateResult[];
  diffScopes: DiffScope[];
}) {
  const defaultDiffScope = phase && diffScopes.some((s) => s.id === phase.phase_id) ? phase.phase_id : "run";
  return (
    <Tabs defaultValue="detail" className="h-full min-h-0">
      <TabsList className="flex-wrap px-2">
        <TabsTrigger value="detail">Detail</TabsTrigger>
        <TabsTrigger value="envelopes">Envelopes</TabsTrigger>
        <TabsTrigger value="gates">Gates</TabsTrigger>
        <TabsTrigger value="prompts">Prompts</TabsTrigger>
        <TabsTrigger value="diff">Diff</TabsTrigger>
      </TabsList>
      <TabsContent value="detail" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <DetailTab phase={phase} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="envelopes" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <EnvelopesTab phase={phase} envelopes={envelopes} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="gates" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <GatesTab phase={phase} gates={gates} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="prompts" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <PromptsTab adwId={adwId} phase={phase} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="diff" className="min-h-0 flex-1">
        <DiffView adwId={adwId} scopes={diffScopes} initialScope={defaultDiffScope} />
      </TabsContent>
    </Tabs>
  );
}
