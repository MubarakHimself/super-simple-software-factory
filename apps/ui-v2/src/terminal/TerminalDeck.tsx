/**
 * Terminal (the KISS correction, `.scratch/app-v2/map.md`): the middle of the
 * app is a bare terminal, VS Code-style. A tab strip, a `+`, three word-links,
 * and a real shell in the project root. Nothing interprets what is typed in
 * it - no harness integration, no parsing, no capability flags, no
 * keybindings; every gesture here is a button or a word-link.
 *
 *   claude · codex · pi          types that command into the active shell
 *   [ Shell 1 ][ Shell 2 ] +     one tab per shell, x to close
 *
 * ── Why this component is mounted by App.tsx, not by a route ──────────────
 * Audit F2's lesson: backscroll that survives a tab switch but not a surface
 * switch is the v1 bug wearing new clothes. So the deck lives ABOVE the
 * surface switch - `App.tsx` keeps it mounted and hides it while another
 * surface is on screen. Going Terminal -> Board -> Terminal never unmounts an
 * xterm, never re-attaches a stream, and never drops a byte; and even a full
 * page reload comes back to the same shells, because the shells are the
 * server's (`server/app/terminals.ts`) and this only ever held a view of them.
 *
 * The shells are per project (the deck is keyed by project id), which is the
 * same rule the rest of the app follows: an action can never land on the
 * wrong project.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../lib/api.ts";
import { IconPlus } from "../shared/Icons.tsx";
import { TerminalPane } from "./TerminalPane.tsx";

interface TerminalSummary {
  id: string;
  projectId: string;
  cwd: string;
  shell: string;
  exited: boolean;
  started_at: string;
}

/** The provider harnesses, as four words. Clicking one types it into the active
 * shell and presses Enter - which is all "run claude here" has ever meant.
 * The app learns nothing about what happens next.
 *
 * `pi` is deliberately NOT one of them any more. pi is the factory's own coding
 * agent - the thing an ADW drives, with a roster, a lane and an envelope behind
 * it - not a provider the operator drops into a shell beside claude and codex.
 * It stays perfectly usable by typing it; it is simply not a quick-link, and
 * Settings > Roster is where the factory's use of it is actually configured.
 *
 * `agy` is Google's Antigravity CLI. Settings > Providers probes all four by
 * the same names, so a word that will fail in the pty is already visible as
 * `not on PATH` before it is clicked. */
const COMMANDS = ["claude", "codex", "grok", "agy"];

export function TerminalDeck({ projectId }: { projectId: string }) {
  const [tabs, setTabs] = useState<TerminalSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const opened = useRef(false);

  const open = useCallback(async () => {
    try {
      const created = await apiPost<TerminalSummary>("/api/app/terminals", { projectId });
      setTabs((current) => [...current, created]);
      setActive(created.id);
      setFailure(null);
    } catch (error) {
      setFailure((error as Error).message);
    }
  }, [projectId]);

  // Adopt whatever this project already has running, and open one shell if it
  // has none. Guarded by a ref rather than by the effect's own lifecycle:
  // StrictMode runs this twice in development, and the second run must not
  // spawn a second shell.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void (async () => {
      try {
        const existing = await apiGet<TerminalSummary[]>(
          `/api/app/terminals?project=${encodeURIComponent(projectId)}`,
        );
        if (existing.length > 0) {
          setTabs(existing);
          setActive(existing[0]!.id);
          return;
        }
      } catch (error) {
        setFailure((error as Error).message);
        return;
      }
      await open();
    })();
  }, [projectId, open]);

  const close = useCallback(async (id: string) => {
    setTabs((current) => {
      const remaining = current.filter((tab) => tab.id !== id);
      setActive((currentActive) => (currentActive === id ? (remaining[0]?.id ?? null) : currentActive));
      return remaining;
    });
    try {
      await apiPost(`/api/app/terminals/${encodeURIComponent(id)}/close`, {});
    } catch {
      /* the tab is gone from the strip either way; the shell dies with the
         server at the latest */
    }
  }, []);

  const type = useCallback(
    async (text: string) => {
      if (!active) return;
      try {
        await apiPost(`/api/app/terminals/${encodeURIComponent(active)}/input`, { text });
      } catch (error) {
        setFailure((error as Error).message);
      }
    },
    [active],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-menurow shrink-0 items-center gap-1 border-b border-hairline px-2">
        {tabs.map((tab, index) => (
          <span
            key={tab.id}
            className={`flex h-5 items-center gap-1.5 rounded-chip px-2 text-body ${
              tab.id === active ? "bg-row-active text-t1" : "text-t2 hover:bg-row-hover"
            }`}
          >
            <button type="button" onClick={() => setActive(tab.id)} title={tab.shell}>
              Shell {index + 1}
            </button>
            <button
              type="button"
              aria-label={`Close shell ${index + 1}`}
              onClick={() => void close(tab.id)}
              className="text-t3 hover:text-t1"
            >
              &times;
            </button>
          </span>
        ))}
        <button
          type="button"
          aria-label="New shell"
          onClick={() => void open()}
          className="flex size-row items-center justify-center rounded-chip text-t3 hover:bg-row-hover hover:text-t1"
        >
          <IconPlus className="size-3.5" />
        </button>

        <span className="ml-auto flex items-center gap-2">
          {COMMANDS.map((command) => (
            <button
              key={command}
              type="button"
              title={`types ${command} into this shell`}
              disabled={!active}
              onClick={() => void type(`${command}\r`)}
              className="rounded-chip px-1.5 font-mono text-mono text-t3 hover:bg-row-hover hover:text-accent disabled:opacity-40"
            >
              {command}
            </button>
          ))}
        </span>
      </header>

      {failure ? (
        <p className="flex items-baseline gap-2 border-b border-hairline px-3 py-1 text-meta text-t3">
          <span>terminal</span>
          <span className="font-mono text-mono text-fail">{failure}</span>
        </p>
      ) : null}

      <div className="min-h-0 flex-1">
        {tabs.map((tab) => (
          <TerminalPane key={tab.id} id={tab.id} visible={tab.id === active} />
        ))}
      </div>
    </div>
  );
}
