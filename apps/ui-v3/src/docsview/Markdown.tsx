/**
 * The one markdown renderer this surface uses: `react-markdown` +
 * `remark-gfm`, styled by the `.reader-content` rules ported from
 * `docs-v3.html` (see `docs.css`). Two behaviors:
 *
 *  - GFM task lists render as real checkboxes and they are always disabled -
 *    Docs reads documents, it never writes one back.
 *  - `onNavigate` lets the reader claim a same-repo relative link instead of
 *    following it; an absolute or external link keeps the browser's default
 *    (a new tab), because this app never fetches anything a human did not ask
 *    for by opening a tree row.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isRelativeHref } from "./paths.ts";

export function Markdown({ text, onNavigate }: { text: string; onNavigate: (href: string) => void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        input: (props) => <input {...props} disabled readOnly />,
        a: ({ href, children, ...props }) => {
          const target = typeof href === "string" ? href : "";
          if (isRelativeHref(target)) {
            return (
              <a
                {...props}
                href={target}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(target);
                }}
              >
                {children}
              </a>
            );
          }
          return (
            <a {...props} href={target} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
