import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  AgentEndPayload,
  AgentStartPayload,
  Event,
  GatePayload,
  HandoffPayload,
  LogPayload,
  Phase,
} from "@shared/types";
import { tokenCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Elapsed } from "@/components/Elapsed";
import { ToolCallRow } from "@/components/ToolCallRow";

function parsePayload<T>(json: string | null): T {
  if (!json) return {} as T;
  try {
    return JSON.parse(json) as T;
  } catch {
    return {} as T;
  }
}

type Block =
  | { kind: "tool_run"; events: Event[] }
  | { kind: "log_run"; events: Event[] }
  | { kind: "single"; event: Event };

/** Runs of consecutive tool_call or log events collapse into a counted stub -
 * the single best idea to steal (spec 7): a 400-event stream renders as a
 * screenful because only the newest of a run stays expanded. */
function blockify(events: Event[]): Block[] {
  const blocks: Block[] = [];
  let run: Event[] = [];
  let runType: "tool_call" | "log" | null = null;

  const flush = () => {
    if (run.length === 0) return;
    blocks.push({ kind: runType === "tool_call" ? "tool_run" : "log_run", events: run });
    run = [];
    runType = null;
  };

  for (const e of events) {
    if (e.type === "phase_start" || e.type === "phase_end") continue; // covered by header + Elapsed
    if (e.type === "tool_call" || e.type === "log") {
      if (runType !== null && runType !== e.type) flush();
      runType = e.type;
      run.push(e);
    } else {
      flush();
      blocks.push({ kind: "single", event: e });
    }
  }
  flush();
  return blocks;
}

function logLineText(e: Event): string {
  const p = parsePayload<LogPayload>(e.payload_json);
  if (p.message) return p.message;
  if (p.input) return `input: ${p.input}`;
  return e.payload_json ?? "";
}

function LogLine({ event }: { event: Event }) {
  return <div className="truncate py-0.5 pl-1 text-[11px] text-muted-foreground">{logLineText(event)}</div>;
}

function CollapsedRun({
  count,
  noun,
  children,
}: {
  count: number;
  noun: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-5 items-center gap-1 pl-1 text-[10.5px] text-[var(--color-text-meta)] hover:text-muted-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span>
          + {count} earlier {noun}
          {count === 1 ? "" : "s"}
        </span>
      </button>
      {open && <div className="border-l border-border pl-1.5">{children}</div>}
    </div>
  );
}

function ToolRunBlock({ events }: { events: Event[] }) {
  if (events.length === 1) return <ToolCallRow event={events[0]!} />;
  const earlier = events.slice(0, -1);
  const latest = events[events.length - 1]!;
  return (
    <div>
      <CollapsedRun count={earlier.length} noun="tool call">
        {earlier.map((e) => (
          <ToolCallRow key={e.event_id} event={e} />
        ))}
      </CollapsedRun>
      <ToolCallRow event={latest} />
    </div>
  );
}

function LogRunBlock({ events }: { events: Event[] }) {
  if (events.length === 1) return <LogLine event={events[0]!} />;
  const earlier = events.slice(0, -1);
  const latest = events[events.length - 1]!;
  return (
    <div>
      <CollapsedRun count={earlier.length} noun="log line">
        {earlier.map((e) => (
          <LogLine key={e.event_id} event={e} />
        ))}
      </CollapsedRun>
      <LogLine event={latest} />
    </div>
  );
}

/** error events never collapse (spec 5.2 work-log rule): a plain-English
 * line first, then the raw output in full - T3's leaky string is the
 * anti-pattern only because nothing explained it, not because it was raw. */
function ErrorBlock({ event, phaseName }: { event: Event; phaseName: string }) {
  const p = parsePayload<{ error?: string }>(event.payload_json);
  const raw = p.error ?? event.payload_json ?? "";
  const firstLine = raw.split("\n")[0] ?? "failed";
  const m = /exited (-?\d+)/.exec(firstLine);
  const plain = m ? `${phaseName} phase failed - ${firstLine}` : `${phaseName} phase failed.`;
  return (
    <div className="my-1 rounded-sm border-l-2 border-[var(--color-fail)] bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] py-1.5 pl-2 pr-2">
      <div className="text-[11.5px] font-medium text-[var(--color-fail)]">{plain}</div>
      {raw && <pre className="mono mt-1 max-h-[400px] overflow-auto whitespace-pre-wrap break-all text-[10.5px] text-muted-foreground">{raw}</pre>}
    </div>
  );
}

function AgentStartRow({ event }: { event: Event }) {
  const p = parsePayload<AgentStartPayload>(event.payload_json);
  return (
    <div className="my-1 flex items-center gap-1.5 border-t border-border pt-1 text-[10.5px] text-muted-foreground">
      {p.color && <span className="inline-block size-1.5 rounded-full" style={{ background: p.color }} />}
      <span className="font-medium text-foreground">{event.name}</span>
      <span className="mono">{p.model ?? "?"}</span>
      {p.session_id && <span className="mono text-[var(--color-text-meta)]">session {p.session_id}</span>}
    </div>
  );
}

