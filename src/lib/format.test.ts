import { describe, it, expect } from "vitest";
import { GRAPH_COLORS, graphColor, relativeTime, relativeTimeSqlite } from "@/lib/format";

describe("graphColor", () => {
  it("returns the color at the given lane index", () => {
    expect(graphColor(0)).toBe(GRAPH_COLORS[0]);
    expect(graphColor(2)).toBe(GRAPH_COLORS[2]);
  });

  it("wraps around when the index exceeds the palette length", () => {
    expect(graphColor(GRAPH_COLORS.length)).toBe(GRAPH_COLORS[0]);
    expect(graphColor(GRAPH_COLORS.length + 3)).toBe(GRAPH_COLORS[3]);
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000; // fixed "now" in ms
  const nowSec = now / 1000;

  it("reports seconds for very recent timestamps", () => {
    expect(relativeTime(nowSec - 5, now)).toBe("5s ago");
  });

  it("rolls up into minutes, hours, and days", () => {
    expect(relativeTime(nowSec - 90, now)).toBe("1m ago");
    expect(relativeTime(nowSec - 60 * 60 * 3, now)).toBe("3h ago");
    expect(relativeTime(nowSec - 60 * 60 * 24 * 2, now)).toBe("2d ago");
  });

  it("clamps future timestamps to 0s", () => {
    expect(relativeTime(nowSec + 1000, now)).toBe("0s ago");
  });
});

describe("relativeTimeSqlite", () => {
  it("parses a UTC SQLite datetime string", () => {
    const now = Date.parse("2001-09-09T01:46:40Z"); // 1_000_000_000s
    expect(relativeTimeSqlite("2001-09-09 01:46:35", now)).toBe("5s ago");
  });

  it("returns an empty string for unparseable input", () => {
    expect(relativeTimeSqlite("not a date")).toBe("");
  });
});
