/**
 * The run header - two lines, and nothing interactive (spec 2.5.1).
 *
 * "A composer is structurally absent - the Runs route never mounts one
 * (W1-F1, 'a Run is not a Session'; ratified observe-only). Where a Session
 * shows a composer, a Run shows this header strip and nothing interactive: no
 * input, no steer, no queue, no answering an ask." That is why this file has
 * no props for callbacks and no buttons: the absence is structural, not a
 * disabled state someone could re-enable.
 *
 * Line 2 is `branch · worktree path · lane · adw name` plus the run's own
 * totals, "each field absent when the record lacks it, never invented".
 * Every run in this db has a null title and a null branch, so this header
 * degrades to `adw_prompt · pi · <model> · 12,769 tok · $0` - which is what
 * the record actually holds. `total_cost` renders as `0` because `0.0` is the
 * recorded value on this flat-rate lane, not because a number was missing.
 */
import { Dot, type Tone } from "../shared/Dot.tsx";
import { Elapsed } from "../shared/Elapsed.tsx";
import { laneOf, runTitle, tokens, type RunDetail } from "./types.ts";

const TONE: Record<string, Tone> = { running: "run", success: "ok", fail: "fail" };

export function RunHeader({ detail, worktreePath }: { detail: RunDetail; worktreePath: string | null }) {
  const run = detail.session;
  const title = runTitle({ title: detail.title, request: run.request, adw_id: run.adw_id });
  const lane = laneOf(detail.agents);
  const tok = tokens(run.total_tokens);
  const running = run.ended_at === null;

  const facts: string[] = [];
  if (detail.branch) facts.push(detail.branch);
  // The worktree path lives in the run's own `branch` trace event, which the
  // live poll already carries for a running run; a run that never cut a
  // worktree has none, and none renders (spec 2.5.1's "absent when null").
  if (worktreePath) facts.push(worktreePath);
  if (lane.coding_agent) facts.push(lane.coding_agent);
  if (lane.model) facts.push(lane.model);
  if (run.adw_name) facts.push(run.adw_name);
  if (tok) facts.push(`${tok} tok`);
  if (run.total_cost !== null && Number.isFinite(run.total_cost)) facts.push(`$${run.total_cost}`);

  return (
    <header className="shrink-0 border-b border-hairline px-5 py-3">
      <div className="flex items-baseline gap-3">
        <h1
          className={`min-w-0 flex-1 truncate text-head font-semibold text-t1 ${title.mono ? "font-mono" : ""}`}
          title={run.adw_id}
        >
          {title.text}
        </h1>
        <span className="flex shrink-0 items-center gap-2 text-body text-t2">
          <Dot tone={TONE[run.status ?? ""] ?? "neutral"} pulse={running} />
          {running ? (
            <>
              <span>Working for</span>
              {run.started_at ? <Elapsed since={run.started_at} format="clock" className="text-t1" /> : null}
            </>
          ) : (
            <>
              {run.status ? <span className="font-mono text-meta text-t3">{run.status}</span> : null}
              <span>Worked for</span>
              {run.started_at ? (
                <Elapsed since={run.started_at} until={run.ended_at} format="span" className="text-t1" />
              ) : null}
            </>
          )}
        </span>
      </div>
      {facts.length > 0 ? (
        <p className="mt-1 truncate font-mono text-meta text-t3">{facts.join(" · ")}</p>
      ) : null}
    </header>
  );
}
