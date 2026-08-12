import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { navigate, surfacePath, type Surface } from "@/routes";
import { ActivityRail } from "@/components/ActivityRail";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Input } from "@/components/ui/input";

export interface PaletteItem {
  id: string;
  label: string;
  sublabel?: string;
}

const SURFACE_KEYS: Record<string, Surface> = { "1": "board", "2": "trace", "3": "gate", "4": "settings" };

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/**
 * The whole app frame (spec 5.1): 44px activity rail, 260px sidebar, flexible
 * main pane, optional 420px inspector. Owns the global keyboard shortcuts:
 * Ctrl+K opens a filter overlay over the sidebar (j/k or arrows navigate it,
 * Enter selects, Esc closes), 1..4 switch surface.
 */
export function Shell({
  active,
  counts,
  topBar,
  sidebar,
  inspector,
  paletteItems,
  onPaletteSelect,
  children,
}: {
  active: Surface;
  counts: Partial<Record<Surface, number>>;
  topBar: React.ReactNode;
  sidebar?: React.ReactNode;
  inspector?: React.ReactNode;
  paletteItems?: PaletteItem[];
  onPaletteSelect?: (id: string) => void;
  children: React.ReactNode;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (paletteOpen) return; // palette owns its own keys while open
      if (isTypingTarget(e.target)) return;
      const surface = SURFACE_KEYS[e.key];
      if (surface) navigate(surfacePath(surface));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas">
      {topBar}
      <div className="flex min-h-0 flex-1">
        <ActivityRail active={active} counts={counts} />
        <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1">
          {/* pixel sizes match spec 5.1 exactly: 260px sidebar, 420px inspector */}
          <ResizablePanel id="sidebar" defaultSize={260} minSize={180} maxSize={420} className="flex flex-col bg-chrome">
            {sidebar}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="main" minSize={320} className="flex min-w-0 flex-col bg-canvas">
            {children}
          </ResizablePanel>
          {inspector && (
            <>
              <ResizableHandle />
              <ResizablePanel id="inspector" defaultSize={420} minSize={280} maxSize={640} className="flex flex-col bg-chrome">
                {inspector}
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
      {paletteOpen && (
        <CommandPalette
          items={paletteItems ?? []}
          onSelect={(id) => {
            onPaletteSelect?.(id);
            setPaletteOpen(false);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}

function CommandPalette({
  items,
  onSelect,
  onClose,
}: {
  items: PaletteItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.label.toLowerCase().includes(q) || i.sublabel?.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => setIndex(0), [query]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "j" && e.ctrlKey)) {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp" || (e.key === "k" && e.ctrlKey)) {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const item = filtered[index];
      if (item) onSelect(item.id);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-24" onClick={onClose}>
      <div
        className="flex max-h-[60vh] w-[420px] flex-col overflow-hidden rounded-md border border-border bg-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
          <Search className="size-3.5 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Filter runs or queue items..."
            className="h-6 border-none px-0 focus-visible:ring-0"
          />
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">no matches</div>
          )}
          {filtered.map((item, i) => (
            <button
              key={item.id}
              type="button"
              onMouseEnter={() => setIndex(i)}
              onClick={() => onSelect(item.id)}
              className={`flex w-full flex-col px-2.5 py-1.5 text-left ${i === index ? "bg-elevated-hover" : ""}`}
            >
              <span className="mono text-[11.5px] text-foreground">{item.label}</span>
              {item.sublabel && <span className="truncate text-[10.5px] text-muted-foreground">{item.sublabel}</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-border px-2.5 py-1.5 text-[10px] text-muted-foreground">
          <Keycap label="Navigate">^ v</Keycap>
          <Keycap label="Select">Enter</Keycap>
          <Keycap label="Close">Esc</Keycap>
        </div>
      </div>
    </div>
  );
}

function Keycap({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <span className="mono rounded-sm border border-border bg-canvas px-1 py-0.5">{children}</span>
      <span>{label}</span>
    </span>
  );
}
