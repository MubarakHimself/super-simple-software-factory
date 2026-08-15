/**
 * The config-file writes. Three routes, one file, one discipline:
 *
 *   POST /api/app/p/:id/config/roster   one agent's `model:` / `thinking:`
 *   GET  /api/app/p/:id/config/router   the builder's model pool
 *   POST /api/app/p/:id/config/router   write that pool (`router.builder_pool`)
 *   POST /api/app/p/:id/config/lanes    per-lane `slots:` (and `enabled:`, which
 *                                       the engine does not read - see below)
 *
 * The first is the one write that changes which model an agent runs on (the
 * operator's question: "if I want to go from kimi-k2.7 planner to GPT 5.6, why
 * can't I do that via the UI?"). The other two write the two OPTIONAL blocks
 * the factory's engine also reads - documented at "the shared config blocks"
 * below, along with the proof that `agents.py` tolerates them.
 *
 * The target is `adws/adw_sssf_config/sssf.config.yaml` - the factory's roster,
 * resolved exactly the way every read resolves it (`configPathFromRepoRoot` in
 * `server/config.ts`, through `getScope`). That file is operator-editable DATA;
 * `adws/*.py` is code and stays frozen. This route touches nothing else, and it
 * is the only route in the app plane that writes into `adws/`.
 *
 * ── Why this rewrites ONE LINE instead of re-serializing the document ──────
 * The obvious implementation is `parseDocument` -> mutate -> `doc.toString()`.
 * It round-trips the comments, but it re-lays them out: on the operator's real
 * file it collapses every aligned trailing comment to a single space and moves
 * nine lines. A config the operator hand-aligned should not be reflowed because
 * he changed one model, so the document is used to LOCATE the field (every node
 * carries its `range` into the source) and the edit is a splice of that range
 * in the original text. The result is a one-line diff, with the file's CRLF
 * endings, alignment, blank lines and comments byte-identical everywhere else -
 * and reverting a change restores the file byte-for-byte.
 *
 * ── Why the write is proved before it lands ───────────────────────────────
 * A malformed write here breaks the operator's factory, so the spliced text is
 * parsed again and compared - whole document, key order ignored - against the
 * ORIGINAL parse with the same one field applied. Anything else that moved
 * (a comment swallowed into a value, a collapsed list, a broken indent) fails
 * that comparison and nothing is written. Then: `.bak` of the original beside
 * the file, temp file + rename so a torn write cannot leave half a config, and
 * one write at a time per config path.
 *
 * Validation before that: the agent must already exist in the file (this route
 * never creates or deletes an agent), `thinking` must be one of the seven words
 * the file's own comment documents, and `model` must look like the `provider/id`
 * pair `adws/adw_modules/agent_pi.py:resolve_model` resolves - no newline, no
 * yaml metacharacter, nothing that could turn one line into two.
 */
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import type { Document, Scalar, YAMLMap } from "yaml";
import { readConfig } from "../config.ts";
import type {
  BuilderPoolEntry,
  LaneBlockEntry,
  LaneEditBody,
  LaneEditResult,
  RosterAgent,
  RosterAgentDefaults,
  RouterEditBody,
  RouterEditResult,
  RouterRead,
} from "../../shared/types.ts";
import { appError, appJson, appSafely, csrfGuard } from "./guard.ts";
import { getScope, param } from "./scoped.ts";

/** The seven words `sssf.config.yaml`'s own comment documents for `thinking:`
 * ("off | minimal | low | medium | high | xhigh | max"). Restated here so the
 * server refuses an eighth rather than writing one the factory cannot read. */
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** `provider/id` as `agent_pi.py:resolve_model` splits it, plus the bare-id
 * form it also accepts as a pattern. Deliberately strict: this string is
 * spliced into a yaml line, so anything that could end that line early (a
 * newline, `#`, `:` followed by a space, a quote) is refused rather than
 * escaped. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/;
const MODEL_MAX = 160;

/** The two fields a row may edit. `writes`, `tools` and `harness_engineering`
 * are permissions and wiring, not lanes - a different decision with different
 * consequences, and not one this endpoint makes. */
type EditableField = "model" | "thinking";
const FIELDS: readonly EditableField[] = ["model", "thinking"];

