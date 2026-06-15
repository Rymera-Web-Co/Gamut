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
 * Relative time from a SQLite `datetime('now')` string ("YYYY-MM-DD HH:MM:SS",
 * UTC with no zone). Returns "" if it can't be parsed.
 */
export function relativeTimeSqlite(utc: string, now = Date.now()): string {
  const ms = Date.parse(`${utc.replace(" ", "T")}Z`);
  if (Number.isNaN(ms)) return "";
  return relativeTime(Math.floor(ms / 1000), now);
}
