/**
 * Tests for the ship plane (`app/ship.ts`), run with
 * `bun test server/app/ship.test.ts` from `apps/ui`.
 *
 * Everything git here is REAL: each test builds a throwaway repository in the
 * OS temp directory with a local bare `origin` beside it, so `fetch`, `push`,
 * "diverged" and "push refused" are the actual git behaviours, not mocks. No
 * network is ever touched (`file://`-style local paths only), and nothing
 * outside the temp directory is read or written.
 *
 * The ONE injected seam is `deps.report`: `adws/ship_report.py` is the
 * factory's own script and re-running it per test would make these tests a
 * python-environment probe instead of a test of the squash sequence. The
 * report grammar is covered separately - once against text captured verbatim
 * from a real `--pr` run, and once by running the real script end to end
 * (skipped only when `uv` is not on PATH).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NOT_STARTED_SENTENCE,
  buildShipReport,
  parseShipReport,
  performShip,
  refusalFrom,
  runShipReport,
  type ReportRun,
  type ShipDeps,
} from "./ship.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function run(cwd: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
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
  return { code, stdout, stderr };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run(cwd, ["git", ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

interface Fixture {
  root: string;
  origin: string;
  /** integration commit sha per card basename, in integration order */
  shas: Map<string, string>;
  base: string;
}

/**
 * A repo shaped like the real thing: `main` with the queue seam, then three
 * cards parked onto `integration` one commit each - exactly what the engine
 * leaves behind (`engine.py:park_card`'s "factory: <card> integrated").
 */
async function makeFixture(cards = ["001-first.md", "002-second.md", "003-third.md"]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "sdl-ship-"));
  roots.push(dir);
  const origin = join(dir, "origin.git");
  const root = join(dir, "work");
  await mkdir(root, { recursive: true });

  await run(dir, ["git", "init", "--bare", "-b", "main", origin]);
  await git(root, "init", "-b", "main", ".");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Ship Test");
  await git(root, "config", "commit.gpgsign", "false");
  await mkdir(join(root, "queue", "done"), { recursive: true });
  await writeFile(join(root, "queue", "TEMPLATE.md"), "# Title of the change\n\nStatus: ready-for-agent\n", "utf-8");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "the queue seam");
  await git(root, "remote", "add", "origin", origin);
  await git(root, "push", "-u", "origin", "main");
  const base = await git(root, "rev-parse", "main");

  await git(root, "checkout", "-b", "integration");
  const shas = new Map<string, string>();
  for (const name of cards) {
    await writeFile(
      join(root, "queue", "done", name),
      `# ${name}\n\nStatus: done\nAdw: simple-sdlc\nAdw-Id: adw-${name.slice(0, 3)}\nNeeds:\n\n## Agent Brief\n\n**Acceptance criteria:**\n- [x] first condition\n`,
      "utf-8",
    );
    await writeFile(join(root, `${name}.txt`), `code for ${name}\n`, "utf-8");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", `factory: ${name} integrated`);
    shas.set(name, await git(root, "rev-parse", "HEAD"));
  }
  await git(root, "push", "-u", "origin", "integration");
  await git(root, "checkout", "main");

  return { root, origin, shas, base };
}

/** `render_pr`'s exact shape, built from the fixture's real shas - so the
 * parser under test reads the same grammar the script prints. */
