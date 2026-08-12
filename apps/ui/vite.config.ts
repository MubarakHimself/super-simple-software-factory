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
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
