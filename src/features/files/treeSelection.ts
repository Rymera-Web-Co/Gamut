import type { DirEntry } from "@/lib/ipc";

/** A row in the flattened, top-to-bottom order of the currently-visible tree. */
export interface FlatRow {
  path: string;
  kind: "dir" | "file";
}

function join(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

/** The parent directory of a repo-relative path (root = ""). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** The trailing name of a repo-relative path (its last `/`-separated segment). */
export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Whether `path` is `dir` itself or nested anywhere beneath it. */
export function isInside(dir: string, path: string): boolean {
  return dir === path || dir.startsWith(`${path}/`);
}

/**
 * Flatten the visible tree to its on-screen row order: a depth-first walk from
 * the root that descends into a directory only when it's open. `getEntries`
 * returns a directory's cached children (root = ""), or `undefined` if they
 * haven't loaded yet — an unloaded open dir simply contributes no descendants.
 * Ignored entries are included; they're rendered (dimmed) and selectable.
 */
export function flattenVisible(
  getEntries: (dir: string) => DirEntry[] | undefined,
  openPaths: Set<string>,
): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (dir: string) => {
    const entries = getEntries(dir);
    if (!entries) return;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      rows.push({ path, kind: entry.kind });
      if (entry.kind === "dir" && openPaths.has(path)) walk(path);
    }
  };
  walk("");
  return rows;
}

/**
 * The paths of every row between `a` and `b` inclusive, in flattened order — the
 * range a Shift-click (or Shift+Arrow) selects. Order-independent in its
 * endpoints. If either endpoint isn't currently visible, falls back to just `b`
 * (the row that was actually clicked).
 */
export function rangePaths(flat: FlatRow[], a: string, b: string): string[] {
  const ia = flat.findIndex((r) => r.path === a);
  const ib = flat.findIndex((r) => r.path === b);
  if (ia === -1 || ib === -1) return [b];
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
  return flat.slice(lo, hi + 1).map((r) => r.path);
}

/**
 * Collapse a set of paths to its top-level members — drop any path nested under
 * another path in the same set. Moving or deleting a folder already carries its
 * descendants, so acting on a descendant again would operate on a path that no
 * longer exists (a spurious failure). Preserves input order.
 */
export function topLevelPaths(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((other) => other !== p && isInside(p, other)));
}

/**
 * Filter a set of dragged paths down to those that would actually move into
 * `targetDir`, dropping: paths already directly inside it (no-op), the target
 * itself, and any ancestor of the target (a folder can't move into its own
 * descendant). Descendants of another dragged path are collapsed away first
 * (see {@link topLevelPaths}). Returns the movable subset, in input order.
 */
export function movablePaths(paths: string[], targetDir: string): string[] {
  return topLevelPaths(paths).filter(
    (p) => parentDir(p) !== targetDir && !isInside(targetDir, p),
  );
}
