/**
 * First-run Setup (spec 4) - the wizard is the engine, this file only
 * drives it, never re-implements it. Two jobs:
 *
 *   1. detectSetup() - runs the wizard's own drift check,
 *      `uv run installer/install.py --verify-only --json`, and reports
 *      install.py's own exit code + its verify[] array verbatim (spec 4.1:
 *      "The app invents no check, no wording, and no ordering of its own").
 *   2. isInstallTarget() - the fixed 3-target enum a renderer may pick from
 *      before setup:run is allowed to build a command line, same discipline
 *      as profiles.ts's fixed profile table (spec 3.2).
 *
 * installer/install.py and installer/steps.py are read-only inputs to this
 * spec (spec 1) - nothing here edits, forks, or duplicates their logic.
 */
import { spawn } from "node:child_process";
import { which } from "./which.js";

export const INSTALL_TARGETS = ["laptop", "server", "container"] as const;
export type InstallTarget = (typeof INSTALL_TARGETS)[number];

export function isInstallTarget(value: unknown): value is InstallTarget {
  return typeof value === "string" && (INSTALL_TARGETS as readonly string[]).includes(value);
}

export interface VerifyCheck {
  id: string;
  outcome: string;
  message: string;
}

export interface SetupStatus {
  /** true only when install.py itself exited 0 (spec 4.1's table: exit 0 =
   * "converged, verification passed"). */
  converged: boolean;
  /** null only on a spawn failure - "uv itself is missing" (spec 4.1's
   * third row). */
  exitCode: number | null;
  /** The target install.py itself detected/used (ctx.target in its own
   * JSON payload) - never guessed here (spec 4.3: "no parallel logic"). */
  target: string | null;
  checks: VerifyCheck[];
  /** Honest diagnostic text for a spawn failure or unparsable output.
   * Never invented wording (MAP rule 6: no mock data). */
  error: string | null;
}

interface InstallJsonPayload {
  target?: unknown;
  verify?: unknown;
}

function parseChecks(raw: unknown): VerifyCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: VerifyCheck[] = [];
  for (const entry of raw) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as VerifyCheck).id === "string" &&
      typeof (entry as VerifyCheck).outcome === "string" &&
      typeof (entry as VerifyCheck).message === "string"
    ) {
      out.push({
        id: (entry as VerifyCheck).id,
        outcome: (entry as VerifyCheck).outcome,
        message: (entry as VerifyCheck).message,
      });
    }
  }
  return out;
}

/** Runs the wizard's own `--verify-only --json` drift check and reports its
 * result verbatim. Never throws - every failure mode (uv missing, a crash,
 * unparsable stdout) comes back as a SetupStatus with converged:false and an
 * honest `error`, so every call site can decide "show Setup" with a plain
 * `if (!status.converged)` and no try/catch of its own. */
export async function detectSetup(repoRoot: string): Promise<SetupStatus> {
  if (!which("uv")) {
    return {
      converged: false,
      exitCode: null,
      target: null,
      checks: [],
      error: "'uv' was not found on PATH. Install uv, then relaunch.",
    };
  }
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("uv", ["run", "installer/install.py", "--verify-only", "--json"], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", (error) => {
      resolvePromise({
        converged: false,
        exitCode: null,
        target: null,
        checks: [],
        error: `could not start 'uv': ${error.message}`,
      });
    });
    child.on("exit", (code) => {
      try {
        const parsed = JSON.parse(stdout) as InstallJsonPayload;
        resolvePromise({
          converged: code === 0,
          exitCode: code,
          target: typeof parsed.target === "string" ? parsed.target : null,
          checks: parseChecks(parsed.verify),
          error: null,
        });
      } catch {
        resolvePromise({
          converged: false,
          exitCode: code,
          target: null,
          checks: [],
          error:
            `install.py --verify-only --json did not return parsable JSON (exit ${code}). ` +
            `stderr: ${stderr.trim().slice(0, 500) || "(empty)"}`,
        });
      }
    });
  });
}
