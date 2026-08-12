import type { GateCheck, GateItem } from "@shared/types";
import { relativeTime, truncate } from "@/lib/format";
import { navigate, tracePath } from "@/routes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusTriple } from "@/components/StatusTriple";
import { DiffView } from "@/components/DiffView";

function parseChecks(checksJson: string | null): GateCheck[] {
  try {
    return checksJson ? (JSON.parse(checksJson) as GateCheck[]) : [];
  } catch {
    return [];
  }
}

/**
 * Gate 2's raw material, not a decision engine (spec 5.4): status triple,
 * diff summary, verification strip, and the merge button as a plain link -
 * this UI never runs gh, never pushes, never merges.
 */
export function GateCard({ item, now }: { item: GateItem; now: number }) {
  const totalFiles = item.diff.files.length;
  const sentence = `built ${relativeTime(item.ended_at, now)} on ${item.branch}, ${totalFiles} file${totalFiles === 1 ? "" : "s"} +${item.diff.added} -${item.diff.deleted}`;

  return (
    <div className="rounded-md border border-border bg-elevated p-3">
      <StatusTriple dot="warning" label="Waiting" sentence={sentence} />
      {item.request && <div className="mt-1.5 text-[11.5px] text-foreground">{truncate(item.request, 140)}</div>}

      <div className="mt-2">
        <DiffView adwId={item.adw_id} scopes={item.diff_scopes} />
      </div>

      <div className="mt-2 space-y-1.5 border-t border-border pt-2">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-16 shrink-0 text-muted-foreground">quality</span>
          {item.quality ? (
            <Badge variant={item.quality.passed ? "success" : "fail"}>{item.quality.passed ? "passed" : "failed"}</Badge>
          ) : (
            <span className="text-[var(--color-text-meta)]">no quality phase in this chain</span>
          )}
        </div>
        {item.gates.map((g) => {
          const checks = parseChecks(g.checks_json);
          return (
            <div key={g.id}>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="w-16 shrink-0 truncate text-muted-foreground">{g.gate}</span>
                <Badge variant={g.passed ? "success" : "fail"}>{g.passed ? "passed" : "failed"}</Badge>
              </div>
              {checks.map((c, i) => (
                <div key={i} className="mono ml-[72px] flex items-start gap-1.5 py-0.5 text-[10.5px]">
                  <span className={c.ok ? "text-[var(--color-success)]" : "text-[var(--color-fail)]"}>
                    {c.ok ? "ok" : "fail"}
                  </span>
                  <span className="min-w-0 flex-1 break-all text-muted-foreground">
                    {c.item} - {c.note}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
        <div className="flex gap-2 text-[11px]">
          <span className="w-16 shrink-0 text-muted-foreground">reviewer</span>
          <span className="min-w-0 flex-1 text-foreground">
            {item.reviewer_summary ?? <span className="text-[var(--color-text-meta)]">no reviewer envelope recorded</span>}
          </span>
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-2 border-t border-border pt-2.5">
        {item.compare_url ? (
          <Button asChild size="sm">
            <a href={item.compare_url} target="_blank" rel="noreferrer">
              Open pull request
            </a>
          </Button>
        ) : (
          <div className="flex flex-1 flex-col gap-1">
            <span className="text-[10.5px] text-muted-foreground">
              {item.remote_kind === "none"
                ? "No origin remote, so there is no pull request to open. Push the branch first:"
                : "Non-github remote, so there is no compare-url pull request to open. Push it, then open a PR on your git host:"}
            </span>
            <code className="mono w-fit truncate rounded-sm border border-border bg-canvas px-1.5 py-0.5 text-[10.5px] text-foreground">
              {item.push_command}
            </code>
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={() => navigate(tracePath(item.adw_id))}>
          Open trace
        </Button>
      </div>
    </div>
  );
}
