import { useEffect, useRef, useState } from "react";

import {
  getActiveDrag,
  startDrag,
  subscribeDrag,
  subscribeDrop,
  type ActiveDrag,
  type DragItem,
} from "./dnd";

/**
 * Props to spread onto a draggable element. A press-and-drag carries `item`
 * (labelled `label` for the ghost); a plain click passes through untouched.
 * `disabled` turns the element back into a normal, non-draggable one.
 */
export function useDraggable(item: DragItem, label: string, opts?: { disabled?: boolean }) {
  const dragged = useRef(false);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      // Left button only; ignore right/middle so context menus still open.
      if (opts?.disabled || e.button !== 0) return;
      dragged.current = false;
      startDrag(item, label, e, () => {
        dragged.current = true;
      });
    },
    // A real drag ends with a `pointerup` that the browser would otherwise turn
    // into a click (selecting the very repo/tab you just moved). Swallow it.
    onClickCapture: (e: React.MouseEvent) => {
      if (dragged.current) {
        e.preventDefault();
        e.stopPropagation();
        dragged.current = false;
      }
    },
    // Keep touch drags from scrolling the list instead of dragging the item.
    style: { touchAction: "none" as const },
  };
}

/**
 * Register an element as a drop target for a pointer drag. `accepts` filters by
 * dragged item; `compute` maps the live pointer position (with the element's
 * rect) to a hover state the caller renders from (e.g. an insertion edge);
 * `onDrop` runs when the pointer is released over the element. Returns a ref to
 * attach and the current hover state (`null` when nothing acceptable hovers).
 */
export function useDropTarget<S, E extends HTMLElement = HTMLElement>(config: {
  accepts: (item: DragItem) => boolean;
  compute: (item: DragItem, rect: DOMRect, x: number, y: number) => S;
  onDrop: (item: DragItem, rect: DOMRect, x: number, y: number) => void;
}) {
  const ref = useRef<E | null>(null);
  const [state, setState] = useState<S | null>(null);
  // Latest config in a ref, so the subscriptions needn't re-bind every render.
  const cfg = useRef(config);
  cfg.current = config;

  useEffect(() => {
    const inside = (rect: DOMRect, x: number, y: number) =>
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    // Only re-render targets that were actually showing a hover state.
    const clear = () => setState((s) => (s === null ? s : null));

    const offMove = subscribeDrag(() => {
      const drag = getActiveDrag();
      const el = ref.current;
      if (!drag || !el || !cfg.current.accepts(drag.item)) {
        clear();
        return;
      }
      const rect = el.getBoundingClientRect();
      if (!inside(rect, drag.x, drag.y)) {
        clear();
        return;
      }
      setState(cfg.current.compute(drag.item, rect, drag.x, drag.y));
    });

    const offDrop = subscribeDrop((item, x, y) => {
      const el = ref.current;
      setState(null);
      if (!el || !cfg.current.accepts(item)) return;
      const rect = el.getBoundingClientRect();
      if (inside(rect, x, y)) cfg.current.onDrop(item, rect, x, y);
    });

    return () => {
      offMove();
      offDrop();
    };
  }, []);

  return { ref, state };
}

/** Subscribe to the active drag; re-renders as the pointer moves. */
export function useActiveDrag(): ActiveDrag | null {
  const [drag, setDrag] = useState<ActiveDrag | null>(getActiveDrag());
  useEffect(() => subscribeDrag(() => setDrag(getActiveDrag())), []);
  return drag;
}

/**
 * A small label that follows the cursor during an internal pointer drag,
 * standing in for the drag image the browser used to draw for HTML5 DnD.
 * Rendered once at the app root.
 */
export function DragGhost() {
  const drag = useActiveDrag();
  if (!drag) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-[200] max-w-48 truncate rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] px-2 py-1 text-xs text-[var(--color-popover-foreground)] shadow-md"
      style={{ left: drag.x + 12, top: drag.y + 8 }}
    >
      {drag.label}
    </div>
  );
}
