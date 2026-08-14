/**
 * `/api/app/projects/:id/readiness` (spec 1.3 table row 3, W1-B1/B8/E1,
 * W3-A2/D) - the one call that feeds the composer strip, the shell's empty
 * states, and the Initialize Git / Initialize factory contextual actions
 * (spec 2.9). Every fact here is re-derived from `root` on every request -
 * nothing is cached in the manifest (spec 1.4).
 *
 * Harness resolution mirrors `apps/ui/electron/profiles.ts`'s `resolveBinary`
 * / `resolvePi` on purpose (never invoke `pi` by name - PI_PATH carries the
 * real launch command, exactly as `adws/adw_modules/agent_pi.py` reads it).
 * It is not imported from there: `apps/ui/electron/**` sits outside
 * `tsconfig.server.json`'s `include`, and the two copies serve different
 * jobs anyway - this one only ever probes `--version`, never spawns a
 * session. K11 (the pty bridge) ports the real profiles.ts/which.ts into
 * `server/app/sessions/` for that job; this stays a read-only probe.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { configPathFromRepoRoot } from "../config.ts";
import { SssfDb } from "../db.ts";
import { GitRepo } from "../gitro.ts";
import { appError, appJson } from "./guard.ts";
import { findProject } from "./manifest.ts";

const WIN32 = process.platform === "win32";
const VERSION_CACHE_MS = 60_000;
const VERSION_TIMEOUT_MS = 2_000;

interface HarnessState {
  state: "ready" | "missing";
  version: string | null;
  path: string | null;
  can_steer: boolean;
}

interface ReadinessResponse {
  git: { is_repo: boolean; branch: string | null; remote: string | null; dirty: boolean | null };
  factory: { config: boolean; queue_template: boolean; db: boolean; justfile: boolean; adws: boolean };
  harnesses: { claude: HarnessState; codex: HarnessState; pi: HarnessState };
  runs: { count: number };
}

function which(cmd: string): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const exts = WIN32 ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const versionCache = new Map<string, { at: number; version: string | null }>();

/** `<argv> --version`, fixed argv array (no shell), 2s timeout, 60s cache -
 * the same shape spec 1.3's `/api/app/providers` describes, scoped here to
 * just the three harnesses readiness needs. */
async function probeVersion(cacheKey: string, argv: string[]): Promise<string | null> {
  const cached = versionCache.get(cacheKey);
  if (cached && Date.now() - cached.at < VERSION_CACHE_MS) return cached.version;

  let version: string | null = null;
  try {
    const proc = Bun.spawn([...argv, "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, VERSION_TIMEOUT_MS);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    const trimmed = out.trim();
    version = trimmed.length > 0 ? trimmed.split("\n")[0]!.trim() : null;
  } catch {
    version = null;
  }
  versionCache.set(cacheKey, { at: Date.now(), version });
  return version;
}

async function resolveOnPath(bin: string): Promise<HarnessState> {
  const path = which(bin);
  if (!path) return { state: "missing", version: null, path: null, can_steer: true };
  const version = await probeVersion(bin, [path]);
  return { state: "ready", version, path, can_steer: true };
}

/** `PI_PATH=<launcher> <script>` (e.g. `PI_PATH=node C:/.../cli.js`), read
 * exactly as `agent_pi.py._resolve_pi_cmd` and `electron/profiles.ts`'s
 * `resolvePi` do. `can_steer: false` per Open Decision 2 (spec 5.2): pi's
 * steer support is unverified on this machine, so it ships terminal-only
 * until the morning ruling, never silently upgraded. */
async function resolvePi(): Promise<HarnessState> {
  const raw = (process.env.PI_PATH ?? "").trim();
  if (!raw) return { state: "missing", version: null, path: null, can_steer: false };
  const firstSpace = raw.indexOf(" ");
  if (firstSpace === -1) return { state: "missing", version: null, path: null, can_steer: false };
  const launcher = raw.slice(0, firstSpace);
  const target = raw.slice(firstSpace + 1).trim();
  if (!target || !existsSync(target)) return { state: "missing", version: null, path: null, can_steer: false };
  const version = await probeVersion(`pi:${target}`, [launcher, target]);
  return { state: "ready", version, path: target, can_steer: false };
}

/** `git status --porcelain`, direct `Bun.spawn` (argv array, no shell) -
 * `gitro.ts` has no dirty-check today and this file cannot edit it (only new
 * files under `server/app/` are permitted), so this mirrors its `run()`
 * helper's shape locally. `null` means "could not tell" (not a repo, or git
 * failed), never coerced to `false`. */
async function gitDirty(root: string): Promise<boolean | null> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    return stdout.trim().length > 0;
  } catch {
    return null;
  }
}

function runCount(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  try {
    const db = new SssfDb(dbPath);
    const count = db.sessionCount();
    db.close();
    return count;
  } catch {
    // A present-but-unopenable db (locked, mid-write, corrupt) is not a
    // crash here - readiness degrades to "0 runs known", never a 500.
    return 0;
  }
}

function param(req: Request, key: string): string {
  return decodeURIComponent((req as Request & { params: Record<string, string> }).params[key] ?? "");
}

export async function getReadiness(req: Request): Promise<Response> {
  const id = param(req, "id");
  if (!id) return appError("missing project id");

  const project = await findProject(id);
  if (!project) return appError(`no project ${id}`, 404);

  const root = project.root;
  const repo = new GitRepo(root);
  const [isRepo, branch, remote, dirty] = await Promise.all([
    repo.isRepo(),
    repo.currentBranch(),
    repo.remoteUrl("origin"),
    gitDirty(root),
  ]);

  const dbPath = join(root, "adws", "adw_data", "sssf.db");
  const factory = {
    config: existsSync(configPathFromRepoRoot(root)),
    queue_template: existsSync(join(root, "queue", "TEMPLATE.md")),
    db: existsSync(dbPath),
    justfile: existsSync(join(root, "justfile")),
    adws: existsSync(join(root, "adws")),
  };

  const [claude, codex, pi] = await Promise.all([resolveOnPath("claude"), resolveOnPath("codex"), resolvePi()]);

  return appJson({
    git: { is_repo: isRepo, branch: isRepo ? branch : null, remote: isRepo ? remote : null, dirty: isRepo ? dirty : null },
    factory,
    harnesses: { claude, codex, pi },
    runs: { count: factory.db ? runCount(dbPath) : 0 },
  } satisfies ReadinessResponse);
}
