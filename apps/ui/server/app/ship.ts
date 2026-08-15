/**
 * SHIP - the one human act in the whole factory (docs/user-journeys.md J5,
 * MAP.md's two-box model): `main` moves by ONE squash commit per finished
 * chunk, clicked by the operator.
 *
 *   GET  /api/app/p/:id/ship/report   the assembled shipping report
 *   POST /api/app/p/:id/ship          the guarded squash sequence
 *
 * ── The report is the script's, not this file's ────────────────────────────
 * `adws/ship_report.py` is the factory's own deterministic account of the
 * chunk (which commits, which cards, each card's acceptance walk with verdicts
 * only ever `confirmed-by-record` / `cannot-confirm-from-record`). This module
 * SHELLS it (`uv run adws/ship_report.py --pr`, cwd = the project root, utf-8,
 * timeout) and parses the markdown it prints. It never re-derives the chunk,
 * the base point, the card list or a verdict - a second implementation of that
 * logic would be a second answer to the same question, and the operator would
 * have no way to tell which one lied.
 *
 * The script has no JSON mode (read its CLI: `--pr` / `--changelog` /
 * `--range` / `--out`, markdown to stdout), so `parseShipReport` below reads
 * `render_pr`'s exact line grammar - each regex names the python line it
 * mirrors. `--pr` is a strict superset of `--changelog` (same cards, same
 * order, plus shas and the box walk), so one run answers both, and the
 * markdown is passed through verbatim as `markdown` because that same text
 * IS the squash commit's body.
 *
 * ── The cut point ──────────────────────────────────────────────────────────
 * Integration is linear, so "ship these three but not that one" is not a thing
 * that exists (change-list #2). Shipping "up to" a card means: advance `main`
 * to THAT CARD'S integration commit - the sha the report prints on its
 * `- Integrated:` line. `cut: "all"` means the tip of the working line.
 * Either way `main` gains exactly one commit: `git merge --squash <sha>` +
 * `git commit -F <the report for BASE..sha>`.
 *
 * "Up to" only means anything if the card list is in ANCESTRY order, and the
 * script sorts it by the park commit's date string instead - so `git rev-list
 * --topo-order` puts the cards back on the line (`orderCardsByAncestry`), and
 * a partial cut is then checked against the ranged report that becomes its own
 * commit message. Disagreement is a refusal, never a wider chunk.
 *
 * ── What this sequence will not do ─────────────────────────────────────────
 * Never `--force`, never `--no-verify`, never a second parent, never a
 * rewrite. It never touches `integration` at all (it only reads a commit sha
 * from it). It refuses - with git's own words, before anything runs - on a
 * dirty tree, a detached HEAD, a missing committer identity, a missing
 * `integration`, and on `main` diverged from `origin/main`. If the push is
 * refused after the commit landed, nothing is undone and nothing is hidden:
 * the response says the commit is local with git's reason attached.
 *
 * The `executeGit`-with-argv-arrays seam, the "git's own stderr is the reason
 * the operator reads" rule and the per-checkout lock are the same three
 * mechanisms `merge.ts` ported from T3 Code's source-control plane; they are
 * duplicated here rather than imported for the reason merge.ts's header gives
 * (that file owns ONE action - the ff-merge - and this one owns another).
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShipCard, ShipCriterion, ShipReportResponse, ShipResult } from "../../shared/types.ts";
import { isSafeRef, isSafeSegment, isSafeSha } from "../gitro.ts";
import { appError, appJson, appSafely, csrfGuard } from "./guard.ts";
import { getScope, param } from "./scoped.ts";

/** The human-owned branch. Same literal `merge.ts` and `ship_report.py`
 * (`HUMAN_TRUNK`) use - the one branch the factory never writes. */
const MAIN = "main";
/** `git_helper.factory_trunk()`'s own default, and `ship_report.py`'s. */
const INTEGRATION = "integration";

const REPORT_TIMEOUT_MS = 120_000;
/** fetch and push cross the network; the local commands are far under this. */
const GIT_TIMEOUT_MS = 120_000;

/** The file the squash body is written to, inside the git dir - NOT the work
 * tree, so writing it can never dirty the tree the sequence just verified is
 * clean. `git commit -F` reads it; the shell never carries the markdown. */
const MESSAGE_FILE = "SDL_SHIP_MSG.md";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** The one seam that runs git, argv arrays only - nothing from a request is
 * ever interpolated into a shell string. */