export interface RosterEditBody {
  /** `agent` edits one roster row; `defaults` edits the top block every row
   * without its own key inherits from. */
  target?: "agent" | "defaults";
  /** the `name:` of an agent already in the file; required when target=agent */
  agent?: string;
  /** absent = leave alone. `null` or `""` = delete the key (inherit again). */
  model?: string | null;
  thinking?: string | null;
}

export interface RosterEditResult {
  roster: RosterAgent[];
  defaults: RosterAgentDefaults;
  /** absolute path of the copy of the previous file this write left behind */
  backup: string;
  /** what changed, one sentence each, in the file's own vocabulary */
  changed: string[];
}

// -- text splicing ------------------------------------------------------------

function lineStartAt(text: string, index: number): number {
  const nl = text.lastIndexOf("\n", index - 1);
  return nl === -1 ? 0 : nl + 1;
}

function lineEndAt(text: string, index: number): number {
  const nl = text.indexOf("\n", index);
  return nl === -1 ? text.length : nl + 1;
}

interface ScalarPair {
  key: Scalar;
  value: Scalar;
}

/** The map's `key: value` pairs whose key AND value are both plain scalars -
 * the only ones this file edits or anchors an insert to. A pair whose value is
 * a list or a nested map (an agent's `tools:`, `prompt_engineering:`) is not
 * one of them. */
function scalarPairs(map: YAMLMap): ScalarPair[] {
  const found: ScalarPair[] = [];
  for (const item of map.items) {
    if (isScalar(item.key) && isScalar(item.value)) found.push({ key: item.key, value: item.value });
  }
  return found;
}

function findPair(map: YAMLMap, key: string): ScalarPair | null {
  return scalarPairs(map).find((pair) => pair.key.value === key) ?? null;
}

/**
 * Splice one `key: value` in `text`, using `map`'s node ranges. Every other
 * byte survives, including the trailing comment on the edited line.
 *
 *   value string -> replace the scalar in place, or insert a new line
 *   value null   -> delete the whole `key: value  # comment` line
 *
 * Returns null when the edit cannot be placed (a map with no scalar pair to
 * anchor an insert to), which the caller turns into a refusal rather than a
 * guess.
 */
function spliceField(text: string, map: YAMLMap, key: string, value: string | null): string | null {
  const pair = findPair(map, key);

  if (pair) {
    const [valueStart, valueEnd] = [pair.value.range![0], pair.value.range![1]];
    if (value === null) {
      // The key's own line, comment included: the comment describes the value
      // that is going away, so it goes with it.
      return text.slice(0, lineStartAt(text, pair.key.range![0])) + text.slice(lineEndAt(text, valueEnd));
    }
    return text.slice(0, valueStart) + stringifyYaml(value).trim() + text.slice(valueEnd);
  }

  if (value === null) return text; // already inherited - nothing to remove

  // A new key goes directly under the map's first plain line, which for an
  // agent is `- name: planner` and for `defaults:` is `coding_agent: pi`.
  const anchor = scalarPairs(map)[0];
  if (!anchor) return null;
  const anchorLineStart = lineStartAt(text, anchor.key.range![0]);
  // YAML forbids tabs in indentation, so a column count IS the indent.
  const indent = " ".repeat(anchor.key.range![0] - anchorLineStart);
  const insertAt = lineEndAt(text, anchor.value.range![1]);
  const eol = text.slice(0, insertAt).endsWith("\r\n") ? "\r\n" : "\n";
  return `${text.slice(0, insertAt)}${indent}${key}: ${stringifyYaml(value).trim()}${eol}${text.slice(insertAt)}`;
}

// -- proof --------------------------------------------------------------------

/** Key order is not meaning in yaml, and an inserted key changes it - so the
 * comparison that proves nothing else moved sorts keys and keeps list order. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = stable(source[key]);
    return out;
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(stable(value));
}

// -- the handler --------------------------------------------------------------

/** One write per config file at a time. Two saves must never interleave a
 * read of the text with another save's rename. */
const inFlight = new Set<string>();

