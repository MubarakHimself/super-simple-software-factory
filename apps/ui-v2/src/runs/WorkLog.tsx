/**
 * The work log (spec 2.5.3) - the server-folded `WorkLogEntry` stream, drawn
 * as one-line typed rows.
 *
 * The fold itself (tool name -> heading, first arg -> preview, `payload.ok`
 * -> status) is the server's job so that every harness collapses to the same
 * vocabulary before it reaches a component. This file owns three things and
 * only three: collapse-and-count, expansion, and the honest inline rows that
 * are not events at all (a phase's own error, and the stall line).
 *
 * Two traps are load-bearing here and both are stated in the spec:
 *   - `payload.ok` is an explicit boolean. T3's string-scan failure heuristic
 *     is deliberately NOT ported - our tracer is stricter, so a scan would
 *     invent failures the record does not claim.
 *   - nesting keys off `parent_id` TRUTHINESS, never null-ness: `parent_id`
 *     is the empty string on all 255 rows in this db, so `!== null` would
 *     indent every single event. The server sends `indent` already resolved.
 *
 * There is no token-level assistant stream in `sssf.db`, so there is no
 * streaming transcript here - by design, not by omission.
 */
import { useState } from "react";
import { clip } from "../lib/format.ts";
import { Dot } from "../shared/Dot.tsx";
import { IconChevronDown, IconDocs, IconFile, IconRuns, IconSession } from "../shared/Icons.tsx";
import { silence, type Stall } from "./stall.ts";
import type { PhaseWithBeat, WorkLogEntry } from "./types.ts";

/** Spec 2.3's `MAX_VISIBLE_WORK_LOG_ENTRIES = 1`, applied to Runs' own
 * grouping: the latest tool call shows, the rest collapse behind one count. */
const MAX_VISIBLE_TOOL_ENTRIES = 1;

function AgentChip({ color }: { color: string | null }) {
  // Real data only: `agent_sessions.color`. No color, no chip - the row is
  // simply not carrying one, which is the honest rendering of a null.
  if (!color) return <span className="size-[6px] shrink-0" aria-hidden="true" />;
  return (
    <span
      aria-hidden="true"
      className="size-[6px] shrink-0 rounded-chip"
      style={{ backgroundColor: color }}
    />
  );
}

function toolIcon(heading: string | undefined) {
  if (heading === "Ran commands") return <IconSession className="size-3" />;
  if (heading === "Edited a file") return <IconFile className="size-3" />;
  if (heading === "Read files") return <IconDocs className="size-3" />;
  return <IconRuns className="size-3" />;
}

const TOOL_MARK: Record<string, { glyph: string; className: string }> = {
  ok: { glyph: "✓", className: "text-ok" },
  fail: { glyph: "✕", className: "text-fail" },
  neutral: { glyph: "—", className: "text-neutral" },
};

