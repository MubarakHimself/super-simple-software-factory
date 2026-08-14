/**
 * Entry point. The theme was already applied by the inline bootstrap in
 * index.html (before first paint); this re-applies it so a manifest-less
 * "system" state is unambiguous and the module owns the class from here on.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, readTheme } from "./lib/theme.ts";
import { AppRoutes } from "./routes.tsx";
import "./tokens.css";

applyTheme(readTheme());

const host = document.getElementById("root");
if (!host) throw new Error("#root is missing from index.html");

createRoot(host).render(
  <StrictMode>
    <AppRoutes />
  </StrictMode>,
);
