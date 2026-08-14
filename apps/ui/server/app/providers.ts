/**
 * `/api/app/providers` (spec 1.3 row 122, W3-C2, spec 4 chunk K2b) - the
 * Settings > Providers pane's `StatusTriple` rows, plus the `just` probe
 * this chunk's own done-when names explicitly ("claude, codex and pi all
 * resolving ... and just missing" as of 2026-08-13). `<bin> --version`,
 * fixed argv (no shell), 2s timeout, 60s cache, no background poll here or
 * anywhere else, and never a claim about authentication - we have no signal
 * for that without reading credentials, and this module never does.
 *
 * Deliberately duplicates the `which()`/PATH-probe shape `readiness.ts`
 * already has, rather than importing it: readiness.ts is not in this
 * chunk's file list, and its own header comment already sets the precedent
 * of local duplication over cross-chunk coupling ("It is not imported from
 * there [electron/profiles.ts] ... this stays a read-only probe").
 *
 * Route wiring into `app/routes.ts` is deliberately NOT done here - see the
 * note at the top of docs.ts for why.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { appJson } from "./guard.ts";

const WIN32 = process.platform === "win32";
const VERSION_CACHE_MS = 60_000;
const VERSION_TIMEOUT_MS = 2_000;

export interface ProviderRow {
  id: string;
  bin: string;
  resolved_path: string | null;
  version: string | null;
  state: "ready" | "missing" | "error";
  detail: string;
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

interface VersionResult {
  version: string | null;
  error: string | null;
}

const versionCache = new Map<string, { at: number; result: VersionResult }>();

/** The version out of a `--version` line: its first token starting with a
 * digit, which is the whole of `uv 0.12.2 (46ead609 2026-08-05 x86_64-...)`
 * that spec 3.6's triple has room for (`● pi 0.9.4 - on PATH`). A line with
 * no such token is kept whole rather than guessed at. */
function versionToken(out: string): string {
  const line = out.split("\n")[0]!.trim();
  return line.split(/\s+/).find((word) => /^\d/.test(word)) ?? line;
}

/** `<argv> --version`, fixed argv array, no shell, 2s timeout, 60s cache -
 * spec row 122's exact shape. Distinguishes "the binary produced a version"
 * from "the binary ran and failed" (`error` set) so callers can render the
 * three-state `ready|missing|error`, never collapsing a real failure into
 * plain "missing". */
async function probeVersion(cacheKey: string, argv: string[]): Promise<VersionResult> {
  const cached = versionCache.get(cacheKey);
  if (cached && Date.now() - cached.at < VERSION_CACHE_MS) return cached.result;

  let result: VersionResult;
  try {
    const proc = Bun.spawn([...argv, "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, VERSION_TIMEOUT_MS);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    if (timedOut) {
      result = { version: null, error: `--version timed out after ${VERSION_TIMEOUT_MS}ms` };
    } else if (code !== 0) {
      result = { version: null, error: `--version exited ${code}` };
    } else {
      const trimmed = out.trim();
      result = trimmed.length > 0 ? { version: versionToken(trimmed), error: null } : { version: null, error: "--version produced no output" };
    }
  } catch (error) {
    result = { version: null, error: (error as Error).message };
  }
  versionCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/** Mirrors `apps/ui/electron/profiles.ts`'s `resolveBinary` exactly,
 * including its message string - spec §2.3 (W1-E3) requires the Sessions
 * surface to show that exact sentence for a missing harness, and reusing it
 * here keeps the app's one honest sentence about a missing binary, not two. */
async function probeOnPath(id: string, bin: string): Promise<ProviderRow> {
  const path = which(bin);
  if (!path) {
    return { id, bin, resolved_path: null, version: null, state: "missing", detail: `'${bin}' was not found on PATH.` };
  }
  const { version, error } = await probeVersion(id, [path]);
  if (error) return { id, bin, resolved_path: path, version: null, state: "error", detail: error };
  return { id, bin, resolved_path: path, version, state: "ready", detail: "on PATH" };
}

/** Mirrors `profiles.ts`'s `resolvePi` exactly, messages included (never
 * invoke `pi` by name - PI_PATH carries the real launch command, exactly as
 * `adws/adw_modules/agent_pi.py._resolve_pi_cmd` reads it). */
async function probePi(): Promise<ProviderRow> {
  const id = "pi";
  const bin = "pi";
  const raw = (process.env.PI_PATH ?? "").trim();
  if (!raw) {
    return {
      id,
      bin,
      resolved_path: null,
      version: null,
      state: "missing",
      detail:
        "PI_PATH is not set. Set it in .env to the real launch command, e.g. " +
        "PI_PATH=node C:/path/to/@earendil-works/pi-coding-agent/dist/cli.js",
    };
  }
  const firstSpace = raw.indexOf(" ");
  if (firstSpace === -1) {
    return { id, bin, resolved_path: null, version: null, state: "missing", detail: `PI_PATH=${raw} has no script path after the launcher.` };
  }
  const launcher = raw.slice(0, firstSpace);
  const target = raw.slice(firstSpace + 1).trim();
  if (!target || !existsSync(target)) {
    return {
      id,
      bin,
      resolved_path: null,
      version: null,
      state: "missing",
      detail: `PI_PATH resolves to '${target}', which does not exist on disk.`,
    };
  }
  const { version, error } = await probeVersion(`pi:${target}`, [launcher, target]);
  if (error) return { id, bin, resolved_path: target, version: null, state: "error", detail: error };
  return { id, bin, resolved_path: target, version, state: "ready", detail: "on PATH via PI_PATH" };
}

export async function getProviders(_req: Request): Promise<Response> {
  // `just` and `uv` are here because spec 2.8's Machine block is `uv / just /
  // pi` and this is the only endpoint that probes a binary. A probe this
  // endpoint does not serve is a probe Settings cannot render at all, which
  // made a passing `uv` indistinguishable from an unprobed one.
  //
  // `grok` and `agy` (Google Antigravity) are here because the Terminal's
  // quick-links type exactly these four harness names into a shell. A word the
  // Terminal offers and this pane cannot speak about is a word that fails in
  // the pty with no warning anywhere - so the quick-link list and the probe
  // list are the same list.
  const [claude, codex, grok, agy, pi, just, uv] = await Promise.all([
    probeOnPath("claude", "claude"),
    probeOnPath("codex", "codex"),
    probeOnPath("grok", "grok"),
    probeOnPath("agy", "agy"),
    probePi(),
    probeOnPath("just", "just"),
    probeOnPath("uv", "uv"),
  ]);
  return appJson([claude, codex, grok, agy, pi, just, uv] satisfies ProviderRow[]);
}
