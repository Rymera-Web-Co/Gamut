// Internal drag-and-drop — reordering repos, groups and terminal tabs, and
// dropping a repo onto a group — is built on POINTER events, not the HTML5
// drag-and-drop API.
//
// The reason is a hard conflict on macOS: accepting folders dropped from the OS
// file manager requires Tauri's native drag-drop handler (`dragDropEnabled`),
// and while that is enabled the WKWebView swallows every HTML5 drag event —
// `dragstart`/`drop` never fire (the commit that first set `dragDropEnabled:
// false` was working around exactly this). Pointer events are untouched by the
// native handler, so in-app reordering keeps working alongside native folder
// drops.
//
// This module owns the pointer-drag *session* — one at a time: a source begins a
// drag, subscribers are notified as the pointer moves, and drop targets are told
// where the pointer was released. Components wire in through the hooks in
// `usePointerDnd`.

export type DragItem =
  | { kind: "repo"; id: number }
  | { kind: "group"; id: number }
  // Terminal tabs reorder within a single group; `groupId` scopes the drag so a
  // tab can't be dropped onto another group's strip. Tab ids are strings.
  | { kind: "tab"; groupId: number; id: string }
  // One or more file-tree entries being dragged to move them into a folder.
  // `repoId` scopes the drag to its own tree; `paths` are repo-relative (the
  // whole multi-selection when dragging a selected row, else just that row).
  | { kind: "tree"; repoId: number; paths: string[] };

/**
 * An in-progress pointer drag: what's being dragged, a label for the on-screen
 * ghost, and the current pointer position in viewport (CSS) pixels.
 */
export interface ActiveDrag {
  item: DragItem;
  label: string;
  x: number;
  y: number;
}

// How far the pointer must travel after pressing before a press becomes a drag,
// so a plain click (select a repo, focus a tab) is never misread as a drag.
const DRAG_THRESHOLD_PX = 4;

let pending: {
  item: DragItem;
  label: string;
  startX: number;
  startY: number;
  onActivate?: () => void;
} | null = null;
let active: ActiveDrag | null = null;

type MoveListener = () => void;
type DropListener = (item: DragItem, x: number, y: number) => void;
const moveListeners = new Set<MoveListener>();
const dropListeners = new Set<DropListener>();

function notifyMove() {
  for (const l of moveListeners) l();
}

/**
 * Subscribe to drag activity. Fires on every pointer move during a drag, and
 * once when a drag ends, so targets can clear their hover state.
 */
export function subscribeDrag(listener: MoveListener): () => void {
  moveListeners.add(listener);
  return () => {
    moveListeners.delete(listener);
  };
}

/**
 * Subscribe to drops. Fires once on pointer release, only if a drag was active,
 * with the released item and the pointer position (CSS pixels).
 */
export function subscribeDrop(listener: DropListener): () => void {
  dropListeners.add(listener);
  return () => {
    dropListeners.delete(listener);
  };
}

/** The drag in progress, or null. Its position updates as the pointer moves. */
export function getActiveDrag(): ActiveDrag | null {
  return active;
}

/**
 * Begin a potential drag from a `pointerdown`. The drag only becomes active
 * (visible, droppable) once the pointer moves past a small threshold, so clicks
 * still register. `onActivate` fires at that crossover — callers use it to
 * swallow the click that would otherwise follow the release.
 */
export function startDrag(
  item: DragItem,
  label: string,
  e: { clientX: number; clientY: number },
  onActivate?: () => void,
): void {
  // One session at a time. If a previous press/drag never cleanly ended (e.g. a
  // second pointer goes down mid-drag), tear it down first so we don't leak
  // listeners or leave `pending`/`active` tracking a stale item.
  if (pending || active) teardown();
  pending = { item, label, startX: e.clientX, startY: e.clientY, onActivate };
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
}

function onPointerMove(e: PointerEvent) {
  if (pending && !active) {
    const dx = e.clientX - pending.startX;
    const dy = e.clientY - pending.startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    active = { item: pending.item, label: pending.label, x: e.clientX, y: e.clientY };
    pending.onActivate?.();
  }
  if (active) {
    // A fresh object each move so subscribers relying on identity re-render.
    active = { ...active, x: e.clientX, y: e.clientY };
    // Suppress text selection / the native image drag while dragging.
    e.preventDefault();
    notifyMove();
  }
}

function onPointerUp(e: PointerEvent) {
  const released = active;
  const { clientX, clientY } = e;
  teardown();
  if (released) {
    for (const l of dropListeners) l(released.item, clientX, clientY);
  }
}

function onPointerCancel() {
  teardown();
}

function teardown() {
  window.removeEventListener("pointermove", onPointerMove, true);
  window.removeEventListener("pointerup", onPointerUp, true);
  window.removeEventListener("pointercancel", onPointerCancel, true);
  const wasActive = active !== null;
  pending = null;
  active = null;
  // Let hover indicators clear now the drag is gone.
  if (wasActive) notifyMove();
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
