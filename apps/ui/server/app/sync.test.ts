/**
 * Tests for `app/sync.ts` (the topbar Sync button's one write), run with
 * `bun test server/app/sync.test.ts` from `apps/ui`.
 *
 * Everything here is a REAL git repository: a bare "origin" plus a working
 * clone, both throwaway directories under the OS temp dir. Nothing is
 * mocked — the claim under test is "this route fetches and fast-forwards, and
 * refuses (never forces) the moment that is not safely possible", and a
 * mocked git would prove nothing about that.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postSync } from "./sync.ts";

const dirs: string[] = [];
const realHome = process.env.SDL_FACTORY_HOME;

afterAll(async () => {
  if (realHome === undefined) delete process.env.SDL_FACTORY_HOME;
  else process.env.SDL_FACTORY_HOME = realHome;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function run(cwd: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${argv.join(" ")} in ${cwd} exited ${code}: ${stderr || stdout}`);
  return { code, stdout, stderr };
}

let counter = 0;

/** A bare "origin" plus a real clone of it, registered as one project in an
 * isolated `SDL_FACTORY_HOME` nothing else on this machine reads. A unique
 * project id per call — `scoped.ts` caches a `GitRepo` per id for the life of
 * the process, so two tests sharing an id would read each other's checkout. */
async function project(): Promise<{ id: string; clone: string; origin: string }> {
  const home = await mkdtemp(join(tmpdir(), "sdl-sync-home-"));
  const origin = await mkdtemp(join(tmpdir(), "sdl-sync-origin-"));
  const clone = join(await mkdtemp(join(tmpdir(), "sdl-sync-clone-")), "repo");
  dirs.push(home, origin, clone);
  process.env.SDL_FACTORY_HOME = home;

  await run(origin, ["init", "--bare", "-b", "main"]);

  const seed = await mkdtemp(join(tmpdir(), "sdl-sync-seed-"));
  dirs.push(seed);
  await run(seed, ["init", "-b", "main"]);
  await run(seed, ["config", "user.email", "test@example.com"]);
  await run(seed, ["config", "user.name", "Test"]);
  // The operator's own global `core.autocrlf` must not leak into what these
  // tests read back — every repo this file creates pins it off, so "v2\n"
  // pushed is "v2\n" read, on every platform this suite runs on.
  await run(seed, ["config", "core.autocrlf", "false"]);
  await writeFile(join(seed, "file.txt"), "v1\n", "utf-8");
  await run(seed, ["add", "file.txt"]);
  await run(seed, ["commit", "-m", "v1"]);
  await run(seed, ["remote", "add", "origin", origin]);
  await run(seed, ["push", "origin", "main"]);

  // `-c core.autocrlf=false` on the clone itself, not a config write after:
  // the checkout that clone performs already happened by the time a
  // post-clone `git config` could take effect, and the operator's own global
  // `autocrlf=true` would otherwise convert the very first checkout before
  // this suite ever gets a say.
  await run(join(clone, ".."), ["-c", "core.autocrlf=false", "clone", origin, "repo"]);
  await run(clone, ["config", "user.email", "test@example.com"]);
  await run(clone, ["config", "user.name", "Test"]);
  await run(clone, ["config", "core.autocrlf", "false"]);

  const id = `sync-test-${++counter}`;
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      version: 1,
      active: id,
      projects: [{ id, name: "test", root: clone, added_at: "", last_opened_at: null }],
      ui: {},
    }),
    "utf-8",
  );
  return { id, clone, origin };
}

function request(id: string): Request {
  const req = new Request("http://127.0.0.1:4700/api/app/p/x/sync", { method: "POST" });
  (req as Request & { params: Record<string, string> }).params = { id };
  return req;
}

/** A second, independent clone of `origin` — the thing that pushes commits
 * the project under test then has to fetch. Cloned into a fresh child
 * directory of its own temp parent, the same shape `project()` uses for its
 * own clone, so `git clone` is always creating the target rather than
 * populating a directory `mkdtemp` already made. */
