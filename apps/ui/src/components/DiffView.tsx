import { useEffect, useState } from "react";
import type { DiffResponse, DiffScope } from "@shared/types";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DiffSummary } from "@/components/DiffSummary";

/**
 * `Whole run | 01 commit_plan | 02 commit_build` selector over the shas the
 * factory's git phases already log, plus the summary card and patch (spec
 * 5.2.1) - the highest-value observability feature in the T3 notes.
 */
export function DiffView({
  adwId,
  scopes,
  initialScope,
}: {
  adwId: string;
  scopes: DiffScope[];
  initialScope?: string;
}) {
  const [scope, setScope] = useState(initialScope ?? "run");
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDiff(null);
    setError(null);
    let cancelled = false;
    api
      .diff(adwId, scope)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [adwId, scope]);

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex flex-wrap gap-1">
        {scopes.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setScope(s.id)}
            className={cn(
              "rounded-sm border px-1.5 py-0.5 text-[10.5px]",
              scope === s.id ? "border-primary text-foreground" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error && <div className="text-[11px] text-[var(--color-fail)]">{error}</div>}

      {diff && (
        <>
          <div className="text-[10.5px] text-muted-foreground">measured against: {diff.base}</div>
          <DiffSummary diff={diff} />
          {!diff.empty && diff.patch && (
            <pre className="mono flex-1 overflow-auto whitespace-pre rounded-md border border-border bg-elevated p-2.5 text-[10.5px] leading-relaxed text-foreground">
              {diff.patch}
            </pre>
          )}
          {diff.truncated && (
            <div className="text-[10.5px] text-[var(--color-warning)]">truncated at 2000 lines</div>
          )}
        </>
      )}
    </div>
  );
}
