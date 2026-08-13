import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Setup's own tiny, separate build (spec 4.3: "its own tiny bundle ... no
 * server, no network"). A second, independent Vite config rather than a
 * second entry in vite.config.ts because `base` is build-wide, not
 * per-entry, and the two pages need opposite bases:
 *
 *   index.html - absolute paths ("/assets/..."), because the Bun server's
 *   SPA fallback serves index.html's bytes for ANY unmatched path (deep
 *   client routes like /trace/<id>), so its asset urls must resolve to the
 *   domain root regardless of how many path segments the current url has.
 *
 *   setup.html - relative paths ("./assets/..."), because it is loaded via
 *   a plain file:// url (electron/main.ts's enterSetup()) with no server
 *   underneath it - an absolute "/assets/x.js" would resolve against the
 *   filesystem root and 404.
 *
 * SETUP.HTML SURVIVAL (spec 4.3 changelog - this used to be wrong): output
 * used to land in the SAME dist/ as the main build (emptyOutDir: false, run
 * after `vite build`). That made survival an ORDERING contract - fine for
 * `just app`/`app-build`, which always run both builds in order, but `just
 * ui` (spec: "unchanged", section 0) runs ONLY vite.config.ts's build, and
 * THAT config's `emptyOutDir: true` wipes the whole dist/ directory first -
 * including whatever setup.html this build had previously placed there. So
 * running `just ui` after `just app` silently deleted the Setup page.
 * Setup now owns dist-setup/, a directory neither `just ui` nor
 * vite.config.ts's build ever touches - `emptyOutDir: true` here is safe
 * because it only ever empties Setup's own directory. `just ui` and
 * `just app` can now run in either order, any number of times, and each
 * rebuilds only what it owns.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
      "@shared": resolve(import.meta.dirname, "./shared"),
    },
  },
  base: "./",
  build: {
    outDir: "dist-setup",
    emptyOutDir: true,
    rollupOptions: {
      input: { setup: resolve(import.meta.dirname, "setup.html") },
    },
  },
});
