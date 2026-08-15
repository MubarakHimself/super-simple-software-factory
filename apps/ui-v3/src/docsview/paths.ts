/**
 * Pure path logic for the Docs surface - no fetch, no React, so it is cheap to
 * read in one sitting and cheap to get right.
 */

/** The URL a tree row or a relative link resolves to. Each segment is encoded
 * on its own so a literal `/` inside a filename can never be mistaken for a
 * path separator. */
export function docsHref(projectId: string, path: string): string {
  return `/p/${encodeURIComponent(projectId)}/docs/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/**
 * Resolves a markdown link's `href` against the document that contains it.
 * `../adws/lane_balancer.py` read from `docs/design/x.md` -> `adws/lane_balancer.py`.
 * A leading `/` is repo-root relative. Anchors and queries are dropped: they
 * address a position inside a document, not another document.
 *
 * Returns `null` for anything that is not a same-repo relative path (an
 * absolute URL, a mailto:, a bare `#anchor`, or a link that walks above the
 * repo root) - those are left for the browser's default handling instead of
 * being claimed here.
 */
/** `true` for a same-repo path a markdown link can reasonably point at:
 * neither a URL scheme (`https:`, `mailto:`), a protocol-relative `//host`,
 * nor a bare in-page `#anchor`. */
export function isRelativeHref(href: string): boolean {
  return !!href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//") && !href.startsWith("#");
}

export function resolveRelative(fromPath: string, href: string): string | null {
  if (!isRelativeHref(href)) return null;
  const bare = href.split("#")[0]!.split("?")[0]!;
  if (!bare.trim()) return null;
  const segments = bare.startsWith("/") ? bare.slice(1).split("/") : [...fromPath.split("/").slice(0, -1), ...bare.split("/")];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null; // walked above the repo root
      out.pop();
    } else out.push(segment);
  }
  return out.length > 0 ? out.join("/") : null;
}

/** `true` for the extensions the Reader renders through the markdown pipeline;
 * everything else is honestly plain text (see Reader.tsx). */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}
