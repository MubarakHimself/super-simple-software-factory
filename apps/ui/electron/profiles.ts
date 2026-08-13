/**
 * The Terminal surface's fixed profile table (spec 3.3). A renderer can only
 * ever pick a profileId from this table - it can never supply a command
 * line. That is the whole difference between a terminal surface and a
 * remote-code-execution hole in a page a browser can also load (spec 0.5).
 *
 * `cwd` is NOT resolved here - callers default it to the repo root
 * themselves (spec 3.3: "cwd defaults to the repo root for all of them").
 */
import { existsSync, readFileSync } from "node:fs";
import { which, WIN32 } from "./which.js";

export interface ResolvedCommand {
  file: string;
  args: string[];
}

export type ProfileResult = { ok: true; command: ResolvedCommand } | { ok: false; message: string };

function resolveShell(): ProfileResult {
  if (WIN32) return { ok: true, command: { file: process.env.ComSpec || "cmd.exe", args: [] } };
  return { ok: true, command: { file: process.env.SHELL || "/bin/sh", args: [] } };
}

function resolveBinary(name: string): ProfileResult {
  const found = which(name);
  if (!found) return { ok: false, message: `'${name}' was not found on PATH.` };
  return { ok: true, command: { file: found, args: [] } };
}

/** MAP landmine, absolute: never invoke `pi` by name (`pi.cmd` truncates
 * multi-line args under cmd.exe). Resolve via PI_PATH, exactly as
 * adws/adw_modules/agent_pi.py._resolve_pi_cmd does: `PI_PATH=node
 * <path>/cli.js`, forward slashes, last token is the real file on disk. */
function resolvePi(): ProfileResult {
  const raw = (process.env.PI_PATH ?? "").trim();
  if (!raw) {
    return {
      ok: false,
      message:
        "PI_PATH is not set. Set it in .env to the real launch command, e.g. " +
        "PI_PATH=node C:/path/to/@earendil-works/pi-coding-agent/dist/cli.js",
    };
  }
  const firstSpace = raw.indexOf(" ");
  if (firstSpace === -1) {
    return { ok: false, message: `PI_PATH=${raw} has no script path after the launcher.` };
  }
  const cmd = raw.slice(0, firstSpace);
  const target = raw.slice(firstSpace + 1).trim();
  if (!target || !existsSync(target)) {
    return { ok: false, message: `PI_PATH resolves to '${target}', which does not exist on disk.` };
  }
  return { ok: true, command: { file: cmd, args: [target] } };
}

export interface TerminalProfile {
  id: string;
  label: string;
}

/** Display order matches spec 3.3's table. */
export const PROFILES: readonly TerminalProfile[] = [
  { id: "shell", label: "Shell" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "pi" },
];

// ---------------------------------------------------------------------------
// The escape hatch (spec 3.3): a hand-written terminals.json in userData may
// add or override entries. Local file, no editor, no UI - loaded once and
// cached, same lifetime as the app.
// ---------------------------------------------------------------------------

interface UserProfileEntry {
  id: string;
  label?: string;
  file: string;
  args?: string[];
}

let userOverrides: Map<string, UserProfileEntry> | null = null;

export function loadUserProfileOverrides(path: string): void {
  userOverrides = new Map();
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as UserProfileEntry).id === "string" &&
        typeof (entry as UserProfileEntry).file === "string"
      ) {
        userOverrides.set((entry as UserProfileEntry).id, entry as UserProfileEntry);
      }
    }
  } catch {
    /* malformed terminals.json - ignored, built-in table still applies */
  }
}

export function resolveProfile(id: string): ProfileResult {
  const override = userOverrides?.get(id);
  if (override) {
    if (!existsSync(override.file) && !which(override.file)) {
      return { ok: false, message: `terminals.json entry '${id}': '${override.file}' not found.` };
    }
    return { ok: true, command: { file: override.file, args: override.args ?? [] } };
  }
  switch (id) {
    case "shell":
      return resolveShell();
    case "claude":
      return resolveBinary("claude");
    case "codex":
      return resolveBinary("codex");
    case "pi":
      return resolvePi();
    default:
      return { ok: false, message: `unknown profile '${id}'` };
  }
}
