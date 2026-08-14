/**
 * The palette (spec 2.1) - one overlay, three modes, keyed by mode:
 * commands (no prefix) / go-to-file (`@`) / search (`?`).
 *
 * Keying by mode is the structural fix for audit F8: the commands mode always
 * has content, so the palette can never open empty. `@` is the same character
 * the composer uses to mention a file (spec 2.3), so the operator learns one
 * gesture, not two.
 *
 * Row geometry is identical to the slash menu because it IS the slash menu's
 * row - `shared/Row.tsx`, one component for palette, slash menu and ask card
 * (spec 3.6). Gestures are discoverable in the footer only; there is no
 * keybindings surface (ratified out, W3-C5).
 *
 * There is no keybinding that opens this: the sidebar's `Search` button is the
 * one way in (the KISS correction - buttons and word-links only). Arrows,
 * Enter and Escape work inside the open field, which is what a search field
 * does, not a command bound to a key.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useShell, type PaletteMode } from "../App.tsx";
import { apiGet } from "../lib/api.ts";
import { setTheme } from "../lib/theme.ts";
import { IconChevronDown, IconFile, IconPlus, IconSearch } from "../shared/Icons.tsx";
import { Row } from "../shared/Row.tsx";
import { SURFACE_NOUN } from "./TopBar.tsx";

const FILE_DEBOUNCE_MS = 120; // spec 1.3: 120ms client debounce on /api/app/files
const MAX_ROWS = 50;

interface Entry {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  run: () => void;
}

function seedFor(mode: PaletteMode): string {
  return mode === "files" ? "@" : mode === "search" ? "?" : "";
}

export function Palette({ mode }: { mode: PaletteMode }) {
  const shell = useShell();
  const { paletteOpen, closePalette, projectId, toggleSidebar } = shell;
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (!paletteOpen) return;
    setQuery(seedFor(mode));
    setCursor(0);
    // Focus after the overlay paints so the caret lands in the input.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [paletteOpen, mode]);

  const activeMode: PaletteMode = query.startsWith("@") ? "files" : query.startsWith("?") ? "search" : "commands";
  const term = activeMode === "commands" ? query : query.slice(1);

  const commands = useCommands(shell, navigate, closePalette, toggleSidebar);
  const remote = useRemoteRows(activeMode, projectId, term, closePalette, navigate);

  const rows = useMemo<Entry[]>(() => {
    if (activeMode !== "commands") return remote.rows.slice(0, MAX_ROWS);
    const needle = term.trim().toLowerCase();
    const matched = needle
      ? commands.filter((c) => `${c.label} ${c.description ?? ""}`.toLowerCase().includes(needle))
      : commands;
    return matched.slice(0, MAX_ROWS);
  }, [activeMode, remote.rows, commands, term]);

  useEffect(() => setCursor(0), [query]);

  if (!paletteOpen) return null;

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => (rows.length === 0 ? 0 : (c + 1) % rows.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => (rows.length === 0 ? 0 : (c - 1 + rows.length) % rows.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      rows[cursor]?.run();
    }
  };

  const placeholder =
    activeMode === "files" ? "Go to file" : activeMode === "search" ? "Search docs" : "Type a command";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePalette();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Palette"
        className="mt-[11vh] w-[640px] max-w-[92vw] overflow-hidden rounded-control border border-hairline bg-overlay shadow-[var(--shadow-overlay)]"
      >
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <IconSearch className="size-3.5 text-t3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            spellCheck={false}
            className="w-full bg-transparent text-head text-t1 outline-none placeholder:text-t3"
          />
        </div>

        <div role="listbox" className="max-h-[46vh] overflow-y-auto py-1">
          {rows.map((entry, index) => (
            <Row
              key={entry.id}
              icon={entry.icon}
              label={entry.label}
              description={entry.description}
              selected={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onSelect={entry.run}
            />
          ))}
          {rows.length === 0 && remote.error ? (
            <p className="flex items-baseline gap-2 px-3 py-1 text-meta text-t3">
              <span>read failed</span>
              <span className="font-mono text-mono text-fail">{remote.error}</span>
            </p>
          ) : null}
          {rows.length === 0 && !remote.error ? <p className="px-3 py-1 text-meta text-t3">No matches.</p> : null}
        </div>

        <footer className="flex items-center gap-4 border-t border-hairline bg-chrome px-3 py-1.5 text-meta text-t3">
          <Legend cap="↑↓" word="move" />
          <Legend cap="↵" word="open" />
          <Legend cap="esc" word="close" />
          <Legend cap="@" word="files" />
          <Legend cap="?" word="docs" />
        </footer>
      </div>
    </div>
  );
}

function Legend({ cap, word }: { cap: string; word: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <b className="rounded-chip border border-hairline px-1 font-mono text-meta font-normal text-t3">{cap}</b>
      {word}
    </span>
  );
}

/** Commands mode: navigation, the entry ways, appearance, and the projects
 * themselves. It always has content - that is what stops F8 from returning. */
