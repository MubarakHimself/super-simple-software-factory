/**
 * The session bridge's fixed harness table (spec 1.3/1.5, ported from
 * `apps/ui/electron/profiles.ts`). A caller (bridge.ts) can only ever pick a
 * harness id from this table - it never receives or forwards a command line
 * from the browser. That is the whole difference between a Session and a
 * remote-code-execution hole in a page a browser can also load (spec 1.2):
 * "The browser never sends a command line. It sends a harness id resolved
 * against a fixed server-side table."
 *
 * `resolveProfile()` returns the *base* command (binary/launcher + any
 * launcher-required leading args, e.g. pi's `node <script.js>`). Each
 * adapter (adapters/claude.ts, adapters/codex.ts, adapters/pi.ts) appends
 * its own protocol-specific argv on top of that base - profiles.ts stays
 * ignorant of stream-json flags, `exec --json`, or anything else harness-
 * protocol-specific; it only answers "where is the binary, and does it
 * exist".
 *
 * readiness.ts (K0) keeps its OWN small, read-only `resolveOnPath`/`resolvePi`
 * for the `--version` probe - deliberately not imported from here, per its
 * own header comment: two different jobs (probe vs spawn), and
 * `apps/ui/electron/**` sits outside the server's tsconfig include, so
 * neither file imports the other's ancestor.
 */
import { existsSync } from "node:fs";
import { which, WIN32 } from "./which.ts";

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

/** The fixed table itself. `shell` stays in it for the raw Terminal escape
 * hatch even though the Session harness enum (spec 1.3's POST
 * /api/app/sessions body) is only `claude|codex|pi`. */
export function resolveProfile(id: string): ProfileResult {
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