function renderReport(fixture: Fixture, names: string[]): string {
  const lines = [
    `# Shipping report: ${names.length} card(s) ready for \`main\``,
    "",
    `\`integration\` is ${names.length} commit(s) ahead of \`main\` (\`${fixture.base}..integration\`). This is the body for the ONE squash commit MAP.md's two-box model reserves for \`main\` - assembled from git alone, no agent judgment.`,
    "",
  ];
  for (const name of names) {
    lines.push(
      `## ${name} (\`${name}\`)`,
      "",
      `- Card: \`queue/done/${name}\``,
      `- Integrated: \`${fixture.shas.get(name)!.slice(0, 10)}\` on 2026-08-15T10:00:00+03:00 (detected via commit-message)`,
      "- Branch: no run branch found",
      "- Diff: none recorded (no adw/adw-001_* branch in this checkout)",
      "",
      "Acceptance criteria:",
      "- [ ] cannot-confirm-from-record - first condition",
      "      record: the record has nothing mechanical that speaks to this criterion (card's own checkbox: checked)",
      "",
    );
  }
  lines.push("## Gaps", "", "- 001-first.md: no adw/adw-001_* branch in this checkout", "");
  return lines.join("\n");
}

/**
 * `names` is the order the SCRIPT prints - which is its date-then-name sort,
 * not ancestry (ship_report.py:548). A ranged call re-walks git, so its card
 * set is decided by ancestry (the fixture's own creation order) and only its
 * ORDER comes from `names` - exactly how the real script behaves, and the
 * reason the two can disagree.
 */
function stubDeps(fixture: Fixture, names: string[], hooks: { onCall?: (range: string | null) => Promise<void> } = {}) {
  const calls: (string | null)[] = [];
  const ancestry = [...fixture.shas.keys()];
  const deps: ShipDeps = {
    report: async (_root, range): Promise<ReportRun> => {
      calls.push(range);
      await hooks.onCall?.(range);
      if (range === null) return { ok: true, markdown: renderReport(fixture, names), reason: null };
      // A ranged call is the mid-line cut: the body covers only the cards up
      // to the cut point, which is what the squash commit must carry.
      const cutSha = range.split("..")[1] ?? "";
      const at = ancestry.findIndex((n) => fixture.shas.get(n)!.startsWith(cutSha));
      const inRange = new Set(ancestry.slice(0, at + 1));
      return { ok: true, markdown: renderReport(fixture, names.filter((n) => inRange.has(n))), reason: null };
    },
  };
  return { deps, calls };
}

// ── the report grammar ──────────────────────────────────────────────────────

/** Captured verbatim from `uv run adws/ship_report.py --pr` against a fixture
 * repo on 2026-08-15 - if `render_pr` ever changes shape, this string is what
 * fails first. */
const REAL_REPORT = `# Shipping report: 2 card(s) ready for \`main\`

\`integration\` is 3 commit(s) ahead of \`main\` (\`ea26454f166b8ddeca31bff704124a7805bef1ea..integration\`). This is the body for the ONE squash commit MAP.md's two-box model reserves for \`main\` - assembled from git alone, no agent judgment.

## Card 001 (\`001-card.md\`)

- Card: \`queue/done/001-card.md\`
- Integrated: \`b53559f156\` on 2026-08-15T19:33:10+03:00 (detected via commit-message)
- Branch: \`adw/adw-001_add-health\`
- Diff: 4 file(s) changed, +120 / -7
- Tests touched: 1 (tests/test_health.py)
- Docs touched: 0 (none)

Acceptance criteria:
- [x] confirmed-by-record - tests cover it
      record: diff touched test file(s): tests/test_health.py (card's own checkbox: checked)
- [ ] cannot-confirm-from-record - behavior returns 200
      record: the record has nothing mechanical that speaks to this criterion (card's own checkbox: unchecked)

## Card 002 (\`002-card.md\`)

- Card: \`queue/done/002-card.md\`
- Integrated: \`a46139f4b3\` on 2026-08-15T19:33:11+03:00 (detected via diff)
- Gap: no H1 title found - malformed card, treated as a gap
- Branch: no run branch found
- Diff: none recorded (no adw/adw-002_* branch in this checkout)

Acceptance criteria: none recorded on this card.

## Gaps

- 002-card.md: no H1 title found - malformed card, treated as a gap
- 002-card.md: no adw/adw-002_* branch in this checkout
`;

