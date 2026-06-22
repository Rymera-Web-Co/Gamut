import { describe, it, expect } from "vitest";
import {
  bindingKey,
  findConflicts,
  resolveBindings,
  SHORTCUT_BY_ID,
  SHORTCUTS,
  type ShortcutId,
} from "@/lib/shortcuts";

describe("number-row defaults (issue #95)", () => {
  it("binds ⌘/Ctrl+1–9 to selecting the Nth group", () => {
    for (let n = 1; n <= 9; n++) {
      const def = SHORTCUT_BY_ID[`selectGroup${n}` as ShortcutId];
      expect(def).toBeDefined();
      expect(def.category).toBe("Groups");
      expect(def.defaultBinding).toEqual({ mod: true, code: `Digit${n}` });
    }
  });

  it("moves the view tabs onto literal Control + 1–4", () => {
    const views: [ShortcutId, number][] = [
      ["view.files", 1],
      ["view.history", 2],
      ["view.review", 3],
      ["view.pulls", 4],
    ];
    for (const [id, n] of views) {
      expect(SHORTCUT_BY_ID[id].defaultBinding).toEqual({ ctrl: true, code: `Digit${n}` });
    }
  });

  it("keeps group and view number rows on distinct abstract bindings (no default conflict)", () => {
    // `mod` and `ctrl` produce different binding keys, so the conflict checker
    // stays quiet even though both rows share the digit codes.
    expect(bindingKey({ mod: true, code: "Digit1" })).not.toBe(
      bindingKey({ ctrl: true, code: "Digit1" }),
    );
    expect(findConflicts(resolveBindings({}))).toEqual({});
  });

  it("never collides with the ⌘⌥1–9 terminal-tab row (those carry alt)", () => {
    for (const def of SHORTCUTS) {
      if (def.category !== "Groups") continue;
      expect(def.defaultBinding.alt).toBeFalsy();
    }
  });
});

describe("cycle-group defaults (issue #118)", () => {
  it("binds ⌘/Ctrl+↑/↓ to stepping between groups", () => {
    expect(SHORTCUT_BY_ID.cycleGroupPrev.defaultBinding).toEqual({ mod: true, code: "ArrowUp" });
    expect(SHORTCUT_BY_ID.cycleGroupNext.defaultBinding).toEqual({ mod: true, code: "ArrowDown" });
  });

  it("groups the cycle commands with the rest of the group navigation", () => {
    expect(SHORTCUT_BY_ID.cycleGroupPrev.category).toBe("Groups");
    expect(SHORTCUT_BY_ID.cycleGroupNext.category).toBe("Groups");
  });
});
