/** The grid fields the slot math needs from a pane. */
export interface GridPane {
  row?: number;
  size?: number;
}

/** The computed slot for one split pane, in percent of the tab's viewport. */
export interface PaneSlot {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 0-based position of the pane's row among the tab's rows. */
  rowPos: number;
  /** First pane in its row — no vertical divider on its left edge. */
  firstInRow: boolean;
  /** Pane sits in the first row — no horizontal divider on its top edge. */
  firstRow: boolean;
}

/** The divider drawn on a pane's leading edge(s). */
export const PANE_DIVIDER = "1px solid var(--color-border)";

/** A usable weight: finite and positive; anything else falls back to 1. */
function weight(w: number | undefined): number {
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1;
}

/**
 * Percent-based grid slots for a tab's panes (#316). Panes group into rows by
 * `pane.row` (the array is row-major); each row's height is its `rowSizes`
 * weight share (default equal), and each pane's width is its `size` weight
 * share of its row. Slots are returned in pane order. Tolerates sparse or
 * short `rowSizes` and non-contiguous row numbers — rows render in ascending
 * `row` order regardless.
 */
export function paneSlots(panes: readonly GridPane[], rowSizes?: readonly number[]): PaneSlot[] {
  const rowValues = [...new Set(panes.map((p) => p.row ?? 0))].sort((a, b) => a - b);
  const rowWeights = rowValues.map((_, i) => weight(rowSizes?.[i]));
  const totalRowWeight = rowWeights.reduce((a, b) => a + b, 0);

  // Row geometry by row value: top offset, height, and position.
  const rowGeo = new Map<number, { top: number; height: number; pos: number }>();
  let top = 0;
  rowValues.forEach((rv, i) => {
    const height = (rowWeights[i] / totalRowWeight) * 100;
    rowGeo.set(rv, { top, height, pos: i });
    top += height;
  });

  // Total width weight per row, then a running left cursor per row.
  const rowTotals = new Map<number, number>();
  for (const p of panes) {
    const rv = p.row ?? 0;
    rowTotals.set(rv, (rowTotals.get(rv) ?? 0) + weight(p.size));
  }
  const cursor = new Map<number, number>();
  return panes.map((p) => {
    const rv = p.row ?? 0;
    const geo = rowGeo.get(rv)!;
    const width = (weight(p.size) / rowTotals.get(rv)!) * 100;
    const left = cursor.get(rv) ?? 0;
    cursor.set(rv, left + width);
    return {
      left,
      top: geo.top,
      width,
      height: geo.height,
      rowPos: geo.pos,
      firstInRow: left === 0,
      firstRow: geo.pos === 0,
    };
  });
}
