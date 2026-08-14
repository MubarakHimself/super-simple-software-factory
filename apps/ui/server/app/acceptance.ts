/**
 * `/api/app/p/:id/gate` and `/gate/:adw_id/acceptance` (spec 4, chunk K2a;
 * spec 2.6). The list itself is the existing `computeGateItems` (gate.ts,
 * unmodified), scoped to one project's db/repo/sessions dir. The acceptance
 * walk is new: a card's criteria (via `criteria.ts`'s extractor) matched
 * against the run's own record - mechanically and conservatively, per Open
 * Decision 12 ("everything else unconfirmed... an LLM judgment pass is a
 * separate, explicit feature").
 *
 * Matching sources, in the order spec 2.6 names them: a named file in the
 * diff's `files[]`, a named file in an envelope's `changed_files`, or a
 * `quality:` check (by name or command) with `status='pass'`. A criterion
 * that names a quality check which ran and FAILED reads `not-met` (the
 * record positively contradicts it); everything else is `unconfirmed` with
 * the skill's own fixed phrase, copied byte for byte (ASCII hyphens) from
 * `~/.claude/skills/morning-brief/SKILL.md:96`. The card's own `- [x]` state
 * is surfaced as `done_in_file` but never fed into the verdict - "never
 * treated as evidence" (spec 2.6).
 */
import { join } from "node:path";
import { computeGateItems, resolveDiff } from "../gate.ts";
import { isSafeSegment } from "../gitro.ts";
import { readQueue } from "../queue.ts";
import type { DiffFile, Envelope } from "../../shared/types.ts";
import { extractCriteria } from "./criteria.ts";
import { appError, appJson, appSafely } from "./guard.ts";
import { factoryAbsent, getScope, param } from "./scoped.ts";

const FIXED_UNCONFIRMED_PHRASE = "cannot confirm from the record - check the compare page for this one";

export type AcceptanceVerdict = "met" | "not-met" | "unconfirmed";

export interface AcceptanceEvidence {
  kind: "diff" | "envelope" | "quality";
  text: string;
  source: string;
}

export interface AcceptanceCriterion {
  text: string;
  done_in_file: boolean;
  verdict: AcceptanceVerdict;
  evidence: AcceptanceEvidence[];
  /** Present only on `unconfirmed` - the skill's fixed sentence, verbatim,
   * so the operator learns to recognize it as one phrase (spec 2.6). */
  note: string | null;
}

export interface AcceptanceResponse {
  criteria: AcceptanceCriterion[];
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** Substring match, case-insensitive, against either the full path or its
 * basename - conservative on purpose: a criterion has to actually name the
 * file (or the check), never a fuzzy or token-overlap guess (spec 2.6: "No
 * fuzzy matching - an invented match is worse than a gap"). */
function mentions(haystackLower: string, needle: string): boolean {
  return needle.length > 0 && haystackLower.includes(needle.toLowerCase());
}

interface QualitySignal {
  name: string; // spec.name, e.g. "lint" (the "quality:" prefix stripped)
  command: string | null;
  status: string | null; // "pass" | "fail" | "incomplete" | "unknown"
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function envelopeChangedFiles(envelopes: Envelope[]): { file: string; agent: string }[] {
  const out: { file: string; agent: string }[] = [];
  for (const env of envelopes) {
    if (env.valid !== 1) continue; // only accepted reports speak for the run
    const payload = parsePayload(env.payload_json);
    const files = payload["changed_files"];
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      if (typeof f === "string" && f) out.push({ file: f, agent: env.agent ?? "?" });
    }
  }
  return out;
}

function matchCriterion(
  text: string,
  diffFiles: DiffFile[],
  changedFiles: { file: string; agent: string }[],
  quality: QualitySignal[],
): { verdict: AcceptanceVerdict; evidence: AcceptanceEvidence[] } {
  const lower = text.toLowerCase();
  const evidence: AcceptanceEvidence[] = [];
  let sawFailingQualityMatch = false;

  for (const f of diffFiles) {
    if (mentions(lower, f.path) || mentions(lower, basename(f.path))) {
      evidence.push({ kind: "diff", text: f.path, source: `+${f.added} -${f.deleted}` });
    }
  }
  for (const cf of changedFiles) {
    if (mentions(lower, cf.file) || mentions(lower, basename(cf.file))) {
      evidence.push({ kind: "envelope", text: cf.file, source: cf.agent });
    }
  }
  for (const q of quality) {
    const named = mentions(lower, q.name) || (q.command ? mentions(lower, q.command) : false);
    if (!named) continue;
    if (q.status === "pass") {
      evidence.push({ kind: "quality", text: q.name, source: "pass" });
    } else {
      sawFailingQualityMatch = true;
    }
  }

  if (evidence.length > 0) return { verdict: "met", evidence };
  if (sawFailingQualityMatch) return { verdict: "not-met", evidence: [] };
  return { verdict: "unconfirmed", evidence: [] };
}

async function getGate(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!scope.db) return factoryAbsent();

  const items = await computeGateItems({ db: scope.db, repo: scope.repo }, scope.sessionsDir);
  return appJson({ items });
}

async function getAcceptance(req: Request): Promise<Response> {
  const id = param(req, "id");
  const adwId = param(req, "adw_id");
  if (!isSafeSegment(adwId)) return appError("invalid adw_id", 400);

  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  if (!scope.db) return factoryAbsent();

  const session = scope.db.session(adwId);
  if (!session) return appError(`no run ${adwId}`, 404);

  // Card <-> Run join is QueueItem.adw_id x sessions.adw_id - "the only link
  // that exists" (spec 2.4). No card, or a card whose text carries no
  // checkbox lines: an honest empty walk, not a 404 - plenty of runs have no
  // card at all (a direct run, per the morning-brief skill's own rule).
  const queue = await readQueue(scope.queueDir);
  const card = queue.items.find((item) => item.adw_id === adwId);
  if (!card) return appJson({ criteria: [] } satisfies AcceptanceResponse);

  const lines = extractCriteria(card.body);
  if (lines.length === 0) return appJson({ criteria: [] } satisfies AcceptanceResponse);

  const commits = scope.db.commitLog(adwId);
  const sessionDir = join(scope.sessionsDir, adwId);
  const diff = await resolveDiff({ repo: scope.repo, sessionDir, commits, scope: "run" });
  const diffFiles = diff?.files ?? [];

  const changedFiles = envelopeChangedFiles(scope.db.envelopes(adwId));

  const events = scope.db.events(adwId, 0, 1000).events;
  const quality: QualitySignal[] = [];
  for (const e of events) {
    if (e.type !== "tool_call" || !e.name?.startsWith("quality:")) continue;
    const payload = parsePayload(e.payload_json);
    quality.push({
      name: e.name.slice("quality:".length),
      command: typeof payload["command"] === "string" ? (payload["command"] as string) : null,
      status: typeof payload["status"] === "string" ? (payload["status"] as string) : null,
    });
  }

  const criteria: AcceptanceCriterion[] = lines.map((line) => {
    const { verdict, evidence } = matchCriterion(line.text, diffFiles, changedFiles, quality);
    return {
      text: line.text,
      done_in_file: line.done,
      verdict,
      evidence,
      note: verdict === "unconfirmed" ? FIXED_UNCONFIRMED_PHRASE : null,
    };
  });

  return appJson({ criteria } satisfies AcceptanceResponse);
}

export const acceptanceRoutes = {
  "/api/app/p/:id/gate": appSafely(getGate),
  "/api/app/p/:id/gate/:adw_id/acceptance": appSafely(getAcceptance),
};