describe("parseShipReport", () => {
  test("reads a real --pr report: cards, cut points, verdicts, gaps", () => {
    const parsed = parseShipReport(REAL_REPORT);

    expect(parsed.commit_count).toBe(3);
    expect(parsed.range).toBe("ea26454f166b8ddeca31bff704124a7805bef1ea..integration");
    expect(parsed.base).toBe("ea26454f166b8ddeca31bff704124a7805bef1ea");
    expect(parsed.tip).toBe("integration");
    expect(parsed.empty).toBe(false);
    expect(parsed.cards.map((c) => c.name)).toEqual(["001-card.md", "002-card.md"]);

    const first = parsed.cards[0]!;
    expect(first.title).toBe("Card 001");
    expect(first.sha).toBe("b53559f156"); // the cut point
    expect(first.date).toBe("2026-08-15T19:33:10+03:00");
    expect(first.detected_by).toBe("commit-message");
    expect(first.branch).toBe("adw/adw-001_add-health");
    expect(first.files_changed).toBe(4);
    expect(first.insertions).toBe(120);
    expect(first.deletions).toBe(7);
    expect(first.gap).toBeNull();
    expect(first.criteria).toHaveLength(2);
    expect(first.criteria[0]).toEqual({
      text: "tests cover it",
      checked: true,
      verdict: "confirmed-by-record",
      evidence: "diff touched test file(s): tests/test_health.py (card's own checkbox: checked)",
    });
    expect(first.criteria[1]!.verdict).toBe("cannot-confirm-from-record");

    const second = parsed.cards[1]!;
    expect(second.detected_by).toBe("diff");
    expect(second.gap).toBe("no H1 title found - malformed card, treated as a gap");
    expect(second.criteria).toEqual([]);
    expect(second.diff_note).toBe("no adw/adw-002_* branch in this checkout");

    // The Gaps section is the report's own, not a re-derivation.
    expect(parsed.gaps).toHaveLength(2);
    expect(parsed.gaps[0]).toContain("no H1 title found");
  });

  test("both 'nothing to ship' shapes are read as empty, with their counts", () => {
    const noCommits = parseShipReport(
      "# Shipping report\n\nNothing to ship: `integration` has no commits `main` does not already have (`abc123..integration`).\n",
    );
    expect(noCommits.commit_count).toBe(0);
    expect(noCommits.empty).toBe(true);
    expect(noCommits.cards).toEqual([]);
    expect(noCommits.range).toBe("abc123..integration");

    const noCards = parseShipReport(
      "# Shipping report\n\nNothing to ship: 4 commit(s) on `integration` since `main` (`abc123..integration`), but no card was parked into `queue/done/` inside them.\n",
    );
    expect(noCards.commit_count).toBe(4);
    expect(noCards.empty).toBe(true);
    expect(noCards.cards).toEqual([]);
  });
});

describe("runShipReport", () => {
  test("a project with no factory says exactly that, and never guesses a report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdl-noscript-"));
    roots.push(dir);
    const result = await runShipReport(dir, null);
    expect(result.ok).toBe(false);
    expect(result.markdown).toBe("");
    expect(result.reason).toContain("ship_report.py");
    expect(result.reason).toContain("no factory installed");
  });

  test("refuses a range that is not BASE..TIP rather than passing it to the script", async () => {
    // The factory's own checkout, where the script really does exist - so the
    // refusal below is the range check and not a missing file.
    const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..");
    const result = await runShipReport(repoRoot, "--out;rm -rf /");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("BASE..TIP");
  });

  // The one test that runs the factory's own script end to end: it proves the
  // grammar above is the grammar the script really prints today.
  const uv = Bun.which("uv");
  test.skipIf(!uv)("the real ship_report.py, run in a fixture repo, parses into its cards", async () => {
    const fixture = await makeFixture(["001-first.md", "002-second.md"]);
    // The script and its one stdlib-only helper, copied in and committed so
    // the tree stays clean (nothing under adws/ in this repo is modified).
    const here = resolve(import.meta.dir, "..", "..", "..", "..");
    await mkdir(join(fixture.root, "adws", "adw_modules"), { recursive: true });
    await cp(join(here, "adws", "ship_report.py"), join(fixture.root, "adws", "ship_report.py"));
    await cp(join(here, "adws", "adw_modules", "git_helper.py"), join(fixture.root, "adws", "adw_modules", "git_helper.py"));
    await git(fixture.root, "add", "-A");
    await git(fixture.root, "commit", "-m", "the factory's report script");

    const report = await runShipReport(fixture.root, null);
    expect(report.reason).toBeNull();
    expect(report.ok).toBe(true);

    const parsed = parseShipReport(report.markdown);
    expect(parsed.commit_count).toBe(2);
    expect(parsed.cards.map((c) => c.name)).toEqual(["001-first.md", "002-second.md"]);
    for (const card of parsed.cards) {
      expect(card.sha).toMatch(/^[0-9a-f]{7,40}$/);
      // the abbreviated sha the report prints IS the fixture's own commit
      expect(fixture.shas.get(card.name)!.startsWith(card.sha!)).toBe(true);
    }
  }, 60_000);
});

