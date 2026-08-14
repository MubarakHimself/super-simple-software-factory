/**
 * Initialize Git and Initialize factory (spec 1.3 table rows `init/git` /
 * `init/factory`, spec 2.9, spec 4 chunk K3s) - the two contextual top-bar
 * actions, and the only two places in the whole app plane allowed to call
 * `jobs.ts#createJob`. Each handler here builds its argv from fixed
 * literals and paths it resolved itself off the manifest's `root` - never
 * from a request body, never from a query string - so "exactly two
 * commands may ever create a job" (spec 1.3) holds by construction, not by
 * a runtime check.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GitRepo } from "../gitro.ts";
import { appError, appJson } from "./guard.ts";
import { createJob } from "./jobs.ts";
import { findProject } from "./manifest.ts";

function param(req: Request, key: string): string {
  return decodeURIComponent((req as Request & { params: Record<string, string> }).params[key] ?? "");
}

function sameDir(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * One `git rev-parse --show-toplevel` in `root` answers both guards spec
 * 1.3 lists for `init/git`: "not already a repo, not nested inside another
 * repo". Non-zero exit means `root` sits inside no repo at all - clear to
 * `git init`. Zero exit with a toplevel equal to `root` means `root` is
 * already a repo. Zero exit with any other toplevel means `root` is a bare
 * subdirectory of a parent repo's working tree, and `git init` there would
 * silently create a nested repo the operator never asked for - refused,
 * distinctly from "already a repo" so the two guards' error text differs
 * for whoever reads the failed job.
 */
async function gitInitGuard(root: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null; // not inside any repo - clear to init
  const toplevel = stdout.trim();
  if (!toplevel) return null;
  if (sameDir(toplevel, root)) return "already a git repository";
  return `nested inside an existing repo at ${toplevel}`;
}

/** POST `/api/app/p/:id/init/git` -> `{job_id}`. No dialog, no confirmation
 * copy (spec 2.9: "the state change is the feedback") - guard, then spawn
 * `git init` with no other flags. */
export async function initGit(req: Request): Promise<Response> {
  const id = param(req, "id");
  if (!id) return appError("missing project id");
  const project = await findProject(id);
  if (!project) return appError(`no project ${id}`, 404);

  const guardError = await gitInitGuard(project.root);
  if (guardError) return appError(guardError, 409);

  const job = createJob(["git", "init"], project.root);
  return appJson({ job_id: job.id }, 201);
}

/** `<root>/.claude/skills/sssf/scripts/install.py`, else
 * `~/.claude/skills/sssf/scripts/install.py` (spec 1.3: "skill resolved
 * `<root>/.claude/skills/sssf/...` else `~/.claude/skills/sssf/...`") -
 * project scope wins, matching the same two-location order `/api/app/skills`
 * (K2b) uses for the identical directory. Neither present -> no job, the
 * caller renders the missing path and a disabled button (spec: "neither ->
 * button disabled with the missing path, no job"). */
function resolveInstallScript(root: string): string | null {
  const projectScript = join(root, ".claude", "skills", "sssf", "scripts", "install.py");
  if (existsSync(projectScript)) return projectScript;
  const userScript = join(homedir(), ".claude", "skills", "sssf", "scripts", "install.py");
  if (existsSync(userScript)) return userScript;
  return null;
}

/** POST `/api/app/p/:id/init/factory` -> `{job_id}`. Spawns the frozen
 * installer verbatim - `uv run <script>`, cwd = `root` (spec 1.3) - never
 * edited, never wrapped in a shell. Requires git to already be a repo
 * (spec 2.9's ordering: "Initialize factory (git.is_repo && !factory.config)"
 * - the button itself only renders in that state, this is the same rule
 * enforced server-side so a stale UI can't skip it). */
export async function initFactory(req: Request): Promise<Response> {
  const id = param(req, "id");
  if (!id) return appError("missing project id");
  const project = await findProject(id);
  if (!project) return appError(`no project ${id}`, 404);

  const repo = new GitRepo(project.root);
  if (!(await repo.isRepo())) return appError("not a git repository yet - initialize git first", 409);

  const script = resolveInstallScript(project.root);
  if (!script) {
    const projectPath = join(project.root, ".claude", "skills", "sssf", "scripts", "install.py");
    const userPath = join(homedir(), ".claude", "skills", "sssf", "scripts", "install.py");
    return appError(`install script not found at ${projectPath} or ${userPath}`, 409);
  }

  const job = createJob(["uv", "run", script], project.root);
  return appJson({ job_id: job.id }, 201);
}
