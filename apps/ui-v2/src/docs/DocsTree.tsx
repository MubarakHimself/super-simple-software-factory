/**
 * The markdown tree (spec 2.7): "depth-1 expansion, empty directories
 * flattened, compact density - the behaviors of T3 section 11.3, not the
 * `@pierre/trees` library."
 *
 * The three behaviors, each of which is one rule here:
 *
 *  - **depth-1 expansion**: opening a directory reveals its immediate children
 *    and nothing deeper. Nothing auto-expands except the ancestors of the open
 *    document, which is the reveal half of W3-B2.
 *  - **empty directories flattened**: a directory whose only child is another
 *    directory renders as one row - `design/inspiration`, not two rows with
 *    one arrow each. (`docs/research/` with four files is not flattened; it is
 *    not empty.)
 *  - **compact density**: 24px rows, one line, never wrapping.
 *
 * Taxonomy grouping is by detection, not schema (W3-B4): the server marks an
 * entry `role:"entry"|"adr"`, and a group renders only when that role occurs.
 * A project without documentation-factory output - this repo today - renders
 * neither group, because a project without the taxonomy is not "missing docs".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { clip } from "../lib/format.ts";
import { IconChevronDown, IconFile } from "../shared/Icons.tsx";

/** `/api/app/p/:id/docs/tree` (spec 1.3). */
export interface DocsTreeEntry {
  path: string;
  kind: "file";
  title: string;
  role: "entry" | "adr" | null;
}

interface DirNode {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}
interface FileNode {
  kind: "file";
  name: string;
  entry: DocsTreeEntry;
}
type TreeNode = DirNode | FileNode;

const ADR_ID = /^(adr-\d+)/i;

function buildTree(entries: DocsTreeEntry[]): TreeNode[] {
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

/** Post-order: flatten the children first, then this node, so a chain of any
 * length collapses into one row. Then sort - directories, then files. */
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

/** Every directory prefix of a file path: `docs/design/x.md` -> docs, docs/design. */
function ancestors(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

function label(entry: DocsTreeEntry): string {
  if (entry.role === "adr") {
    const base = entry.path.split("/").pop() ?? entry.path;
    const id = ADR_ID.exec(base)?.[1];
    if (id) return `${id.toUpperCase()} · ${clip(entry.title, 34)}`;
  }
  return clip(entry.title, 42);
}

export function DocsTree({
  entries,
  selected,
  onOpen,
}: {
  entries: DocsTreeEntry[];
  /** Project-relative path of the open document, or "". */
  selected: string;
  onOpen: (path: string) => void;
}) {
  const nodes = useMemo(() => buildTree(entries), [entries]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(ancestors(selected)));

  // Reveal: the open document's directories expand. Never collapses anything
  // the operator opened by hand - this only adds.
  useEffect(() => {
    if (!selected) return;
    const needed = ancestors(selected);
    setExpanded((prev) => {
      if (needed.every((path) => prev.has(path))) return prev;
      const next = new Set(prev);
      for (const path of needed) next.add(path);
      return next;
    });
  }, [selected]);

  const groups = useMemo(
    () => ({
      entry: entries.filter((entry) => entry.role === "entry"),
      adr: entries.filter((entry) => entry.role === "adr"),
    }),
    [entries],
  );

  return (
    <nav aria-label="Docs" className="flex h-full w-column shrink-0 flex-col overflow-y-auto border-r border-hairline bg-chrome py-1">
      {groups.entry.length > 0 ? <Group name="Entry" entries={groups.entry} selected={selected} onOpen={onOpen} /> : null}
      {groups.adr.length > 0 ? <Group name="Decisions" entries={groups.adr} selected={selected} onOpen={onOpen} /> : null}
      {groups.entry.length + groups.adr.length > 0 ? <div className="my-1 border-t border-hairline" /> : null}
      <Branch nodes={nodes} depth={0} expanded={expanded} setExpanded={setExpanded} selected={selected} onOpen={onOpen} />
    </nav>
  );
}

function Group({
  name,
  entries,
  selected,
  onOpen,
}: {
  name: string;
  entries: DocsTreeEntry[];
  selected: string;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      <p className="px-2 py-1 text-meta text-t3">{name}</p>
      {entries.map((entry) => (
        <FileRow key={`group:${entry.path}`} entry={entry} depth={0} selected={selected} onOpen={onOpen} />
      ))}
    </>
  );
}

function Branch({
  nodes,
  depth,
  expanded,
  setExpanded,
  selected,
  onOpen,
}: {
  nodes: TreeNode[];
  depth: number;
  expanded: ReadonlySet<string>;
  setExpanded: (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  selected: string;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === "file" ? (
          <FileRow key={node.entry.path} entry={node.entry} depth={depth} selected={selected} onOpen={onOpen} />
        ) : (
          <DirRow
            key={node.path}
            node={node}
            depth={depth}
            expanded={expanded}
            setExpanded={setExpanded}
            selected={selected}
            onOpen={onOpen}
          />
        ),
      )}
    </>
  );
}

function DirRow({
  node,
  depth,
  expanded,
  setExpanded,
  selected,
  onOpen,
}: {
  node: DirNode;
  depth: number;
  expanded: ReadonlySet<string>;
  setExpanded: (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  selected: string;
  onOpen: (path: string) => void;
}) {
  const open = expanded.has(node.path);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        title={node.path}
        onClick={() =>
          setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(node.path)) next.delete(node.path);
            else next.add(node.path);
            return next;
          })
        }
        style={{ paddingLeft: 8 + depth * 12 }}
        className="flex h-row w-full shrink-0 items-center gap-1.5 pr-2 text-left text-body text-t2 hover:bg-row-hover hover:text-t1"
      >
        <IconChevronDown
          className={`size-3 shrink-0 text-t3 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
      {open ? (
        <Branch
          nodes={node.children}
          depth={depth + 1}
          expanded={expanded}
          setExpanded={setExpanded}
          selected={selected}
          onOpen={onOpen}
        />
      ) : null}
    </>
  );
}

function FileRow({
  entry,
  depth,
  selected,
  onOpen,
}: {
  entry: DocsTreeEntry;
  depth: number;
  selected: string;
  onOpen: (path: string) => void;
}) {
  const isSelected = entry.path === selected;
  const ref = useRef<HTMLButtonElement>(null);

  // The other half of reveal: a row opened from a link inside the reader is
  // scrolled to, not left somewhere below the fold.
  useEffect(() => {
    if (isSelected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [isSelected]);

  return (
    <button
      ref={ref}
      type="button"
      title={entry.path}
      onClick={() => onOpen(entry.path)}
      style={{ paddingLeft: 8 + depth * 12 + 10 }}
      className={[
        "flex h-row w-full shrink-0 items-center gap-1.5 pr-2 text-left text-body",
        isSelected
          ? "bg-row-active text-t1 shadow-[inset_2px_0_0_var(--accent)]"
          : "text-t2 hover:bg-row-hover hover:text-t1",
      ].join(" ")}
    >
      <IconFile className="size-3 shrink-0 text-t3" />
      <span className="min-w-0 truncate">{label(entry)}</span>
    </button>
  );
}