async function git(root: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<Run> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // LC_ALL=C keeps git's messages parseable whatever the operator's locale;
    // GIT_TERMINAL_PROMPT=0 turns a credential prompt into an error instead of
    // a server process hanging on a hidden password question.
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** git's own words, trimmed to the lines that carry them. `fallback` is used
 * only when git said nothing at all. */
function reasonFrom(run: Run, fallback: string): string {
  const said = `${run.stderr}\n${run.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return said.length > 0 ? said.slice(0, 4).join(" ") : fallback;
}

// ── running the factory's own script ────────────────────────────────────────

export interface ReportRun {
  ok: boolean;
  markdown: string;
  /** the script's own error text when ok is false - never a sentence this
   * file invented over one the script wrote */
  reason: string | null;
}

/**
 * `uv run adws/ship_report.py --pr [--range BASE..TIP]`, cwd = the project
 * root, utf-8 in and out, killed at the timeout. Pure read-only: every git
 * call inside that script is a query (its own docstring, "PURE READ-ONLY").
 */
export async function runShipReport(root: string, range: string | null): Promise<ReportRun> {
  const script = join(root, "adws", "ship_report.py");
  if (!existsSync(script)) {
    return {
      ok: false,
      markdown: "",
      reason:
        `${script} does not exist - the shipping report is the factory's own script, ` +
        `and this project has no factory installed yet`,
    };
  }
  if (range !== null && !/^[A-Za-z0-9._/-]+\.\.[A-Za-z0-9._/-]+$/.test(range)) {
    return { ok: false, markdown: "", reason: `${range} is not a BASE..TIP range this app will pass to the script` };
  }

  const argv = ["uv", "run", "adws/ship_report.py", "--pr", ...(range === null ? [] : ["--range", range])];
  try {
    const proc = Bun.spawn(argv, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // PYTHONUTF8/PYTHONIOENCODING pin the child's encoding to utf-8 on
      // Windows too, where the console default is cp1252.
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    const timer = setTimeout(() => proc.kill(), REPORT_TIMEOUT_MS);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        const said = `${stderr}\n${stdout}`
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        return {
          ok: false,
          markdown: "",
          reason: said.length > 0 ? said.slice(0, 4).join(" ") : `${argv.join(" ")} exited ${code}`,
        };
      }
      return { ok: true, markdown: stdout, reason: null };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    // Bun.spawn throws when the binary itself is missing - the operator reads
    // the command that failed, not a stack trace.
    return {
      ok: false,
      markdown: "",
      reason: `could not run '${argv.join(" ")}': ${(error as Error).message} (is uv on PATH?)`,
    };
  }
}

// ── parsing render_pr's own line grammar ────────────────────────────────────
//
// Every regex below quotes the ship_report.py line it mirrors, so a change
// there is findable from here.

/** `f"`{chunk.tip}` is {n} commit(s) ahead of `{HUMAN_TRUNK}` (`{range}`)."` */
const AHEAD_RE = /^`([^`]+)` is (\d+) commit\(s\) ahead of `[^`]+` \(`([^`]+)`\)/m;
/** `f"Nothing to ship: `{tip}` has no commits `{HUMAN_TRUNK}` does not already have (`{range}`)."` */
const NO_COMMITS_RE = /^Nothing to ship: `([^`]+)` has no commits `[^`]+` does not already have \(`([^`]+)`\)/m;
/** `f"Nothing to ship: {n} commit(s) on `{tip}` since `{HUMAN_TRUNK}` (`{range}`), but no card ..."` */
const NO_CARDS_RE = /^Nothing to ship: (\d+) commit\(s\) on `([^`]+)` since `[^`]+` \(`([^`]+)`\)/m;

/** `f"## {card.title} (`{card.name}`)"` */
const CARD_HEADING_RE = /^## (.*?)(?: \(`([^`]+)`\))?$/;
/** `f"- Card: `queue/done/{card.name}`"` */
const CARD_PATH_RE = /^- Card: `queue\/done\/(.+)`$/;
/** `f"- Integrated: `{card.sha[:10]}` on {card.date} (detected via {card.detected_by})"` */
const INTEGRATED_RE = /^- Integrated: `([0-9a-f]+)` on (\S+) \(detected via ([a-z-]+)\)$/;
/** `f"- Branch: `{evidence.branch}`"` / `f"- Branch: {branch}"` (the second
 * form is only ever the literal "no run branch found"). */
