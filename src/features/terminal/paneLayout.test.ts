import { describe, expect, it } from "vitest";

import { paneSlots, resizePair } from "./paneLayout";

/** Rounded geometry tuple for terse assertions: [left, top, width, height]. */
function geo(slots: ReturnType<typeof paneSlots>) {
  return slots.map((s) => [s.left, s.top, s.width, s.height].map((n) => Math.round(n * 100) / 100));
}

describe("paneSlots (#316)", () => {
  it("lays one row out side by side", () => {
    const slots = paneSlots([{ row: 0 }, { row: 0 }]);
    expect(geo(slots)).toEqual([
      [0, 0, 50, 100],
      [50, 0, 50, 100],
    ]);
    expect(slots.map((s) => s.firstInRow)).toEqual([true, false]);
    expect(slots.map((s) => s.firstRow)).toEqual([true, true]);
  });

  it("lays 50/50 over 100 out as two rows", () => {
    const slots = paneSlots([{ row: 0 }, { row: 0 }, { row: 1 }]);
    expect(geo(slots)).toEqual([
      [0, 0, 50, 50],
      [50, 0, 50, 50],
      [0, 50, 100, 50],
    ]);
  });

  it("lays 33/33/33 over 50/50 out as two rows", () => {
    const slots = paneSlots([{ row: 0 }, { row: 0 }, { row: 0 }, { row: 1 }, { row: 1 }]);
    expect(geo(slots)).toEqual([
      [0, 0, 33.33, 50],
      [33.33, 0, 33.33, 50],
      [66.67, 0, 33.33, 50],
      [0, 50, 50, 50],
      [50, 50, 50, 50],
    ]);
  });

  it("applies pane width weights within a row", () => {
    const slots = paneSlots([
      { row: 0, size: 3 },
      { row: 0, size: 1 },
    ]);
    expect(geo(slots)).toEqual([
      [0, 0, 75, 100],
      [75, 0, 25, 100],
    ]);
  });

  it("applies row height weights across rows", () => {
    const slots = paneSlots([{ row: 0 }, { row: 1 }], [1, 3]);
    expect(geo(slots)).toEqual([
      [0, 0, 100, 25],
      [0, 25, 100, 75],
    ]);
  });

  it("marks divider edges: firstInRow / firstRow / rowPos", () => {
    const slots = paneSlots([{ row: 0 }, { row: 0 }, { row: 1 }]);
    expect(slots.map((s) => [s.firstInRow, s.firstRow, s.rowPos])).toEqual([
      [true, true, 0],
      [false, true, 0],
      [true, false, 1],
    ]);
  });

  it("resizePair converts a pixel drag into weights, conserving the pair total", () => {
    // Two equal panes on a 1000px axis: +250px moves a quarter of the axis
    // weight (2) from right to left.
    expect(resizePair(1, 1, 2, 250, 1000, 0.08)).toEqual([1.5, 0.5]);
    // Only the pair rebalances: a three-pane row's total (3) scales the delta.
    const [a, b] = resizePair(1, 1, 3, 100, 1000, 0.08);
    expect(a + b).toBe(2);
    expect(a).toBeCloseTo(1.3);
  });

  it("resizePair clamps both edges at minShare of the axis total", () => {
    // Dragging far right: the right pane floors at 8% of the axis (0.16 of 2).
    const [a, b] = resizePair(1, 1, 2, 5000, 1000, 0.08);
    expect(a).toBeCloseTo(1.84);
    expect(b).toBeCloseTo(0.16);
    // Far left mirrors it.
    const [c, d] = resizePair(1, 1, 2, -5000, 1000, 0.08);
    expect(c).toBeCloseTo(0.16);
    expect(d).toBeCloseTo(1.84);
  });

  it("resizePair keeps responding when the pair can't afford the minimum", () => {
    // Both neighbours already at the floor (pairTotal 0.32 = 2 × 8% of 2):
    // the floor relaxes to an equal split, so the divider still tracks.
    const [a, b] = resizePair(0.16, 0.16, 2, 5000, 1000, 0.08);
    expect(a).toBeCloseTo(0.16);
    expect(b).toBeCloseTo(0.16);
    const [c, d] = resizePair(0.1, 0.22, 2, -5000, 1000, 0.08);
    expect(c + d).toBeCloseTo(0.32);
    expect(c).toBeCloseTo(0.16); // clamped at pairTotal/2, not axis minShare
  });

  it("resizePair is a no-op on a zero-length axis", () => {
    expect(resizePair(1, 1, 2, 100, 0, 0.08)).toEqual([1, 1]);
  });

  it("tolerates absent rows (pre-grid blobs), sparse rowSizes, and bad weights", () => {
    // No row fields at all → one side-by-side row (the pre-#316 layout).
    expect(geo(paneSlots([{}, {}]))).toEqual([
      [0, 0, 50, 100],
      [50, 0, 50, 100],
    ]);
    // rowSizes shorter than the row count and non-positive sizes fall back to 1.
    const slots = paneSlots([{ row: 0, size: -2 }, { row: 1 }], [2]);
    expect(geo(slots)).toEqual([
      [0, 0, 100, 66.67],
      [0, 66.67, 100, 33.33],
    ]);
  });
});
