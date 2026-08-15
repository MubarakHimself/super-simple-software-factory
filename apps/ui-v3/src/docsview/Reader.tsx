/**
 * The reader pane, ported from `docs-v3.html`'s `.reader-pane` block: a
 * centred column with a serif title, a mono meta line, then the document.
 *
 * Two things this file decides that the mock (one static example) did not
 * have to:
 *
 *  - **the title comes from the document itself.** A leading `# Heading` line
 *    becomes the `<h1>` and is not repeated inside the body - the same
 *    `firstHeading` rule `docs.ts` already uses for the tree row, applied
 *    here so the two never disagree. A document with no leading heading falls
 *    back to the tree's title (or the bare filename for a file the tree never
 *    listed - see the note on `title` below).
 *  - **a non-markdown file renders as plain, read-only text** rather than
 *    being refused. `docs/tree` only ever lists `.md` files, but
 *    `docs/file` will return anything under the project root, so a relative
 *    link from inside a doc can point at, say, `adws/lane_balancer.py`; this
 *    pane still opens it, honestly labelled as what it is.
 */
import { useMemo } from "react";
import { useResource } from "../lib/poll.ts";
import { ReadFailure } from "../shell/EmptyState.tsx";
import { Markdown } from "./Markdown.tsx";
import { isMarkdownPath, resolveRelative } from "./paths.ts";
import { relativeTime } from "./relativeTime.ts";
import type { DocsFileResponse } from "./types.ts";

function splitLeadingHeading(text: string): { heading: string | null; body: string } {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const match = i < lines.length ? /^#\s+(.+?)\s*$/.exec(lines[i]!) : null;
  if (!match) return { heading: null, body: text };
  let j = i + 1;
  while (j < lines.length && lines[j]!.trim() === "") j++;
  return { heading: match[1]!.trim(), body: lines.slice(j).join("\n") };
}

export function Reader({
  projectId,
  path,
  /** The tree row's title, or the bare filename when `path` arrived from a
   * relative link the tree never listed - used only as a fallback for a
   * document with no leading `# Heading` of its own. */
  fallbackTitle,
  onOpenRelative,
}: {
  projectId: string;
  path: string;
  fallbackTitle: string;
  onOpenRelative: (path: string) => void;
}) {
  const file = useResource<DocsFileResponse>(
    `${projectId}|docs-file|${path}`,
    `/api/app/p/${encodeURIComponent(projectId)}/docs/file?path=${encodeURIComponent(path)}`,
  );

  const markdown = isMarkdownPath(path);
  const split = useMemo(() => (file.data && markdown ? splitLeadingHeading(file.data.text) : null), [file.data, markdown]);
  const title = split?.heading ?? fallbackTitle;
  const lineCount = file.data ? file.data.text.split("\n").length : 0;

  const navigate = (href: string) => {
    const target = resolveRelative(path, href);
    if (target) onOpenRelative(target);
  };

  return (
    <div className="reader-pane">
      <div className="reader-scroll">
        <div className="reader-content fade-in" key={path}>
          {file.data ? (
            <>
              <h1>{title}</h1>
              <div className="doc-meta">
                {path} · {lineCount} {lineCount === 1 ? "line" : "lines"} · modified {relativeTime(file.data.mtime)}
              </div>
              {/* Last-good content stays on screen even when the most recent
                  refresh failed - the failure is a note beside it, not a
                  replacement for it (poll.ts: "data and error are live at
                  once, on purpose"). */}
              {file.error ? <ReadFailure error={file.error} /> : null}
              {markdown ? <Markdown text={split!.body} onNavigate={navigate} /> : <pre className="doc-plain">{file.data.text}</pre>}
            </>
          ) : file.error ? (
            <ReadFailure error={file.error} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
