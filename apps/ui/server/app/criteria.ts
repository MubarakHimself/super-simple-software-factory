/**
 * `/api/app/p/:id/queue` (spec 4, chunk K2a) - the existing `QueueResponse`
 * (`readQueue`, unmodified - queue.ts is not this chunk's to edit) plus
 * `items[].criteria:[{text,done}]`, extracted with the exact same checkbox
 * regex `queue.ts`'s own `countCriteria` already counts with, and the one
 * `~/.claude/skills/morning-brief/scripts/collect_runs.py` reads (spec 1.3's
 * table, row `/api/app/p/:id/queue`) - so a card's criteria list means the
 * same thing everywhere the factory shows one.
 */
import { readQueue } from "../queue.ts";
import type { QueueItem, QueueResponse } from "../../shared/types.ts";
import { appError, appJson, appSafely } from "./guard.ts";
import { getScope, param } from "./scoped.ts";

export interface CriteriaLine {
  text: string;
  done: boolean;
}

const CRITERIA_LINE = /^[ \t]*-\s*\[( |x|X)\](.*)$/gm;

/** Same acceptance-criteria checkbox line `queue.ts`'s `countCriteria`
 * matches, but returning the texts too (spec's `{text,done}` shape) instead
 * of only a count - Board's inspector and Gate's acceptance walk both need
 * the sentence, not just the number. */
export function extractCriteria(body: string): CriteriaLine[] {
  const lines: CriteriaLine[] = [];
  for (const m of body.matchAll(CRITERIA_LINE)) {
    const mark = m[1];
    const text = (m[2] ?? "").trim();
    lines.push({ text, done: mark === "x" || mark === "X" });
  }
  return lines;
}

export interface QueueItemWithCriteria extends QueueItem {
  criteria: CriteriaLine[];
}

export interface ScopedQueueResponse extends Omit<QueueResponse, "items"> {
  items: QueueItemWithCriteria[];
}

async function getQueue(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);

  // Deliberately does not gate on `scope.db` - a bare/greenfield project can
  // have a queue/ directory with no factory installed yet (spec's Board
  // empty state: "this repo's queue/ holds only TEMPLATE.md", no db needed
  // to say so), and `readQueue` already degrades an absent directory to
  // `{items:[], unparsed:[]}` on its own.
  const queue = await readQueue(scope.queueDir);
  const items: QueueItemWithCriteria[] = queue.items.map((item) => ({
    ...item,
    criteria: extractCriteria(item.body),
  }));

  return appJson({ dir: queue.dir, items, unparsed: queue.unparsed } satisfies ScopedQueueResponse);
}

export const criteriaRoutes = {
  "/api/app/p/:id/queue": appSafely(getQueue),
};
