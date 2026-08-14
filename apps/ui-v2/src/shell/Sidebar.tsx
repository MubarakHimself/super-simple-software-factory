/**
 * The sidebar (spec 2.1) - the only navigation in the app.
 *
 *   sdl-factory  v            project switcher: name + chevron
 *   Search                    the palette - a button, no key opens it
 *
 *   Terminal                  the shells (the KISS correction)
 *   Board                  3  counts render only when non-zero
 *   Runs                   1
 *   Gate
 *   Docs
 *   -
 *   Settings                  pinned bottom
 *
 * Text budget: 9 labels, ~14 words for the whole navigation surface. Every
 * label is sentence case and each noun is spelled here exactly as it is
 * spelled in the breadcrumb, the surface heading and the palette (spec 2.0).
 *
 * F12 is killed by naming each badge's quantity rather than by moving it:
 * three identical-looking badges carried three different quantities in v1, so
 * `Board` = N ready, `Runs` = N running, `Gate` = N waiting, each said in its
 * own `title` at zero on-screen text cost. A badge whose quantity cannot be
 * named in two words does not ship.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useShell } from "../App.tsx";
import { useResource } from "../lib/poll.ts";
import { Dot } from "../shared/Dot.tsx";
import {
  IconBoard,
  IconChevronDown,
  IconDocs,
  IconGate,
  IconPlus,
  IconRuns,
  IconSearch,
  IconSettings,
  IconTerminal,
} from "../shared/Icons.tsx";
import { Row } from "../shared/Row.tsx";

// The palette used to advertise a Ctrl/Cmd+K hint here. The KISS correction
// removed the binding, so the hint went with it: this button IS the way in.

interface NavItem {
  to: string;
  label: string;
  icon: typeof IconBoard;
  /** Which live count this row shows, and the two words that name it. */
  count?: (counts: { board_ready: number; runs_running: number; gate: number }) => number;
  countName?: string;
  /** Dimmed with tooltip `needs factory` when the project has no factory (spec 2.9). */
  needsFactory?: boolean;
}

const NAV: NavItem[] = [
  // Where Sessions used to be, and the only entry way that is left: a shell.
  { to: "terminal", label: "Terminal", icon: IconTerminal },
  { to: "board", label: "Board", icon: IconBoard, count: (c) => c.board_ready, countName: "ready", needsFactory: true },
  { to: "runs", label: "Runs", icon: IconRuns, count: (c) => c.runs_running, countName: "running", needsFactory: true },
  { to: "gate", label: "Gate", icon: IconGate, count: (c) => c.gate, countName: "waiting", needsFactory: true },
  { to: "docs", label: "Docs", icon: IconDocs },
];