function readEdits(body: RosterEditBody): { field: EditableField; value: string | null }[] | string {
  const edits: { field: EditableField; value: string | null }[] = [];
  for (const field of FIELDS) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      edits.push({ field, value: null });
      continue;
    }
    if (typeof raw !== "string") return `${field} must be a string, or null to inherit`;
    const value = raw.trim();
    if (field === "thinking") {
      if (!(THINKING as readonly string[]).includes(value)) {
        return `thinking must be one of ${THINKING.join(" | ")} - '${value}' is not a word the factory reads`;
      }
    } else {
      if (value.length > MODEL_MAX) return `model is longer than ${MODEL_MAX} characters`;
      if (!MODEL_RE.test(value)) {
        return `model must look like provider/id (letters, digits and . _ : + @ / -) - '${value}' does not`;
      }
    }
    edits.push({ field, value });
  }
  return edits;
}

export async function postRosterEdit(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!existsSync(scope.configPath)) {
    return appError(`no sssf.config.yaml in this project - there is no roster to edit`, 409);
  }

  let body: RosterEditBody;
  try {
    body = (await req.json()) as RosterEditBody;
  } catch {
    return appError("body must be JSON", 400);
  }

  const target = body.target ?? "agent";
  if (target !== "agent" && target !== "defaults") return appError("target must be 'agent' or 'defaults'", 400);
  const agentName = typeof body.agent === "string" ? body.agent.trim() : "";
  if (target === "agent" && agentName === "") return appError("agent is required when target is 'agent'", 400);

  const edits = readEdits(body);
  if (typeof edits === "string") return appError(edits, 400);
  if (edits.length === 0) return appError("nothing to change - send model and/or thinking", 400);

  const path = scope.configPath;
  if (inFlight.has(path)) return appError(`a roster save is already running for ${path}`, 409);
  inFlight.add(path);
  try {
    const original = await readFile(path, "utf-8");
    const doc: Document = parseDocument(original);
    if (doc.errors.length > 0) {
      return appError(`${path} does not parse as yaml: ${doc.errors[0]!.message} - fix it by hand first`, 409);
    }

    // What the file says now, as plain data - the roster this endpoint may
    // edit, and the baseline the proof at the bottom compares against.
    type Block = Record<string, unknown>;
    const before = parseYaml(original) as { defaults?: Block; agents?: Block[] };
    const expected = structuredClone(before);

    let expectedOwner: Block;
    const subject = target === "defaults" ? "defaults" : agentName;

    if (target === "defaults") {
      if (!expected.defaults) return appError("this config has no defaults: block", 409);
      expectedOwner = expected.defaults;
    } else {
      const index = (before.agents ?? []).findIndex((agent) => agent.name === agentName);
      if (index === -1) {
        const known = (before.agents ?? []).map((agent) => String(agent.name)).join(", ");
        return appError(`no agent named '${agentName}' in this roster (${known}) - this endpoint never adds one`, 409);
      }
      expectedOwner = expected.agents![index]!;
    }

    // The splice, one field at a time. Each pass re-parses, because every edit
    // moves the ranges of everything after it.
    let next = original;
    const changed: string[] = [];
    for (const edit of edits) {
      const liveDoc = next === original ? doc : parseDocument(next);
      const liveMap = relocate(liveDoc, target, agentName);
      if (!liveMap) return appError(`could not find ${subject} again after an edit - nothing was written`, 500);
      const had = findPair(liveMap, edit.field);
      const wasValue = had ? String(had.value.value) : null;
      const spliced = spliceField(next, liveMap, edit.field, edit.value);
      if (spliced === null) {
        return appError(`could not place ${edit.field} in ${subject} - nothing was written`, 409);
      }
      if (spliced === next) continue;
      next = spliced;
      changed.push(
        edit.value === null
          ? `${subject}.${edit.field} cleared (was ${wasValue}) - it inherits the default again`
          : `${subject}.${edit.field} ${wasValue === null ? "set to" : `${wasValue} ->`} ${edit.value}`,
      );
      if (edit.value === null) delete expectedOwner[edit.field];
      else expectedOwner[edit.field] = edit.value;
    }

    if (changed.length === 0) return appError("that is already what the file says", 409);

    // ── the proof, before anything touches disk ──────────────────────────
    const proofDoc = parseDocument(next);
    if (proofDoc.errors.length > 0) {
      return appError(`the edit would not parse (${proofDoc.errors[0]!.message}) - nothing was written`, 500);
    }
    const after = parseYaml(next);
    if (canonical(after) !== canonical(expected)) {
      return appError(
        "the edit changed more of the file than the field asked for - nothing was written",
        500,
      );
    }

    // ── land it: backup, temp file, rename ───────────────────────────────
    const backup = `${path}.bak`;
    await writeFile(backup, original, "utf-8");
    const temp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
    await writeFile(temp, next, "utf-8");
    await rename(temp, path); // replaces atomically, Windows included

    const parsed = await readConfig(path);
    return appJson({
      roster: parsed.roster,
      defaults: parsed.defaults,
      backup,
      changed,
    } satisfies RosterEditResult);
  } finally {
    inFlight.delete(path);
  }
}

