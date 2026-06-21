import { describe, it, expect } from "vitest";
import { PALETTE_CATEGORIES, parsePaletteOrder } from "@/lib/settings";

describe("parsePaletteOrder", () => {
  it("parses a full, valid order verbatim", () => {
    expect(parsePaletteOrder("terminals,groups,repos")).toEqual(["terminals", "groups", "repos"]);
  });

  it("defaults to the canonical order for the default string", () => {
    expect(parsePaletteOrder(PALETTE_CATEGORIES.join(","))).toEqual([
      "repos",
      "groups",
      "terminals",
    ]);
  });

  it("appends categories missing from a partial value, in canonical order", () => {
    expect(parsePaletteOrder("terminals")).toEqual(["terminals", "repos", "groups"]);
  });

  it("drops unknown and duplicate tokens, then completes the permutation", () => {
    expect(parsePaletteOrder("groups,bogus,groups,terminals")).toEqual([
      "groups",
      "terminals",
      "repos",
    ]);
  });

  it("falls back to the full canonical order for empty/corrupt input", () => {
    expect(parsePaletteOrder("")).toEqual(["repos", "groups", "terminals"]);
    expect(parsePaletteOrder("nonsense, , ,")).toEqual(["repos", "groups", "terminals"]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parsePaletteOrder("  groups , repos , terminals ")).toEqual([
      "groups",
      "repos",
      "terminals",
    ]);
  });
});
