/**
 * `GET /api/app/p/:id/cards` - the Board's whole truth about a queue card,
 * including the two things the v1 `/queue` read could not say: what a card is
 * WAITING ON, and whether a parked card is integrated or already shipped.
 *
 * Why a new endpoint instead of widening `/queue`: `server/queue.ts` is read
 * by the parked v1/v2 SPAs and by `merge.ts`, and it reads exactly one
 * directory (`queue/`). The v3 Board needs `queue/done/` in the same list -
 * the Done column badges integrated/shipped (docs/user-journeys.md change #4)
 * - so this module reads both and leaves `queue.ts` untouched.
 *
 * ── The header grammar is not re-invented ──────────────────────────────────
 * `parseHeaderBlock` below mirrors `server/queue.ts`'s function of the same
 * name and `adws/dispatch.py`'s `parse_header` line for line: an H1, then the
 * contiguous run of `Key: value` lines directly under it, ending at the first
 * blank line or the first line that is not a field. A file one of the three
 * calls malformed is malformed to all three. `Needs:` is comma-split exactly
 * the way `dispatch.py:_parse_needs` splits it.
 *
 * ── The lifecycle (docs/user-journeys.md, "Card lifecycle") ────────────────
 *   ready-for-agent -> running -> done (the run finished and pushed)
 *                   -> integrated (the ENGINE parked the card in queue/done/)
 *                   -> shipped (inside a chunk squash on main)
 * plus `blocked`, which carries its own `Blocked-reason:` line.
 *
 * ── integrated vs shipped: how it is decided, and why ──────────────────────
 * `git ls-tree -r --name-only <main> -- queue/done` - ONE git call for the
 * whole set. A card parked in `queue/done/` whose file `main`'s tree already
 * holds shipped with that chunk's squash; one `main` does not hold is on the
 * working line, waiting.
 *
 * This is the thin git derivation, and it is chosen over shelling
 * `adws/ship_report.py` per poll deliberately. That script's tree-receipt
 * (`last_shipped_point`) exists to find the chunk's BASE COMMIT - the newest
 * commit on `integration` whose tree `main` already holds - because `git
 * merge --squash` records no merge parentage. For the per-card question
 * ("is this card's park already on main?") the card FILE is the same receipt:
 * a squash stages `integration`'s entire diff, so the parked card file lands
 * on `main` in the same commit as the code it belongs to. One `git ls-tree`
 * answers it for every card at once, with no python process on a surface the
 * Board polls. The chunk's ORDER and each card's integration sha still come
 * from the script, through `GET /ship/report` (ship.ts) - the one place that
 * work is done.
 *
 * When `main` cannot be resolved at all, parked cards are `unknown` with that
 * sentence attached - never guessed into `integrated`.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CardItem, CardState, CardsResponse, QueueStatus, UnparsedQueueItem } from "../../shared/types.ts";
import { appError, appJson, appSafely } from "./guard.ts";
import { getScope, param } from "./scoped.ts";

const VALID_STATUSES: QueueStatus[] = ["ready-for-agent", "running", "blocked", "done"];
const HEADER_LINE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/;
const H1 = /^#\s+(.+?)\s*$/;
const CRITERIA_LINE = /^[ \t]*-\s*\[( |x|X)\](.*)$/gm;
const MAIN = "main";

interface ParsedCard {
  title: string | null;
  fields: Record<string, string>;
}

/** Mirrors `server/queue.ts`'s `parseHeaderBlock` exactly - see this file's
 * header for why it is mirrored rather than imported. */
function parseHeaderBlock(text: string): ParsedCard | null {
  const lines = text.split(/\r\n|\n/);
  let h1Index = -1;
  let title: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = H1.exec(lines[i] ?? "");
    if (m) {
      h1Index = i;
      title = m[1] ?? null;
      break;
    }
  }
  if (h1Index === -1) return null;

  let i = h1Index + 1;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;

  const fields: Record<string, string> = {};
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    const m = HEADER_LINE.exec(line);
    if (!m) break;
    fields[(m[1] ?? "").toLowerCase()] = (m[2] ?? "").trim();
    i++;
  }
  return { title, fields };
}

/** `dispatch.py:_parse_needs` - comma-separated basenames, trimmed; an absent
 * or empty value (or one that is only commas and whitespace) yields []. */
