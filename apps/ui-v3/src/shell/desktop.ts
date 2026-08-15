/**
 * The desktop bridge, as the renderer sees it.
 *
 * `window.factory` exists only inside the Electron shell (see
 * `apps/ui/electron/preload.cts`). In a browser tab — `just ui3`, `just
 * ui3-dev` — it is simply absent, and every caller here has to say what it
 * does instead. That is the whole point of this file: one place that answers
 * "can this machine do the native thing?", so no component guesses.
 *
 * Nothing here throws for the browser case. A missing bridge is a fact about
 * where the app is running, not a failure.
 */
export interface FolderPick {
  canceled: boolean;
  path: string | null;
}

interface FactoryBridge {
  isDesktop?: true;
  pickFolder?: () => Promise<FolderPick>;
}

declare global {
  interface Window {
    factory?: FactoryBridge;
  }
}

/** True only when the running shell can open the OS directory dialog. */
export function canPickFolder(): boolean {
  return typeof window.factory?.pickFolder === "function";
}

/** Opens the native folder picker. The caller must have checked
 * `canPickFolder()` first; calling it in a browser resolves as a cancel rather
 * than rejecting, so a mis-wired caller cannot produce a stuck spinner. */
export async function pickFolder(): Promise<FolderPick> {
  const pick = window.factory?.pickFolder;
  if (!pick) return { canceled: true, path: null };
  return pick();
}
