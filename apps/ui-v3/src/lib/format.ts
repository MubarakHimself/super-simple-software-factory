/**
 * Formatting the status strip and the topbar need. Every one of these returns
 * a string a human reads, and none of them invents a value: an absent number
 * comes back as the em dash, never as 0.
 */

/** The mock's own shape: "14h 22m". Below an hour it degrades to minutes, and
 * past two days to days, because "3412h 07m" is not a thing anyone reads. */
export function formatUptime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "1 lane" / "3 lanes" - a count that reads as a sentence, not as a field. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Wall-clock, for "synced 19:42". Local time, 24h, no seconds. */
export function clockTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
