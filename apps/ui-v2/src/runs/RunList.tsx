/**
 * The run list - the second column Runs owns (spec 2.5).
 *
 * Row shape is fixed at three lines and a fixed height, which is the whole
 * answer to audit F14's "12 identical rows": title, then branch, then lane.
 * `adw_id` is a hover/copy affordance and never a label (spec 3.7).
 *
 *   ● Add a health endpoint          2m 41s
 *     build · builder                adw/a1b2c3d4_add-a-health-endpoint
 *     pi · kimi-k2.7-code · 41.2k tok
 *
 * Every token is absent-when-null rather than blank-padded, so a row whose
 * record is thin (every run in this db: no title, no branch) reads short
 * instead of reading `-` four times. The height does not change either way.
 *
 * Installer self-checks are excluded by default and the fact is VISIBLE, not
 * silent: one dim footer line that toggles them (spec 2.5, audit F1's kill).
 */
import { Link } from "react-router-dom";
import { Dot, type Tone } from "../shared/Dot.tsx";
import { Elapsed } from "../shared/Elapsed.tsx";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { laneOf, runTitle, tokens, type Run, type RunStatus } from "./types.ts";

const TONE: Record<RunStatus, Tone> = { running: "run", success: "ok", fail: "fail" };

function toneOf(status: RunStatus | null): Tone {
  return status ? TONE[status] : "neutral";
}

/** The phase the row reports: the open one while running, else the last one
 * the record holds. `name · owner` - the factory's own two words. */
function stepOf(run: Run): string | null {
  const phases = run.phases;
  if (phases.length === 0) return null;
  const open = [...phases].reverse().find((p) => p.started_at && !p.ended_at);
  const phase = open ?? phases[phases.length - 1]!;
  return [phase.name, phase.owner].filter(Boolean).join(" · ") || null;
}

function RunRow({ run, projectId, selected }: { run: Run; projectId: string; selected: boolean }) {
  const title = runTitle(run);
  const lane = laneOf(run.agents);
  const step = stepOf(run);
  const tok = tokens(run.total_tokens);
  const line3 = [lane.coding_agent, lane.model, tok ? `${tok} tok` : null].filter(Boolean).join(" · ");

  return (
    <Link
      to={`/p/${projectId}/runs/${run.adw_id}`}
      title={run.adw_id}
      className={[
        "flex h-[74px] shrink-0 flex-col justify-center gap-[3px] border-b border-hairline px-4 no-underline",
        selected ? "bg-row-active shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-row-hover",
      ].join(" ")}
    >
      <span className="flex items-center gap-2">
        <Dot tone={toneOf(run.status)} pulse={run.status === "running"} />
        <span className={`min-w-0 flex-1 truncate text-body text-t1 ${title.mono ? "font-mono text-mono" : ""}`}>
          {title.text}
        </span>
        {run.status ? <span className="shrink-0 font-mono text-meta text-t3">{run.status}</span> : null}
        {run.started_at ? (
          <Elapsed
            since={run.started_at}
            until={run.ended_at}
            format={run.ended_at ? "span" : "clock"}
            className="shrink-0 text-meta text-t2"
          />
        ) : null}
      </span>
      <span className="flex items-center gap-3 pl-[14px] text-meta text-t3">
        <span className="min-w-0 truncate">{step}</span>
      </span>
      <span className="truncate pl-[14px] font-mono text-meta text-t3">{line3}</span>
    </Link>
  );
}

export function RunList({
  projectId,
  runs,
  hiddenSelfChecks,
  showSelfChecks,
  onToggleSelfChecks,
  selectedAdwId,
  error,
}: {
  projectId: string;
  runs: Run[];
  hiddenSelfChecks: number;
  showSelfChecks: boolean;
  onToggleSelfChecks: () => void;
  selectedAdwId: string | null;
  error: string | null;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs.map((run) => (
          <RunRow key={run.adw_id} run={run} projectId={projectId} selected={run.adw_id === selectedAdwId} />
        ))}
      </div>
      {error ? <ReadFailure error={error} /> : null}
      {hiddenSelfChecks > 0 ? (
        <button
          type="button"
          onClick={onToggleSelfChecks}
          className="flex h-row shrink-0 items-center border-t border-hairline px-3 text-left text-meta text-t3 hover:text-t2"
        >
          {hiddenSelfChecks} self-checks {showSelfChecks ? "shown" : "hidden"}
        </button>
      ) : null}
    </div>
  );
}
