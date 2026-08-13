import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PtyPane } from "@/components/PtyPane";
import { drainAndSubscribeExternalSessions } from "@/lib/terminalBus";

/** Fixed profile table (spec 3.3), display order matches the spec's table.
 * The renderer only ever names a profileId - main matches it against its
 * OWN fixed table and resolves the real command; this list exists purely
 * to draw four buttons, never to construct a command line. */
const PROFILES: { id: string; label: string }[] = [
  { id: "shell", label: "Shell" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "pi" },
];

interface TabState {
  id: string;
  label: string;
  running: boolean;
}

/** The fifth surface (spec 3): tabbed ptys owned by the Electron main
 * process, xterm.js in the renderer. In a plain browser `window.factory` is
 * undefined and this renders the real desktop-only empty state (spec 3.6) -
 * never a dead button, never a fake terminal (MAP rule 6). */
export function TerminalSurface() {
  if (typeof window === "undefined" || window.factory?.isDesktop !== true) {
    return (
      <div className="flex h-full items-center justify-center p-10">
        <div className="max-w-[480px] text-center">
          <div className="mb-2 text-[13px] font-semibold text-foreground">Terminal is desktop-only.</div>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Terminals run in the SDL Factory desktop app, never in this read-only web UI. Open the desktop app to use
            them.
          </p>
        </div>
      </div>
    );
  }
  return <DesktopTerminalSurface />;
}

function nextLabel(existing: TabState[], base: string): string {
  const taken = new Set(existing.map((t) => t.label));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

function DesktopTerminalSurface() {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Sessions opened elsewhere (spec 5.2's Deploy button, via
  // window.factory.server.deploy()) show up here as a real tab - a session
  // announced while this surface was unmounted (every surface fully
  // unmounts on nav) is queued and drained on the next mount.
  useEffect(() => {
    return drainAndSubscribeExternalSessions(({ sessionId, label }) => {
      setTabs((prev) => {
        if (prev.some((t) => t.id === sessionId)) return prev;
        return [...prev, { id: sessionId, label: nextLabel(prev, label), running: true }];
      });
      setActiveId(sessionId);
    });
  }, []);

  const openTab = useCallback(async (profileId: string, label: string) => {
    const { sessionId } = await window.factory!.term.open(profileId);
    setTabs((prev) => [...prev, { id: sessionId, label, running: true }]);
    setActiveId(sessionId);
  }, []);

  // PtyPane's own unmount effect calls window.factory.term.close() and
  // disposes its xterm instance - removing the tab here is the only thing
  // this needs to do; there is no separate close() call to duplicate.
  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveId((current) => (current === id ? (next[next.length - 1]?.id ?? null) : current));
      return next;
    });
  }, []);

  const markExited = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, running: false } : t)));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-chrome px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveId(tab.id)}
              className={cn(
                "group flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-2 text-[11px]",
                activeId === tab.id ? "bg-elevated text-foreground" : "text-muted-foreground hover:bg-elevated-hover",
                !tab.running && "opacity-50",
              )}
            >
              <span className="mono">{tab.label}</span>
              <span
                role="button"
                aria-label={`close ${tab.label}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="opacity-0 group-hover:opacity-100"
              >
                <X className="size-3" />
              </span>
            </button>
          ))}
          {tabs.length === 0 && (
            <span className="px-1.5 text-[11px] text-muted-foreground">no terminals open</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-l border-border pl-1.5">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => void openTab(p.id, nextLabel(tabs, p.label))}
              className="mono h-6 rounded-sm px-2 text-[11px] text-muted-foreground hover:bg-elevated-hover hover:text-foreground"
            >
              + {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-canvas">
        {tabs.length === 0 && (
          <div className="flex h-full items-center justify-center p-10">
            <p className="max-w-[420px] text-center text-[12px] leading-relaxed text-muted-foreground">
              No terminals open. Pick a profile above - Shell, Claude, Codex, or pi - to start one in the repo root.
            </p>
          </div>
        )}
        {/* Every open tab's PtyPane stays mounted the whole time (spec 3.4:
            switching tabs hides the DOM node but keeps the xterm object
            alive, so backscroll survives a tab switch with no buffering on
            our side) - only CSS display toggles which one is visible. */}
        {tabs.map((tab) => (
          <div key={tab.id} className="absolute inset-0 p-1.5" style={{ display: activeId === tab.id ? "block" : "none" }}>
            <PtyPane sessionId={tab.id} onExit={() => markExited(tab.id)} />
          </div>
        ))}
      </div>
    </div>
  );
}
