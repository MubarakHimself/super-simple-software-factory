/**
 * One shell, one xterm. Bytes in over SSE, keystrokes out over POST.
 *
 * This pane keeps NO scrollback of its own, on purpose. The server's ring
 * buffer is the backscroll and it replays in full on every attach, so the
 * copy the operator sees after Terminal -> Board -> Terminal is the only copy
 * that was ever complete. A client-side cache here would hide a broken replay
 * instead of proving a working one (audit F2).
 *
 * The deck keeps every pane mounted and hides the inactive ones, so switching
 * tabs or surfaces never remounts an xterm and never re-attaches a stream. A
 * hidden pane measures 0x0, which is why every fit goes through `refit()`'s
 * size check - fitting to nothing would resize the shell to nothing.
 */
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { apiPost } from "../lib/api.ts";

/** The ANSI names xterm wants, in ANSI order - the same order `--ansi` lists
 * its sixteen colors in (tokens.css). */
const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/**
 * Read from the live tokens rather than restated here, so the terminal is the
 * same colors as the surface behind it in every theme (spec 3.2) - and so a
 * theme switch repaints the shell without a reload.
 *
 * Until the 2026-08-14 layout pass this returned four colors and left the
 * sixteen ANSI slots to xterm's own defaults, which is why `git status` and a
 * pytest summary came out in the browser's stock red and green against this
 * app's palette. The sixteen now come from `--ansi`, one comma-separated list
 * per theme; a malformed or absent list leaves xterm's defaults alone rather
 * than half a palette.
 */
function readTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const base: Record<string, string> = {
    background: read("--canvas", "#0a0a0b"),
    foreground: read("--t1", "#ededef"),
    cursor: read("--accent", "#f59e0b"),
    cursorAccent: read("--canvas", "#0a0a0b"),
    selectionBackground: read("--row-active", "rgba(255,255,255,0.07)"),
  };
  const ansi = read("--ansi", "")
    .split(",")
    .map((color) => color.trim())
    .filter(Boolean);
  if (ansi.length !== ANSI_NAMES.length) return base as ITheme;
  ANSI_NAMES.forEach((name, index) => {
    base[name] = ansi[index]!;
  });
  return base as ITheme;
}

export function TerminalPane({ id, visible }: { id: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<{ term: XTerm; fit: FitAddon; refit: () => void } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [exited, setExited] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 14,
      lineHeight: 1.3,
      cursorBlink: true,
      convertEol: false,
      theme: readTheme(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const refit = () => {
      // A hidden pane has no size; fitting to it would resize the shell to
      // one column and reflow everything the operator has on screen.
      if (host.clientWidth < 2 || host.clientHeight < 2) return;
      fit.fit();
      void apiPost(`/api/app/terminals/${encodeURIComponent(id)}/resize`, { cols: term.cols, rows: term.rows }).catch(
        () => {
          /* a refused resize changes nothing the operator can act on */
        },
      );
    };
    liveRef.current = { term, fit, refit };
    refit();

    // ── keystrokes out, one at a time ────────────────────────────────────
    // Serialized on purpose: two keystrokes in two concurrent POSTs can reach
    // the pty out of order, and a terminal that transposes your typing is
    // worse than a slow one.
    let pending = "";
    let inFlight = false;
    let refused = false;
    const drain = async () => {
      if (inFlight || refused || pending.length === 0) return;
      inFlight = true;
      const text = pending;
      pending = "";
      try {
        await apiPost(`/api/app/terminals/${encodeURIComponent(id)}/input`, { text });
      } catch (error) {
        refused = true;
        term.options.disableStdin = true;
        setFailure((error as Error).message);
      } finally {
        inFlight = false;
        void drain();
      }
    };
    const typed = term.onData((data) => {
      pending += data;
      void drain();
    });

    const observer = new ResizeObserver(() => refit());
    observer.observe(host);

    const themeWatch = new MutationObserver(() => {
      term.options.theme = readTheme();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    // ── bytes in ─────────────────────────────────────────────────────────
    const controller = new AbortController();
    let cancelled = false;

    const read = async () => {
      try {
        const res = await fetch(`/api/app/terminals/${encodeURIComponent(id)}/raw`, {
          signal: controller.signal,
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok) {
          let message = `${res.status} ${res.statusText}`.trim();
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body?.error === "string" && body.error.trim()) message = body.error;
          } catch {
            /* the status line is what the server said */
          }
          if (!cancelled) setFailure(message);
          return;
        }
        if (!res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let split: number;
          while ((split = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const event = JSON.parse(line.slice(5).trim()) as
                  | { kind: "data"; chunk: string }
                  | { kind: "exit"; code: number };
                if (event.kind === "data") term.write(event.chunk);
                else if (!cancelled) setExited(event.code);
              } catch {
                /* a torn frame - the next carries its own payload */
              }
            }
          }
        }
      } catch (error) {
        // An aborted read is this pane unmounting, not a failure to report:
        // Chrome surfaces a mid-body abort as a bare `TypeError: Failed to
        // fetch`, so the signal is the reliable test.
        if (cancelled || controller.signal.aborted || (error as Error).name === "AbortError") return;
        setFailure((error as Error).message);
      }
    };
    void read();

    return () => {
      cancelled = true;
      controller.abort();
      typed.dispose();
      observer.disconnect();
      themeWatch.disconnect();
      liveRef.current = null;
      term.dispose();
    };
  }, [id]);

  // Becoming visible again is the one moment a hidden pane can finally
  // measure itself.
  useEffect(() => {
    if (!visible) return;
    const live = liveRef.current;
    if (!live) return;
    live.refit();
    live.term.focus();
  }, [visible]);

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ display: visible ? undefined : "none" }}>
      {/* `data-pty` marks the pane as a real shell. It used to be what the
          shell's Ctrl+K handler yielded to; that binding is gone (the KISS
          correction: no keybindings anywhere), so the attribute is now just
          the honest name for what this element is. */}
      <div data-pty ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-4 py-3" />
      {exited !== null ? (
        <p className="border-t border-hairline px-3 py-1 text-meta text-t3">
          Ended &middot; exit <span className="font-mono text-mono">{exited}</span>
        </p>
      ) : null}
      {failure ? (
        <p className="flex items-baseline gap-2 border-t border-hairline px-3 py-1 text-meta text-t3">
          <span>terminal</span>
          <span className="font-mono text-mono text-fail">{failure}</span>
        </p>
      ) : null}
    </div>
  );
}