const BRANCH_RE = /^- Branch: `(.+)`$/;
/** `f"- Diff: {n} file(s) changed, +{ins} / -{del}"` */
const DIFF_RE = /^- Diff: (\d+) file\(s\) changed, \+(\d+) \/ -(\d+)$/;
/** `f"- Diff: none recorded ({evidence.note})"` */
const DIFF_NOTE_RE = /^- Diff: none recorded(?: \((.*)\))?$/;
/** `f"- Gap: {card.read_error}"` */
const GAP_RE = /^- Gap: (.+)$/;
/** `f"- [{mark}] {c.verdict} - {c.text}"` */
const CRITERION_RE = /^- \[([ xX])\] (confirmed-by-record|cannot-confirm-from-record) - (.*)$/;
/** `f"      record: {c.evidence}"` */
const RECORD_RE = /^\s+record: (.*)$/;

export interface ParsedReport {
  cards: ShipCard[];
  commit_count: number;
  range: string | null;
  base: string | null;
  tip: string | null;
  gaps: string[];
  empty: boolean;
}

function splitRange(range: string | null): { base: string | null; tip: string | null } {
  if (!range) return { base: null, tip: null };
  const at = range.indexOf("..");
  if (at === -1) return { base: null, tip: null };
  return { base: range.slice(0, at) || null, tip: range.slice(at + 2) || null };
}

/**
 * `render_pr`'s markdown -> the same facts as data. Anything the report did
 * not print stays null here; nothing is inferred from a card's name, a date or
 * a file path.
 */
export function parseShipReport(markdown: string): ParsedReport {
  let commitCount = 0;
  let range: string | null = null;

  const ahead = AHEAD_RE.exec(markdown);
  const noCommits = NO_COMMITS_RE.exec(markdown);
  const noCards = NO_CARDS_RE.exec(markdown);
  if (ahead) {
    commitCount = Number.parseInt(ahead[2] ?? "0", 10) || 0;
    range = ahead[3] ?? null;
  } else if (noCards) {
    commitCount = Number.parseInt(noCards[1] ?? "0", 10) || 0;
    range = noCards[3] ?? null;
  } else if (noCommits) {
    commitCount = 0;
    range = noCommits[2] ?? null;
  }

  const cards: ShipCard[] = [];
  const gaps: string[] = [];
  let card: ShipCard | null = null;
  let inGaps = false;
  let pending: ShipCriterion | null = null;

  const push = () => {
    if (card) cards.push(card);
    card = null;
    pending = null;
  };

  for (const raw of markdown.split(/\r\n|\n/)) {
    const line = raw.trimEnd();

    const heading = line.startsWith("## ") ? CARD_HEADING_RE.exec(line) : null;
    if (heading) {
      push();
      const title = (heading[1] ?? "").trim();
      const name = heading[2] ?? null;
      if (title === "Gaps" && name === null) {
        inGaps = true;
        continue;
      }
      inGaps = false;
      card = {
        name: name ?? title,
        title,
        sha: null,
        date: null,
        detected_by: null,
        branch: null,
        files_changed: null,
        insertions: null,
        deletions: null,
        diff_note: null,
        criteria: [],
        gap: null,
      };
      continue;
    }

    if (inGaps) {
      if (line.startsWith("- ")) gaps.push(line.slice(2).trim());
      continue;
    }
    if (!card) continue;

    // The `record:` continuation belongs to the criterion above it.
    if (pending) {
      const record = RECORD_RE.exec(line);
      if (record) {
        pending.evidence = (record[1] ?? "").trim();
        pending = null;
        continue;
      }
      pending = null;
    }

    const path = CARD_PATH_RE.exec(line);
    if (path) {
      // The `- Card:` line is the authoritative basename; the heading's own
      // copy is only a fallback for a title that swallowed its backticks.
      card.name = path[1] ?? card.name;
      continue;
    }
    const integrated = INTEGRATED_RE.exec(line);
    if (integrated) {
      card.sha = integrated[1] ?? null;
      card.date = integrated[2] ?? null;
      const how = integrated[3] ?? "";
      card.detected_by = how === "commit-message" || how === "diff" ? how : null;
      continue;
    }
    const branch = BRANCH_RE.exec(line);
    if (branch) {
      card.branch = branch[1] ?? null;
      continue;
    }
    const diff = DIFF_RE.exec(line);
    if (diff) {
      card.files_changed = Number.parseInt(diff[1] ?? "0", 10) || 0;
      card.insertions = Number.parseInt(diff[2] ?? "0", 10) || 0;
      card.deletions = Number.parseInt(diff[3] ?? "0", 10) || 0;
      continue;
    }
    const diffNote = DIFF_NOTE_RE.exec(line);
    if (diffNote) {
      card.files_changed = 0;
      card.insertions = 0;
      card.deletions = 0;
      card.diff_note = diffNote[1] ?? null;
      continue;
    }
    const gap = GAP_RE.exec(line);
    if (gap) {
      card.gap = gap[1] ?? null;
      continue;
    }
    const criterion = CRITERION_RE.exec(line);
    if (criterion) {
      const verdict = criterion[2] as ShipCriterion["verdict"];
      const entry: ShipCriterion = {
        text: (criterion[3] ?? "").trim(),
        // render_pr writes `[x]` for confirmed-by-record and `[ ]` otherwise,
        // so the box is the verdict restated - the card's OWN checkbox is in
        // the `record:` line ("card's own checkbox: checked").
        checked: verdict === "confirmed-by-record",
        verdict,
        evidence: "",
      };
      card.criteria.push(entry);
      pending = entry;
      continue;
    }
  }
  push();

  const { base, tip } = splitRange(range);
  return {
    cards,
    commit_count: commitCount,
    range,
    base,
    tip: tip ?? (ahead?.[1] ?? noCommits?.[1] ?? noCards?.[2] ?? null),
    gaps,
    empty: cards.length === 0,
  };
}

