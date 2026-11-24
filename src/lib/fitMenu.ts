/** Viewport coordinates at which to open a menu. */
export interface ContextMenuPosition {
  x: number;
  y: number;
}

/** Gap kept between the menu and the viewport edge, in px. */
export const EDGE = 4;

/**
 * Place a `w`×`h` menu at the cursor, inside a `vw`×`vh` viewport. A menu that
 * does not fit below or right of the cursor opens above or left of it. When it
 * fits on neither side, it is pinned to the edge (and scrolls when too tall).
 */
export function fitMenu(
  at: ContextMenuPosition,
  w: number,
  h: number,
  vw: number,
  vh: number,
): ContextMenuPosition {
  const axis = (p: number, size: number, view: number) => {
    if (p + size <= view - EDGE) return p;
    if (p - size >= EDGE) return p - size;
    return Math.max(EDGE, view - EDGE - size);
  };
  return { x: axis(at.x, w, vw), y: axis(at.y, h, vh) };
}
