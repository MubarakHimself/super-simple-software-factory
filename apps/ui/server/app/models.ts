/**
 * `GET /api/app/models` - the lanes pi actually knows on this machine, so the
 * Roster's lane control can be a dropdown instead of a text box.
 *
 * The operator's words: "I don't know these models by heart and I can't type
 * all of them." A free-text field over a catalog the machine already has is a
 * memory test, so this endpoint runs the same cost-free probe the factory runs
 * and hands the UI the real list, grouped by provider.
 *
 * ── The source ────────────────────────────────────────────────────────────
 * `pi -ne --list-models`, which is exactly what
 * `adws/adw_modules/agent_pi.py:_pi_catalog` shells and what
 * `resolve_model()` validates a roster's `provider/id` against - so a lane
 * offered here is a lane the factory can actually resolve. It is the MERGED
 * view (built-in providers + `~/.pi/agent/models.json` + anything an extension
 * registers), which is why it is preferred over reading `models.json` directly:
 * that file is only one of the inputs, and it carries `apiKey` fields this app
 * must never read or serve. Nothing here opens it.
 *
 * `--list-models` prints a table and exits. It never sends a prompt, never
 * spends a token, and `-ne` keeps ambient extension discovery (which can prompt
 * and hang) switched off - the same flag and the same reason as the factory's.
 *
 * ── Resolving pi ──────────────────────────────────────────────────────────
 * `PI_PATH` when the environment carries it (split into argv the way
 * `_resolve_pi_cmd` splits it), else `pi` on PATH. The factory itself refuses
 * the second half of that - "adws must never invoke `pi` by name" - because an
 * ambiguous binary in an unattended run is a real hazard. This is the opposite
 * situation: an operator-initiated, read-only listing in a settings pane, on a
 * server process that does not read `.env` (see `server/config.ts`'s header)
 * and therefore never sees the `PI_PATH` the factory uses. The response says
 * which of the two resolved, so the pane can never imply more than it knows.
 *
 * ── Thinking levels ───────────────────────────────────────────────────────
 * Parsed out of `pi --help`'s own `--thinking <level>` line rather than
 * restated here, so the vocabulary is pi's rather than this file's guess. See
 * the note on `THINKING_FALLBACK` for what that list turned out to be.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { appJson } from "./guard.ts";

const WIN32 = process.platform === "win32";
const PROBE_TIMEOUT_MS = 25_000;

export interface CatalogModel {
  id: string;
  /** context window in tokens, or null when the column was unreadable */
  context: number | null;
  max_out: number | null;
  /** pi's own `thinking` column: whether a thinking level means anything for
   * this model at all. It is a CAPABILITY, not a list of level names - see
   * `ModelCatalog.thinking_levels`. */
  thinking: boolean;
  images: boolean;
}

export interface CatalogProvider {
  id: string;
  models: CatalogModel[];
}

export interface ModelCatalog {
  providers: CatalogProvider[];
  /** The level vocabulary, from `pi --help`. Global to pi, not per provider. */
  thinking_levels: string[];
  /** how pi was resolved, for a pane that must not imply more than it knows */
  source: string | null;
  /** set only when `providers` is empty: the honest sentence about why */
  detail: string | null;
}

/**
 * pi's `--help` says: "Set thinking level: off, minimal, low, medium, high,
 * xhigh, max" - ONE list, for every provider. There is no per-provider
 * vocabulary anywhere in pi's catalog, its help, or its models config; what IS
 * per-model is the `thinking` yes/no column above. So this is the fallback for
 * a `--help` that could not be read, not an invented alternative, and it is the
 * same seven words `sssf.config.yaml`'s own comment documents and `roster.ts`
 * validates against.
 */
const THINKING_FALLBACK = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function which(cmd: string): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const exts = WIN32 ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

interface PiCommand {
  argv: string[];
  how: string;
}

/** `PI_PATH` first, `pi` on PATH second, null when neither resolves. */
function piCommand(): PiCommand | null {
  const raw = (process.env.PI_PATH ?? "").trim();
  if (raw) {
    // `_resolve_pi_cmd` splits PI_PATH into a word list; a launcher plus a
    // script path is the documented shape (`node C:/.../cli.js`).
    const argv = raw.split(/\s+/).filter(Boolean);
    const target = argv[argv.length - 1] ?? "";
    const looksLikePath = target.includes("/") || target.includes("\\");
    if (argv.length > 0 && (looksLikePath ? existsSync(target) : which(target) !== null)) {
      return { argv, how: "PI_PATH" };
    }
  }
  const onPath = which("pi");
  return onPath ? { argv: [onPath], how: "pi on PATH" } : null;
}

