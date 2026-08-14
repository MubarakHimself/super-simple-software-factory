/**
 * Density - the second half of Appearance (spec 2.8), built as the exact twin
 * of `lib/theme.ts` so there is one mental model for "a machine-scoped look
 * preference", not two.
 *
 * Two states. `compact` is spec 3.4's own geometry and stamps nothing on
 * `<html>`; `comfortable` stamps `density-comfortable`, which `density.css`
 * turns into taller rows.
 *
 * **Where it is stored, and why that is a departure worth naming.** Spec 2.8
 * says "Theme in localStorage; everything else app-owned in the manifest".
 * There is no manifest-write endpoint for `ui:{}` in v1 - `/api/app/projects`
 * POST is the only write the app plane exposes besides the two init jobs - so
 * a manifest-backed density would be a control that silently forgets. It
 * lives in localStorage beside the theme instead, which is honest today and a
 * one-line move when the endpoint lands.
 *
 * The class is applied at module load, not on Settings' first render: the
 * Settings surface is a lazy chunk, so a preference applied only there would
 * miss every other route. `init/InitActions.tsx` - the one component in this
 * chunk the shell mounts on every route - imports this module for that
 * effect.
 */
import { useCallback, useEffect, useState } from "react";
import "./density.css";

export type Density = "compact" | "comfortable";

const KEY = "sdl-factory.density";
const CHANGED = "sdl-factory:density";

export function readDensity(): Density {
  try {
    return localStorage.getItem(KEY) === "comfortable" ? "comfortable" : "compact";
  } catch {
    return "compact";
  }
}

export function applyDensity(density: Density): void {
  const root = document.documentElement;
  root.classList.toggle("density-comfortable", density === "comfortable");
  try {
    if (density === "compact") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, density);
  } catch {
    /* private mode or a read-only profile - the choice still applies to this tab */
  }
}

export function setDensity(density: Density): void {
  applyDensity(density);
  window.dispatchEvent(new CustomEvent<Density>(CHANGED, { detail: density }));
}

export function useDensity(): [Density, (next: Density) => void] {
  const [density, setLocal] = useState<Density>(readDensity);
  useEffect(() => {
    const onChange = (event: Event) => setLocal((event as CustomEvent<Density>).detail);
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, []);
  return [density, useCallback((next: Density) => setDensity(next), [])];
}

applyDensity(readDensity());
