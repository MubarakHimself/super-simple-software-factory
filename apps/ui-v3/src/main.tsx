/**
 * Entry point.
 *
 * The stored appearance (theme, density, mono font, motion) is applied here,
 * synchronously, before the first `render()` — the one-line fix the
 * Appearance chunk's own file (`settings/appearance.ts`) asked the shell for:
 * six real themes now exist (`tokens.css`'s `:root[data-theme="…"]` blocks),
 * so applying the pick only once Settings has mounted would flash the
 * previous session's palette on every boot, most visibly on a light theme
 * loading over the dark default.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyAppearance, readAppearance } from "./settings/appearance.ts";
import { AppRoutes } from "./routes.tsx";
import "./tokens.css";
import "./shell.css";

applyAppearance(readAppearance());

const host = document.getElementById("root");
if (!host) throw new Error("#root is missing from index.html");

createRoot(host).render(
  <StrictMode>
    <AppRoutes />
  </StrictMode>,
);
