/**
 * The ids of every row between `a` and `b` inclusive, in `ordered` order — the
 * range a ⇧-click selects. Order-independent in its endpoints, modelled on
 * `treeSelection.ts:rangePaths` but keyed on numeric repo ids instead of tree
 * paths. Kept local to `features/repos`: `rangePaths` is keyed on `FlatRow`/path
 * strings and doesn't transfer, and generalising it for numeric ids is
 * speculative until something else needs it.
 *
 * If either endpoint isn't in `ordered`, falls back to just `[b]` (the row that
 * was actually clicked).
 */
export function rangeIds(ordered: number[], a: number, b: number): number[] {
  const ia = ordered.indexOf(a);
  const ib = ordered.indexOf(b);
  if (ia === -1 || ib === -1) return [b];
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
  return ordered.slice(lo, hi + 1);
}
