import { describe, expect, it } from "vitest";

import { sessionDot, tabBusy } from "./activity";
import type { TermTab } from "@/store/ui";

describe("sessionDot", () => {
  it("is a static grey dot when idle with nothing pending", () => {
    expect(sessionDot(undefined, false)).toEqual({ color: "var(--color-faint)", pulse: false });
  });

  it("pulses while working, even with unseen output", () => {
    expect(sessionDot(undefined, true)).toEqual({ color: "var(--color-primary)", pulse: true });
    expect(sessionDot("output", true).pulse).toBe(true);
  });

  it("keeps unseen output as a static primary dot once idle", () => {
    expect(sessionDot("output", false)).toEqual({ color: "var(--color-primary)", pulse: false });
  });

  it("shows a bell or exit as a static dot, even while working", () => {
    expect(sessionDot("bell", true).pulse).toBe(false);
    expect(sessionDot("exit", false)).toEqual({
      color: "var(--color-destructive)",
      pulse: false,
    });
  });
});

describe("tabBusy", () => {
  const tab = { panes: [{ id: "a" }, { id: "b" }] } as unknown as TermTab;

  it("is true when any pane is busy", () => {
    expect(tabBusy(tab, { b: true })).toBe(true);
    expect(tabBusy(tab, { c: true })).toBe(false);
  });
});