// ── the refusal an operator actually reads ──────────────────────────────────
//
// The defect this covers: a project the factory has never run in has no
// `integration` branch, the script says so in git's vocabulary, and Home and
// the merge rail printed that sentence verbatim in a red box. It is the normal
// state of every fresh project and it is now one plain sentence.

describe("refusalFrom", () => {
  test("no integration branch is 'the factory hasn't run here', with the script's text kept for a tooltip", () => {
    const said =
      "ship_report: error: 'integration' does not resolve to a commit in C:\\repo - is this checkout missing " +
      "that branch? (fetch it, or pass --integration origin/<name>, or --range to name two refs that exist here)";
    const refusal = refusalFrom(said);
    expect(refusal.not_started).toBe(true);
    expect(refusal.reason).toBe(NOT_STARTED_SENTENCE);
    expect(refusal.reason).not.toContain("does not resolve");
    expect(refusal.detail).toContain("does not resolve to a commit"); // nothing is hidden
  });

  // The state STRICTLY EARLIER than a missing `integration`: the app was pointed
  // at a project before the factory was installed in it, so `adws/ship_report.py`
  // is not there to run. With the registry empty this is the FIRST refusal a new
  // operator meets, and it was printing an absolute Windows path in red.
  test("no factory installed is the same quiet state, with the path kept for a tooltip", async () => {
    const root = await mkdtemp(join(tmpdir(), "no-factory-"));
    roots.push(root);
    const attempt = await runShipReport(root, null);
    expect(attempt.ok).toBe(false);

    const refusal = refusalFrom(attempt.reason!);
    expect(refusal.not_started).toBe(true);
    expect(refusal.reason).toBe(NOT_STARTED_SENTENCE);
    expect(refusal.reason).not.toContain(root); // no absolute path in the sentence
    expect(refusal.detail).toContain("ship_report.py"); // nothing is hidden

    // And the whole way through the endpoint's own builder, on the real seam.
    const report = await buildShipReport(root, null, { report: runShipReport });
    expect(report.available).toBe(false);
    expect(report.not_started).toBe(true);
    expect(report.reason).toBe(NOT_STARTED_SENTENCE);
  });

  test("a missing `main` is NOT that - it is a real problem with the checkout", () => {
    const refusal = refusalFrom(
      "ship_report: error: 'main' does not resolve to a commit in C:\\repo - is this checkout missing that branch? (fetch it)",
    );
    expect(refusal.not_started).toBe(false);
    expect(refusal.reason).toContain("'main' does not resolve");
  });

  test("any other failure keeps its first sentence, and only its first sentence", () => {
    const refusal = refusalFrom("Traceback (most recent call last). File x, line 3. KeyError: 'cards'");
    expect(refusal.reason).toBe("Traceback (most recent call last).");
    expect(refusal.detail).toContain("KeyError");
    expect(refusal.not_started).toBe(false);
  });

  test("a one-sentence failure carries no tooltip - there is nothing more to show", () => {
    const refusal = refusalFrom("could not run 'uv run adws/ship_report.py --pr': ENOENT (is uv on PATH?)");
    expect(refusal.detail).toBeNull();
    expect(refusal.not_started).toBe(false);
  });
});

