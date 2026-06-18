// Drag state is tracked in a module-level variable rather than via custom
// dataTransfer MIME types, because some webviews (notably WKWebView used by
// Tauri on macOS) strip custom dataTransfer types — which would make
// `dragover` fail to recognise the payload and reject the drop.

export type DragItem =
  | { kind: "repo"; id: number }
  | { kind: "group"; id: number }
  // Terminal tabs reorder within a single group; `groupId` scopes the drag so a
  // tab can't be dropped onto another group's strip. Tab ids are strings.
  | { kind: "tab"; groupId: number; id: string }
  | null;

let current: DragItem = null;

export function setDrag(item: DragItem) {
  current = item;
}

export function getDrag(): DragItem {
  return current;
}

export function clearDrag() {
  current = null;
}

/** Return a new array with `srcId` moved to just before `targetId`. */
export function moveBefore<T>(items: T[], srcId: T, targetId: T): T[] {
  if (srcId === targetId) return items;
  const without = items.filter((x) => x !== srcId);
  const idx = without.indexOf(targetId);
  if (idx === -1) return items;
  without.splice(idx, 0, srcId);
  return without;
}

/**
 * Return a new array with `srcId` moved adjacent to `targetId`. `position`
 * decides whether it lands before or after the target, which lets a drop
 * reach the very end of the list (after the last item), not just "before".
 */
export function moveAdjacent<T>(
  items: T[],
  srcId: T,
  targetId: T,
  position: "before" | "after",
): T[] {
  if (srcId === targetId) return items;
  const without = items.filter((x) => x !== srcId);
  const idx = without.indexOf(targetId);
  if (idx === -1) return items;
  without.splice(position === "after" ? idx + 1 : idx, 0, srcId);
  return without;
}
