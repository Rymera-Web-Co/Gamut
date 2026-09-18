/**
 * Which edge of a row a drag is hovering, from the row's rect and the
 * pointer's viewport Y. Splits on the rect's vertical midpoint: strictly
 * below it is `"after"`, everything else — including the exact midpoint — is
 * `"before"`. The tie-break matters at the boundary case (a zero-height rect,
 * or a pointer landing exactly on the midpoint pixel): resolving ties to
 * `"before"` keeps the rule a total, deterministic function of `y` without a
 * separate "on the line" state.
 */
export function dropEdge(rect: DOMRect, y: number): "before" | "after" {
  const mid = rect.top + rect.height / 2;
  return y > mid ? "after" : "before";
}
