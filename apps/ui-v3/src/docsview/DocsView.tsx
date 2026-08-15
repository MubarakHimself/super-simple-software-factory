/**
 * Docs (journeys J3 step 4, mock `docs-v3.html`): the project's own
 * repository read as a reference - `docs/ specs/ queue/ app_docs/` plus the
 * root's own markdown, exactly what `apps/ui/server/app/docs.ts` walks. No
 * welcome copy, no explainer paragraph: the breadcrumb above already says
 * `project / Docs`, so this surface spends its screen on the tree and the
 * document and nothing else.
 *
 * This file owns the two decisions the surface is:
 *
 *  1. **Which document opens first.** An `entry`-role row (per `docs.ts`'s
 *     detection: `docs/index.md`, `AGENTS.md`, `constitution.md`,
 *     `glossary.md` at a doc root) wins; otherwise the first row in the
 *     already-sorted tree - never invented, always a real file.
 *  2. **Where a relative link goes.** `[x](../specs/ui.md)` resolves against
 *     the open file's own directory (`paths.ts`) and navigates in-app; the
 *     tree reveals the row. The URL is `/p/:id/docs/<path>`, a real address.
 *     Unlike a `.md`-only reader, a link to a file `docs/tree` never listed
 *     (e.g. a script the doc references) still opens - `Reader.tsx` renders
 *     it as plain text rather than refusing it.
 */
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useShell } from "../App.tsx";
import { useResource } from "../lib/poll.ts";
import { EmptyState, ReadFailure } from "../shell/EmptyState.tsx";
import "./docs.css";
import { Reader } from "./Reader.tsx";
import { Tree } from "./Tree.tsx";
import { docsHref } from "./paths.ts";
import type { DocsTreeEntry } from "./types.ts";

function entryDoc(entries: DocsTreeEntry[]): string | null {
  return entries.find((entry) => entry.role === "entry")?.path ?? entries[0]?.path ?? null;
}

export default function Docs() {
  const { projectId, project } = useShell();
  const params = useParams();
  const navigate = useNavigate();
  // The splat of `/p/:projectId/docs/*`. React Router hands it back decoded.
  const selected = (params["*"] ?? "").replace(/^\/+/, "");

  const tree = useResource<DocsTreeEntry[]>(`${projectId}|docs-tree`, `/api/app/p/${encodeURIComponent(projectId)}/docs/tree`);
  const entries = tree.data ?? [];

  // Opening the surface with no path opens the entry doc, and REPLACES the
  // history entry so Back leaves Docs rather than bouncing off the redirect.
  useEffect(() => {
    if (selected || !tree.data) return;
    const first = entryDoc(tree.data);
    if (first) navigate(docsHref(projectId, first), { replace: true });
  }, [selected, tree.data, projectId, navigate]);

  const open = (path: string) => navigate(docsHref(projectId, path));

  if (tree.loading) return null;

  if (!tree.data && tree.error) {
    return (
      <EmptyState heading="Docs unavailable" sentence="The app could not read this project's docs from the server.">
        <ReadFailure error={tree.error} />
      </EmptyState>
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        heading="No docs"
        sentence="This project has no docs/, specs/, queue/ or app_docs/ markdown yet — publish a batch and they land here."
      />
    );
  }

  const fallbackTitle = selected ? (entries.find((entry) => entry.path === selected)?.title ?? selected.split("/").pop() ?? selected) : "";

  return (
    <>
      <Tree entries={entries} selected={selected} scopeName={project?.name ?? projectId} error={tree.error} onOpen={open} />
      {selected ? <Reader projectId={projectId} path={selected} fallbackTitle={fallbackTitle} onOpenRelative={open} /> : null}
    </>
  );
}
