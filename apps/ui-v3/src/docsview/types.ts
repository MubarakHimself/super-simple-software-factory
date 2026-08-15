/**
 * The two shapes `apps/ui/server/app/docs.ts` hands back. Kept local to this
 * surface rather than in the shared shell lib - nothing outside Docs reads
 * them (see `lib/api.ts`'s own note: a surface owns its own types).
 */

/** `GET /api/app/p/:id/docs/tree` - one row per markdown file under the repo
 * root (depth-1) plus `docs/ specs/ queue/ app_docs/` (recursive). There is no
 * `kind:"dir"` row: directories are inferred client-side from `path`. */
export interface DocsTreeEntry {
  path: string; // project-relative, posix-style
  kind: "file";
  title: string;
  role: "entry" | "adr" | null;
}

/** `GET /api/app/p/:id/docs/file?path=...`. Works for any file under the
 * project root, not only the ones `docs/tree` lists - a relative link inside a
 * doc can point at a file the tree never walked (e.g. a script in `adws/`),
 * and the reader still opens it, honestly, as plain text (see Reader.tsx). */
export interface DocsFileResponse {
  path: string;
  text: string;
  bytes: number;
  mtime: string;
}