export function parseNeeds(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

/** The same checkbox line `queue.ts:countCriteria` counts and
 * `criteria.ts:extractCriteria` extracts. */
function extractCriteria(body: string): { text: string; done: boolean }[] {
  const out: { text: string; done: boolean }[] = [];
  for (const m of body.matchAll(CRITERIA_LINE)) {
    const mark = m[1];
    out.push({ text: (m[2] ?? "").trim(), done: mark === "x" || mark === "X" });
  }
  return out;
}

/** `**Category:** enhancement` in the Agent Brief body, same as queue.ts. */
function extractField(body: string, label: string): string | null {
  const m = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, "i").exec(body);
  return m ? (m[1] ?? "").trim() : null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

interface RawCard {
  name: string;
  path: string;
  parked: boolean;
  text: string;
  parsed: ParsedCard;
}

async function readDir(dir: string, prefix: string, parked: boolean, unparsed: UnparsedQueueItem[]): Promise<RawCard[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md") && e.name !== "TEMPLATE.md")
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // no such directory is a state, not an error (a fresh project)
  }

  const cards: RawCard[] = [];
  for (const name of names) {
    const rel = `${prefix}${name}`;
    let text: string;
    try {
      text = await readFile(join(dir, name), "utf-8");
    } catch (error) {
      unparsed.push({ path: rel, reason: `could not read file: ${(error as Error).message}` });
      continue;
    }
    const parsed = parseHeaderBlock(text);
    if (!parsed) {
      unparsed.push({ path: rel, reason: 'no H1 title found (expected "# Title" on its own line)' });
      continue;
    }
    cards.push({ name, path: rel, parked, text, parsed });
  }
  return cards;
}

export interface CardsInput {
  queueDir: string;
  doneDir: string;
  /** basenames of the cards `main`'s tree already holds under `queue/done/`;
   * null when `main` could not be read at all. */
  shippedNames: Set<string> | null;
  shippedReason: string | null;
  mainRef: string;
}

/**
 * The whole derivation, with no I/O of its own beyond the two directories -
 * so the tests can drive every state from files plus one injected set.
 */
