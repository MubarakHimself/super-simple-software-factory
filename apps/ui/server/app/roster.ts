/**
 * `POST /api/app/p/:id/config/roster` - the one write that changes which model
 * an agent runs on (the operator's question: "if I want to go from kimi-k2.7
 * planner to GPT 5.6, why can't I do that via the UI?").
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
import type { RosterAgent, RosterAgentDefaults } from "../../shared/types.ts";
import { appError, appJson, csrfGuard } from "./guard.ts";
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
  };
}
