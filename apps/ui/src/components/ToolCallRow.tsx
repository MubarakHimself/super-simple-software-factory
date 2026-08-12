import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Event, ToolCallPayload } from "@shared/types";
import { cn } from "@/lib/utils";

const TOOL_LABEL: Record<string, string> = {
  bash: "ran command",
  write: "wrote file",
  edit: "edited file",
  read: "read",
  grep: "searched",
  find: "found files",
  ls: "listed",
};

function splitName(name: string | null): { tool: string; target: string } {
  if (!name) return { tool: "tool", target: "" };
  const i = name.indexOf(": ");
  return i === -1 ? { tool: name, target: "" } : { tool: name.slice(0, i), target: name.slice(i + 2) };
}

/**
 * One 22px tool-call row: `>_` glyph, bold type, dim mono payload, right
 * edge ok/err + chevron. Expanded shows args and result_snippet (spec 5.2
 * work-log rule #3).
 */
export function ToolCallRow({ event }: { event: Event }) {
  const [open, setOpen] = useState(false);
  const { tool, target } = splitName(event.name);
  let payload: ToolCallPayload = {};
  try {
    payload = event.payload_json ? (JSON.parse(event.payload_json) as ToolCallPayload) : {};
  } catch {
    /* unparsed payload -> row still renders from event.name */
  }
  const ok = payload.ok ?? true;
  const label = TOOL_LABEL[tool] ?? tool;

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[22px] w-full items-center gap-1.5 px-1 text-left hover:bg-elevated"
      >
        <span className="mono w-3 shrink-0 text-[var(--color-text-meta)]">&gt;_</span>
        <span className="w-[92px] shrink-0 text-[11px] font-medium text-foreground">{label}</span>
        <span className="mono min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{target}</span>
        <span className={cn("mono shrink-0 text-[10px]", ok ? "text-[var(--color-success)]" : "text-[var(--color-fail)]")}>
          {ok ? "ok" : "err"}
        </span>
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mono ml-4 mb-1.5 space-y-1 rounded-sm bg-elevated p-2 text-[10.5px] text-muted-foreground">
          {payload.args && Object.keys(payload.args).length > 0 && (
            <div>
              <div className="mb-0.5 text-[var(--color-text-meta)]">args</div>
              <pre className="whitespace-pre-wrap break-all">{JSON.stringify(payload.args, null, 2)}</pre>
            </div>
          )}
          {payload.result_snippet && (
            <div>
              <div className="mb-0.5 text-[var(--color-text-meta)]">result</div>
              <pre className="whitespace-pre-wrap break-all">{payload.result_snippet}</pre>
            </div>
          )}
          {payload.duration_ms !== undefined && (
            <div className="text-[var(--color-text-meta)]">{payload.duration_ms}ms</div>
          )}
        </div>
      )}
    </div>
  );
}