// ── the line's real order ───────────────────────────────────────────────────

/**
 * `ship_report.py` prints its cards in `cards.sort(key=lambda c: (c.date or
 * "", c.name))` order - the park commit's `%cI` DATE STRING, then the name.
 * That is NOT ancestry order: mixed timezone offsets or clock skew between the
 * engine's VPS and a hand-parked card, or two cards parked inside the same
 * second (where the tiebreak falls to the name), and a later card sorts above
 * an earlier one.
 *
 * The rail draws this list "oldest first" and the cut is a PREFIX of it, so a
 * wrong order is a wrong chunk - the operator confirms N cards and ships N+1.
 * Ancestry is the only authority on which card comes first, so git is asked for
 * it here: `rev-list --topo-order --reverse BASE..TIP` IS the line, and the
 * cards are placed onto it.
 *
 * This re-derives nothing: the cards, their shas, their diffs and every verdict
 * stay the script's. Only their ORDER comes from git. If any card cannot be
 * placed (no sha, or a sha this range does not hold) the script's order is left
 * exactly as printed - and the ship's own cross-check below refuses rather than
 * shipping a prefix nobody can vouch for.
 */
export async function orderCardsByAncestry(root: string, parsed: ParsedReport): Promise<boolean> {
  if (parsed.cards.length < 2) return true;
  const { base, tip } = parsed;
  const usable = (value: string | null): value is string => value !== null && (isSafeSha(value) || isSafeRef(value));
  if (!usable(base) || !usable(tip)) return false;

  const walk = await git(root, ["rev-list", "--topo-order", "--reverse", `${base}..${tip}`]);
  if (walk.code !== 0) return false;
  const line = walk.stdout
    .split("\n")
    .map((sha) => sha.trim())
    .filter(Boolean);
  if (line.length === 0) return false;

  const place = new Map<string, number>();
  for (const card of parsed.cards) {
    if (!card.sha || !isSafeSha(card.sha)) return false;
    const at = line.findIndex((full) => full.startsWith(card.sha!));
    if (at === -1) return false;
    place.set(card.name, at);
  }

  parsed.cards = parsed.cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => (place.get(a.card.name)! - place.get(b.card.name)!) || a.index - b.index)
    .map((entry) => entry.card);
  return true;
}

// ── GET /api/app/p/:id/ship/report ──────────────────────────────────────────

function emptyReport(reason: string): ShipReportResponse {
  return {
    markdown: "",
    cards: [],
    commit_count: 0,
    empty: true,
    range: null,
    base: null,
    tip: null,
    gaps: [],
    available: false,
    reason,
    generated_at: new Date().toISOString(),
  };
}

export async function buildShipReport(root: string, range: string | null, deps: ShipDeps = liveDeps): Promise<ShipReportResponse> {
  const run = await deps.report(root, range);
  if (!run.ok) return emptyReport(run.reason ?? "the shipping report could not be produced");
  const parsed = parseShipReport(run.markdown);
  // The rail renders these in array order and calls it "oldest first"; git is
  // what makes that true.
  await orderCardsByAncestry(root, parsed);
  return {
    markdown: run.markdown,
    cards: parsed.cards,
    commit_count: parsed.commit_count,
    empty: parsed.empty,
    range: parsed.range,
    base: parsed.base,
    tip: parsed.tip,
    gaps: parsed.gaps,
    available: true,
    reason: null,
    generated_at: new Date().toISOString(),
  };
}

