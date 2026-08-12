import { useEffect, useState } from "react";

export type Surface = "trace" | "board" | "gate" | "settings";

export interface RouteState {
  surface: Surface;
  adwId: string | null;
}

const SURFACES: Surface[] = ["trace", "board", "gate", "settings"];

function parse(pathname: string): RouteState {
  const parts = pathname.split("/").filter(Boolean);
  const first = parts[0];
  if (first && (SURFACES as string[]).includes(first) && first !== "trace") {
    return { surface: first as Surface, adwId: null };
  }
  if (first === "trace") return { surface: "trace", adwId: parts[1] ?? null };
  return { surface: "trace", adwId: null };
}

/** Client-side navigation, no framework: pushState + a popstate broadcast so
 * every mounted useRoute() picks it up (spec keeps deps to the framework
 * plus `yaml` - no router package). */
export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): RouteState {
  const [state, setState] = useState<RouteState>(() => parse(window.location.pathname));
  useEffect(() => {
    const onPop = () => setState(parse(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return state;
}

export function tracePath(adwId?: string | null): string {
  return adwId ? `/trace/${encodeURIComponent(adwId)}` : "/trace";
}

export const boardPath = "/board";
export const gatePath = "/gate";
export const settingsPath = "/settings";

export function surfacePath(surface: Surface): string {
  switch (surface) {
    case "board":
      return boardPath;
    case "gate":
      return gatePath;
    case "settings":
      return settingsPath;
    case "trace":
      return "/trace";
  }
}