describe("buildShipReport", () => {
  const uvHere = Bun.which("uv");
  test.skipIf(!uvHere)("a fixture with no integration branch reports not_started, empty, and no git vocabulary", async () => {
    const fixture = await makeFixture([]);
    const here = resolve(import.meta.dir, "..", "..", "..", "..");
    await mkdir(join(fixture.root, "adws", "adw_modules"), { recursive: true });
    await cp(join(here, "adws", "ship_report.py"), join(fixture.root, "adws", "ship_report.py"));
    await cp(join(here, "adws", "adw_modules", "git_helper.py"), join(fixture.root, "adws", "adw_modules", "git_helper.py"));
    await git(fixture.root, "add", "-A");
    await git(fixture.root, "commit", "-m", "the factory's report script");

    // The factory has never run here: only the engine ever creates
    // `integration`, so a fresh project simply does not have one.
    await git(fixture.root, "push", "origin", "--delete", "integration");
    await git(fixture.root, "branch", "-D", "integration");
    await git(fixture.root, "fetch", "--prune", "origin");

    // The real script's own words, through the real seam.
    const report = await buildShipReport(fixture.root, null, { report: runShipReport });
    expect(report.available).toBe(false);
    expect(report.not_started).toBe(true);
    expect(report.empty).toBe(true);
    expect(report.cards).toEqual([]);
    expect(report.reason).toBe(NOT_STARTED_SENTENCE);
    expect(report.detail).toContain("integration");
  }, 60_000);
});

// ── the guarded squash ──────────────────────────────────────────────────────

