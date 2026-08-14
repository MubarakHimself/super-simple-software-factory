import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Prints the one thing an operator needs to know before `ui2-dev` is useful. */
function devBanner(): Plugin {
  return {
    name: "sdl-ui2-dev-banner",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        console.log(
          "[ui2-dev] /api proxies to http://127.0.0.1:4700 - run `just ui2` in another terminal first",
        );
      });
    },
  };
}

// Spec section 4: "Vite dev server: 4720, proxying /api to 4700 (4710 belongs
// to v1's ui-dev)". 4700 keeps serving the API; only the static UI moves.
export default defineConfig({
  plugins: [react(), tailwindcss(), devBanner()],
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "./src") },
  },
  server: {
    host: "127.0.0.1",
    port: 4720,
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
