import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffScope, Event, Phase, QueueItem, SessionSummary } from "@shared/types";
import { api } from "@/lib/api";
import { usePoll } from "@/lib/poll";
import { navigate, tracePath, useRoute, type Surface } from "@/routes";
import { Shell, type PaletteItem } from "@/components/Shell";
import { TopBar } from "@/components/TopBar";
import { Sidebar } from "@/components/Sidebar";
import { RunList } from "@/components/RunList";
import { RunHeader } from "@/components/RunHeader";
import { PhaseTimeline } from "@/components/PhaseTimeline";
import { WorkLog } from "@/components/WorkLog";
import { Inspector } from "@/components/Inspector";
import { EmptyState } from "@/components/EmptyState";
import { BoardColumns } from "@/components/BoardColumns";
import { GateCard } from "@/components/GateCard";
import { SettingsPanes } from "@/components/SettingsPanes";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

function LoadingRows() {
  return (
    <div className="space-y-2 p-4">
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Cursor-polled event tail for one session: fetched at `poll_ms` while
 * running, once more when a run finishes, then left alone (spec 4). */
function useEventStream(adwId: string | null, running: boolean, pollMs: number): Event[] {
  const [events, setEvents] = useState<Event[]>([]);
  const cursorRef = useRef(0);

  useEffect(() => {
    setEvents([]);
    cursorRef.current = 0;
  }, [adwId]);

  useEffect(() => {
    if (!adwId) return;
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      // The pause-on-hidden rule (spec 4) governs the repeating LIVE poll of
      // a running session, never a finished session's one-shot backfill -
      // otherwise a session opened in a background tab, or finished while
      // backgrounded, would show an empty log forever.
      const shouldFetch = running ? document.visibilityState === "visible" : true;
      if (shouldFetch) {
        try {
          const page = await api.events(adwId as string, cursorRef.current, 500);
          if (!cancelled && page.events.length > 0) {
            setEvents((prev) => [...prev, ...page.events]);
            cursorRef.current = page.cursor;
          }
        } catch {
          /* transient fetch error - retried on the next tick */
        }
      }
      if (!cancelled && running) timer = window.setTimeout(tick, pollMs);
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [adwId, running, pollMs]);

  return events;
}

/** Commit shas a run logged, read back out of the events already on screen -
 * the client-side mirror of db.ts's commitLog, so the diff-scope API shape
 * stays exactly what spec 4 documents (no extra field on the response). */
function deriveDiffScopes(phases: Phase[], events: Event[]): DiffScope[] {
  const scopes: DiffScope[] = [{ id: "run", label: "Whole run", sha: null }];
  const phaseById = new Map(phases.map((p) => [p.phase_id, p]));
  for (const e of events) {
    if (e.type !== "log" || !e.phase_id) continue;
    try {
      const payload = JSON.parse(e.payload_json ?? "{}") as { sha?: unknown };
      if (typeof payload.sha === "string" && payload.sha) {
        const phase = phaseById.get(e.phase_id);
        const seq = phase?.seq !== undefined && phase?.seq !== null ? String(phase.seq).padStart(2, "0") : "??";
        scopes.push({ id: e.phase_id, label: `${seq} ${phase?.name ?? e.phase_id}`, sha: payload.sha });
      }
    } catch {
      /* not a commit log line */
    }
  }
  return scopes;
}

export function App() {
  const route = useRoute();
  const now = useNow(1000);
  const sessions = usePoll(() => api.sessions(200), 2000);
  const queue = usePoll(() => api.queue(), 4000);
  const gate = usePoll(() => api.gate(), 4000);
  const health = usePoll(() => api.health(), 15000);

  const counts: Partial<Record<Surface, number>> = {
    board: queue.data?.items.filter((i) => i.status === "ready-for-agent").length,
    trace: sessions.data?.filter((s) => s.status === "running").length,
    gate: gate.data?.items.length,
  };

  const paletteItems: PaletteItem[] = useMemo(() => {
    if (route.surface === "board") {
      return (queue.data?.items ?? []).map((i) => ({ id: i.path, label: i.title, sublabel: i.status }));
    }
    return (sessions.data ?? []).map((s) => ({
      id: s.adw_id,
      label: s.adw_id,
      sublabel: s.request ?? undefined,
    }));
  }, [route.surface, queue.data, sessions.data]);

  function onPaletteSelect(id: string) {
    if (route.surface === "board") {
      setSelectedQueuePath(id);
    } else {
      navigate(tracePath(id));
    }
  }

  const [selectedQueuePath, setSelectedQueuePath] = useState<string | null>(null);

  const topBar = (
    <TopBar
      breadcrumb={breadcrumbFor(route.surface, route.adwId)}
      live={sessions.live}
      lastUpdatedAt={sessions.lastUpdatedAt}
      now={now}
      dbPath={health.data?.db ?? null}
      onRefresh={sessions.refresh}
    />
  );

  if (route.surface === "trace") {
    return (
      <TracePage
        route={route}
        sessions={sessions.data ?? []}
        now={now}
        counts={counts}
        topBar={topBar}
        paletteItems={paletteItems}
        onPaletteSelect={onPaletteSelect}
      />
    );
  }

  if (route.surface === "board") {
    const selected = queue.data?.items.find((i) => i.path === selectedQueuePath) ?? null;
    return (
      <Shell
        active="board"
        counts={counts}
        topBar={topBar}
        paletteItems={paletteItems}
        onPaletteSelect={onPaletteSelect}
        sidebar={
          <Sidebar title="Queue" count={queue.data?.items.length}>
            <BoardSidebarList items={queue.data?.items ?? []} selectedPath={selectedQueuePath} onSelect={setSelectedQueuePath} />
          </Sidebar>
        }
      >
        {!queue.data ? (
          <LoadingRows />
        ) : queue.data.items.length === 0 && queue.data.unparsed.length === 0 ? (
          <EmptyState message="No queue items. The Board reads queue/*.md - one markdown agent brief per item, with a Status: line. Nothing writes them yet: the planning chain (plan -> triage -> ready-for-agent) will. Start one by copying queue/TEMPLATE.md." />
        ) : selected ? (
          <QueueItemDetail item={selected} />
        ) : (
          <BoardColumns
            items={queue.data.items}
            unparsed={queue.data.unparsed}
            selectedPath={selectedQueuePath}
            onSelect={setSelectedQueuePath}
          />
        )}
      </Shell>
    );
  }

  if (route.surface === "gate") {
    return (
      <Shell
        active="gate"
        counts={counts}
        topBar={topBar}
        sidebar={
          <Sidebar title="Waiting on gate" count={gate.data?.items.length}>
            <div className="flex flex-col">
              {(gate.data?.items ?? []).map((item) => (
                <a
                  key={item.adw_id}
                  href={`#gate-${item.adw_id}`}
                  className="flex flex-col gap-0 border-l-2 border-transparent px-2 py-1 hover:bg-elevated-hover"
                >
                  <span className="mono text-[11px] text-foreground">{item.adw_id}</span>
                  <span className="mono truncate text-[10.5px] text-muted-foreground">{item.branch}</span>
                </a>
              ))}
              {gate.data && gate.data.items.length === 0 && (
                <div className="px-2 py-2 text-[11px] text-muted-foreground">nothing waiting</div>
              )}
            </div>
          </Sidebar>
        }
      >
        <div className="h-full overflow-y-auto p-3">
          {!gate.data ? (
            <LoadingRows />
          ) : gate.data.items.length === 0 ? (
            <EmptyState message="No runs are waiting on the pre-merge brief. A run appears here when it finishes successfully on its adw/<adw_id>_<slug> branch and that branch is not yet merged into main. Today's runs (adw_prompt, adw_scout) are read-only and cut no branch." />
          ) : (
            <div className="space-y-3">
              {gate.data.items.map((item) => (
                <div key={item.adw_id} id={`gate-${item.adw_id}`}>
                  <GateCard item={item} now={now} />
                </div>
              ))}
            </div>
          )}
        </div>
      </Shell>
    );
  }

  // settings - its own component so this hook is never called conditionally
  // within App itself (Rules of Hooks: App must call the same hooks on every
  // render regardless of which surface is active).
  return <SettingsPage counts={counts} topBar={topBar} />;
}

function SettingsPage({
  counts,
  topBar,
}: {
  counts: Partial<Record<Surface, number>>;
  topBar: React.ReactNode;
}) {
  const config = usePoll(() => api.config(), 15000);
  return (
    <Shell
      active="settings"
      counts={counts}
      topBar={topBar}
      sidebar={
        <Sidebar title="Settings">
          <nav className="flex flex-col gap-0.5 p-2 text-[11px]">
            {[
              ["roster", "Roster"],
              ["lanes", "Lanes"],
              ["observability", "Observability"],
              ["paths", "Paths and process"],
            ].map(([id, label]) => (
              <a key={id} href={`#${id}`} className="rounded-sm px-2 py-1 text-muted-foreground hover:bg-elevated-hover hover:text-foreground">
                {label}
              </a>
            ))}
          </nav>
        </Sidebar>
      }
    >
      <div className="h-full overflow-y-auto">
        {config.data ? <SettingsPanes config={config.data} /> : <LoadingRows />}
      </div>
    </Shell>
  );
}

function breadcrumbFor(surface: Surface, adwId: string | null): string[] {
  if (surface === "trace") return adwId ? ["trace", adwId] : ["trace"];
  return [surface];
}

function BoardSidebarList({
  items,
  selectedPath,
  onSelect,
}: {
  items: QueueItem[];
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}) {
  const counts = { "ready-for-agent": 0, running: 0, blocked: 0, done: 0 } as Record<string, number>;
  for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1;
  return (
    <div className="p-2 text-[11px]">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className="mb-1 w-full rounded-sm px-2 py-1 text-left text-muted-foreground hover:bg-elevated-hover"
      >
        all columns
      </button>
      {Object.entries(counts).map(([status, n]) => (
        <div key={status} className="flex items-center justify-between px-2 py-1 text-muted-foreground">
          <span>{status}</span>
          <span className="text-[var(--color-text-meta)]">{n}</span>
        </div>
      ))}
      {selectedPath && (
        <div className="mt-2 border-t border-border pt-2">
          {items
            .filter((i) => i.path === selectedPath)
            .map((i) => (
              <div key={i.path} className="mono truncate px-2 text-[10.5px] text-foreground">
                {i.path}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function QueueItemDetail({ item }: { item: QueueItem }) {
  return (
    <div className="mx-auto max-w-[720px] px-4 py-4">
      <div className="mb-2 flex items-center gap-2">
        <code className="mono rounded-sm border border-border bg-elevated px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
          {item.path}
        </code>
      </div>
      <pre className="mono whitespace-pre-wrap break-words rounded-md border border-border bg-elevated p-3 text-[11.5px] leading-relaxed text-foreground">
        {item.body}
      </pre>
    </div>
  );
}

function TracePage({
  route,
  sessions,
  now,
  counts,
  topBar,
  paletteItems,
  onPaletteSelect,
}: {
  route: { adwId: string | null };
  sessions: SessionSummary[];
  now: number;
  counts: Partial<Record<Surface, number>>;
  topBar: React.ReactNode;
  paletteItems: PaletteItem[];
  onPaletteSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const adwId = route.adwId;

  useEffect(() => {
    if (!adwId && sessions.length > 0) navigate(tracePath(sessions[0]!.adw_id));
  }, [adwId, sessions]);

  const detail = usePoll(() => api.session(adwId as string), 2000, { enabled: !!adwId, deps: [adwId] });
  const running = detail.data?.session.status === "running";
  const events = useEventStream(adwId, running, 500);

  // A finished session's envelopes/gates never change again, so the poll
  // interval collapses to "once" (Infinity) once the run is no longer
  // running - still one hook instance, matching spec 4's "fetched once and
  // then left alone."
  const NEVER_MS = 2_147_000_000; // ~24 days - setInterval's practical max, i.e. "don't poll again"
  const envelopes = usePoll(() => api.envelopes(adwId as string), running ? 4000 : NEVER_MS, {
    enabled: !!adwId,
    deps: [adwId, running],
  });
  const gates = usePoll(() => api.gates(adwId as string), running ? 4000 : NEVER_MS, {
    enabled: !!adwId,
    deps: [adwId, running],
  });

  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  const phases = detail.data?.phases ?? [];
  useEffect(() => {
    if (phases.length === 0) return;
    if (selectedPhaseId && phases.some((p) => p.phase_id === selectedPhaseId)) return;
    setSelectedPhaseId(phases[phases.length - 1]!.phase_id);
  }, [phases, selectedPhaseId]);
  const activePhase = phases.find((p) => p.phase_id === selectedPhaseId) ?? null;

  const diffScopes = useMemo(() => deriveDiffScopes(phases, events), [phases, events]);
  const latestEventAt = events.length > 0 ? (events[events.length - 1]!.started_at ?? null) : undefined;

  if (sessions.length === 0) {
    return (
      <Shell
        active="trace"
        counts={counts}
        topBar={topBar}
        sidebar={
          <Sidebar title="Sessions" count={0}>
            <div className="p-3 text-[11px] text-muted-foreground">no sessions yet</div>
          </Sidebar>
        }
      >
        <EmptyState message="No sessions yet. Run one: just demo." />
      </Shell>
    );
  }

  return (
    <Shell
      active="trace"
      counts={counts}
      topBar={topBar}
      paletteItems={paletteItems}
      onPaletteSelect={onPaletteSelect}
      sidebar={
        <Sidebar title="Sessions" count={sessions.length}>
          <div className="border-b border-border p-1.5">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter (Ctrl+K)"
              className="h-6 text-[11px]"
            />
          </div>
          <RunList sessions={sessions} selectedId={adwId} now={now} filter={filter} />
        </Sidebar>
      }
      inspector={
        adwId && (
          <Inspector
            adwId={adwId}
            phase={activePhase}
            envelopes={envelopes.data ?? []}
            gates={gates.data ?? []}
            diffScopes={diffScopes}
          />
        )
      }
    >
      {!adwId || !detail.data ? (
        <LoadingRows />
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <RunHeader
            session={detail.data.session}
            phases={detail.data.phases}
            processes={detail.data.processes}
            agents={detail.data.agents}
            usage={detail.data.usage}
            now={now}
            latestEventAt={latestEventAt}
            branch={detail.data.branch}
            title={detail.data.title}
          />
          <PhaseTimeline phases={detail.data.phases} activePhaseId={selectedPhaseId} onSelect={setSelectedPhaseId} />
          <WorkLog phases={detail.data.phases} events={events} running={running} activePhaseId={selectedPhaseId} />
        </div>
      )}
    </Shell>
  );
}