function AgentEndRow({ event }: { event: Event }) {
  const p = parsePayload<AgentEndPayload>(event.payload_json);
  const usage = p.usage;
  return (
    <div className="my-1 flex items-center gap-2 border-b border-border pb-1 text-[10.5px] text-muted-foreground">
      <span className="font-medium text-foreground">{event.name} ended</span>
      {usage && (
        <span className="mono">
          spend {tokenCompact(usage.total_tokens)} . read {tokenCompact(usage.input_tokens + usage.cache_write_tokens)} . written{" "}
          {tokenCompact(usage.output_tokens)}
        </span>
      )}
    </div>
  );
}

function HandoffRow({ event }: { event: Event }) {
  const p = parsePayload<HandoffPayload>(event.payload_json);
  return (
    <div className="my-1 border-t border-dashed border-border pt-1 text-[10.5px] text-muted-foreground">
      <span className="font-medium text-foreground">handoff</span> - {p.summary ?? "(no summary)"}
      {p.artifacts && p.artifacts.length > 0 && <span className="mono"> . {p.artifacts.length} artifact(s)</span>}
    </div>
  );
}

function GateRow({ event }: { event: Event }) {
  const p = parsePayload<GatePayload>(event.payload_json);
  const passed = event.type === "gate_pass";
  return (
    <div className="flex items-center gap-1.5 py-0.5 pl-1 text-[11px]">
      <span
        className={cn(
          "inline-block size-1.5 rounded-full",
          passed ? "bg-[var(--color-success)]" : "bg-[var(--color-fail)]",
        )}
      />
      <span className="font-medium text-foreground">{event.name}</span>
      <span className="text-muted-foreground">{(p.checks ?? []).length} checked</span>
    </div>
  );
}

function PhaseBlock({
  phase,
  events,
  registerRef,
}: {
  phase: Phase;
  events: Event[];
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}) {
  const blocks = useMemo(() => blockify(events), [events]);
  return (
    <div ref={(el) => registerRef(phase.phase_id, el)} className="border-b border-border px-3 py-2">
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="mono text-[10.5px] text-[var(--color-text-meta)]">
          {phase.seq !== null ? String(phase.seq).padStart(2, "0") : "??"}
        </span>
        <span className="text-[12.5px] font-bold text-foreground">{phase.name}</span>
        <span className="text-[10.5px] text-muted-foreground">
          {phase.kind} - {phase.owner}
        </span>
      </div>
      {phase.description && <div className="mb-1.5 text-[11.5px] text-foreground/90">{phase.description}</div>}
      <div>
        {blocks.map((b, i) => {
          if (b.kind === "tool_run") return <ToolRunBlock key={i} events={b.events} />;
          if (b.kind === "log_run") return <LogRunBlock key={i} events={b.events} />;
          const e = b.event;
          if (e.type === "error") return <ErrorBlock key={i} event={e} phaseName={phase.name ?? "this"} />;
          if (e.type === "agent_start") return <AgentStartRow key={i} event={e} />;
          if (e.type === "agent_end") return <AgentEndRow key={i} event={e} />;
          if (e.type === "handoff") return <HandoffRow key={i} event={e} />;
          if (e.type === "gate_pass" || e.type === "gate_fail") return <GateRow key={i} event={e} />;
          return null;
        })}
      </div>
      <div className="mt-1.5">
        <Elapsed startedAt={phase.started_at} endedAt={phase.ended_at} />
      </div>
    </div>
  );
}

/** The heart of Trace (spec 5.2): each phase renders as a narrative header,
 * events collapse-and-count underneath, error blocks never collapse, and a
 * floating pill offers to jump back to the tail while it is live. */
export function WorkLog({
  phases,
  events,
  running,
  activePhaseId,
}: {
  phases: Phase[];
  events: Event[];
  running: boolean;
  activePhaseId: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const phaseRefs = useRef(new Map<string, HTMLDivElement>());
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  const eventsByPhase = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of events) {
      if (!e.phase_id) continue;
      const list = map.get(e.phase_id);
      if (list) list.push(e);
      else map.set(e.phase_id, [e]);
    }
    return map;
  }, [events]);

  const registerRef = (id: string, el: HTMLDivElement | null) => {
    if (el) phaseRefs.current.set(id, el);
    else phaseRefs.current.delete(id);
  };

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    setPinnedToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  useEffect(() => {
    if (!pinnedToBottom) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, pinnedToBottom]);

  useEffect(() => {
    if (!activePhaseId) return;
    phaseRefs.current.get(activePhaseId)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [activePhaseId]);

  const scrollToEnd = () => {
    const el = containerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setPinnedToBottom(true);
  };

  if (phases.length === 0) {
    return <div className="p-6 text-[12px] text-muted-foreground">no phases recorded yet</div>;
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={containerRef} onScroll={onScroll} className="h-full overflow-y-auto">
        {phases.map((phase) => (
          <PhaseBlock
            key={phase.phase_id}
            phase={phase}
            events={eventsByPhase.get(phase.phase_id) ?? []}
            registerRef={registerRef}
          />
        ))}
      </div>
      {running && !pinnedToBottom && (
        <button
          type="button"
          onClick={scrollToEnd}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-elevated px-2.5 py-1 text-[11px] text-foreground shadow-none hover:bg-elevated-hover"
        >
          <ChevronDown className="size-3" /> Scroll to end
        </button>
      )}
    </div>
  );
}
