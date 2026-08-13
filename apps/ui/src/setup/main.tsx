import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SetupScreen } from "@/components/SetupScreen";
import "@/lib/tokens.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    <SetupScreen />
  </StrictMode>,
);
