/**
 * Project-keyed fetching, the one poll, and the Sync bus.
 *
 * ── Project keying ─────────────────────────────────────────────────────────
 * No row from the previous project may survive a switch. Data is carried
 * alongside the key it arrived under, and the hook returns `null` whenever
 * that key is not the key being asked for right now, so a late response from
 * the previous project cannot paint - it is discarded on arrival. Any
 * project-scoped key MUST start with the project id.
 *
 * ── Failures ───────────────────────────────────────────────────────────────
 * A read failure keeps the panel's last good data AND exposes the server's own
 * error string: `data` and `error` are live at once, on purpose. A panel
 * renders what it has plus the line saying the last read failed.
 *
 * ── The Sync bus ───────────────────────────────────────────────────────────
 * The topbar's Sync button is two things at once (the operator's own words:
 * "that button does a lot - providers, machines, kanban, docs... it's like a
 * status update"):
 *
 *   1. THE REPO — `POST /api/app/p/:id/sync` (`server/app/sync.ts`): a real
 *      `git fetch` + `merge --ff-only` in the project's own checkout. Never
 *      pushes, never forces; dirty or diverged is a named, honest outcome.
 *   2. EVERYTHING ON SCREEN — every mounted `useResource` registers its
 *      reader here, so a surface joins Sync by doing nothing at all beyond
 *      using this hook. `requestSyncAll()` re-reads all of them alongside the
 *      repo call.
 *
 * `areas` tracks WHEN each of the two named areas the popover reports on
 * (`board`, `docs`) last finished re-reading, and whether that re-read
 * failed - derived from the same key `useResource` already carries, via
 * `areaForKey()` below. A source that is not currently mounted (the operator
 * is on a different surface) contributes nothing to `areas` and the popover
 * says "not open right now" rather than inventing a timestamp for it. Machine
 * and provider freshness live entirely in their own panes (Settings ->
 * Machines / Providers) - this bus does not touch either, and the popover
 * says so with a link rather than a number this bus cannot honestly produce.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiGet, apiPost, type RepoSyncResult } from "./api.ts";

export interface Resource<T> {
  data: T | null;
  error: string | null;
  /** True until the first response (of any kind) for the current key lands. */
  loading: boolean;
  refresh: () => void;
}

interface Held<T> {
  key: string;
  data: T | null;
  error: string | null;
  loading: boolean;
}

/* ── the Sync bus ───────────────────────────────────────────────────────── */

/** A mounted reader: re-reads its source, rejects if that read failed. */
type Reader = () => Promise<void>;
/** Reader -> the `useResource` key it was registered under, so a sync can
 * derive which named area (if any) a given reader belongs to. */
const readers = new Map<Reader, string>();

export type SyncStatus = "idle" | "syncing" | "done" | "failed";

/** The two named areas the popover reports freshness for — the ones the
 * operator can actually be looking at on screen (Board reads the `|cards`
 * key, Docs reads `|docs-tree` / `|docs-file|…`). Machines and providers are
 * deliberately not areas here: their freshness lives in their own panes. */
export type SyncArea = "board" | "docs";

export interface AreaState {
  /** epoch ms this area last finished re-reading, or null if it has never
   * been open during a sync. */
  at: number | null;
  failed: boolean;
}

export interface SyncState {
  status: SyncStatus;
  /** epoch ms of the last completed sync, or null before the first one. */
  at: number | null;
  /** how many sources the last (or current) sync covers (readers + the repo call). */
  sources: number;
  /** how many of those failed. */
  failed: number;
  /** the repo half — null until the first sync completes, or when it was not
   * attempted (no project id yet). */
  repo: RepoSyncResult | null;
  areas: Record<SyncArea, AreaState>;
}

const NO_AREA: AreaState = { at: null, failed: false };

let syncState: SyncState = {
  status: "idle",
  at: null,
  sources: 0,
  failed: 0,
  repo: null,
  areas: { board: NO_AREA, docs: NO_AREA },
};
const watchers = new Set<() => void>();

function publish(next: SyncState): void {
  syncState = next;
  for (const watcher of watchers) watcher();
}

function subscribeSync(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

function syncSnapshot(): SyncState {
  return syncState;
}

/** What the Sync button renders. Honest in every branch, including "nothing
 * was on screen to re-read". */
export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSync, syncSnapshot, syncSnapshot);
}

/** `${projectId}|cards` -> "board", `${projectId}|docs-tree` /
 * `${projectId}|docs-file|…` -> "docs", everything else -> not an area this
 * bus reports on (still re-read, just not surfaced by name in the popover). */
function areaForKey(key: string): SyncArea | null {
  const suffix = key.includes("|") ? key.slice(key.indexOf("|") + 1) : key;
  if (suffix === "cards") return "board";
  if (suffix.startsWith("docs")) return "docs";
  return null;
}

/** Re-reads every mounted resource AND the project's repo (when a project id
 * is given). Resolves when everything has answered. `projectId` is optional
 * because the topbar's Sync button always has one, but a caller before a
 * project exists should not have to invent one. */
