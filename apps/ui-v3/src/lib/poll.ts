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
 * The topbar's Sync button means "re-read every data source on screen". Every
 * mounted `useResource` registers its reader here, so a surface joins Sync by
 * doing nothing at all beyond using this hook. `requestSyncAll()` awaits all
 * of them and publishes an honest result (how many sources, how many failed) -
 * never a spinner that ends in silence.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiGet } from "./api.ts";

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
const readers = new Set<Reader>();

export type SyncStatus = "idle" | "syncing" | "done" | "failed";

export interface SyncState {
  status: SyncStatus;
  /** epoch ms of the last completed sync, or null before the first one. */
  at: number | null;
  /** how many sources the last (or current) sync covers. */
  sources: number;
  /** how many of those failed. */
  failed: number;
}

let syncState: SyncState = { status: "idle", at: null, sources: 0, failed: 0 };
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

/** Re-reads every mounted resource. Resolves when they have all answered. */
export async function requestSyncAll(): Promise<void> {
  if (syncState.status === "syncing") return;
  const current = [...readers];
  publish({ status: "syncing", at: syncState.at, sources: current.length, failed: 0 });
  const results = await Promise.allSettled(current.map((read) => read()));
  const failed = results.filter((result) => result.status === "rejected").length;
  publish({ status: failed > 0 ? "failed" : "done", at: Date.now(), sources: current.length, failed });
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
    readers.add(reader);

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