function ToolRow({ entry }: { entry: WorkLogEntry }) {
  const [open, setOpen] = useState(false);
  const mark = TOOL_MARK[entry.status ?? "neutral"]!;
  const hasDetail = Boolean(entry.result_snippet) || Object.keys(entry.args ?? {}).length > 0;

  return (
    <div className={entry.indent ? "pl-4" : ""}>
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
        className="flex h-logrow w-full items-center gap-2 px-5 text-left hover:bg-row-hover disabled:cursor-default"
      >
        <AgentChip color={entry.agent_color} />
        <span className="shrink-0 text-t3">{toolIcon(entry.heading)}</span>
        <span className="shrink-0 text-body text-t2">{entry.heading}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-mono text-t3">{entry.preview}</span>
        <span aria-hidden="true" className={`shrink-0 text-meta ${mark.className}`}>
          {mark.glyph}
        </span>
        {hasDetail ? (
          <IconChevronDown className={`size-3 shrink-0 text-t3 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        ) : null}
      </button>
      {open ? (
        <pre className="mx-5 mb-2 max-h-64 overflow-auto rounded-control border border-hairline bg-raised px-3 py-2 font-mono text-mono text-t2">
          {JSON.stringify(entry.args ?? {}, null, 2)}
          {entry.result_snippet ? `\n\n${entry.result_snippet}` : ""}
        </pre>
      ) : null}
    </div>
  );
}

function ToolGroup({ entries }: { entries: WorkLogEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = entries.length - MAX_VISIBLE_TOOL_ENTRIES;
  const visible = expanded ? entries : entries.slice(-MAX_VISIBLE_TOOL_ENTRIES);

  return (
    <div>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex h-logrow w-full items-center gap-2 px-5 text-left font-mono text-meta text-t3 hover:text-t2"
        >
          <IconChevronDown className={`size-3 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
          {expanded ? `${hidden} previous tool calls` : `+${hidden} previous tool calls`}
        </button>
      ) : null}
      {visible.map((entry) => (
        <ToolRow key={entry.rowid} entry={entry} />
      ))}
    </div>
  );
}

function LogRow({ entry }: { entry: WorkLogEntry }) {
  return (
    <p className={`flex h-logrow items-center gap-2 px-5 font-mono text-mono text-t3 ${entry.indent ? "pl-9" : ""}`}>
      <AgentChip color={entry.agent_color} />
      <span className="min-w-0 truncate">{entry.text}</span>
    </p>
  );
}

function CommitRow({ entry }: { entry: WorkLogEntry }) {
  return (
    <p className="flex h-logrow items-center gap-2 px-5 text-body text-t2">
      <AgentChip color={entry.agent_color} />
      <span className="shrink-0 font-mono text-mono text-accent">{entry.sha?.slice(0, 7)}</span>
      <span className="min-w-0 flex-1 truncate">{entry.message}</span>
      {entry.file_count !== null && entry.file_count !== undefined ? (
        <span className="shrink-0 font-mono text-meta text-t3">{entry.file_count} files</span>
      ) : null}
    </p>
  );
}

/** `handoff.summary` renders as the phase's closing paragraph (spec 2.5.3) -
 * the one place in this surface where prose is the right shape. */
function HandoffRow({ entry }: { entry: WorkLogEntry }) {
  const [open, setOpen] = useState(false);
  const artifacts = entry.artifacts ?? [];
  return (
    <div className="px-5 py-2">
      <p className="flex items-baseline gap-2 text-body text-t1">
        <AgentChip color={entry.agent_color} />
        <span className="min-w-0">{entry.summary}</span>
      </p>
      {artifacts.length > 0 ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 flex items-center gap-2 font-mono text-meta text-t3 hover:text-t2"
        >
          <IconChevronDown className={`size-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
          {artifacts.length} artifacts
        </button>
      ) : null}
      {open ? (
        <ul className="mt-1 max-h-64 overflow-auto font-mono text-mono text-t3">
          {artifacts.map((path) => (
            <li key={path} className="truncate">
              {path}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A failure carries `phases.error` VERBATIM, clipped with an expander (spec
 * 2.5.3). The clip is a display bound; the expander shows the recorded string
 * unaltered, because a paraphrased error is a different error. */
function ErrorRow({ detail, attempt }: { detail: string; attempt: string | null }) {
  const [open, setOpen] = useState(false);
  const long = detail.length > 120;
  return (
    <div className="px-5 py-1">
      <p className="flex items-baseline gap-2 text-body">
        <span className="translate-y-[-2px]">
          <Dot tone="fail" />
        </span>
        <span className="min-w-0 font-mono text-mono text-fail">{open || !long ? detail : clip(detail, 120)}</span>
        {attempt ? <span className="shrink-0 font-mono text-meta text-t3">attempt {attempt}</span> : null}
      </p>
      {long ? (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 pl-4 font-mono text-meta text-t3 hover:text-t2">
          {open ? "less" : "more"}
        </button>
      ) : null}
    </div>
  );
}

function GateRow({ entry }: { entry: WorkLogEntry }) {
  return (
    <p className="flex h-logrow items-center gap-2 px-5 text-body text-t2">
      <span className="translate-y-[-2px]">
        <Dot tone={entry.passed ? "ok" : "fail"} />
      </span>
      <span className="font-mono text-mono">{entry.gate}</span>
      <span className="text-t3">{entry.passed ? "passed" : "failed"}</span>
    </p>
  );
}

/**
 * The stall line, rendered where it happened: an inline log entry, never a
 * spinner, never a banner, never a silent gap (spec 2.5.6, the Codex idiom).
 * `stopped` carries pid evidence from `processes` - timestamps only.
 */
function StallRow({ stall }: { stall: Stall }) {
  const quiet = `no output for ${silence(stall.silentMinutes)}`;
  const parts =
    stall.kind === "stopped"
      ? ["Stopped", quiet, stall.lastStep ? `last step: ${stall.lastStep}` : null]
      : [`No output for ${silence(stall.silentMinutes)}`];

  return (
    <p className="flex items-baseline gap-2 px-5 py-1 text-body">
      <span className="translate-y-[-2px]">
        <Dot tone="warn" />
      </span>
      <span className="text-warn">{parts.filter(Boolean).join(" · ")}</span>
      {stall.pid !== null ? (
        <span className="font-mono text-meta text-t3">
          pid {stall.pid}
          {stall.pidEndedAt ? ` ended ${stall.pidEndedAt.slice(11, 19)}` : ""}
        </span>
      ) : null}
    </p>
  );
}

// -- the stream ------------------------------------------------------------

type Block =
  | { kind: "tools"; key: string; entries: WorkLogEntry[] }
  | { kind: "entry"; key: string; entry: WorkLogEntry }
  | { kind: "phase-error"; key: string; detail: string; attempt: string | null };

/**
 * Groups consecutive tool calls and drops each phase's own error in at the
 * boundary where that phase stopped being the one talking - the position it
 * happened, which is the whole idiom (spec 3.6's "honest inline log entries").
 */
export function buildBlocks(entries: WorkLogEntry[], phases: PhaseWithBeat[]): Block[] {
  const errorByPhase = new Map<string, { detail: string; attempt: string | null }>();
  for (const p of phases) {
    if (!p.error) continue;
    const attempt = (p.retries ?? 0) > 0 ? `${(p.attempt ?? 0) + 1} of ${(p.retries ?? 0) + 1}` : null;
    errorByPhase.set(p.phase_id, { detail: p.error, attempt });
  }

  const blocks: Block[] = [];
  let tools: WorkLogEntry[] = [];
  let phaseId: string | null = null;

  const flushTools = () => {
    if (tools.length === 0) return;
    blocks.push({ kind: "tools", key: `tools-${tools[0]!.rowid}`, entries: tools });
    tools = [];
  };
  const flushPhaseError = (id: string | null) => {
    if (!id) return;
    const error = errorByPhase.get(id);
    if (!error) return;
    errorByPhase.delete(id);
    blocks.push({ kind: "phase-error", key: `err-${id}`, detail: error.detail, attempt: error.attempt });
  };

  for (const entry of entries) {
    if (entry.phase_id !== phaseId) {
      flushTools();
      flushPhaseError(phaseId);
      phaseId = entry.phase_id;
    }
    if (entry.kind === "tool") {
      tools.push(entry);
      continue;
    }
    flushTools();
    blocks.push({ kind: "entry", key: `e-${entry.rowid}`, entry });
  }
  flushTools();
  flushPhaseError(phaseId);
  // A phase that failed without ever emitting an event still says so.
  for (const [id, error] of errorByPhase) {
    blocks.push({ kind: "phase-error", key: `err-${id}`, detail: error.detail, attempt: error.attempt });
  }
  return blocks;
}

export function WorkLog({
  entries,
  phases,
  stall,
}: {
  entries: WorkLogEntry[];
  phases: PhaseWithBeat[];
  stall: Stall | null;
}) {
  const blocks = buildBlocks(entries, phases);

  return (
    <div className="py-2">
      {blocks.map((block) => {
        if (block.kind === "tools") return <ToolGroup key={block.key} entries={block.entries} />;
        if (block.kind === "phase-error")
          return <ErrorRow key={block.key} detail={block.detail} attempt={block.attempt} />;
        const entry = block.entry;
        if (entry.kind === "commit") return <CommitRow key={block.key} entry={entry} />;
        if (entry.kind === "handoff") return <HandoffRow key={block.key} entry={entry} />;
        if (entry.kind === "error") return <ErrorRow key={block.key} detail={entry.detail ?? ""} attempt={null} />;
        if (entry.kind === "gate") return <GateRow key={block.key} entry={entry} />;
        return <LogRow key={block.key} entry={entry} />;
      })}
      {stall ? <StallRow stall={stall} /> : null}
    </div>
  );
}
