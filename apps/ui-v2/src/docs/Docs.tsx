/**
 * Docs (spec 2.7). Second column: the markdown tree. Main pane: the reader.
 * No welcome paragraph, no breadcrumb explainer - the breadcrumb in the top
 * bar already says `project / Docs`, so this surface spends its text on the
 * document and nothing else.
 *
 * This file owns the three decisions the surface is:
 *
 *  1. **Which document opens.** First hit of `docs/index.md` -> `README.md` ->
 *     `MAP.md`. In this repo there is no `docs/index.md` and there is a
 *     `README.md`, so README is the first hit and MAP is never reached.
 *  2. **Where a relative link goes.** `[x](../specs/ui.md)` resolves against
 *     the open file's own directory and navigates in-app; the tree reveals the
 *     row (spec 2.7 / W3-B2). The URL becomes `/p/:id/docs/<path>`, so a deep
 *     link is a real address an agent can be pointed at.
 * (A third decision used to live here - what `Plan from this` meant, the
 * import entry way into the composer. The KISS correction removed the
 * composer, so the reader carries no action at all now: Docs reads documents.)
 *
 * Everything on screen comes from `/api/app/p/:id/docs/*` - real files on
 * disk, or the surface's own honest empty state.
 */
import { useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useShell } from "../App.tsx";
import { useResource } from "../lib/poll.ts";
import { EmptyState, ReadFailure } from "../shell/EmptyState.tsx";
import { DocsTree, type DocsTreeEntry } from "./DocsTree.tsx";
import { Reader } from "./Reader.tsx";

/** Spec 2.7, in order. Compared case-insensitively: this app runs on a
 * case-insensitive filesystem, where `Readme.md` IS `README.md`. */
const ENTRY_ORDER = ["docs/index.md", "readme.md", "map.md"];

/** Path segments are encoded the same way the palette encodes them
 * (`shell/Palette.tsx`), so both produce the identical address for one file. */
function docsHref(projectId: string, path: string): string {
  return `/p/${projectId}/docs/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function entryDoc(entries: DocsTreeEntry[]): string | null {
  for (const wanted of ENTRY_ORDER) {
    const hit = entries.find((entry) => entry.path.toLowerCase() === wanted);
    if (hit) return hit.path;
  }
  // No entry doc by name. The first document in the tree is still a real file
  // in this project - it is the honest fallback, and it is never invented.
  return entries[0]?.path ?? null;
}

/**
 * `../specs/ui.md` read from `docs/design/x.md` -> `specs/ui.md`.
 * A leading `/` is repo-root relative. Anchors and queries are dropped: they
 * address a position inside a document, not another document.
 */
export function resolveRelative(fromPath: string, href: string): string | null {
  const bare = href.split("#")[0]!.split("?")[0]!;
  if (!bare.trim()) return null;
  const segments = bare.startsWith("/")
    ? bare.slice(1).split("/")
    : [...fromPath.split("/").slice(0, -1), ...bare.split("/")];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.length > 0 ? out.join("/") : null;
}

export default function Docs() {
  const { projectId } = useShell();
  const params = useParams();
  const navigate = useNavigate();
  // The splat of `/p/:projectId/docs/*`. React Router hands it back decoded.
  const selected = (params["*"] ?? "").replace(/^\/+/, "");

  const tree = useResource<DocsTreeEntry[]>(
    projectId ? `${projectId}|docs-tree` : null,
    projectId ? `/api/app/p/${encodeURIComponent(projectId)}/docs/tree` : null,
  );
  const entries = tree.data ?? [];

  // Opening the surface with no path opens the entry doc, and REPLACES the
  // history entry - so Back leaves Docs rather than bouncing off the redirect.
  useEffect(() => {
    if (selected || !tree.data) return;
    const first = entryDoc(tree.data);
    if (first) navigate(docsHref(projectId, first), { replace: true });
  }, [selected, tree.data, projectId, navigate]);

  const open = useCallback((path: string) => navigate(docsHref(projectId, path)), [navigate, projectId]);

  const openRelative = useCallback(
    (href: string) => {
      const target = resolveRelative(selected, href);
      // Docs is the markdown surface (spec 2.0). A relative link to a `.py` or
      // a `.png` is not a document this reader can honestly render, so it is
      // left alone rather than opened onto a wrong-looking page.
      if (!target || !/\.(md|markdown)$/i.test(target)) return;
      open(target);
    },
    [open, selected],
  );

  if (tree.loading) return null;
  if (!tree.data && tree.error) {
    return (
      <div className="flex h-full items-center justify-center">
        <ReadFailure error={tree.error} />
      </div>
    );
  }
  if (entries.length === 0) return <EmptyState heading="Docs" sentence="No markdown here yet." />;

  return (
    <div className="flex h-full min-h-0">
      <DocsTree entries={entries} selected={selected} onOpen={open} />
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <Reader projectId={projectId} path={selected} onOpenRelative={openRelative} />
        ) : null}
      </div>
    </div>
  );
}