export function Sidebar() {
  const { projectId, project, readiness, live, openPalette } = useShell();
  const navigate = useNavigate();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // The Settings dot (W3-D4). One read on shell mount - spec 2.8 is explicit
  // that providers refresh "on page open + explicit control; no background
  // poll". Until K2b serves this route it 404s and no dot renders, which is
  // the honest answer to "we have not probed anything yet".
  const providers = useResource<{ id: string; state: string }[]>("providers", "/api/app/providers");
  const notReady = (providers.data ?? []).filter((p) => p.state !== "ready");

  const factoryKnown = readiness.data !== null;
  const factoryAbsent = factoryKnown && !readiness.data!.factory.config;
  const counts = live.data?.counts ?? null;

  return (
    <aside className="flex h-full w-sidebar shrink-0 flex-col border-r border-hairline bg-chrome">
      <div className="relative px-1 pt-1">
        <div className="flex h-row items-center">
          <button
            type="button"
            onClick={() => navigate(`/p/${projectId}/home`)}
            title={project?.root ?? undefined}
            className="min-w-0 flex-1 truncate rounded-chip px-2 text-left text-head font-semibold text-t1 hover:bg-row-hover"
          >
            {project?.name ?? "…"}
          </button>
          <button
            type="button"
            aria-label="Switch project"
            aria-expanded={switcherOpen}
            onClick={() => setSwitcherOpen((open) => !open)}
            className="flex size-row items-center justify-center rounded-chip text-t3 hover:bg-row-hover hover:text-t1"
          >
            <IconChevronDown className="size-3" />
          </button>
        </div>
        {switcherOpen ? <ProjectSwitcher onClose={() => setSwitcherOpen(false)} /> : null}
      </div>

      <button
        type="button"
        onClick={() => openPalette("commands")}
        className="mx-2 mt-1 flex h-row items-center gap-2 rounded-control border border-hairline bg-raised px-2 text-body text-t3 hover:border-t3 hover:text-t2"
      >
        <IconSearch className="size-3.5" />
        <span>Search</span>
      </button>

      <nav className="mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {NAV.map((item) => {
          const dimmed = item.needsFactory === true && factoryAbsent;
          const count = counts && item.count ? item.count(counts) : 0;
          return (
            <NavRow
              key={item.to}
              to={`/p/${projectId}/${item.to}`}
              label={item.label}
              icon={<item.icon className="size-3.5" />}
              count={count}
              countTitle={count > 0 && item.countName ? `${count} ${item.countName}` : undefined}
              dimmed={dimmed}
            />
          );
        })}
      </nav>

      <div className="border-t border-hairline px-2 py-2">
        <NavRow
          to={`/p/${projectId}/settings`}
          label="Settings"
          icon={<IconSettings className="size-3.5" />}
          dot={notReady.length > 0 ? `${notReady.length} not ready` : undefined}
        />
      </div>
    </aside>
  );
}

function NavRow({
  to,
  label,
  icon,
  count = 0,
  countTitle,
  dimmed = false,
  dot,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  count?: number;
  countTitle?: string;
  dimmed?: boolean;
  dot?: string;
}) {
  if (dimmed) {
    // Non-interactive, tooltip only. No explanatory sentence in a sidebar,
    // ever (spec 2.9, audit F4's lesson).
    return (
      <span
        title="needs factory"
        aria-disabled="true"
        className="flex h-row cursor-default items-center gap-2 rounded-chip px-2 text-body text-t3 opacity-50"
      >
        {icon}
        <span>{label}</span>
      </span>
    );
  }
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex h-row items-center gap-2 rounded-chip px-2 text-body ${
          isActive ? "bg-row-active text-t1 shadow-[inset_2px_0_0_var(--accent)]" : "text-t2 hover:bg-row-hover hover:text-t1"
        }`
      }
    >
      {icon}
      <span>{label}</span>
      {dot ? (
        <span className="ml-auto" title={dot}>
          <Dot tone="accent" />
        </span>
      ) : null}
      {count > 0 ? (
        <span className="ml-auto font-mono text-meta tabular-nums text-t3" title={countTitle}>
          {count}
        </span>
      ) : null}
    </NavLink>
  );
}

/** name + chevron opens this; adding a project is its last row (spec 2.1). */
function ProjectSwitcher({ onClose }: { onClose: () => void }) {
  const { projects, projectId } = useShell();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="listbox"
      className="absolute inset-x-1 top-full z-30 mt-1 overflow-hidden rounded-control border border-hairline bg-overlay py-1 shadow-[var(--shadow-overlay)]"
    >
      {projects.map((p) => (
        <Row
          key={p.id}
          label={p.name}
          title={p.root}
          selected={p.id === projectId}
          onSelect={() => {
            onClose();
            navigate(`/p/${p.id}/home`);
          }}
        />
      ))}
      <div className="my-1 border-t border-hairline" />
      <Row
        icon={<IconPlus className="size-3.5" />}
        label="Add project"
        onSelect={() => {
          onClose();
          navigate("/add");
        }}
      />
    </div>
  );
}
