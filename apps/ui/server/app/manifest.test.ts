/**
 * Tests for the project manifest (`app/manifest.ts`) and the request shape
 * around it (`app/projects.ts`), run with
 * `bun test server/app/manifest.test.ts` from `apps/ui`.
 *
 * Three regressions live here, all of them things the operator saw:
 *
 *  1. THE PHANTOM PROJECT - the server used to register its own repo on every
 *     boot, so the project list could never be empty and the first-run surface
 *     was unreachable. `seedBootProject()` must write nothing now.
 *  2. THE PROBE THAT WROTE - detection used to register the path before it
 *     could read it, so every mistyped-but-real directory became a permanent
 *     project. `describePath()` must leave the manifest byte-identical.
 *  3. NO WAY BACK - there was no removal at all, so the phantom could not be
 *     dismissed even by hand (the next boot re-added it).
 *
 * SDL_FACTORY_HOME points the manifest at a temp directory for the whole file,
 * so no test can touch the operator's own `~/.sdl-factory/config.json`.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "sdl-manifest-home-"));
process.env.SDL_FACTORY_HOME = home;
delete process.env.SDL_SEED_BOOT_PROJECT;

const { appHome, describePath, manifestPath, readManifest, removeProject, seedBootProject, upsertProject } =
  await import("./manifest.ts");
const { createProject, listProjects } = await import("./projects.ts");

const scratch: string[] = [home];

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function makeFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sdl-manifest-proj-"));
  scratch.push(dir);
  return dir;
}

/** POST body -> the handler, the way routes.ts calls it. */
function post(body: unknown): Request {
  return new Request("http://127.0.0.1:4700/api/app/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await rm(manifestPath(), { force: true });
});

describe("appHome", () => {
  test("SDL_FACTORY_HOME is the seam these tests stand on", () => {
    expect(appHome()).toBe(home);
    expect(manifestPath()).toBe(join(home, "config.json"));
  });
});

describe("seedBootProject", () => {
  test("writes nothing - the self-repo is no longer auto-registered", async () => {
    expect(await seedBootProject()).toBeNull();
    expect(existsSync(manifestPath())).toBe(false);
    expect((await readManifest()).projects).toEqual([]);
  });
});

describe("upsertProject", () => {
  test("registers a folder and is idempotent per path", async () => {
    const folder = await makeFolder();
    const first = await upsertProject(folder);
    expect(first.ok).toBe(true);
    const second = await upsertProject(`${folder}\\`.replace(/\\$/, "/"));
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.project.id).toBe(first.project.id);
    expect((await readManifest()).projects).toHaveLength(1);
  });

  test("refuses a path that is not a directory, in the server's own words", async () => {
    const missing = join(await makeFolder(), "nope");
    const result = await upsertProject(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(`no such directory: ${missing}`);
  });
});

describe("describePath", () => {
  test("reads a bare folder truthfully and registers nothing", async () => {
    const folder = await makeFolder();
    const probe = await describePath(folder);
    expect("ok" in probe).toBe(false);
    if ("ok" in probe) return;
    expect(probe.exists).toBe(true);
    expect(probe.is_directory).toBe(true);
    expect(probe.is_git_repo).toBe(false);
    expect(probe.factory_initialized).toBe(false);
    expect(probe.registered_id).toBeNull();
    expect(probe.problem).toBeNull();
    // the point of the whole test: probing wrote nothing
    expect(existsSync(manifestPath())).toBe(false);
  });

  test("sees a factory config when one is there, and says a path is already registered", async () => {
    const folder = await makeFolder();
    await mkdir(join(folder, "adws", "adw_sssf_config"), { recursive: true });
    await writeFile(join(folder, "adws", "adw_sssf_config", "sssf.config.yaml"), "agents: []\n", "utf-8");
    const added = await upsertProject(folder);
    const before = await readFile(manifestPath(), "utf-8");

    const probe = await describePath(folder);
    if ("ok" in probe) throw new Error(probe.error);
    expect(probe.factory_initialized).toBe(true);
    expect(probe.registered_id).toBe(added.ok ? added.project.id : "");
    expect(await readFile(manifestPath(), "utf-8")).toBe(before);
  });

  test("a missing path is described, not thrown - the row says why Add would refuse", async () => {
    const missing = join(await makeFolder(), "nope");
    const probe = await describePath(missing);
    if ("ok" in probe) throw new Error(probe.error);
    expect(probe.exists).toBe(false);
    expect(probe.problem).toBe(`no such directory: ${missing}`);
  });
});

describe("removeProject", () => {
  test("drops the registration and moves `active` off it", async () => {
    const one = await makeFolder();
    const two = await makeFolder();
    const first = await upsertProject(one);
    await upsertProject(two);
    if (!first.ok) throw new Error(first.error);

    expect((await readManifest()).active).toBe(first.project.id);
    const removed = await removeProject(first.project.id);
    expect(removed.ok).toBe(true);

    const manifest = await readManifest();
    expect(manifest.projects.map((p) => p.id)).not.toContain(first.project.id);
    expect(manifest.active).toBe(manifest.projects[0]?.id ?? null);
  });

  test("an unknown id is a named 404, never a silent success", async () => {
    const result = await removeProject("deadbeef");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("no project deadbeef");
  });
});

describe("POST /api/app/projects", () => {
  test("probe answers detection and leaves the list empty", async () => {
    const folder = await makeFolder();
    const res = await createProject(post({ path: folder, intent: "probe" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; is_git_repo: boolean };
    expect(body.path).toBe(folder);
    expect(body.is_git_repo).toBe(false);
    expect(await (await listProjects()).json()).toEqual([]);
  });

  test("no intent still adds - the older callers keep working", async () => {
    const folder = await makeFolder();
    const res = await createProject(post({ path: folder }));
    expect(res.status).toBe(201);
    expect((await readManifest()).projects).toHaveLength(1);
  });

  test("remove takes an id and reports what it dropped", async () => {
    const folder = await makeFolder();
    const added = (await (await createProject(post({ path: folder }))).json()) as { id: string };
    const res = await createProject(post({ intent: "remove", id: added.id }));
    expect(res.status).toBe(200);
    expect((await readManifest()).projects).toEqual([]);
  });

  test("an unknown intent is refused by name and writes nothing", async () => {
    const folder = await makeFolder();
    const res = await createProject(post({ path: folder, intent: "register" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('unknown intent "register"');
    expect((await readManifest()).projects).toEqual([]);
  });
});
