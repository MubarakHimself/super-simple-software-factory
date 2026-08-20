/**
 * Tests for `app/readiness.ts` - run with
 * `bun test server/app/readiness.test.ts` from `apps/ui`.
 *
 * ── The contradiction these pin ────────────────────────────────────────────
 * Home showed a project the banner "No factory here - This project has no
 * adws/ in it yet" DIRECTLY ABOVE its own checklist, which read "Git
 * repository yes - on branch integration / Factory initialized yes -
 * sssf.config.yaml is there". Both were rendering honestly; they were reading
 * DIFFERENT signals:
 *
 *   the checklist  `/readiness` -> `factory.config` (is sssf.config.yaml on
 *                  disk?), which is what "initialized" means and what the
 *                  installer itself is checked against
 *   the banner     `/runs` -> `{factory:"absent"}`, which `scoped.ts` answers
 *                  from `scope.db === null` - is there an adws/adw_data/sssf.db?
 *
 * A project that is fully initialized and has simply never had a card run in
 * it (or whose runs live on the VPS, which is every project this operator has)
 * satisfies the first and fails the second. So the banner fired on a project
 * whose own checklist said it was ready.
 *
 * `ui-v3` has no component-test harness, so what is pinned here is THE
 * ENDPOINT TRUTH THAT DRIVES THE GATE: that `/readiness` reports the two
 * facts separately, that `factory.config` is true for exactly the folder the
 * checklist calls initialized, and that `factory.db` - the OLD gate - is false
 * for that same folder. Home now gates on `factory.config`, the checklist's
 * own field, so one truth drives both.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReadiness } from "./readiness.ts";
import { upsertProject } from "./manifest.ts";

const dirs: string[] = [];
const realHome = process.env.SDL_FACTORY_HOME;

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "sdl-readiness-home-"));
  dirs.push(home);
  process.env.SDL_FACTORY_HOME = home;
});

afterAll(async () => {
  if (realHome === undefined) delete process.env.SDL_FACTORY_HOME;
  else process.env.SDL_FACTORY_HOME = realHome;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function git(cwd: string, argv: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${argv.join(" ")} in ${cwd} exited ${code}: ${stderr}`);
}

interface ReadinessBody {
  git: { is_repo: boolean; branch: string | null };
  factory: { config: boolean; queue_template: boolean; db: boolean; justfile: boolean; adws: boolean };
}

/** The route helper's own contract: `params` is set by the router before the
 * handler ever runs (see `scoped.ts:param`). */
async function readiness(id: string): Promise<ReadinessBody> {
  const request = new Request(`http://127.0.0.1:4700/api/app/projects/${id}/readiness`);
  (request as Request & { params: Record<string, string> }).params = { id };
  const response = await getReadiness(request);
  expect(response.status).toBe(200);
  return (await response.json()) as ReadinessBody;
}

/** A real git repo, optionally stamped the way the factory installer stamps
 * one: `adws/` with the config inside it. Never a db - only a RUN writes that. */
async function project(options: { initialized: boolean; branch?: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sdl-readiness-proj-"));
  dirs.push(root);
  await writeFile(join(root, "README.md"), "fixture\n", "utf-8");
  await git(root, ["init", "-b", options.branch ?? "integration"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "test"]);

  if (options.initialized) {
    await mkdir(join(root, "adws", "adw_sssf_config"), { recursive: true });
    await writeFile(join(root, "adws", "adw_sssf_config", "sssf.config.yaml"), "defaults:\n  model: xai/grok-5-code\n", "utf-8");
    await mkdir(join(root, "queue"), { recursive: true });
    await writeFile(join(root, "queue", "TEMPLATE.md"), "# card\n", "utf-8");
  }

  const upserted = await upsertProject(root);
  if (!("project" in upserted)) throw new Error(`upsertProject failed: ${JSON.stringify(upserted)}`);
  return upserted.project.id;
}

describe("the signal Home's 'No factory here' banner is allowed to read", () => {
  test(
    "an initialized project that has never RUN: config yes, adws yes, db no",
    async () => {
      const id = await project({ initialized: true });
      const body = await readiness(id);

      // What the checklist under the banner prints, verbatim in field form.
      expect(body.git.is_repo).toBe(true);
      expect(body.git.branch).toBe("integration");
      expect(body.factory.config).toBe(true);
      expect(body.factory.adws).toBe(true);

      // And the signal the banner USED to gate on - the one that made it
      // contradict the checklist above. Both are true statements about this
      // folder; only the first one means "initialized".
      expect(body.factory.db).toBe(false);
    },
    30_000,
  );

  test(
    "a folder with no factory in it: the banner's condition and the checklist agree, both no",
    async () => {
      const id = await project({ initialized: false });
      const body = await readiness(id);

      expect(body.git.is_repo).toBe(true);
      expect(body.factory.config).toBe(false);
      expect(body.factory.adws).toBe(false);
      expect(body.factory.db).toBe(false);
    },
    30_000,
  );
});