// ═══ the shared config blocks: `router:` and `lanes:` ════════════════════════
//
// Two OPTIONAL top-level blocks that both this app and the factory's engine
// read. `adws/adw_modules/agents.py:load_config` builds `SSSFConfig(**raw)`
// from the whole document, and `SSSFConfig` is a plain pydantic BaseModel -
// pydantic v2's default is `extra="ignore"`, so an unknown top-level key is
// dropped, not rejected. Verified against this repo's own config on this
// machine: `load_config` on a copy carrying both blocks returns the five
// agents and raises nothing. The engine lane needs no tolerance change; it
// needs to READ them.
//
//   router:
//     builder_pool:            # ordered, 1-5 entries; entry #1 mirrors the
//       - model: "..."         # builder agent's own `model:`
//   lanes:
//     ollama-cloud: { slots: 2 }
//
// ── Why a block is replaced whole where a field is spliced in place ────────
// The roster edits above splice ONE scalar because the operator hand-aligned
// that part of the file and it is his. These two blocks are the opposite: the
// app writes them, nothing else does, and a nested list cannot be reached by a
// single-scalar splice. So the block's own byte range is replaced and every
// byte outside it survives - defaults, agents, observability, worktrees, the
// comments between them, the file's CRLF endings. The same proof runs after:
// re-parse, and compare the whole document against the original parse with
// only that one top-level key changed. And because replacing a range CAN eat a
// comment written inside it, a block that carries a `#` is refused rather than
// rewritten.

/** What the schema allows, and what the Roster pane draws: one primary plus
 * four. A sixth would be a router the operator cannot see the whole of. */
export const MAX_BUILDER_POOL = 5;

/** A lane's slot count. 0 is refused for the reason engine.py's own parser
 * refuses it: a lane with no slots holds every card that draws on it forever. */
const SLOTS_MIN = 1;
const SLOTS_MAX = 8;

/** A provider account id as it appears as a `provider/model` prefix. */
const LANE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * The byte range of one TOP-LEVEL `key:` block: from the start of its own line
 * to the end of the last line that carries content in it.
 *
 * The document locates the key (its node range is where in the source it is);
 * the extent is then measured LEXICALLY, line by line, because a node's own
 * range reaches past the blank line that follows the block - and a range that
 * eats that blank line deletes the separation the operator put there. A line
 * belongs to the block when it is blank or indented; the first column-0 line
 * ends it, and trailing blank lines are left outside. So the comment block
 * introducing the next key, and the blank line before it, both survive.
 */
function topLevelRange(doc: Document, text: string, key: string): { start: number; end: number } | null {
  const contents = doc.contents;
  if (!isMap(contents)) return null;
  for (const item of contents.items) {
    if (!isScalar(item.key) || item.key.value !== key) continue;
    const keyRange = item.key.range;
    if (!keyRange) return null;
    const start = lineStartAt(text, keyRange[0]);
    let cursor = lineEndAt(text, start);
    let end = cursor; // the key's own line always carries content
    while (cursor < text.length) {
      const lineEnd = lineEndAt(text, cursor);
      const line = text.slice(cursor, lineEnd);
      const blank = line.trim() === "";
      if (!blank && !/^[ \t]/.test(line)) break; // a new column-0 key
      cursor = lineEnd;
      if (!blank) end = lineEnd;
    }
    return { start, end };
  }
  return null;
}

/** The block as yaml, in the file's own line endings. `lineWidth: 0` keeps a
 * long `provider/model` string on one line instead of folding it. */
