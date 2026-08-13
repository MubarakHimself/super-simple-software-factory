/**
 * shutil.which()-equivalent PATH search (+ PATHEXT on Windows). Shared by
 * profiles.ts (spec 3.3), setup.ts (spec 4 - "uv" must fail visibly, not
 * silently), and server-lens.ts (spec 5 - "ssh") so every action surface
 * fails the same honest way when its binary is missing (MAP rule 6: never a
 * silent no-op).
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
