import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Prints the one thing an operator needs to know before `ui-dev` is useful. */
function devBanner(): Plugin {
  return {
    name: "sssf-dev-banner",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        console.log(
          "[ui-dev] /api proxies to http://127.0.0.1:4700 - run `just ui` in another terminal first",
        );
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), devBanner()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
      "@shared": resolve(import.meta.dirname, "./shared"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4710,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4700",
        changeOrigin: false,
      },
    },
  },
  // Absolute asset paths (Vite's default base "/"), unchanged: server/
  // index.ts's serveStatic() falls back to index.html for ANY unmatched
  // path (deep client-side routes like /trace/<id>), so index.html's own
  // asset urls must resolve to the domain root regardless of how many path
  // segments the current URL has - only an absolute base does that.
  // setup.html (spec 4.3's separate loadFile() page) needs the OPPOSITE -
  // relative paths, since it is loaded via a plain file:// url with no
  // server underneath it at all - see vite.setup.config.ts, a second,
  // independent build for that one page (Vite's `base` is build-wide, not
  // per-entry, so it cannot live in this same config) with its OWN outDir
  // (dist-setup/, spec 4.3 changelog) - this build's emptyOutDir:true only
  // ever empties dist/, so `just ui` (this config alone) can never take
  // Setup's build down with it.
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
