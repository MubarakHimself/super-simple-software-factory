/** Formatting helpers. No progress bars, no percents - spec 1.4 non-negotiable. */

export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "-";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "-";
  const deltaMs = now - then;
  const deltaS = Math.round(deltaMs / 1000);
  if (deltaS < 5) return "just now";
  if (deltaS < 60) return `${deltaS}s ago`;
  const deltaM = Math.floor(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  const deltaH = Math.floor(deltaM / 60);
  if (deltaH < 24) return `${deltaH}h ago`;
  const deltaD = Math.floor(deltaH / 24);
  return `${deltaD}d ago`;
}

/** "28.4s" under a minute, "1m 51s" under an hour, "1h 04m" beyond. */
export function elapsedLabel(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const totalWholeSeconds = Math.floor(totalSeconds);
  const minutes = Math.floor(totalWholeSeconds / 60);
  const seconds = totalWholeSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes.toString().padStart(2, "0")}m`;
}

export function tokenCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "0";
  return n.toLocaleString("en-US");
}

/** "63k" style compact form for read/written pills. */
export function tokenCompact(n: number | null | undefined): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

/** ISO -> epoch ms, tolerant of null/invalid. */
export function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
