/**
 * Turns the flat list `/docs/tree` returns into the nested shape the file
 * tree draws, with two rules that keep it honest about what the server
 * actually walked (`apps/ui/server/app/docs.ts`: root depth-1 plus
 * `docs/ specs/ queue/ app_docs/` recursively - never `adws/` or `tests/`,
 * which the mock draws as illustration only):
 *
 *  - **a directory whose only child is another directory collapses into one
 *    row** - `docs/research/pi` renders as one row, not three nested arrows
 *    for two of which there is nothing else to see.
 *  - **directories sort before files, then alphabetically** - so the shape on
 *    screen matches the shape on disk.
 */
import type { DocsTreeEntry } from "./types.ts";

export interface DirNode {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}
export interface FileNode {
  kind: "file";
  name: string;
  entry: DocsTreeEntry;
}
export type TreeNode = DirNode | FileNode;

export function buildTree(entries: DocsTreeEntry[]): TreeNode[] {
  const root: DirNode = { kind: "dir", name: "", path: "", children: [] };
  for (const entry of entries) {
    const segments = entry.path.split("/");
    let dir = root;
    for (const name of segments.slice(0, -1)) {
      const path = dir.path ? `${dir.path}/${name}` : name;
      let next = dir.children.find((child): child is DirNode => child.kind === "dir" && child.path === path);
      if (!next) {
        next = { kind: "dir", name, path, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ kind: "file", name: segments[segments.length - 1]!, entry });
  }
  normalize(root);
  return root.children;
}

/** Post-order: flatten children first, so a chain of any length collapses
 * into one row; then sort this level. */
function normalize(node: DirNode): void {
  for (const child of node.children) if (child.kind === "dir") normalize(child);
  while (node.children.length === 1 && node.children[0]!.kind === "dir" && node.path !== "") {
    const only = node.children[0] as DirNode;
    node.name = `${node.name}/${only.name}`;
    node.path = only.path;
    node.children = only.children;
  }
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Every directory prefix of a file path: `docs/design/x.md` -> ["docs", "docs/design"]. */
export function ancestors(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}
