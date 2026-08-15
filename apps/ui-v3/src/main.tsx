/**
 * Entry point. One skin, dark, exactly as the mocks draw it - there is no
 * theme bootstrap here because v3 has no light mode to flash into. (The
 * Appearance tab's named themes are the Settings chunk's, and they will swap
 * tokens, not stylesheets.)
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppRoutes } from "./routes.tsx";
import "./tokens.css";
import "./shell.css";

const host = document.getElementById("root");
if (!host) throw new Error("#root is missing from index.html");

createRoot(host).render(
  <StrictMode>
    <AppRoutes />
  </StrictMode>,
);