async function getShipReport(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);
  const range = new URL(req.url).searchParams.get("range");
  return appJson(await buildShipReport(scope.root, range && range.trim() ? range.trim() : null));
}

// ── POST /api/app/p/:id/ship ────────────────────────────────────────────────

/** The one injectable seam: everything else in the sequence is git, and git is
 * exercised for real (fixture repos with local bare origins) in the tests. */
export interface ShipDeps {
  report: (root: string, range: string | null) => Promise<ReportRun>;
}

export const liveDeps: ShipDeps = { report: runShipReport };

export interface ShipBody {
  /** a card basename (`003-slug.md`) to cut the chunk AT that card, or
   * `"all"` for the whole line. Defaults to `"all"`. */
  cut?: string;
}

export type ShipOutcome = { ok: true; result: ShipResult } | { ok: false; error: string; status: number };

function refuse(error: string, status = 409): ShipOutcome {
  return { ok: false, error, status };
}

/** One ship per checkout at a time - two clicks must never interleave a
 * checkout with a commit. */
const inFlight = new Set<string>();

async function gitOk(root: string, args: string[]): Promise<boolean> {
  return (await git(root, args)).code === 0;
}

async function refExists(root: string, ref: string): Promise<boolean> {
  if (!isSafeRef(ref) && !isSafeSha(ref)) return false;
  return gitOk(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/** true / false, or null when either ref does not resolve (unknown, not "no"). */
async function isAncestor(root: string, ancestor: string, of: string): Promise<boolean | null> {
  if (!(await refExists(root, ancestor)) || !(await refExists(root, of))) return null;
  const { code } = await git(root, ["merge-base", "--is-ancestor", ancestor, of]);
  if (code === 0) return true;
  if (code === 1) return false;
  return null;
}

/**
 * The guarded squash sequence. Every refusal happens BEFORE anything is
 * written, except the two that cannot (a push refused after the commit
 * landed, a branch that would not restore) - and those are reported as facts
 * on a 200, never swallowed.
 */
export async function performShip(root: string, body: ShipBody, deps: ShipDeps = liveDeps): Promise<ShipOutcome> {
  const cut = (body.cut ?? "all").trim() || "all";
  if (cut !== "all" && (!isSafeSegment(cut) || !cut.toLowerCase().endsWith(".md"))) {
    return refuse(`cut must be "all" or a queue card basename like 003-slug.md, got ${cut}`, 400);
  }

  if (!(await gitOk(root, ["rev-parse", "--git-dir"]))) {
    return refuse(`${root} is not a git repository`);
  }

  if (inFlight.has(root)) return refuse(`a ship is already running in ${root}`);
  inFlight.add(root);
  try {
    // 1. A clean tree. The squash stages `integration`'s whole diff, so any
    //    uncommitted work in the way would be mixed into the ship commit.
    const status = await git(root, ["status", "--porcelain"]);
    if (status.code !== 0) return refuse(reasonFrom(status, "git status failed"));
    if (status.stdout.trim() !== "") {
      const count = status.stdout.trim().split("\n").length;
      return refuse(
        `the checkout at ${root} has ${count} uncommitted change(s) - commit or stash them first; ` +
          `the ship squash stages the whole chunk and will not mix your working tree into it`,
      );
    }

    // 2. Where we are now, so we can put the operator back afterwards.
    const head = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const previousBranch = head.code === 0 ? head.stdout.trim() : "";
    if (previousBranch === "" || previousBranch === "HEAD") {
      return refuse(`the checkout at ${root} is on a detached HEAD - check out a branch first`);
    }

    // 3. A committer identity, named before anything is staged (J7's "loud
    //    preflight line naming the fix").
    const email = await git(root, ["config", "user.email"]);
    const name = await git(root, ["config", "user.name"]);
    if (email.stdout.trim() === "" || name.stdout.trim() === "") {
      return refuse(
        `git has no committer identity in ${root} - set it with ` +
          `\`git config user.email you@example.com\` and \`git config user.name "Your Name"\`, then ship again`,
      );
    }

    // 4. Fetch, so "diverged" is a fact about the hub and not about a stale
    //    local view. No remote = nothing to fetch and nothing to push, said
    //    plainly rather than pretended away.
    const remoteUrl = await git(root, ["remote", "get-url", "origin"]);
    const remote = remoteUrl.code === 0 && remoteUrl.stdout.trim() !== "" ? "origin" : null;
    let fetched = false;
    let fetchNote: string | null = null;
    if (remote) {
      const fetch = await git(root, ["fetch", "--prune", remote]);
      if (fetch.code !== 0) {
        return refuse(
          `could not fetch ${remote}: ${reasonFrom(fetch, `git fetch ${remote} exited ${fetch.code}`)} - ` +
            `the ship needs an up-to-date view of ${MAIN} before it moves it`,
        );
      }
      fetched = true;
    } else {
      fetchNote = `no origin remote in ${root} - nothing was fetched, and nothing will be pushed`;
    }

    // 5. The working line. A main-tracking clone has only ever fetched it, so
    //    `origin/integration` is the honest fallback (ship_report.py's own
    //    `resolve_integration_ref` does exactly this).
    let integrationRef = INTEGRATION;
    if (!(await refExists(root, integrationRef))) {
      integrationRef = `origin/${INTEGRATION}`;
      if (!(await refExists(root, integrationRef))) {
        return refuse(
          `no ${INTEGRATION} branch in ${root} (nor origin/${INTEGRATION}) - ` +
            `the factory's working line is the only thing a chunk ships from`,
        );
      }
    }

    // 6. main itself, and whether the hub has moved under it.
    if (!(await refExists(root, MAIN))) return refuse(`no ${MAIN} branch in ${root} - nothing to ship onto`);
    if (remote && (await refExists(root, `origin/${MAIN}`))) {
      const behind = await isAncestor(root, `origin/${MAIN}`, MAIN);
      if (behind === null) return refuse(`could not compare origin/${MAIN} with ${MAIN}`);
      if (!behind) {
        return refuse(
          `${MAIN} and origin/${MAIN} have diverged: origin/${MAIN} holds commits your ${MAIN} does not - ` +
            `pull first, then ship; this button never forces`,
        );
      }
    }

    // 7. The report decides what is shippable - this app never re-derives it.
    const chunk = await deps.report(root, null);
    if (!chunk.ok) return refuse(`the shipping report could not be produced: ${chunk.reason ?? "no reason given"}`);
    const parsed = parseShipReport(chunk.markdown);
    if (parsed.commit_count === 0) {
      return refuse(`nothing to ship: ${integrationRef} has no commits ${MAIN} does not already have`);
    }
    if (parsed.cards.length === 0) {
      return refuse(
        `nothing to ship: ${parsed.commit_count} commit(s) on ${integrationRef} since ${MAIN}, ` +
          `but no card was parked into queue/done/ inside them`,
      );
    }
    if (!parsed.base) {
      return refuse(`the shipping report printed no BASE..TIP range - cannot tell where this chunk starts`);
    }

    // The cut is a prefix of this array, so the array has to be the line.
    await orderCardsByAncestry(root, parsed);

    // 8. The cut point: the card's own integration commit, or the tip.
    let cutRef: string;
    let cutRange: string | null;
    let shipping: string[];
    if (cut === "all") {
      cutRef = integrationRef;
      cutRange = null; // the script's own default range - already in `chunk`
      shipping = parsed.cards.map((c) => c.name);
    } else {
      const index = parsed.cards.findIndex((c) => c.name === cut);
      if (index === -1) {
        return refuse(
          `${cut} is not a card in this chunk - the report lists ${parsed.cards.map((c) => c.name).join(", ")}`,
        );
      }
      const at = parsed.cards[index]!;
      if (!at.sha || !isSafeSha(at.sha)) {
        return refuse(`the report names no integration commit for ${cut} - it cannot be a cut point`);
      }
      cutRef = at.sha;
      cutRange = `${parsed.base}..${at.sha}`;
      shipping = parsed.cards.slice(0, index + 1).map((c) => c.name);
    }

    const resolved = await git(root, ["rev-parse", "--verify", cutRef]);
    if (resolved.code !== 0) return refuse(reasonFrom(resolved, `${cutRef} does not resolve in ${root}`));
    const cutSha = resolved.stdout.trim();

    // The cut must sit ON the working line - a sha from a stale report that no
    // longer belongs to `integration` is refused rather than merged.
    const onLine = await isAncestor(root, cutSha, integrationRef);
    if (onLine === null) return refuse(`could not compare ${cutSha} with ${integrationRef}`);
    if (!onLine) {
      return refuse(`${cutSha.slice(0, 10)} is not an ancestor of ${integrationRef} - re-read the report and ship again`);
    }

    // 9. The squash body, for exactly the range being shipped.
    const message = cutRange === null ? chunk : await deps.report(root, cutRange);
    if (!message.ok) {
      return refuse(`the squash body could not be produced for ${cutRange}: ${message.reason ?? "no reason given"}`);
    }

    // 9b. That body is the report re-walked over BASE..<cut>, so it is git's
    //     own answer to "which cards are inside this cut". The prefix computed
    //     above must agree with it exactly. If it does not, the app would be
    //     shipping a set the operator never confirmed - and disagreeing with
    //     the very commit message it is about to author - so it refuses here,
    //     before the checkout is touched, rather than silently widening.
    if (cutRange !== null) {
      const inRange = parseShipReport(message.markdown);
      const actual = inRange.cards.map((c) => c.name);
      const same = actual.length === shipping.length && actual.every((name) => shipping.includes(name));
      if (!same) {
        return refuse(
          `the cut at ${cut} selects ${shipping.length} card(s) (${shipping.join(", ")}) but the report for ` +
            `${cutRange} carries ${actual.length} (${actual.length === 0 ? "none" : actual.join(", ")}) - ` +
            `the order the line is listed in and git's own ancestry disagree, so nothing was shipped; ` +
            `Sync and read the report again`,
        );
      }
    }

    // 10. Move to main. Everything before this line was a question; from here
    //     on the checkout changes, so every step reports what it actually did.
    if (previousBranch !== MAIN) {
      const checkout = await git(root, ["checkout", MAIN]);
      if (checkout.code !== 0) {
        return refuse(`could not check out ${MAIN}: ${reasonFrom(checkout, `git checkout ${MAIN} exited ${checkout.code}`)}`);
      }
    }

    const restore = async (): Promise<{ ok: boolean; error: string | null }> => {
      if (previousBranch === MAIN) return { ok: true, error: null };
      const back = await git(root, ["checkout", previousBranch]);
      return back.code === 0
        ? { ok: true, error: null }
        : { ok: false, error: reasonFrom(back, `git checkout ${previousBranch} exited ${back.code}`) };
    };

    /**
     * The exit used by every failure AFTER the checkout moved. `git merge
     * --squash` records no MERGE_HEAD, so `git merge --abort` is a no-op and a
     * plain `git checkout` then refuses with "you need to resolve your current
     * index first" - which would strand the operator ON `main` holding a
     * conflicted index or a staged cross-branch chunk, a state only manual git
     * could undo.
     *
     * `git reset --hard HEAD` is the lossless answer here and nowhere else:
     * step 1 already PROVED this tree was clean on entry, so the only thing it
     * can discard is what this sequence itself just staged - and that is
     * reconstructible at any time by running the ship again. Nothing of the
     * operator's is in the way to lose.
     */
    const abandon = async (): Promise<{ ok: boolean; error: string | null }> => {
      const reset = await git(root, ["reset", "--hard", "HEAD"]);
      if (reset.code !== 0) {
        return { ok: false, error: reasonFrom(reset, `git reset --hard HEAD exited ${reset.code}`) };
      }
      return restore();
    };

    // 11. The squash itself. Never a second parent, never a force, and
    //     `integration` is only ever READ (a sha is passed, no ref is moved).
    const squash = await git(root, ["merge", "--squash", cutSha]);
    if (squash.code !== 0) {
      const why = reasonFrom(squash, `git merge --squash ${cutSha.slice(0, 10)} exited ${squash.code}`);
      const back = await abandon();
      return refuse(
        back.ok
          ? `the squash was refused: ${why} - the half-merged index was thrown away and your checkout is back ` +
              `on ${previousBranch}, exactly as it was`
          : `the squash was refused: ${why} - and the checkout could not be returned to ${previousBranch}: ` +
              `${back.error}; you are on ${MAIN} and will have to run \`git reset --hard HEAD\` and ` +
              `\`git checkout ${previousBranch}\` yourself`,
      );
    }

    const staged = await git(root, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) {
      const back = await abandon();
      return refuse(
        `git merge --squash ${cutSha.slice(0, 10)} staged no changes - ${MAIN} already holds this content` +
          (back.ok ? "" : ` (and the checkout could not return to ${previousBranch}: ${back.error})`),
      );
    }

    // 12. The body goes into the git dir, so the work tree stays clean, and
    //     `git commit -F` reads it - the markdown never passes through a shell.
    const gitDirRun = await git(root, ["rev-parse", "--absolute-git-dir"]);
    const gitDir = gitDirRun.code === 0 ? gitDirRun.stdout.trim() : join(root, ".git");
    const messageFile = join(gitDir, MESSAGE_FILE);
    try {
      await writeFile(messageFile, message.markdown.replace(/\r\n/g, "\n"), "utf-8");
    } catch (error) {
      const back = await abandon();
      return refuse(
        `could not write the squash body to ${messageFile}: ${(error as Error).message}` +
          (back.ok ? "" : ` (and the checkout could not return to ${previousBranch}: ${back.error})`),
      );
    }

    // `--cleanup=verbatim`: the report is markdown, and its `#` headings are
    // git comment characters under every other cleanup mode.
    const commit = await git(root, ["commit", "--cleanup=verbatim", "-F", messageFile]);
    if (commit.code !== 0) {
      const why = reasonFrom(commit, `git commit exited ${commit.code}`);
      // The staged chunk is this sequence's own work (a commit hook refused it,
      // typically), and it is reproducible by shipping again - so it is thrown
      // away rather than left on MAIN under the operator's hands, where one
      // stray `git commit` would author an unreviewed commit on the trunk.
      const back = await abandon();
      return refuse(
        back.ok
          ? `the squash was staged on ${MAIN} but the commit failed: ${why} - the staged chunk was thrown away ` +
              `and your checkout is back on ${previousBranch}; nothing of yours was touched, and shipping again ` +
              `rebuilds it exactly`
          : `the squash was staged on ${MAIN} but the commit failed: ${why} - and the checkout could not be ` +
              `returned to ${previousBranch}: ${back.error}; you are on ${MAIN} with the chunk still staged`,
      );
    }

    const shortSha = await git(root, ["rev-parse", "--short", MAIN]);
    const commitSha = shortSha.code === 0 ? shortSha.stdout.trim() : cutSha.slice(0, 7);

    // 13. Push. A refusal here is a fact about the hub, not a failure of the
    //     ship: the commit exists locally and the response says so.
    let pushed = false;
    let pushError: string | null = null;
    if (remote) {
      const push = await git(root, ["push", remote, MAIN]);
      if (push.code === 0) {
        pushed = true;
      } else {
        pushError = reasonFrom(push, `git push ${remote} ${MAIN} exited ${push.code}`);
      }
    } else {
      pushError = fetchNote;
    }

    const back = await restore();

    return {
      ok: true,
      result: {
        shipped: true,
        cut,
        cut_sha: cutSha,
        range: cutRange ?? parsed.range ?? `${parsed.base}..${cutSha}`,
        cards: shipping,
        commit: commitSha,
        message_file: messageFile,
        integration_ref: integrationRef,
        fetched,
        fetch_note: fetchNote,
        pushed,
        push_error: pushError,
        remote,
        previous_branch: previousBranch,
        restored_branch: back.ok,
        restore_error: back.error,
      },
    };
  } finally {
    inFlight.delete(root);
  }
}

async function postShip(req: Request): Promise<Response> {
  const id = param(req, "id");
  const scope = await getScope(id);
  if (!scope) return appError(`no project ${id}`, 404);

  let body: ShipBody = {};
  try {
    const text = await req.text();
    if (text.trim() !== "") body = JSON.parse(text) as ShipBody;
  } catch (error) {
    return appError(`body must be JSON: ${(error as Error).message}`, 400);
  }
  if (typeof body !== "object" || body === null || (body.cut !== undefined && typeof body.cut !== "string")) {
    return appError('body must be {"cut": "<card basename>" | "all"}', 400);
  }

  const outcome = await performShip(scope.root, body);
  return outcome.ok ? appJson(outcome.result) : appError(outcome.error, outcome.status);
}

/** Mounted from `routes.ts`. The GET is a read; the POST is the only write in
 * the whole app that moves `main`, and it is behind the same origin +
 * `X-App-Token` guard every other write on this plane uses. */
export function shipRoutes(token: string, selfOrigins: ReadonlySet<string>) {
  return {
    "/api/app/p/:id/ship/report": { GET: appSafely(getShipReport) },
    "/api/app/p/:id/ship": { POST: csrfGuard(token, selfOrigins, postShip) },
  };
}