function blockText(key: string, value: unknown, eol: string): string {
  return stringifyYaml({ [key]: value }, { lineWidth: 0 }).replace(/\r?\n/g, eol);
}

/**
 * Replace (or insert, or delete) one top-level block. `value === null` deletes
 * it. A new block is appended at the end of the file, after one blank line -
 * yaml has no significant key order, and appending is the only placement that
 * cannot disturb what is already there.
 *
 * Returns the new text, or a sentence saying why it refused.
 */
export function writeTopLevelBlock(text: string, doc: Document, key: string, value: unknown): string | { refused: string } {
  const eol = eolOf(text);
  const found = topLevelRange(doc, text, key);

  if (found) {
    const current = text.slice(found.start, found.end);
    if (current.includes("#")) {
      return {
        refused:
          `the \`${key}:\` block in this file carries a comment, and this write replaces the whole block - ` +
          `it would lose that comment, so nothing was written. Edit the block by hand, or delete the comment first`,
      };
    }
    if (value !== null) return text.slice(0, found.start) + blockText(key, value, eol) + text.slice(found.end);

    // Deleting. When the block is the LAST thing in the file, the blank lines
    // above it separated it from what came before and nothing else, so they go
    // with it - which is what makes "add a pool, then clear it" restore the
    // file byte for byte. In the middle of a file they separate two survivors
    // and stay.
    let from = found.start;
    const rest = text.slice(found.end);
    if (rest.trim() === "") {
      while (from > 0) {
        const previous = lineStartAt(text, from - 1);
        if (text.slice(previous, from).trim() !== "") break;
        from = previous;
      }
    }
    return text.slice(0, from) + rest;
  }

  if (value === null) return text; // nothing there to delete
  const base = text.endsWith(eol) ? text : text.endsWith("\n") ? text : text + eol;
  const spaced = base.endsWith(eol + eol) ? base : base + eol;
  return spaced + blockText(key, value, eol);
}

/** `writeTopLevelBlock` with the parse in front of it, for callers that hold
 * only the text (the tests, and any future single-shot edit). */
export function spliceBlock(text: string, key: string, value: unknown): string | { refused: string } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { refused: `the file does not parse as yaml: ${doc.errors[0]!.message}` };
  return writeTopLevelBlock(text, doc, key, value);
}

/** The pool a `POST /config/router` body asks for, or the one sentence saying
 * why it was refused. Exported so the rule is testable without a request. */
export function validatePool(entries: unknown): BuilderPoolEntry[] | string {
  if (!Array.isArray(entries)) return "builder_pool must be a list of {model} entries";
  if (entries.length > MAX_BUILDER_POOL) {
    return `the builder pool holds at most ${MAX_BUILDER_POOL} models - ${entries.length} were sent`;
  }
  const pool: BuilderPoolEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const model = typeof (entry as { model?: unknown })?.model === "string" ? String((entry as { model: string }).model).trim() : "";
    if (!model) return "every pool entry needs a model";
    if (model.length > MODEL_MAX) return `model is longer than ${MODEL_MAX} characters`;
    if (!MODEL_RE.test(model)) {
      return `model must look like provider/id (letters, digits and . _ : + @ / -) - '${model}' does not`;
    }
    if (seen.has(model)) return `'${model}' is in the pool twice - a pool of one model repeated is a pool of one model`;
    seen.add(model);
    pool.push({ model });
  }
  return pool;
}

/** The `lanes:` block as plain data, ignoring anything that is not a map of
 * lane -> map. A block that is something else entirely is reported, never
 * silently replaced. */
function readLanesBlock(raw: unknown): { lanes: Record<string, LaneBlockEntry>; reason: string | null } {
  if (raw === undefined || raw === null) return { lanes: {}, reason: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { lanes: {}, reason: "the `lanes:` block in this file is not a map of lane names - it is left alone" };
  }
  const out: Record<string, LaneBlockEntry> = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const lane: LaneBlockEntry = {};
    if (typeof record.slots === "number" && Number.isInteger(record.slots)) lane.slots = record.slots;
    if (typeof record.enabled === "boolean") lane.enabled = record.enabled;
    out[name] = lane;
  }
  return { lanes: out, reason: null };
}