async function otherClone(origin: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "sdl-sync-pusher-"));
  dirs.push(parent);
  const dir = join(parent, "repo");
  await run(parent, ["-c", "core.autocrlf=false", "clone", origin, "repo"]);
  await run(dir, ["config", "user.email", "test@example.com"]);
  await run(dir, ["config", "user.name", "Test"]);
  await run(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

async function push(from: string, text: string, message: string): Promise<void> {
  await writeFile(join(from, "file.txt"), text, "utf-8");
  await run(from, ["add", "file.txt"]);
  await run(from, ["commit", "-m", message]);
  await run(from, ["push", "origin", "main"]);
}

describe("POST /api/app/p/:id/sync", () => {
  test("no project id is a 404, never a throw", async () => {
    const res = await postSync(request("does-not-exist"));
    expect(res.status).toBe(404);
  });

  test(
    "a clean clone with nothing new on origin reports up-to-date and never rewrites HEAD",
    async () => {
      const { id, clone } = await project();
      const before = (await run(clone, ["rev-parse", "HEAD"])).stdout.trim();

      const res = await postSync(request(id));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { repo: { status: string; before_sha: string; after_sha: string; branch: string } };
      expect(body.repo.status).toBe("up-to-date");
      expect(body.repo.branch).toBe("main");
      expect(body.repo.before_sha).toBe(before);
      expect(body.repo.after_sha).toBe(before);
    },
    15_000,
  );

  test(
    "a real fast-forward pulls the new commit and moves HEAD to it",
    async () => {
      const { id, clone, origin } = await project();
      const pusherDir = await otherClone(origin);
      await push(pusherDir, "v2\n", "v2");

      const before = (await run(clone, ["rev-parse", "HEAD"])).stdout.trim();
      const res = await postSync(request(id));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { repo: { status: string; before_sha: string; after_sha: string } };
      expect(body.repo.status).toBe("pulled");
      expect(body.repo.before_sha).toBe(before);
      expect(body.repo.after_sha).not.toBe(before);
      expect(await readFile(join(clone, "file.txt"), "utf-8")).toBe("v2\n");
    },
    20_000,
  );

  test(
    "uncommitted changes are never pulled over — dirty, and the file is untouched",
    async () => {
      const { id, clone, origin } = await project();
      const pusherDir = await otherClone(origin);
      await push(pusherDir, "v2\n", "v2");

      await writeFile(join(clone, "file.txt"), "local edit, uncommitted\n", "utf-8");

      const res = await postSync(request(id));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { repo: { status: string; detail: string } };
      expect(body.repo.status).toBe("dirty");
      expect(body.repo.detail).toContain("uncommitted");
      expect(await readFile(join(clone, "file.txt"), "utf-8")).toBe("local edit, uncommitted\n");
    },
    20_000,
  );

  test(
    "a local commit origin does not have, alongside a real origin commit, is diverged — refused, never forced",
    async () => {
      const { id, clone, origin } = await project();
      const pusherDir = await otherClone(origin);
      await push(pusherDir, "from origin\n", "from origin");

      // The clone commits its own, different change without ever pushing it.
      await writeFile(join(clone, "file.txt"), "from clone, never pushed\n", "utf-8");
      await run(clone, ["add", "file.txt"]);
      await run(clone, ["commit", "-m", "local-only"]);
      const before = (await run(clone, ["rev-parse", "HEAD"])).stdout.trim();

      const res = await postSync(request(id));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { repo: { status: string; detail: string; before_sha: string; after_sha: string } };
      expect(body.repo.status).toBe("diverged");
      expect(body.repo.detail).toContain("diverged");
      expect(body.repo.detail).toContain("never forces");
      expect(body.repo.before_sha).toBe(before);
      expect(body.repo.after_sha).toBe(before); // HEAD did not move
      expect(await readFile(join(clone, "file.txt"), "utf-8")).toBe("from clone, never pushed\n");
    },
    20_000,
  );

  test(
    "no origin remote is reported by name, not attempted",
    async () => {
      const { id, clone } = await project();
      await run(clone, ["remote", "remove", "origin"]);

      const res = await postSync(request(id));
      const body = (await res.json()) as { repo: { status: string; detail: string } };
      expect(body.repo.status).toBe("no-remote");
      expect(body.repo.detail).toContain("origin");
    },
    15_000,
  );

  test(
    "a plain directory that is not a git repository says so",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "sdl-sync-home-notrepo-"));
      const plain = await mkdtemp(join(tmpdir(), "sdl-sync-notrepo-"));
      dirs.push(home, plain);
      process.env.SDL_FACTORY_HOME = home;
      const id = `sync-test-${++counter}`;
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          version: 1,
          active: id,
          projects: [{ id, name: "plain", root: plain, added_at: "", last_opened_at: null }],
          ui: {},
        }),
        "utf-8",
      );

      const res = await postSync(request(id));
      const body = (await res.json()) as { repo: { status: string } };
      expect(body.repo.status).toBe("not-a-repo");
    },
    15_000,
  );

  test(
    "two syncs of the same project cannot interleave",
    async () => {
      const { id } = await project();
      const [a, b] = await Promise.all([postSync(request(id)), postSync(request(id))]);
      const statuses = [a.status, b.status].sort();
      // One runs to completion (200); the other is refused as already-running (409).
      expect(statuses).toEqual([200, 409]);
    },
    15_000,
  );
});
