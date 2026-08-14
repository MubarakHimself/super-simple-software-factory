/**
 * shutil.which()-equivalent PATH search (+ PATHEXT on Windows). Ported
 * verbatim from `apps/ui/electron/which.ts` (spec 1.3: "Ported wholesale
 * from apps/ui/electron/: ... which.ts. They are already tested; only the
 * sink changes from IPC sender to SSE" - this file has no sink at all, so
 * it needed no change beyond its import path). Shared by profiles.ts (harness
 * resolution) and readiness.ts's own read-only copy (which stays separate on
 * purpose - see readiness.ts's own header comment).
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export const WIN32 = process.platform === "win32";

export function which(cmd: string): string | null {
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
