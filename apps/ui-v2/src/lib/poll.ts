/**
 * Project-keyed fetching and the one poll.
 *
 * Spec 2.1, binding (W3-A3): "No row from the previous project survives a
 * switch - every fetched collection is cached under a key whose first
 * component is projectId, and a panel renders only data whose key matches the
 * current route's project. On a switch the panel is empty (its own empty
 * state) until its first response for the new project lands."
 *
 * That is enforced here rather than asked for in twelve surfaces: `data` is
 * carried alongside the key it arrived under, and the hook returns `null`
 * whenever that key is not the key being asked for right now. A late response
 * from the previous project cannot paint - it is discarded on arrival.
 *
 * Also spec 2.1: a read failure keeps the panel's last good data and shows the
 * server's own error string. So `data` and `error` are both live at once, on
 * purpose; a panel renders the data it has AND the line saying the last read
 * failed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * @param key   identity of what is being fetched; MUST start with the project
 *              id for anything project-scoped. `null` disables the fetch.
 * @param path  the URL. `null` disables the fetch.
 * @param intervalMs  poll cadence; omit for a one-shot read.
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

    const read = async () => {
      try {
        const data = await apiGet<T>(path, controller.signal);
        if (cancelled || activeKey.current !== key) return;
        setHeld({ key, data, error: null, loading: false });
      } catch (error) {
        if (cancelled || activeKey.current !== key) return;
        if ((error as Error).name === "AbortError") return;
        setHeld((prev) => ({ key, data: prev.key === key ? prev.data : null, error: (error as Error).message, loading: false }));
      }
    };

    void read();
    if (!intervalMs) {
      return () => {
        cancelled = true;
        controller.abort();
      };
    }
    const timer = window.setInterval(() => void read(), intervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [key, path, intervalMs, nonce]);

  // The guard that makes the rule structural: data from another key never paints.
  if (held.key !== (key ?? "")) return { data: null, error: null, loading: key !== null, refresh };
  return { data: held.data, error: held.error, loading: held.loading, refresh };
}

/** The one 2s poll (spec 1.3): sidebar counts, Board, Runs list all read it. */
export const LIVE_INTERVAL_MS = 2000;

export function useLive<T>(projectId: string | null): Resource<T> {
  return useResource<T>(
    projectId ? `${projectId}|live` : null,
    projectId ? `/api/app/p/${encodeURIComponent(projectId)}/live` : null,
    LIVE_INTERVAL_MS,
  );
}
