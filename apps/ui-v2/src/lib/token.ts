/**
 * The per-process CSRF token (spec 1.2). The server injects
 * `<script>window.__APP_TOKEN__="..."</script>` before `</head>` when it
 * serves `apps/ui-v2/dist/index.html` (spec 1.1 edit 3), so it exists in the
 * built app and is absent under `ui2-dev` (Vite serves its own index.html).
 * Reads never need it; writes without it get a 403, which is the correct
 * answer for a page the server did not serve.
 */
declare global {
  interface Window {
    __APP_TOKEN__?: string;
  }
}

export function appToken(): string | null {
  return typeof window.__APP_TOKEN__ === "string" ? window.__APP_TOKEN__ : null;
}
