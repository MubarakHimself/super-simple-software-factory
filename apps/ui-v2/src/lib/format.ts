/**
 * Formatting, kept small on purpose. Anything that decides what a value MEANS
 * belongs to a surface; this file only decides how a value READS.
 */

/** `0:42`, `12:05`, `1:04:11` - the ticking form (spec 2.5's run header). */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** `41s`, `4m 12s`, `1h 06m` - the settled form (spec 2.5's "Worked for"). */
export function span(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function msSince(iso: string, until?: string | null): number {
  const from = Date.parse(iso);
  if (Number.isNaN(from)) return 0;
  const to = until ? Date.parse(until) : Date.now();
  return (Number.isNaN(to) ? Date.now() : to) - from;
}

/**
 * Clips to `max` characters with a single ellipsis. Server adapters clip
 * free text too (spec 1.3) - this is the client's own guard for strings that
 * arrive from a file rather than an adapter, never a second budget.
 */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}\u2026`;
}

