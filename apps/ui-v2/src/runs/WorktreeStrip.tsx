/**
 * The Worktrees strip (spec 2.5): "A collapsed one-line-per-tree Worktrees
 * strip below the list."
 *
 * The words are the ones `just worktrees` prints, copied from `worktrees.py`
 * `classify()` and its `_STATE_ORDER`: `alive`, `orphan`, `unmerged`,
 * `merged`, `no-tree`. The word is **`alive`** - `live` is not a state this
 * factory has, and renaming it would teach the operator a second vocabulary
 * for one fact.
 *
 * Collapsed means not fetched: `/worktrees` runs a fistful of `git` processes
 * per run, and the strip is one line until the operator asks for it. Opening
 * it is the request.
 */
import { useState } from "react";
import { useResource } from "../lib/poll.ts";
import { Dot, type Tone } from "../shared/Dot.tsx";
import { IconChevronDown } from "../shared/Icons.tsx";
import { ReadFailure } from "../shell/EmptyState.tsx";
import type { WorktreeItem, WorktreeState } from "./types.ts";

const TONE: Record<WorktreeState, Tone> = {
  alive: "run",
  unmerged: "warn",
  orphan: "fail",
  merged: "neutral",
  "no-tree": "idle",
};

export function WorktreeStrip({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useResource<WorktreeItem[]>(
    open ? `${projectId}|worktrees` : null,
    open ? `/api/app/p/${encodeURIComponent(projectId)}/worktrees` : null,
  );
  const items = data ?? [];

  return (
    <div className="shrink-0 border-t border-hairline">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-row w-full items-center gap-2 px-3 text-left text-meta text-t3 hover:text-t2"
      >
        <IconChevronDown className={`size-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        <span>Worktrees</span>
        {open && data ? <span className="ml-auto font-mono">{items.length}</span> : null}
      </button>
      {open ? (
        <div className="max-h-40 overflow-y-auto border-t border-hairline">
          {error ? <ReadFailure error={error} /> : null}
          {items.map((item) => (
            <p
              key={`${item.adw_id}-${item.branch}`}
              title={item.note || undefined}
              className="flex h-logrow items-center gap-2 px-3 font-mono text-meta text-t3"
            >
              <Dot tone={TONE[item.state]} />
              <span className="min-w-0 flex-1 truncate text-t2">{item.branch || item.adw_id}</span>
              {item.dirty ? <span className="shrink-0 text-warn">dirty</span> : null}
              <span className="shrink-0">{item.state}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