export async function readCards(input: CardsInput): Promise<CardsResponse> {
  const unparsed: UnparsedQueueItem[] = [];
  const live = await readDir(input.queueDir, "queue/", false, unparsed);
  const done = await readDir(input.doneDir, "queue/done/", true, unparsed);

  // A need is satisfied once the named card is PARKED in queue/done/ - not
  // when it merely reads `Status: done` (dispatch.py:needs_satisfied's whole
  // point: parking is the moment the dependency's code is on the line the
  // next run is cut from).
  const parkedNames = new Set(done.map((card) => card.name));

  const items: CardItem[] = [];
  for (const raw of [...live, ...done]) {
    const fields = raw.parsed.fields;
    const statusRaw = fields["status"];

    let status: QueueStatus | null = null;
    if (statusRaw !== undefined && VALID_STATUSES.includes(statusRaw as QueueStatus)) {
      status = statusRaw as QueueStatus;
    } else if (!raw.parked) {
      // A live card with no readable Status: is exactly what queue.ts calls
      // unparsed, and the Board must not silently place it in a column.
      unparsed.push({
        path: raw.path,
        reason:
          statusRaw === undefined
            ? "missing Status: line under the H1"
            : `unknown Status: "${statusRaw}" (expected one of ${VALID_STATUSES.join(", ")})`,
      });
      continue;
    }

    const needs = parseNeeds(fields["needs"]);
    const waitingOn = raw.parked ? [] : needs.filter((need) => !parkedNames.has(need));
    const criteria = extractCriteria(raw.text);
    const blockedReason = nonEmpty(fields["blocked-reason"]);

    let state: CardState;
    let reason: string;
    if (raw.parked) {
      if (input.shippedNames === null) {
        state = "unknown";
        reason =
          input.shippedReason ??
          `cannot tell integrated from shipped: ${MAIN} could not be read in this checkout`;
      } else if (input.shippedNames.has(raw.name)) {
        state = "shipped";
        reason = `queue/done/${raw.name} is in ${input.mainRef}'s tree - it shipped inside a chunk squash`;
      } else {
        state = "integrated";
        reason =
          `parked in queue/done/ by the engine and not yet in ${input.mainRef}'s tree - ` +
          `it is on the working line, waiting for the next ship`;
      }
    } else {
      switch (status) {
        case "ready-for-agent":
          state = "ready";
          reason =
            waitingOn.length > 0
              ? `waiting on ${waitingOn.join(", ")} - the factory dispatches this once every card it needs is parked in queue/done/`
              : "ready - the factory auto-picks this when a lane frees up; no dispatch needed";
          break;
        case "running":
          state = "running";
          reason = fields["adw-id"]
            ? `run ${fields["adw-id"]} is working this card`
            : "a run has claimed this card, but it recorded no Adw-Id: yet";
          break;
        case "blocked":
          state = "blocked";
          reason =
            blockedReason ??
            "the card says Status: blocked but carries no Blocked-reason: line - open the card to see why";
          break;
        case "done":
          state = "done";
          reason =
            "the run finished and pushed its own branch; the engine integrates it next " +
            "(rebase, re-verify, ff-merge, park)";
          break;
        default:
          state = "unknown";
          reason = "this card carries no status this app can read";
      }
    }

    items.push({
      path: raw.path,
      name: raw.name,
      slug: raw.name.replace(/\.md$/i, ""),
      title: raw.parsed.title ?? raw.name,
      status,
      state,
      state_reason: reason,
      parked: raw.parked,
      adw: nonEmpty(fields["adw"]),
      adw_id: nonEmpty(fields["adw-id"]),
      created: nonEmpty(fields["created"]),
      context: nonEmpty(fields["context"]),
      category: extractField(raw.text, "Category"),
      feature: nonEmpty(fields["feature"]),
      priority: nonEmpty(fields["priority"]),
      needs,
      waiting_on: waitingOn,
      blocked_reason: blockedReason,
      blocks: [], // filled below, once every card is known
      criteria_done: criteria.filter((c) => c.done).length,
      criteria_total: criteria.length,
      criteria,
      body: raw.text,
    });
  }

  // Reverse edges: "Blocks" in the inspector is every card whose Needs: names
  // this one (docs/user-journeys.md J3.2).
  const byName = new Map(items.map((item) => [item.name, item]));
  for (const item of items) {
    for (const need of item.needs) {
      byName.get(need)?.blocks.push(item.name);
    }
  }

  return {
    dir: input.queueDir,
    done_dir: input.doneDir,
    items,
    unparsed,
    shipped_source: input.shippedNames === null ? "unavailable" : "git-tree",
    shipped_reason: input.shippedNames === null ? input.shippedReason : null,
    main_ref: input.mainRef,
  };
}

/**
 * `git ls-tree -r --name-only <main> -- queue/done` -> the basenames `main`
 * already holds. `main` first, `origin/main` when this checkout only tracks
 * it; null (with a sentence) when neither resolves.
 */
export async function shippedFromMain(root: string): Promise<Pick<CardsInput, "shippedNames" | "shippedReason" | "mainRef">> {
  for (const ref of [MAIN, `origin/${MAIN}`]) {
    const proc = Bun.spawn(["git", "ls-tree", "-r", "--name-only", ref, "--", "queue/done"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      if (ref === `origin/${MAIN}`) {
        const said = stderr.trim().split("\n")[0]?.trim();
        return {
          shippedNames: null,
          shippedReason:
            `neither ${MAIN} nor origin/${MAIN} could be read in ${root}` +
            (said ? ` (git said: ${said})` : "") +
            " - a parked card cannot be told from a shipped one until one of them resolves",
          mainRef: MAIN,
        };
      }
      continue;
    }
    const names = new Set<string>();
    for (const line of stdout.split("\n")) {
      const path = line.trim();
      if (!path.startsWith("queue/done/")) continue;
      const name = path.slice("queue/done/".length);
      if (name && !name.includes("/")) names.add(name);
    }
    return { shippedNames: names, shippedReason: null, mainRef: ref };
  }
  // Unreachable in practice (the loop returns on both branches), kept honest.
  return { shippedNames: null, shippedReason: `${MAIN} could not be read in ${root}`, mainRef: MAIN };
}

async function getCards(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);

  // Deliberately not gated on `scope.db`: a project can carry a queue with no
  // factory installed yet, and the Board says so honestly rather than 500ing.
  const shipped = await shippedFromMain(scope.root);
  return appJson(
    await readCards({
      queueDir: scope.queueDir,
      doneDir: join(scope.queueDir, "done"),
      ...shipped,
    }),
  );
}

export const cardsRoutes = {
  "/api/app/p/:id/cards": appSafely(getCards),
};
