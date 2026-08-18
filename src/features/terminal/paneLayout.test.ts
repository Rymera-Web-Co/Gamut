import { describe, expect, it } from "vitest";

import { paneSlots } from "./paneLayout";

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