/** `router.builder_pool` as plain data. */
function readPool(raw: unknown): { pool: BuilderPoolEntry[]; present: boolean; reason: string | null } {
  if (raw === undefined || raw === null) return { pool: [], present: false, reason: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { pool: [], present: true, reason: "the `router:` block in this file is not a map - its pool could not be read" };
  }
  const pool = (raw as Record<string, unknown>).builder_pool;
  if (pool === undefined || pool === null) return { pool: [], present: true, reason: null };
  if (!Array.isArray(pool)) {
    return { pool: [], present: true, reason: "`router.builder_pool` is not a list - it is left alone" };
  }
  const entries: BuilderPoolEntry[] = [];
  for (const item of pool) {
    if (item && typeof item === "object" && typeof (item as Record<string, unknown>).model === "string") {
      entries.push({ model: String((item as Record<string, unknown>).model) });
    }
  }
  if (entries.length !== pool.length) {
    return {
      pool: entries,
      present: true,
      reason: `\`router.builder_pool\` holds ${pool.length} entries but only ${entries.length} carry a \`model:\` - the rest are not shown`,
    };
  }
  return { pool: entries, present: true, reason: null };
}

/** Both blocks, as data, from a config path. Exported because the lanes read
 * in `factory.ts` derives a lane from a pool entry the same way it derives one
 * from a roster model - a pool entry is a real draw on a provider account. */
export async function readRouterAndLanes(configPath: string): Promise<{
  pool: BuilderPoolEntry[];
  pool_present: boolean;
  pool_reason: string | null;
  lanes: Record<string, LaneBlockEntry>;
  lanes_present: boolean;
  lanes_reason: string | null;
}> {
  const raw = (parseYaml(await readFile(configPath, "utf-8")) ?? {}) as Record<string, unknown>;
  const router = readPool(raw.router);
  const lanes = readLanesBlock(raw.lanes);
  return {
    pool: router.pool,
    pool_present: router.present,
    pool_reason: router.reason,
    lanes: lanes.lanes,
    lanes_present: raw.lanes !== undefined && raw.lanes !== null,
    lanes_reason: lanes.reason,
  };
}

/** Every provider account this config already draws on - the roster's model
 * prefixes plus the pool's. A lane the config does not name is not one this
 * endpoint will write a slot count for: it would be a lane invented in a file,
 * running nothing. */
function knownLanes(raw: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const add = (model: unknown) => {
    if (typeof model !== "string" || !model.includes("/")) return;
    const lane = model.split("/", 1)[0]!.trim();
    if (lane) found.add(lane);
  };
  const defaults = (raw.defaults ?? {}) as Record<string, unknown>;
  add(defaults.model);
  for (const agent of (raw.agents ?? []) as Record<string, unknown>[]) add(agent?.model);
  for (const entry of readPool(raw.router).pool) add(entry.model);
  return found;
}

/** The one write path both block endpoints run: proof, backup, temp + rename.
 * Identical discipline to the field splice above, at block scale. */
async function landBlock(
  path: string,
  key: "router" | "lanes",
  build: (before: Record<string, unknown>) => { value: unknown; changed: string[] } | { error: string; status?: number },
): Promise<Response | { backup: string; changed: string[] }> {
  if (inFlight.has(path)) return appError(`a config save is already running for ${path}`, 409);
  inFlight.add(path);
  try {
    const original = await readFile(path, "utf-8");
    const doc: Document = parseDocument(original);
    if (doc.errors.length > 0) {
      return appError(`${path} does not parse as yaml: ${doc.errors[0]!.message} - fix it by hand first`, 409);
    }
    const before = (parseYaml(original) ?? {}) as Record<string, unknown>;

    const plan = build(before);
    if ("error" in plan) return appError(plan.error, plan.status ?? 400);
    if (plan.changed.length === 0) return appError("that is already what the file says", 409);

    const written = writeTopLevelBlock(original, doc, key, plan.value);
    if (typeof written !== "string") return appError(written.refused, 409);
    if (written === original) return appError("that is already what the file says", 409);

    // ── the proof: only this one top-level key may have moved ────────────
    const expected = structuredClone(before);
    if (plan.value === null) delete expected[key];
    else expected[key] = plan.value as Record<string, unknown>;

    const proofDoc = parseDocument(written);
    if (proofDoc.errors.length > 0) {
      return appError(`the edit would not parse (${proofDoc.errors[0]!.message}) - nothing was written`, 500);
    }
    if (canonical(parseYaml(written)) !== canonical(expected)) {
      return appError(`the edit changed more of the file than the \`${key}:\` block - nothing was written`, 500);
    }

    const backup = `${path}.bak`;
    await writeFile(backup, original, "utf-8");
    const temp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
    await writeFile(temp, written, "utf-8");
    await rename(temp, path);
    return { backup, changed: plan.changed };
  } finally {
    inFlight.delete(path);
  }
}