interface Ran {
  stdout: string;
  code: number;
  error: string | null;
}

/** Fixed argv, no shell, hard timeout, stdin closed - a probe that cannot turn
 * into an interactive session. */
async function run(argv: string[]): Promise<Ran> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, PROBE_TIMEOUT_MS);
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    if (timedOut) return { stdout: "", code: -1, error: `timed out after ${PROBE_TIMEOUT_MS}ms` };
    return { stdout, code, error: code === 0 ? null : `exited ${code}` };
  } catch (error) {
    return { stdout: "", code: -1, error: (error as Error).message };
  }
}

/** `262.1K` / `1M` / `30000` -> a number. Ported from `agent_pi.py:_count`,
 * which reads the same column of the same table. */
function count(value: string): number | null {
  const suffix = value.slice(-1).toUpperCase();
  const scale = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : null;
  const parsed = Number.parseFloat(scale === null ? value : value.slice(0, -1));
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * (scale ?? 1));
}

/**
 * The table `--list-models` prints:
 *
 *   provider      model                   context  max-out  thinking  images
 *   ollama-cloud  kimi-k2.7-code          262.1K   32.8K    no        no
 *
 * Header dropped, whitespace-split (no column here ever contains a space), and
 * a row that does not have six readable columns is skipped rather than guessed
 * at - the same tolerance `_pi_catalog` shows.
 */
function parseCatalog(stdout: string): CatalogProvider[] {
  const byProvider = new Map<string, CatalogModel[]>();
  for (const line of stdout.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 6) continue;
    const [provider, id, context, maxOut, thinking, images] = columns as [string, string, string, string, string, string];
    if (!provider || !id) continue;
    const models = byProvider.get(provider) ?? [];
    models.push({
      id,
      context: count(context),
      max_out: count(maxOut),
      thinking: thinking.toLowerCase() === "yes",
      images: images.toLowerCase() === "yes",
    });
    byProvider.set(provider, models);
  }
  return Array.from(byProvider.entries()).map(([id, models]) => ({ id, models }));
}

/** pi's help line: `--thinking <level>   Set thinking level: off, minimal, ...` */
function parseThinkingLevels(help: string): string[] | null {
  const match = help.match(/Set thinking level:\s*([^\r\n]+)/i);
  if (!match) return null;
  const levels = match[1]!
    .split(",")
    .map((word) => word.trim())
    .filter((word) => /^[a-z]+$/i.test(word));
  return levels.length > 0 ? levels : null;
}

/** One probe per server process. The catalog changes when the operator
 * registers a provider with pi, which is a thing they do in a terminal and then
 * come back from - so a process-lifetime cache with an explicit re-read is the
 * right cadence, and it keeps a settings pane from shelling a subprocess on
 * every open. */
let cached: ModelCatalog | null = null;
let inFlight: Promise<ModelCatalog> | null = null;

async function buildCatalog(): Promise<ModelCatalog> {
  const pi = piCommand();
  if (!pi) {
    return {
      providers: [],
      thinking_levels: THINKING_FALLBACK,
      source: null,
      detail:
        "pi was not found: PI_PATH is not set in this server's environment and 'pi' is not on PATH. " +
        "Type a lane by hand, or start the server with PI_PATH set.",
    };
  }

  const listed = await run([...pi.argv, "-ne", "--list-models"]);
  if (listed.error) {
    return {
      providers: [],
      thinking_levels: THINKING_FALLBACK,
      source: pi.how,
      detail: `pi --list-models ${listed.error}`,
    };
  }

  const providers = parseCatalog(listed.stdout);
  const helped = await run([...pi.argv, "--help"]);
  const levels = helped.error ? null : parseThinkingLevels(helped.stdout);

  return {
    providers,
    thinking_levels: levels ?? THINKING_FALLBACK,
    source: pi.how,
    detail: providers.length === 0 ? "pi --list-models printed no models." : null,
  };
}

export async function getModels(req: Request): Promise<Response> {
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  if (refresh) {
    cached = null;
    inFlight = null;
  }
  if (cached) return appJson(cached);
  // Two opens of the pane must not become two `pi` subprocesses.
  inFlight ??= buildCatalog().finally(() => {
    inFlight = null;
  });
  const catalog = await inFlight;
  // A failed probe is not cached: the fix (set PI_PATH, install pi) happens
  // outside this process and should not need a restart to be seen.
  if (catalog.providers.length > 0) cached = catalog;
  return appJson(catalog satisfies ModelCatalog);
}
