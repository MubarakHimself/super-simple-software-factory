/**
 * The auto-save status bar's state (settings-v3.html draws the bar; there is no
 * Save button anywhere in Settings, by design).
 *
 * The mock's `markDirty()` fakes it: it flips to "Saving…" and back to "All
 * changes saved" on an 800ms timer whether or not anything was written. This
 * hook is the honest version - every state below corresponds to something that
 * actually happened:
 *
 *   idle    nothing has been changed on this pane yet
 *   saving  a request is in flight, named
 *   saved   the server accepted a write and said what changed (its own words)
 *   local   something was stored in this browser only - never called "saved"
 *   failed  the server refused, and its sentence is printed verbatim
 *
 * "local" exists because two things on these panes genuinely have nowhere on
 * disk to go this wave (the lane enable toggles, the appearance preferences).
 * Collapsing them into "saved" would be the exact lie the bar is here to avoid.
 */
import { useCallback, useMemo, useState } from "react";

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving"; what: string }
  | { kind: "saved"; sentence: string }
  | { kind: "local"; sentence: string }
  | { kind: "failed"; what: string; error: string };

export interface SaveReporter {
  state: SaveState;
  saving: (what: string) => void;
  saved: (sentence: string) => void;
  local: (sentence: string) => void;
  failed: (what: string, error: string) => void;
  reset: () => void;
}

export function useSaveReporter(): SaveReporter {
  const [state, setState] = useState<SaveState>({ kind: "idle" });

  const saving = useCallback((what: string) => setState({ kind: "saving", what }), []);
  const saved = useCallback((sentence: string) => setState({ kind: "saved", sentence }), []);
  const local = useCallback((sentence: string) => setState({ kind: "local", sentence }), []);
  const failed = useCallback((what: string, error: string) => setState({ kind: "failed", what, error }), []);
  const reset = useCallback(() => setState({ kind: "idle" }), []);

  return useMemo(
    () => ({ state, saving, saved, local, failed, reset }),
    [state, saving, saved, local, failed, reset],
  );
}

/** The bar's own line, for a given scope name. `idle` says what the pane will
 * do rather than claiming a save that never happened - and `idleText` lets the
 * surface say it per pane, because three of the five panes write nothing at all
 * and one blanket "edits save as you make them" would be false on those. */
export function saveLine(state: SaveState, scopeName: string, idleText?: string): { text: string; className: string } {
  switch (state.kind) {
    case "saving":
      return { text: `Saving ${state.what}…`, className: "dirty" };
    case "saved":
      return { text: state.sentence, className: "saved" };
    case "local":
      return { text: state.sentence, className: "saved" };
    case "failed":
      return { text: `${state.what} was not saved — ${state.error}`, className: "failed" };
    default:
      return {
        text: idleText ?? `Nothing changed yet — ${scopeName} scope. Edits save as you make them.`,
        className: "saved",
      };
  }
}
