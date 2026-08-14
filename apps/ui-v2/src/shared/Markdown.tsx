/**
 * The one markdown renderer (spec 3.6: "one markdown renderer (Docs = card
 * inspector = brief)"). `react-markdown` + `remark-gfm`, styled by the `.md`
 * rules in tokens.css - the explicit verdict of
 * docs/research/shadcn-markdown-rendering.md for static trusted files.
 * Streamdown is reserved for streamed output and is not used here.
 *
 * Two behaviors the surfaces depend on:
 *  - GFM task lists render as REAL checkboxes and they are always disabled.
 *    Spec 2.4 / Open Decision 20: the UI never writes a card, and T3's
 *    write-on-tick is the one T3 behavior we deliberately refuse.
 *  - `onNavigate` lets Docs (W3-B2) claim relative `.md` links for in-app
 *    navigation. Absolute/external links keep their default behavior; nothing
 *    here fetches anything.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function isRelative(href: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//") && !href.startsWith("#");
}

export function Markdown({
  text,
  onNavigate,
  className = "",
}: {
  text: string;
  /** Called with a relative link target instead of following it. */
  onNavigate?: (href: string) => void;
  className?: string;
}) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          input: ({ ...props }) => <input {...props} disabled readOnly />,
          a: ({ href, children, ...props }) => {
            const target = typeof href === "string" ? href : "";
            if (onNavigate && target && isRelative(target)) {
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
    </div>
  );
}
