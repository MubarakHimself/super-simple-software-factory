import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Prints the one thing an operator needs to know before `ui3-dev` is useful. */
function devBanner(): Plugin {
  return {
    name: "sdl-ui3-dev-banner",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        console.log(
          "[ui3-dev] /api proxies to http://127.0.0.1:4700 - run `just ui3` in another terminal first",
        );
      });
    },
  };
}

// Ports, one per UI generation, so three dev servers can run side by side:
// 4710 is v1's `ui-dev`, 4720 is v2's `ui2-dev`, 4730 is this one. 4700 keeps
// serving the API in every case; only the static UI moves.
//
// No Tailwind, no component library: the v3 mocks are plain CSS and are ported
// as plain CSS (src/tokens.css + src/shell.css). Adding a styling framework
// here would put a second vocabulary between the mocks and the screen.
export default defineConfig({
  plugins: [react(), devBanner()],
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "./src") },
  },
  server: {
    host: "127.0.0.1",
    port: 4730,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4700", changeOrigin: false },
    },
  },
  // Absolute asset paths (Vite's default base "/"): the server falls back to
  // index.html for any unmatched path, so a deep route like
  // /p/<id>/docs/docs/day-one.md must still resolve its assets from the root.
  build: { outDir: "dist", emptyOutDir: true },
});
