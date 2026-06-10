// Drag state is tracked in a module-level variable rather than via custom
// dataTransfer MIME types, because some webviews (notably WKWebView used by
// Tauri on macOS) strip custom dataTransfer types — which would make
// `dragover` fail to recognise the payload and reject the drop.

export type DragItem =
  | { kind: "repo"; id: number }
  | { kind: "group"; id: number }
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
