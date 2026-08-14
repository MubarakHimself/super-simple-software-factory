/**
 * `/api/app/skills?project=` (spec 1.3 row 120, W1-B2, spec 4 chunk K2b) -
 * the slash menu's data source and the only surface that can invoke a
 * `disable-model-invocation: true` skill (`to-spec`, `to-tickets`, `triage`).
 * Never a hardcoded list: this reads every `~/.claude/skills/<dir>/SKILL.md`
 * (scope "user") and, when `project` resolves, every
 * `<root>/.claude/skills/<dir>/SKILL.md` (scope "project") too - project
 * scope wins name collisions.
 *
 * Route wiring into `app/routes.ts` is deliberately NOT done here - see the
 * note at the top of docs.ts for why (K2b's file list excludes routes.ts,
 * a seam no two parallel chunks may both touch).
 *
 * Naming interpretation, flagged plainly: a skill's *invocable* identifier on
 * this machine is its directory name (`/redesign-skill`, not the frontmatter
 * `name:` field inside it, which reads `redesign-existing-projects` for that
 * one skill and `design-taste-frontend` for `taste-skill` - two of the 37
 * user skills where the two diverge). The spec's row 120 names "frontmatter"
 * as the source of truth for the whole row, but a slash-menu `name` that
 * cannot be typed back as a working `/name` would be worse than useless, so
 * `name` here is the directory name and `description`/`disable_model_invocation`
 * come from frontmatter. Confirmed against this session's own skill listing,
 * which itself keys by directory name for both of those two skills.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { appJson } from "./guard.ts";
import { findProject } from "./manifest.ts";

export interface SkillEntry {
  name: string;
  description: string;
  scope: "project" | "user";
  path: string;
  disable_model_invocation: boolean;
}

interface ParsedFrontmatter {
  description?: string;
  disableModelInvocation?: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const FRONTMATTER_LINE_RE = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;
const DESC_CLIP_CHARS = 60;
const EM_DASH = "—";

/** Minimal YAML-frontmatter reader: flat `key: value` lines only, which is
 * every SKILL.md on this machine (verified: none of the 37 user skills or
 * the 1 project skill has a multi-line or nested frontmatter field). Not a
 * general YAML parser - deliberately, since a real one is a dependency this
 * chunk does not need for two fields. */
function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return {};
  const result: ParsedFrontmatter = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const m = FRONTMATTER_LINE_RE.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "description") result.description = value;
    else if (key === "disable-model-invocation") result.disableModelInvocation = value.toLowerCase() === "true";
  }
  return result;
}

/** Spec §2.3: "descriptions clipped to the first clause before an em-dash or
 * 60 chars" - the slash-menu row rule, enforced here so no client can ship a
 * row that violates the text budget. */
export function clipDescription(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const dashIndex = collapsed.indexOf(EM_DASH);
  const clause = dashIndex === -1 ? collapsed : collapsed.slice(0, dashIndex).trim();
  if (clause.length <= DESC_CLIP_CHARS) return clause;
  const hardCut = clause.slice(0, DESC_CLIP_CHARS);
  const lastSpace = hardCut.lastIndexOf(" ");
  const trimmed = lastSpace > 40 ? hardCut.slice(0, lastSpace) : hardCut;
  return `${trimmed.replace(/[.,;:]+$/, "")}…`;
}

async function collectSkills(dirAbs: string, scope: "project" | "user"): Promise<SkillEntry[]> {
  let dirents;
  try {
    dirents = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const d of dirents) {
    // Deliberately not gated on d.isDirectory(): most entries under
    // ~/.claude/skills on this machine are symlinks/junctions (verified -
    // 29 of the 37 user skills), and Dirent.isDirectory() reports the link
    // itself, never the target, so that check silently dropped 29 of 37
    // real skills. existsSync(skillFile) is the true gate - it follows
    // symlinks by definition, so a plain file sitting next to the real
    // skill directories (which would make `<name>/SKILL.md` a nonsense
    // path) is excluded the same way a missing SKILL.md is.
    const skillFile = join(dirAbs, d.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let text: string;
    try {
      text = await readFile(skillFile, "utf-8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    out.push({
      name: d.name,
      description: clipDescription(fm.description ?? ""),
      scope,
      path: skillFile,
      disable_model_invocation: fm.disableModelInvocation ?? false,
    });
  }
  return out;
}

/** One-slot cache keyed by the `project` query param - spec row 120:
 * "cached, invalidated on project switch". A different project param simply
 * replaces the slot; there is no TTL, matching that literal wording. */
let cache: { key: string; entries: SkillEntry[] } | null = null;

export async function getSkills(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("project") ?? "";
  if (cache && cache.key === projectId) return appJson(cache.entries);

  const userSkills = await collectSkills(join(homedir(), ".claude", "skills"), "user");

  let projectSkills: SkillEntry[] = [];
  if (projectId) {
    const project = await findProject(projectId);
    if (project) {
      projectSkills = await collectSkills(join(project.root, ".claude", "skills"), "project");
    }
  }

  const byName = new Map<string, SkillEntry>();
  for (const s of userSkills) byName.set(s.name, s);
  for (const s of projectSkills) byName.set(s.name, s); // project scope wins collisions

  const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  cache = { key: projectId, entries };
  return appJson(entries);
}
