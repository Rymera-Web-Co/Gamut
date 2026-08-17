/** Lane colors for the commit graph, indexed by column. */
export const GRAPH_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
  "#06b6d4",
  "#ef4444",
  "#eab308",
];

export function graphColor(index: number): string {
  return GRAPH_COLORS[index % GRAPH_COLORS.length];
}

/** Compact relative time from a unix-seconds timestamp. */
export function relativeTime(unixSeconds: number, now = Date.now()): string {
  const diff = Math.max(0, Math.floor(now / 1000 - unixSeconds));
  const units: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [30, "d"],
    [12, "mo"],
    [Number.POSITIVE_INFINITY, "y"],
  ];
  let value = diff;
  let unit = "s";
  for (const [size, label] of units) {
    if (value < size) {
      unit = label;
      break;
    }
    value = Math.floor(value / size);
    unit = label;
  }
  return `${value}${unit} ago`;
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

/**
 * Relative time from an ISO 8601 timestamp (e.g. GitHub's `created_at` /
 * `updated_at`). Returns "" for empty or unparseable input — `Date.parse`
 * yields `NaN` there, which would otherwise render as "NaNs ago" (#143).
 */
export function relativeTimeIso(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return relativeTime(Math.floor(ms / 1000), now);
}

/**
 * Parse an ISO 8601 timestamp to epoch milliseconds for sorting, mapping
 * empty/unparseable input to 0 so a bad value can't produce `NaN` and corrupt
 * comparator ordering (#143).
 */
export function isoToMillis(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Relative time from a SQLite `datetime('now')` string ("YYYY-MM-DD HH:MM:SS",
 * UTC with no zone). Returns "" if it can't be parsed.
 */
export function relativeTimeSqlite(utc: string, now = Date.now()): string {
  const ms = Date.parse(`${utc.replace(" ", "T")}Z`);
  if (Number.isNaN(ms)) return "";
  return relativeTime(Math.floor(ms / 1000), now);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Format an epoch-ms timestamp (e.g. a Diagnostics `ErrorEntry.at_ms`, #301)
 * as exactly `YYYY-MM-DD HH:MM:SS`, zero-padded, in local time. Pinned to an
 * exact format (rather than a relative/locale string) so the "Recent errors"
 * section's timestamps are stable and testable — see `vitest.config.ts`'s
 * `TZ=UTC` for how tests pin an exact expected string.
 */
export function formatTimestampMs(atMs: number): string {
  const d = new Date(atMs);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${date} ${time}`;
}

/** Last path segment of a filesystem path (either separator style). */
export function pathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