export async function requestSyncAll(projectId?: string | null): Promise<void> {
  if (syncState.status === "syncing") return;
  const current = [...readers.entries()]; // [reader, key][]
  publish({ ...syncState, status: "syncing", sources: current.length + (projectId ? 1 : 0), failed: 0 });

  const [repoOutcome, ...readOutcomes] = await Promise.allSettled([
    projectId
      ? apiPost<{ repo: RepoSyncResult }>(`/api/app/p/${encodeURIComponent(projectId)}/sync`)
      : Promise.resolve(null),
    ...current.map(([read]) => read()),
  ]);

  const now = Date.now();
  const areas: Record<SyncArea, AreaState> = { ...syncState.areas };
  current.forEach(([, key], index) => {
    const area = areaForKey(key);
    if (!area) return;
    areas[area] = { at: now, failed: readOutcomes[index]?.status === "rejected" };
  });

  const repo =
    repoOutcome.status === "fulfilled"
      ? (repoOutcome.value?.repo ?? syncState.repo)
      : projectId
        ? ({ status: "failed", detail: (repoOutcome.reason as Error).message, branch: null, before_sha: null, after_sha: null } satisfies RepoSyncResult)
        : syncState.repo;

  const failedReads = readOutcomes.filter((result) => result.status === "rejected").length;
  const repoFailed = repo !== null && (repo.status === "failed" || repo.status === "not-a-repo");
  const failed = failedReads + (repoFailed ? 1 : 0);

  publish({
    status: failed > 0 ? "failed" : "done",
    at: now,
    sources: current.length + (projectId ? 1 : 0),
    failed,
    repo,
    areas,
  });
}

/* ── the hook ───────────────────────────────────────────────────────────── */

/**
 * @param key   identity of what is being fetched; MUST start with the project
 *              id for anything project-scoped. `null` disables the fetch.
 * @param path  the URL, relative. `null` disables the fetch.
 * @param intervalMs  poll cadence; omit for a one-shot read (Sync still
 *              re-reads it).
 */
export function useResource<T>(key: string | null, path: string | null, intervalMs?: number): Resource<T> {
  const [held, setHeld] = useState<Held<T>>({ key: key ?? "", data: null, error: null, loading: key !== null });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // The key the effect is currently fetching for, read inside async callbacks.
  const activeKey = useRef<string | null>(key);
  activeKey.current = key;

  useEffect(() => {
    if (key === null || path === null) {
      setHeld({ key: "", data: null, error: null, loading: false });
      return;
    }
    // The switch itself empties the panel - before any request goes out.
    setHeld((prev) => (prev.key === key ? prev : { key, data: null, error: null, loading: true }));

    let cancelled = false;
    const controller = new AbortController();

    /** Resolves with the error string when the read failed, null when it did
     * not - so both the panel and the Sync bus learn the same truth. */
    const read = async (): Promise<string | null> => {
      try {
        const data = await apiGet<T>(path, controller.signal);
        if (cancelled || activeKey.current !== key) return null;
        setHeld({ key, data, error: null, loading: false });
        return null;
      } catch (error) {
        if (cancelled || activeKey.current !== key) return null;
        if ((error as Error).name === "AbortError") return null;
        const message = (error as Error).message;
        setHeld((prev) => ({ key, data: prev.key === key ? prev.data : null, error: message, loading: false }));
        return message;
      }
    };

    const reader: Reader = async () => {
      const failure = await read();
      if (failure) throw new Error(failure);
    };
    readers.set(reader, key);

    void read();
    const timer = intervalMs ? window.setInterval(() => void read(), intervalMs) : null;
    return () => {
      cancelled = true;
      controller.abort();
      readers.delete(reader);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [key, path, intervalMs, nonce]);

  // The guard that makes the project rule structural: data from another key
  // never paints.
  if (held.key !== (key ?? "")) return { data: null, error: null, loading: key !== null, refresh };
  return { data: held.data, error: held.error, loading: held.loading, refresh };
}

/** The one 2s poll: sidebar counts, Board and Runs all read this resource. */
export const LIVE_INTERVAL_MS = 2000;

/** Factory health moves slower than a run does and is read by exactly one
 * component (the sidebar footer), so it gets its own gentler cadence. */
export const HEALTH_INTERVAL_MS = 5000;

export function useLive<T>(projectId: string | null): Resource<T> {
  return useResource<T>(
    projectId ? `${projectId}|live` : null,
    projectId ? `/api/app/p/${encodeURIComponent(projectId)}/live` : null,
    LIVE_INTERVAL_MS,
  );
}

export function useFactoryHealth<T>(projectId: string | null): Resource<T> {
  return useResource<T>(
    projectId ? `${projectId}|factory-health` : null,
    projectId ? `/api/app/p/${encodeURIComponent(projectId)}/factory/health` : null,
    HEALTH_INTERVAL_MS,
  );
}
