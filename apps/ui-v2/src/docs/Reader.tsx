/**
 * The reader (spec 2.7): `react-markdown` + `remark-gfm`, rendered by the
 * app's ONE markdown renderer - `shared/Markdown.tsx`, the same component the
 * card inspector uses (spec 3.6).
 *
 * ── The width rule (2026-08-14 layout pass) ───────────────────────────────
 * The reader used to be a 68ch column pinned to the left of a pane a metre
 * wide, which is the defect the operator drew a red box around: "the spacing
 * makes no sense - the right half is empty". Two facts are both true and the
 * old layout obeyed neither: prose past ~95 characters a line is hard to read,
 * AND a pane with nothing in its right half looks broken.
 *
 * So the pane is filled by a second real thing rather than by stretched text:
 * the document's own headings, as an outline the operator can jump from. The
 * prose column keeps a measure; the outline takes the width the measure does
 * not want; the two together are centred and span ~80% of the pane. A document
 * with fewer than two headings has no outline to show, so it renders none and
 * the prose column simply centres - honest empty states apply to a rail too.
 *
 * The outline is read out of the DOM after the markdown renders, never parsed
 * from the text a second time: one parser, one truth, and no way for the rail
 * to name a heading the document does not have.
 *
 * A file over 1MB arrives already truncated with the server's own stated line
 * inside the text (`/api/app/p/:id/docs/file`), so nothing is added here: one
 * statement of a fact, from the side that knows it.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useResource } from "../lib/poll.ts";
import { Markdown } from "../shared/Markdown.tsx";
import { ReadFailure } from "../shell/EmptyState.tsx";

export interface DocsFile {
  path: string;
  text: string;
  bytes: number;
  mtime: string;
}

interface Heading {
  id: string;
  text: string;
  level: number;
}

/** Below two headings there is no outline worth a rail. */
const OUTLINE_MIN = 2;

export function Reader({
  projectId,
  path,
  onOpenRelative,
}: {
  projectId: string;
  /** Project-relative, posix-style. */
  path: string;
  onOpenRelative: (href: string) => void;
}) {
  const file = useResource<DocsFile>(
    `${projectId}|docs-file|${path}`,
    `/api/app/p/${encodeURIComponent(projectId)}/docs/file?path=${encodeURIComponent(path)}`,
  );

  const proseRef = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const text = file.data?.text ?? null;

  // Read after paint, from the rendered document. Ids are stamped here because
  // nothing else needs them - the anchor exists to be jumped to, and that is
  // the whole of its life.
  useEffect(() => {
    const host = proseRef.current;
    if (!host || text === null) {
      setHeadings([]);
      return;
    }
    const found = [...host.querySelectorAll<HTMLElement>("h1, h2, h3")].map((node, index) => {
      if (!node.id) node.id = `doc-heading-${index}`;
      return { id: node.id, text: (node.textContent ?? "").trim(), level: Number(node.tagName[1]) };
    });
    setHeadings(found.filter((heading) => heading.text.length > 0));
  }, [text, path]);

  const outline = headings.length >= OUTLINE_MIN ? headings : [];

  return (
    <>
      <header className="flex h-menurow shrink-0 items-center gap-3 border-b border-hairline px-4">
        <span className="min-w-0 truncate font-mono text-mono text-t3" title={path}>
          {path}
        </span>
      </header>

      {/* A container query, not a media query: what decides whether the
          outline fits is this pane's width, and the pane is the window minus a
          sidebar that collapses and a tree that does not (spec 3.4's rule,
          expressed in CSS instead of in a ResizeObserver). Under 1000px the
          rail would be taking a third of the reader to save the operator a
          scroll, so it is not there at all. */}
      <div className="@container min-h-0 flex-1 overflow-auto">
        {file.error ? <ReadFailure error={file.error} /> : null}
        <div
          className={`mx-auto flex w-full items-start gap-12 px-8 py-7 ${
            outline.length > 0 ? "max-w-[1180px]" : "max-w-[900px]"
          }`}
        >
          {/* `--md-measure: 100%` hands the measure decision to this column,
              which the layout above already sized to about 90 characters. */}
          <div ref={proseRef} className="min-w-0 flex-1" style={{ "--md-measure": "100%" } as CSSProperties}>
            {text !== null ? <Markdown text={text} onNavigate={onOpenRelative} /> : null}
          </div>

          {outline.length > 0 ? (
            <nav
              aria-label="On this page"
              className="sticky top-0 hidden max-h-[78vh] w-[240px] shrink-0 overflow-y-auto border-l border-hairline pl-5 @[1000px]:block"
            >
              <p className="mb-2 text-meta text-t3">On this page</p>
              {outline.map((heading) => (
                <button
                  key={heading.id}
                  type="button"
                  title={heading.text}
                  onClick={() => document.getElementById(heading.id)?.scrollIntoView({ block: "start" })}
                  style={{ paddingLeft: (heading.level - 1) * 12 }}
                  className="block w-full truncate rounded-chip py-1 pr-1 text-left text-body text-t2 hover:bg-row-hover hover:text-accent"
                >
                  {heading.text}
                </button>
              ))}
            </nav>
          ) : null}
        </div>
      </div>
    </>
  );
}
