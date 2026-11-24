import { describe, expect, it } from "vitest";

import { fitMenu } from "./fitMenu";

describe("fitMenu", () => {
  const vw = 1000;
  const vh = 800;

  it("opens at the cursor when the menu fits", () => {
    expect(fitMenu({ x: 100, y: 100 }, 200, 300, vw, vh)).toEqual({ x: 100, y: 100 });
  });

  it("opens above the cursor near the bottom edge", () => {
    expect(fitMenu({ x: 100, y: 700 }, 200, 300, vw, vh)).toEqual({ x: 100, y: 400 });
  });

  it("opens left of the cursor near the right edge", () => {
    expect(fitMenu({ x: 900, y: 100 }, 200, 300, vw, vh)).toEqual({ x: 700, y: 100 });
  });

  it("pins to the bottom edge when the menu fits on neither side", () => {
    expect(fitMenu({ x: 100, y: 400 }, 200, 700, vw, vh)).toEqual({ x: 100, y: 96 });
  });

  it("pins to the top edge when the menu is taller than the viewport", () => {
    expect(fitMenu({ x: 100, y: 400 }, 200, 900, vw, vh)).toEqual({ x: 100, y: 4 });
  });
});