describe("performShip", () => {
  test("happy path: one squash commit on main, pushed, previous branch restored", async () => {
    const fixture = await makeFixture();
    const names = [...fixture.shas.keys()];
    const { deps, calls } = stubDeps(fixture, names);

    const before = await git(fixture.root, "rev-parse", "main");
    const integrationBefore = await git(fixture.root, "rev-parse", "integration");

    const outcome = await performShip(fixture.root, { cut: "all" }, deps);
    if (!outcome.ok) throw new Error(`refused: ${outcome.error}`);

    expect(outcome.result.shipped).toBe(true);
    expect(outcome.result.cards).toEqual(names);
    expect(outcome.result.pushed).toBe(true);
    expect(outcome.result.push_error).toBeNull();
    expect(outcome.result.integration_ref).toBe("integration");
    expect(outcome.result.fetched).toBe(true);
    expect(outcome.result.restored_branch).toBe(true);
    expect(calls).toEqual([null]); // "all" reuses the chunk report as the body

    // ONE commit on main, carrying integration's whole tree.
    const after = await git(fixture.root, "rev-parse", "main");
    expect(after).not.toBe(before);
    expect(await git(fixture.root, "rev-list", "--count", `${before}..main`)).toBe("1");
    expect(await git(fixture.root, "rev-parse", "main^{tree}")).toBe(await git(fixture.root, "rev-parse", "integration^{tree}"));

    // The report IS the commit message - markdown headings and all.
    const message = (await run(fixture.root, ["git", "log", "-1", "--format=%B", "main"])).stdout;
    expect(message).toContain("# Shipping report: 3 card(s) ready for `main`");
    expect(message).toContain("## 003-third.md");

    // integration is never touched, and the hub has main's new commit.
    expect(await git(fixture.root, "rev-parse", "integration")).toBe(integrationBefore);
    expect(await git(fixture.origin, "rev-parse", "main")).toBe(after);
    // and the operator is back where they started
    expect(await git(fixture.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  }, 60_000);

  test("a mid-line cut advances main to THAT card's integration commit, no further", async () => {
    const fixture = await makeFixture();
    const names = [...fixture.shas.keys()];
    const { deps, calls } = stubDeps(fixture, names);

    // Start somewhere else entirely, to exercise the restore.
    await git(fixture.root, "checkout", "-b", "operator-branch");

    const outcome = await performShip(fixture.root, { cut: "002-second.md" }, deps);
    if (!outcome.ok) throw new Error(`refused: ${outcome.error}`);

    expect(outcome.result.cards).toEqual(["001-first.md", "002-second.md"]);
    expect(outcome.result.cut_sha).toBe(fixture.shas.get("002-second.md")!);
    expect(outcome.result.range).toBe(`${fixture.base}..${fixture.shas.get("002-second.md")!.slice(0, 10)}`);

    // The body was assembled for the cut range, not the whole line.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(`${fixture.base}..${fixture.shas.get("002-second.md")!.slice(0, 10)}`);
    const message = (await run(fixture.root, ["git", "log", "-1", "--format=%B", "main"])).stdout;
    expect(message).toContain("## 002-second.md");
    expect(message).not.toContain("## 003-third.md");

    // main holds the tree of card 002 - and nothing of card 003.
    expect(await git(fixture.root, "rev-parse", "main^{tree}")).toBe(
      await git(fixture.root, "rev-parse", `${fixture.shas.get("002-second.md")}^{tree}`),
    );
    const shipped = await git(fixture.root, "ls-tree", "-r", "--name-only", "main");
    expect(shipped).toContain("queue/done/002-second.md");
    expect(shipped).not.toContain("queue/done/003-third.md");

    expect(outcome.result.previous_branch).toBe("operator-branch");
    expect(outcome.result.restored_branch).toBe(true);
    expect(await git(fixture.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("operator-branch");
  }, 60_000);

  test("a dirty tree is refused, and nothing moves", async () => {
    const fixture = await makeFixture();
    const { deps, calls } = stubDeps(fixture, [...fixture.shas.keys()]);
    await writeFile(join(fixture.root, "queue", "TEMPLATE.md"), "# edited by the operator\n", "utf-8");

    const before = await git(fixture.root, "rev-parse", "main");
    const outcome = await performShip(fixture.root, { cut: "all" }, deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(409);
    expect(outcome.error).toContain("uncommitted change");
    expect(calls).toEqual([]); // refused before the report was even asked for
    expect(await git(fixture.root, "rev-parse", "main")).toBe(before);
  }, 60_000);

  test("a diverged main is refused by name, never forced", async () => {
    const fixture = await makeFixture();
    const { deps } = stubDeps(fixture, [...fixture.shas.keys()]);

    // Someone else pushed to the hub's main (a second clone does it for real).
    const other = join(fixture.root, "..", "other");
    await run(fixture.root, ["git", "clone", fixture.origin, other]);
    await git(other, "config", "user.email", "other@example.com");
    await git(other, "config", "user.name", "Other");
    await writeFile(join(other, "hub.txt"), "landed on the hub\n", "utf-8");
    await git(other, "add", "-A");
    await git(other, "commit", "-m", "someone else shipped first");
    await git(other, "push", "origin", "main");

    const before = await git(fixture.root, "rev-parse", "main");
    const outcome = await performShip(fixture.root, { cut: "all" }, deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("diverged");
    expect(outcome.error).toContain("pull first");
    expect(outcome.error).toContain("never forces");
    expect(await git(fixture.root, "rev-parse", "main")).toBe(before);
    // the hub still holds only the other person's commit
    expect(await git(fixture.origin, "rev-parse", "main")).not.toBe(before);
  }, 60_000);

  test("a refused push is surfaced honestly: the commit is local, and the response says so", async () => {
    const fixture = await makeFixture();
    const names = [...fixture.shas.keys()];
    // The hub goes away AFTER the fetch succeeded - the report call is the
    // hook, because it is the last step before the checkout is touched.
    const { deps } = stubDeps(fixture, names, {
      onCall: async (range) => {
        if (range !== null) return;
        await git(fixture.root, "remote", "set-url", "origin", join(fixture.root, "..", "gone.git"));
      },
    });

    const before = await git(fixture.root, "rev-parse", "main");
    const outcome = await performShip(fixture.root, { cut: "all" }, deps);
    if (!outcome.ok) throw new Error(`refused: ${outcome.error}`);

    expect(outcome.result.shipped).toBe(true);
    expect(outcome.result.pushed).toBe(false);
    expect(outcome.result.push_error).toBeTruthy();
    expect(outcome.result.push_error).toContain("repository");
    // The squash still landed locally, and nothing was undone or hidden.
    expect(await git(fixture.root, "rev-list", "--count", `${before}..main`)).toBe("1");
  }, 60_000);

  test("a cut naming a card outside the chunk is refused, listing what is shippable", async () => {
    const fixture = await makeFixture();
    const { deps } = stubDeps(fixture, [...fixture.shas.keys()]);
    const outcome = await performShip(fixture.root, { cut: "099-not-here.md" }, deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("099-not-here.md is not a card in this chunk");
    expect(outcome.error).toContain("001-first.md");
  }, 60_000);

  test("a report that could not be produced refuses the ship in the script's own words", async () => {
    const fixture = await makeFixture();
    const deps: ShipDeps = {
      report: async () => ({ ok: false, markdown: "", reason: "'integration' does not resolve to a commit" }),
    };
    const before = await git(fixture.root, "rev-parse", "main");
    const outcome = await performShip(fixture.root, { cut: "all" }, deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("'integration' does not resolve to a commit");
    expect(await git(fixture.root, "rev-parse", "main")).toBe(before);
  }, 60_000);

  test("no integration branch at all is a refusal, not a crash", async () => {
    const fixture = await makeFixture();
    const { deps } = stubDeps(fixture, [...fixture.shas.keys()]);
    await git(fixture.root, "branch", "-D", "integration");
    await git(fixture.root, "push", "origin", "--delete", "integration");
    await git(fixture.root, "fetch", "--prune", "origin");

    const outcome = await performShip(fixture.root, { cut: "all" }, deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("no integration branch");
    expect(existsSync(join(fixture.root, ".git", "SDL_SHIP_MSG.md"))).toBe(false);
  }, 60_000);

  // ── the cut is a prefix, so the order had better be the line ──────────────

  test("a report ordered by park date, not ancestry, still cuts the chunk git agrees with", async () => {
    const fixture = await makeFixture();
    // The park commits' dates put 002 first (mixed offsets, or two parks in the
    // same second falling back to the name) - ancestry still says 001, 002,
    // 003, and ancestry is what a squash actually carries.
    const skewed = ["002-second.md", "001-first.md", "003-third.md"];
    const { deps } = stubDeps(fixture, skewed);

    const outcome = await performShip(fixture.root, { cut: "002-second.md" }, deps);
    if (!outcome.ok) throw new Error(`refused: ${outcome.error}`);

    // The prefix arithmetic read the LINE, not the printout: cutting at 002
    // ships 001 with it, and the app says so before it commits.
    expect(outcome.result.cards).toEqual(["001-first.md", "002-second.md"]);
    expect(outcome.result.cut_sha).toBe(fixture.shas.get("002-second.md")!);

    // and that is exactly what landed - the message it authored agrees.
    const shipped = await git(fixture.root, "ls-tree", "-r", "--name-only", "main");
    expect(shipped).toContain("queue/done/001-first.md");
    expect(shipped).toContain("queue/done/002-second.md");
    expect(shipped).not.toContain("queue/done/003-third.md");
    const message = (await run(fixture.root, ["git", "log", "-1", "--format=%B", "main"])).stdout;
    expect(message).toContain("2 card(s) ready for `main`");
  }, 60_000);

  test("a cut whose card list disagrees with the ranged report is refused, never widened", async () => {
    const fixture = await makeFixture();
    const names = [...fixture.shas.keys()];
    // A report that answers every range with the whole line - the disagreement
    // the prefix can never reconcile.
    const deps: ShipDeps = {
      report: async (): Promise<ReportRun> => ({ ok: true, markdown: renderReport(fixture, names), reason: null }),
    };

    const before = await git(fixture.root, "rev-parse", "main");
    const outcome = await performShip(fixture.root, { cut: "002-second.md" }, deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("selects 2 card(s)");
    expect(outcome.error).toContain("carries 3");
    expect(outcome.error).toContain("nothing was shipped");
    expect(await git(fixture.root, "rev-parse", "main")).toBe(before);
  }, 60_000);

  // ── every exit path after the checkout moves puts the operator back ───────

  test("a conflicting squash is undone: back on the previous branch, tree clean", async () => {
    const fixture = await makeFixture();
    const { deps } = stubDeps(fixture, [...fixture.shas.keys()]);

    // A hotfix committed straight onto main, touching a file the chunk also
    // adds - `git merge --squash` hits an add/add conflict, and `git merge
    // --abort` cannot help because --squash records no MERGE_HEAD.
    await writeFile(join(fixture.root, "002-second.md.txt"), "a hotfix straight onto main\n", "utf-8");
    await git(fixture.root, "add", "-A");
    await git(fixture.root, "commit", "-m", "hotfix on main");
    await git(fixture.root, "push", "origin", "main");
    await git(fixture.root, "checkout", "-b", "operator-branch");

    const before = await git(fixture.root, "rev-parse", "main");
    const outcome = await performShip(fixture.root, { cut: "all" }, deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("the squash was refused");
    expect(outcome.error).toContain("back on operator-branch");
    // the operator is where they started, with nothing of the chunk in the way
    expect(await git(fixture.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("operator-branch");
    expect(await git(fixture.root, "status", "--porcelain")).toBe("");
    expect(await git(fixture.root, "rev-parse", "main")).toBe(before);

    // and the app can still ship afterwards - the dirty-tree guard is not stuck
    const second = await performShip(fixture.root, { cut: "all" }, deps);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).not.toContain("uncommitted change");
  }, 60_000);

  test("a commit refused by a hook is undone too, and shipping again rebuilds it", async () => {
    const fixture = await makeFixture();
    const { deps } = stubDeps(fixture, [...fixture.shas.keys()]);
    const hook = join(fixture.root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho 'the hook says no' >&2\nexit 1\n", { encoding: "utf-8", mode: 0o755 });
    await git(fixture.root, "checkout", "-b", "operator-branch");

    const before = await git(fixture.root, "rev-parse", "main");
    const outcome = await performShip(fixture.root, { cut: "all" }, deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("the commit failed");
    expect(await git(fixture.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("operator-branch");
    expect(await git(fixture.root, "status", "--porcelain")).toBe("");
    expect(await git(fixture.root, "rev-parse", "main")).toBe(before);

    // the chunk was reconstructible all along: drop the hook and ship again
    await rm(hook, { force: true });
    const again = await performShip(fixture.root, { cut: "all" }, deps);
    if (!again.ok) throw new Error(`refused: ${again.error}`);
    expect(again.result.cards).toEqual([...fixture.shas.keys()]);
    expect(await git(fixture.root, "rev-list", "--count", `${before}..main`)).toBe("1");
  }, 60_000);

  test("an unsafe cut string never reaches git", async () => {
    const fixture = await makeFixture();
    const { deps, calls } = stubDeps(fixture, [...fixture.shas.keys()]);
    const outcome = await performShip(fixture.root, { cut: "../../etc/passwd" }, deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    expect(calls).toEqual([]);
  }, 60_000);
});
