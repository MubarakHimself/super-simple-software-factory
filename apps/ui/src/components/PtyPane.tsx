import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/** Shared with TerminalSurface's tab theme - one look for every pty pane in
 * the app (Terminal tabs, the Setup screen's embedded pty, a Deploy tab). */
export const XTERM_THEME = {
  background: "#0a0a0b",
  foreground: "#ededef",
  cursor: "#ededef",
  selectionBackground: "rgba(59, 130, 246, 0.35)",
  black: "#0a0a0b",
  brightBlack: "#6e6e76",
  white: "#ededef",
};

/**
 * One xterm.js instance wired to one main-process pty session over
 * `window.factory.term.*` (spec 3's IPC surface - the same one whether the
 * session was opened via a Terminal profile, `setup:run`, or
 * `server:deploy`; PtyPane only ever needs the sessionId back, never how it
 * was created). Mounts the xterm instance once per `sessionId` and disposes
 * it on unmount - callers that want a tab to survive being hidden (spec
 * 3.4's "switching tabs hides the DOM node but keeps the xterm object
 * alive") keep PtyPane mounted and toggle CSS display around it instead of
 * conditionally rendering it, exactly as TerminalSurface does.
 */
export function PtyPane({
  sessionId,
  onExit,
  scrollback = 5000,
  autoFocus = true,
}: {
  sessionId: string;
  onExit?: (exitCode: number) => void;
  scrollback?: number;
  autoFocus?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const node = containerRef.current;
    const factory = window.factory;
    if (!node || !factory) return;

    const term = new XTerm({
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      scrollback,
      theme: XTERM_THEME,
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    term.onData((data) => factory.term.input(sessionId, data));
    term.onResize(({ cols, rows }) => factory.term.resize(sessionId, cols, rows));

    const offData = factory.term.onData((id, chunk) => {
      if (id === sessionId) term.write(chunk);
    });
    const offExit = factory.term.onExit((id, exitCode) => {
      if (id === sessionId) onExitRef.current?.(exitCode);
    });
    // Subscriptions are live as of the two lines above - only now is it
    // safe to tell main "start streaming" (the pty data-race fix, spec 3.4
    // addendum). Anything main emitted before this moment (a spawn banner,
    // a not-found line, an exit for a dead profile) was buffered, never
    // lost, and arrives here as the very next term:data/term:exit event.
    factory.term.attach(sessionId);

    const doFit = () => {
      try {
        fit.fit();
      } catch {
        /* container not laid out yet, or the pty already exited (landmine
         * 2.4.1) - the next resize/layout pass catches it */
      }
    };
    requestAnimationFrame(() => {
      doFit();
      if (autoFocus) term.focus();
    });
    const observer = new ResizeObserver(doFit);
    observer.observe(node);

    return () => {
      offData();
      offExit();
      observer.disconnect();
      factory.term.close(sessionId);
      term.dispose();
    };
    // Deliberately keyed on sessionId alone: onExit is read through a ref
    // (onExitRef) precisely so a new callback identity on every render
    // never re-runs this effect and re-mounts the xterm instance.
  }, [sessionId, scrollback, autoFocus]);

  return <div ref={containerRef} className="h-full w-full" />;
}
