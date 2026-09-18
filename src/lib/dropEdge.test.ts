import { describe, expect, it } from "vitest";

import { dropEdge } from "./dropEdge";

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 100,
    x: 0,
    y: top,
    width: 100,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("dropEdge (#340)", () => {
  it('returns "before" above the vertical midpoint', () => {
    expect(dropEdge(rect(0, 20), 5)).toBe("before");
  });

  it('returns "after" below the vertical midpoint', () => {
    expect(dropEdge(rect(0, 20), 15)).toBe("after");
  });

  it('resolves the exact midpoint to "before" (documented tie-break)', () => {
    expect(dropEdge(rect(0, 20), 10)).toBe("before");
  });
});
