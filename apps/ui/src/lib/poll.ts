import { useCallback, useEffect, useRef, useState } from "react";

export type LiveState = "live" | "paused" | "stale";

/**
 * Poll `fn` on an interval, paused whenever the tab is hidden (spec 4:
 * "all polling pauses when document.visibilityState === 'hidden'"). No
 * websockets, no push - the data path is agents -> sqlite -> ui, so this is
 * the whole transport.
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  opts: { enabled?: boolean; deps?: unknown[] } = {},
): {
  data: T | null;
  error: string | null;
  loading: boolean;
  lastUpdatedAt: number | null;
  live: LiveState;
  refresh: () => void;
} {
  const { enabled = true, deps = [] } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const inFlight = useRef(false);

  const tick = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await fnRef.current();
      setData(result);
      setError(null);
      setLastUpdatedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    void tick();
    if (!visible) return;
    const id = window.setInterval(() => void tick(), intervalMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, visible, intervalMs, tick, ...deps]);

  const live: LiveState = !enabled ? "stale" : !visible ? "paused" : error ? "stale" : "live";

  return { data, error, loading, lastUpdatedAt, live, refresh: () => void tick() };
}
