/**
 * Tests for `app/init.ts` — the two contextual writes, run with
 * `bun test server/app/init.test.ts` from `apps/ui`.
 *
 * What is actually under test here is the ARGV, because argv is the whole
 * security contract of this file: "each handler builds its argv from fixed
 * literals and paths it resolved itself off the manifest's `root` — never from
 * a request body, never from a query string". A test that only checked the
 * status code would pass just as happily on a handler that interpolated a
 * query string into the command line. So every test reaches into the job
 * record `createJob` produced and asserts the exact array.
 *
 * The real installer's `uv run` is deliberately NOT exercised here — stamping
 * 44 files into a fixture is an end-to-end proof, not a unit seam. The script
 * these tests resolve is a two-line stand-in placed at the project-scoped
 * location, which is also how the project-scope-wins rule gets proven.
 *
 * Everything is a real git repository under the OS temp dir, with
 * SDL_FACTORY_HOME redirected so the operator's own project list is never
 * read or written.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initFactory, initGit } from "./init.ts";
import { getJob } from "./jobs.ts";
import { upsertProject } from "./manifest.ts";

const dirs: string[] = [];
const realHome = process.env.SDL_FACTORY_HOME;

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "sdl-init-home-"));
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

/** A throwaway folder registered as one project. `repo` makes it a real git
 * repository first; `script` plants the project-scoped installer stand-in. */
async function project(options: { repo: boolean; script?: boolean }): Promise<{ id: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "sdl-init-proj-"));
  dirs.push(root);
  await writeFile(join(root, "package.json"), '{"name":"fixture"}\n', "utf-8");

  if (options.repo) {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
  }
  if (options.script) {
    const scripts = join(root, ".claude", "skills", "sssf", "scripts");
    await mkdir(scripts, { recursive: true });
    // Two lines, no dependencies, no prompts — enough to be a resolvable path.
    await writeFile(join(scripts, "install.py"), 'print("stand-in installer")\n', "utf-8");
  }

  const added = await upsertProject(root);
  if (!added.ok) throw new Error(added.error);
  return { id: added.project.id, root: added.project.root };
}

function request(id: string, path: string): Request {
  const req = new Request(`http://127.0.0.1:4700/api/app/p/x/${path}`, { method: "POST" });
  (req as Request & { params: Record<string, string> }).params = { id };
  return req;
}

async function body(res: Response): Promise<Record<string, string>> {
  return (await res.json()) as Record<string, string>;
}

describe("initFactory", () => {
  test("builds `uv run <script>` in the project root, and nothing else", async () => {
    const { id, root } = await project({ repo: true, script: true });

    const res = await initFactory(request(id, "init/factory"));
    expect(res.status).toBe(201);
    const job = getJob((await body(res)).job_id!);

    // The whole contract, in one assertion: three fixed elements, the third
    // being a path this handler resolved itself off `root`.
    expect(job?.argv).toEqual(["uv", "run", join(root, ".claude", "skills", "sssf", "scripts", "install.py")]);
    expect(job?.cwd).toBe(root);
  });

  test("prefers the project-scoped script over the user-scoped one", async () => {
    const { id, root } = await project({ repo: true, script: true });
    const job = getJob((await body(await initFactory(request(id, "init/factory")))).job_id!);
    // `~/.claude/skills/sssf/scripts/install.py` exists on this machine too;
    // the resolved path must still be the one inside the project.
    expect(job?.argv[2]).toBe(join(root, ".claude", "skills", "sssf", "scripts", "install.py"));
    expect(job?.argv[2]?.startsWith(root)).toBe(true);
  });

  test("refuses on a folder that is not a git repository, and creates no job", async () => {
    const { id } = await project({ repo: false, script: true });
    const res = await initFactory(request(id, "init/factory"));
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("not a git repository yet - initialize git first");
  });

  test("404s an id that is not in the manifest", async () => {
    const res = await initFactory(request("deadbeefcafe", "init/factory"));
    expect(res.status).toBe(404);
  });
});

describe("initGit", () => {
  test("builds exactly `git init`, with no other flag", async () => {
    const { id, root } = await project({ repo: false });
    const res = await initGit(request(id, "init/git"));
    expect(res.status).toBe(201);
    const job = getJob((await body(res)).job_id!);
    expect(job?.argv).toEqual(["git", "init"]);
    expect(job?.cwd).toBe(root);
  });

  test("refuses a folder that is already a repository", async () => {
    const { id } = await project({ repo: true });
    const res = await initGit(request(id, "init/git"));
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("already a git repository");
  });

  test("refuses a bare subdirectory of an existing repo rather than nesting one", async () => {
    const { root } = await project({ repo: true });
    const nested = join(root, "packages", "inner");
    await mkdir(nested, { recursive: true });
    const added = await upsertProject(nested);
    if (!added.ok) throw new Error(added.error);

    const res = await initGit(request(added.project.id, "init/git"));
    expect(res.status).toBe(409);
    expect((await body(res)).error).toStartWith("nested inside an existing repo at ");
  });
});