function useCommands(
  shell: ReturnType<typeof useShell>,
  navigate: ReturnType<typeof useNavigate>,
  close: () => void,
  toggleSidebar: () => void,
): Entry[] {
  const { projectId, projects, readiness } = shell;
  return useMemo<Entry[]>(() => {
    const go = (path: string) => () => {
      close();
      navigate(path);
    };
    const factoryKnown = readiness.data !== null;
    const factoryAbsent = factoryKnown && !readiness.data!.factory.config;

    const surfaces: Entry[] = (["home", "terminal", "board", "runs", "gate", "docs", "settings"] as const)
      .filter((key) => !(factoryAbsent && (key === "board" || key === "runs" || key === "gate")))
      .map((key) => ({
        id: `go:${key}`,
        label: SURFACE_NOUN[key]!,
        run: go(`/p/${projectId}/${key}`),
      }));

    // The entry ways are gone with the composer (the KISS correction): the
    // only way in is a shell, and the Terminal row above is the way to it.
    return [
      ...surfaces,
      { id: "add-project", label: "Add project", icon: <IconPlus className="size-3.5" />, run: go("/add") },
      ...projects
        .filter((p) => p.id !== projectId)
        .map<Entry>((p) => ({
          id: `project:${p.id}`,
          label: p.name,
          description: p.root,
          icon: <IconChevronDown className="size-3.5" />,
          run: go(`/p/${p.id}/home`),
        })),
      { id: "theme-light", label: "Light theme", run: () => { setTheme("light"); close(); } },
      { id: "theme-dark", label: "Dark theme", run: () => { setTheme("dark"); close(); } },
      { id: "theme-system", label: "System theme", run: () => { setTheme("system"); close(); } },
      { id: "toggle-sidebar", label: "Toggle sidebar", run: () => { toggleSidebar(); close(); } },
    ];
  }, [projectId, projects, readiness.data, navigate, close, toggleSidebar]);
}

/**
 * The two server-backed modes. Both routes belong to K2b; until they exist the
 * fetch fails and the palette shows the server's own error string rather than
 * an empty list pretending the project has no files.
 */
function useRemoteRows(
  mode: PaletteMode,
  projectId: string,
  term: string,
  close: () => void,
  navigate: ReturnType<typeof useNavigate>,
): { rows: Entry[]; error: string | null } {
  const [paths, setPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "commands") {
      setPaths([]);
      setError(null);
      return;
    }
    if (term.trim().length === 0) {
      setPaths([]);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const url =
        mode === "files"
          ? `/api/app/files?project=${encodeURIComponent(projectId)}&q=${encodeURIComponent(term)}&limit=80`
          : `/api/app/p/${encodeURIComponent(projectId)}/docs/search?q=${encodeURIComponent(term)}`;
      try {
        const data = await apiGet<unknown>(url, controller.signal);
        setPaths(toPaths(data));
        setError(null);
      } catch (failure) {
        if ((failure as Error).name === "AbortError") return;
        setPaths([]);
        setError((failure as Error).message);
      }
    }, FILE_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [mode, projectId, term]);

  const rows = useMemo<Entry[]>(
    () =>
      paths.map((path) => ({
        id: `path:${path}`,
        label: path.split(/[\\/]/).pop() ?? path,
        description: path,
        icon: <IconFile className="size-3.5" />,
        run: () => {
          close();
          // Docs is the app's only file reader (spec 2.7); its route is
          // deep-linkable by path, which is what makes go-to-file possible
          // at all (W3-B2).
          navigate(`/p/${projectId}/docs/${path.split(/[\\/]/).map(encodeURIComponent).join("/")}`);
        },
      })),
    [paths, projectId, close, navigate],
  );

  return { rows, error };
}

/** Both endpoints answer with paths; neither shape is invented here. */
function toPaths(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => (typeof item === "string" ? item : ((item as { path?: unknown })?.path as string | undefined)))
    .filter((value): value is string => typeof value === "string");
}
