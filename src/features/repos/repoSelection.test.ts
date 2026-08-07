import { describe, expect, it } from "vitest";

import { rangeIds } from "./repoSelection";

describe("rangeIds", () => {
  const ordered = [10, 20, 30, 40, 50];

  it("selects the inclusive range in ascending order", () => {
    expect(rangeIds(ordered, 20, 40)).toEqual([20, 30, 40]);
  });

  it("selects the inclusive range when the anchor is after the clicked id (descending click)", () => {
    expect(rangeIds(ordered, 40, 20)).toEqual([20, 30, 40]);
  });

  it("falls back to just the clicked id when the anchor is missing", () => {
    expect(rangeIds(ordered, 999, 30)).toEqual([30]);
  });

  it("falls back to just the clicked id when the clicked id is missing", () => {
    expect(rangeIds(ordered, 20, 999)).toEqual([999]);
  });

  it("returns a single-element range when anchor and clicked id are the same", () => {
    expect(rangeIds(ordered, 30, 30)).toEqual([30]);
  });
});