// ── GET /api/app/p/:id/config/router ────────────────────────────────────────

export async function getRouter(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!existsSync(scope.configPath)) {
    return appJson({
      builder_pool: [],
      present: false,
      builder_model: null,
      max_pool: MAX_BUILDER_POOL,
      config_path: scope.configPath,
      reason: "this project has no sssf.config.yaml, so it has no roster and no builder pool",
    } satisfies RouterRead);
  }
  const blocks = await readRouterAndLanes(scope.configPath);
  const parsed = await readConfig(scope.configPath);
  const builder = parsed.roster.find((agent) => agent.name.trim().toLowerCase() === "builder") ?? null;
  return appJson({
    builder_pool: blocks.pool,
    present: blocks.pool_present,
    builder_model: builder?.model ?? null,
    max_pool: MAX_BUILDER_POOL,
    config_path: scope.configPath,
    reason: blocks.pool_reason,
  } satisfies RouterRead);
}

// ── POST /api/app/p/:id/config/router ───────────────────────────────────────

export async function postRouterEdit(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!existsSync(scope.configPath)) {
    return appError("no sssf.config.yaml in this project - there is no roster to give a pool", 409);
  }

  let body: RouterEditBody;
  try {
    body = (await req.json()) as RouterEditBody;
  } catch {
    return appError("body must be JSON", 400);
  }
  const checked = validatePool(body?.builder_pool);
  if (typeof checked === "string") return appError(checked, 400);
  const pool = checked;

  const landed = await landBlock(scope.configPath, "router", (before) => {
    const existing = (before.router && typeof before.router === "object" && !Array.isArray(before.router)
      ? { ...(before.router as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    const had = readPool(before.router).pool.map((entry) => entry.model);
    const now = pool.map((entry) => entry.model);
    if (had.join(" ") === now.join(" ")) return { value: existing, changed: [] };

    if (now.length === 0) delete existing.builder_pool;
    else existing.builder_pool = pool.map((entry) => ({ model: entry.model }));
    const value = Object.keys(existing).length === 0 ? null : existing;

    const changed =
      now.length === 0
        ? [`router.builder_pool cleared (was ${had.join(", ")}) - the builder runs its own model alone`]
        : [
            `router.builder_pool ${had.length === 0 ? "set to" : `${had.join(", ")} ->`} ${now.join(", ")}` +
              ` (${now.length} of ${MAX_BUILDER_POOL})`,
          ];
    return { value, changed };
  });
  if (landed instanceof Response) return landed;

  const after = await readRouterAndLanes(scope.configPath);
  return appJson({
    builder_pool: after.pool,
    backup: landed.backup,
    changed: landed.changed,
  } satisfies RouterEditResult);
}

// ── POST /api/app/p/:id/config/lanes ────────────────────────────────────────

export async function postLaneEdit(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!existsSync(scope.configPath)) {
    return appError("no sssf.config.yaml in this project - there are no lanes to configure", 409);
  }

  let body: LaneEditBody;
  try {
    body = (await req.json()) as LaneEditBody;
  } catch {
    return appError("body must be JSON", 400);
  }
  const lane = typeof body?.lane === "string" ? body.lane.trim() : "";
  if (!lane) return appError("lane is required", 400);
  if (!LANE_RE.test(lane)) return appError(`'${lane}' is not a provider account name (letters, digits and . _ -)`, 400);
  if (body.slots === undefined && body.enabled === undefined) {
    return appError("nothing to change - send slots and/or enabled", 400);
  }
  if (body.slots !== undefined && body.slots !== null) {
    if (typeof body.slots !== "number" || !Number.isInteger(body.slots)) return appError("slots must be a whole number", 400);
    if (body.slots < SLOTS_MIN) {
      return appError(`slots must be at least ${SLOTS_MIN} - a lane with no slots holds every card that draws on it forever`, 400);
    }
    if (body.slots > SLOTS_MAX) return appError(`slots must be at most ${SLOTS_MAX}`, 400);
  }
  if (body.enabled !== undefined && body.enabled !== null && typeof body.enabled !== "boolean") {
    return appError("enabled must be true or false", 400);
  }

  const landed = await landBlock(scope.configPath, "lanes", (before) => {
    if (!knownLanes(before).has(lane)) {
      return {
        error:
          `'${lane}' is not a lane of this config - a lane exists because a roster model or a builder-pool entry names ` +
          `that provider. Point a model at it first`,
        status: 409,
      };
    }
    const read = readLanesBlock(before.lanes);
    if (read.reason) return { error: `${read.reason} - nothing was written`, status: 409 };
    const next: Record<string, LaneBlockEntry> = {};
    for (const [name, entry] of Object.entries(read.lanes)) next[name] = { ...entry };
    const entry: LaneBlockEntry = { ...(next[lane] ?? {}) };
    const changed: string[] = [];

    if (body.slots !== undefined) {
      const was = entry.slots ?? null;
      if (body.slots === null) {
        if (was !== null) {
          delete entry.slots;
          changed.push(`lanes.${lane}.slots cleared (was ${was}) - the engine's default applies again`);
        }
      } else if (was !== body.slots) {
        entry.slots = body.slots;
        changed.push(`lanes.${lane}.slots ${was === null ? "set to" : `${was} ->`} ${body.slots}`);
      }
    }
    if (body.enabled !== undefined) {
      const was = entry.enabled ?? true;
      const now = body.enabled === null ? true : body.enabled;
      if (was !== now) {
        // `enabled: true` is what a lane already is, so it is not written -
        // the file says only what departs from the default.
        if (now) delete entry.enabled;
        else entry.enabled = false;
        // NO ENGINE READS THIS KEY. `engine.py:config_lanes` takes `slots` out
        // of this block and nothing else, so writing `enabled: false` records
        // an intention and stops no dispatch. The sentence says so rather than
        // reporting a lane as switched off while it goes on taking runs; the
        // Lanes pane no longer offers the switch for the same reason.
        changed.push(
          now
            ? `lanes.${lane}.enabled cleared from the file (it had no effect either way)`
            : `lanes.${lane} written disabled in the file only - no engine reads that key, so the lane keeps taking runs`,
        );
      }
    }

    if (Object.keys(entry).length === 0) delete next[lane];
    else next[lane] = entry;
    return { value: Object.keys(next).length === 0 ? null : next, changed };
  });
  if (landed instanceof Response) return landed;

  const after = await readRouterAndLanes(scope.configPath);
  return appJson({
    lanes: after.lanes,
    backup: landed.backup,
    changed: landed.changed,
  } satisfies LaneEditResult);
}

/** The same map, in a freshly parsed document (ranges move after every splice). */
function relocate(doc: Document, target: "agent" | "defaults", agentName: string): YAMLMap | null {
  if (target === "defaults") {
    const node = doc.get("defaults", true);
    return isMap(node) ? node : null;
  }
  const seq = doc.get("agents", true);
  if (!isSeq(seq)) return null;
  const found = seq.items.find((item) => isMap(item) && item.get("name") === agentName);
  return isMap(found) ? found : null;
}

/** Mounted from `routes.ts`, behind the same origin + `X-App-Token` guard as
 * every other write on this plane (spec 1.2). */
export function rosterRoutes(token: string, selfOrigins: ReadonlySet<string>) {
  return {
    "/api/app/p/:id/config/roster": {
      POST: csrfGuard(token, selfOrigins, postRosterEdit),
    },
    /** The builder's model pool - the one agent that runs long and in
     * parallel, so the one agent with more than one model. */
    "/api/app/p/:id/config/router": {
      GET: appSafely(getRouter),
      POST: csrfGuard(token, selfOrigins, postRouterEdit),
    },
    /** Per-lane slots and the enable switch, in the config's `lanes:` block. */
    "/api/app/p/:id/config/lanes": {
      POST: csrfGuard(token, selfOrigins, postLaneEdit),
    },
  };
}
