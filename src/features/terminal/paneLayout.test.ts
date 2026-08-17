import { describe, expect, it } from "vitest";

import { paneSlot } from "./paneLayout";

const DIVIDER = "1px solid var(--color-border)";

describe("paneSlot (#316)", () => {
  it("lays a row split out side by side with left-edge dividers", () => {
    expect(paneSlot("row", 0, 2)).toEqual({
      left: "0%",
      width: "50%",
      top: "0",
      height: "100%",
      borderLeft: "",
      borderTop: "",
    });
    expect(paneSlot("row", 1, 2)).toEqual({
      left: "50%",
      width: "50%",
      top: "0",
      height: "100%",
      borderLeft: DIVIDER,
      borderTop: "",
    });
  });

  it("lays a column split out stacked with top-edge dividers", () => {
    expect(paneSlot("column", 0, 2)).toEqual({
      left: "0",
      width: "100%",
      top: "0%",
      height: "50%",
      borderLeft: "",
      borderTop: "",
    });
    expect(paneSlot("column", 1, 2)).toEqual({
      left: "0",
      width: "100%",
      top: "50%",
      height: "50%",
      borderLeft: "",
      borderTop: DIVIDER,
    });
  });

  it("splits three stacked panes into thirds", () => {
    expect(paneSlot("column", 2, 3).top).toBe(`${(2 * 100) / 3}%`);
    expect(paneSlot("column", 2, 3).height).toBe(`${100 / 3}%`);
  });

  it("always assigns BOTH axes and BOTH borders, so a direction flip fully resets a reused node", () => {
    // A node styled by a column pass then re-laid-out as a row must not keep
    // its top offset or its top divider (and vice versa).
    const row = paneSlot("row", 1, 2);
    const column = paneSlot("column", 1, 2);
    for (const slot of [row, column]) {
      expect(Object.keys(slot).sort()).toEqual([
        "borderLeft",
        "borderTop",
        "height",
        "left",
        "top",
        "width",
      ]);
    }
    expect(row.borderTop).toBe("");
    expect(column.borderLeft).toBe("");
  });
});
