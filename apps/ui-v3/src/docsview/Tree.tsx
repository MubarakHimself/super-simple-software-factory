/**
 * The file tree pane, ported from `docs-v3.html`'s `.tree-col` block. Two
 * behaviors beyond the static mock:
 *
 *  - **the filter box works**: typing narrows the tree to paths/titles that
 *    contain the text, client-side (the tree is already on screen - there is
 *    no reason to round-trip `/docs/search` for a filter over data already
 *    held). A folder with no matching descendant simply is not built, because
 *    `buildTree` only ever creates a directory a file path passes through.
 *  - **only the open document's ancestors start expanded**; everything else
 *    starts collapsed, which is the honest default for a project whose tree
 *    the operator has not looked at yet. Filtering expands everything a match
 *    lives inside, so a hit is never hidden behind a closed row.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { FileIcon, FolderIcon, TreeChevron } from "./icons.tsx";
import { ancestors, buildTree, type DirNode, type TreeNode } from "./tree.ts";
import type { DocsTreeEntry } from "./types.ts";

export function Tree({
  entries,
  selected,
  scopeName,
  /** Set when the tree loaded once and a later refresh (e.g. Sync) failed -
   * `entries` is still the last-good list, shown alongside the note. */
  error,
  onOpen,
}: {
  entries: DocsTreeEntry[];
  /** Project-relative path of the open document, or "". */
  selected: string;
  scopeName: string;
  error?: string | null;
  onOpen: (path: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const filtered = useMemo(
    () => (query ? entries.filter((e) => e.path.toLowerCase().includes(query) || e.title.toLowerCase().includes(query)) : entries),
    [entries, query],
  );
  const nodes = useMemo(() => buildTree(filtered), [filtered]);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(ancestors(selected)));
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

  // Filtering reveals every directory a match lives inside, on top of
  // whatever the operator already opened by hand.
  const effectiveExpanded = useMemo(() => {
    if (!query) return expanded;
    const all = new Set(expanded);
    const collectDirs = (list: TreeNode[]) => {
      for (const node of list) {
        if (node.kind === "dir") {
          all.add(node.path);
          collectDirs(node.children);
        }
      }
    };
    collectDirs(nodes);
    return all;
  }, [query, expanded, nodes]);

  return (
    <div className="tree-col">
      <div className="tree-header">
        <h3>Files</h3>
        <span className="tree-scope">{scopeName}</span>
      </div>
      <div className="tree-search">
        <input
          className="tree-search-input"
          type="text"
          placeholder="Filter files…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="tree-body">
        {error ? <ReadFailure error={error} /> : null}
        {nodes.length === 0 ? (
          <p className="tree-empty">{query ? `No files match "${filter.trim()}".` : "No files."}</p>
        ) : (
          <Branch nodes={nodes} depth={0} expanded={effectiveExpanded} setExpanded={setExpanded} selected={selected} onOpen={onOpen} />
        )}
      </div>
    </div>
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
          <DirRow key={node.path} node={node} depth={depth} expanded={expanded} setExpanded={setExpanded} selected={selected} onOpen={onOpen} />
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
    <div className="tree-folder">
      <div
        className={`tree-folder-header${open ? " open" : ""}`}
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
      >
        <TreeChevron className="chev" />
        <FolderIcon className="folder-icon" />
        <span className="folder-name">{node.name}/</span>
      </div>
      {open ? (
        <div className="tree-files">
          <Branch nodes={node.children} depth={depth + 1} expanded={expanded} setExpanded={setExpanded} selected={selected} onOpen={onOpen} />
        </div>
      ) : null}
    </div>
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [isSelected]);

  return (
    <div
      ref={ref}
      className={`tree-file${isSelected ? " active" : ""}`}
      title={entry.path}
      onClick={() => onOpen(entry.path)}
      style={{ paddingLeft: 8 + depth * 12 + 10 }}
    >
      <FileIcon className="file-icon" />
      <span className="file-name">{entry.title}</span>
      {entry.role ? <span className="file-tag">{entry.role}</span> : null}
    </div>
  );
}
