import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TermTab } from "@/store/ui";
import {
  flattenTerminalTabs,
  isTabCycleChord,
  stepTerminalTab,
  useTerminalShortcuts,
  type TerminalShortcutContext,
} from "./useTerminalShortcuts";

const tab: TermTab = {
  id: "tab-1",
  title: "t",
  panes: [{ id: "term-1", cwd: "/repo" }],
  activePaneId: "term-1",
};

function makeCtx(overrides: Partial<TerminalShortcutContext> = {}): TerminalShortcutContext {
  return {
    handleNewTab: vi.fn(),
    handleSplit: vi.fn(),
    handleCloseTab: vi.fn(),
    selectTerminalTab: vi.fn(),
    focusTerminal: vi.fn(),
    activeGroupId: 1,
    gt: { tabs: [tab], activeTabId: tab.id },
    activeTab: tab,
    groupOrder: [1],
    terminals: { 1: { tabs: [tab], activeTabId: tab.id } },
    ...overrides,
  };
}

/**
 * Context for a single group whose terminals are `tabs` — keeps `gt`,
 * `terminals` and `groupOrder` consistent, which the cross-group ring reads
 * (#328).
 */
function oneGroupCtx(tabs: TermTab[], activeTabId: string): TerminalShortcutContext {
  return makeCtx({
    gt: { tabs, activeTabId },
    terminals: { 1: { tabs, activeTabId } },
    groupOrder: [1],
    activeTab: tabs.find((t) => t.id === activeTabId),
  });
}

// The pane-scoped shortcuts require focus inside hostRef. Mirror the real DOM
// (panes mount an .xterm tree inside the host, and focus sits on xterm's
// textarea) so the fixture exercises the same shape the app produces (#323).
let host: HTMLDivElement;
let textarea: HTMLTextAreaElement;

beforeEach(() => {
  host = document.createElement("div");
  const xterm = document.createElement("div");
  xterm.className = "xterm";
  textarea = document.createElement("textarea");
  xterm.appendChild(textarea);
  host.appendChild(xterm);
  document.body.appendChild(host);
  textarea.focus();
});

afterEach(() => {
  host.remove();
});

function press(code: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { code, metaKey: true, ...init }));
}

function makeTabs(n: number): TermTab[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tab-${i + 1}`,
    title: `t${i + 1}`,
    panes: [{ id: `term-${i + 1}`, cwd: "/repo" }],
    activePaneId: `term-${i + 1}`,
  }));
}

/**
 * Two groups in sidebar order 1 then 2, holding `a` and `b` tabs; group 1 is
 * active on `activeTabId`. Group 2's ids are prefixed so the ring must step by
 * (groupId, tabId) rather than tab id alone (#328).
 */
function twoGroupCtx(a: TermTab[], b: TermTab[], activeTabId: string) {
  const renamed = b.map((t) => ({
    ...t,
    id: `g2-${t.id}`,
    panes: t.panes.map((p) => ({ ...p, id: `g2-${p.id}` })),
    activePaneId: `g2-${t.activePaneId}`,
  }));
  return {
    ctx: makeCtx({
      gt: { tabs: a, activeTabId },
      terminals: {
        1: { tabs: a, activeTabId },
        2: { tabs: renamed, activeTabId: renamed[0].id },
      },
      groupOrder: [1, 2],
    }),
    g2: renamed,
  };
}

/** Dispatch a keydown on window and return it, so defaultPrevented is checkable. */
function cycle(init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { code: "Tab", ctrlKey: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}

describe("Ctrl+Tab terminal tab cycling (#156, #323, #328)", () => {
  it("Ctrl+Tab selects the next tab and wraps last→first", () => {
    const tabs = makeTabs(2);
    const ctx = oneGroupCtx(tabs, "tab-2");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = cycle();

    expect(ctx.focusTerminal).toHaveBeenCalledTimes(1);
    expect(ctx.focusTerminal).toHaveBeenCalledWith(1, "tab-1", "term-1");
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl+Shift+Tab selects the previous tab and wraps first→last", () => {
    const tabs = makeTabs(2);
    const ctx = oneGroupCtx(tabs, "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = cycle({ shiftKey: true });

    expect(ctx.focusTerminal).toHaveBeenCalledTimes(1);
    expect(ctx.focusTerminal).toHaveBeenCalledWith(1, "tab-2", "term-2");
    expect(e.defaultPrevented).toBe(true);
  });

  it("steps both ways from a middle tab (no first/last shortcut)", () => {
    const tabs = makeTabs(3);
    const ctx = oneGroupCtx(tabs, "tab-2");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    cycle();
    expect(ctx.focusTerminal).toHaveBeenLastCalledWith(1, "tab-3", "term-3");
    cycle({ shiftKey: true });
    expect(ctx.focusTerminal).toHaveBeenLastCalledWith(1, "tab-1", "term-1");
  });

  it("selects nothing with fewer than 2 tabs but still swallows the chord", () => {
    const ctx = makeCtx(); // single tab, single group
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = cycle();

    expect(ctx.focusTerminal).not.toHaveBeenCalled();
    // Swallowed even as a no-op — un-prevented, the chord would fall through
    // to the webview's own Tab handling (focus traversal on WebKitGTK).
    expect(e.defaultPrevented).toBe(true);
  });

  it("declines the chord when focus is outside the terminal host", () => {
    const tabs = makeTabs(2);
    const ctx = oneGroupCtx(tabs, "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));
    (document.activeElement as HTMLElement | null)?.blur();

    const e = cycle();

    expect(ctx.focusTerminal).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  // ── Cross-group cycling (#328) ─────────────────────────────────────────────

  it("steps from the last tab of a group into the first tab of the next group", () => {
    const { ctx, g2 } = twoGroupCtx(makeTabs(2), makeTabs(2), "tab-2");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    cycle();

    expect(ctx.focusTerminal).toHaveBeenCalledWith(2, g2[0].id, g2[0].activePaneId);
  });

  it("wraps from the very first tab back to the last tab of the last group", () => {
    const { ctx, g2 } = twoGroupCtx(makeTabs(2), makeTabs(2), "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    cycle({ shiftKey: true });

    const last = g2[g2.length - 1];
    expect(ctx.focusTerminal).toHaveBeenCalledWith(2, last.id, last.activePaneId);
  });

  it("reaches another group's terminal even when the active group has only one tab", () => {
    const { ctx, g2 } = twoGroupCtx(makeTabs(1), makeTabs(1), "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = cycle();

    expect(ctx.focusTerminal).toHaveBeenCalledWith(2, g2[0].id, g2[0].activePaneId);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("flattenTerminalTabs / stepTerminalTab (#328)", () => {
  it("flattens groups in the given order and skips groups with no terminals", () => {
    const a = makeTabs(2);
    const b = makeTabs(1);
    const ring = flattenTerminalTabs([2, 1, 3], {
      1: { tabs: a, activeTabId: a[0].id },
      2: { tabs: b, activeTabId: b[0].id },
      3: { tabs: [], activeTabId: null },
    });

    expect(ring.map((e) => [e.groupId, e.tab.id])).toEqual([
      [2, "tab-1"],
      [1, "tab-1"],
      [1, "tab-2"],
    ]);
  });

  it("drops terminals of groups that are no longer in the group order", () => {
    const a = makeTabs(1);
    const ring = flattenTerminalTabs([1], {
      1: { tabs: a, activeTabId: a[0].id },
      99: { tabs: makeTabs(3), activeTabId: "tab-1" },
    });

    expect(ring).toHaveLength(1);
    expect(ring[0].groupId).toBe(1);
  });

  it("returns null with fewer than two terminals in the ring", () => {
    const a = makeTabs(1);
    const ring = flattenTerminalTabs([1], { 1: { tabs: a, activeTabId: a[0].id } });

    expect(stepTerminalTab(ring, 1, "tab-1", 1)).toBeNull();
  });

  it("returns null when the active tab is not in the ring", () => {
    const a = makeTabs(2);
    const ring = flattenTerminalTabs([1], { 1: { tabs: a, activeTabId: a[0].id } });

    expect(stepTerminalTab(ring, 7, "tab-1", 1)).toBeNull();
    expect(stepTerminalTab(ring, 1, "nope", 1)).toBeNull();
  });

  it("distinguishes same-named tab ids in different groups", () => {
    // Both groups have a "tab-1": the ring must step by (groupId, tabId), not
    // by tab id alone.
    const ring = flattenTerminalTabs([1, 2], {
      1: { tabs: makeTabs(1), activeTabId: "tab-1" },
      2: { tabs: makeTabs(1), activeTabId: "tab-1" },
    });

    expect(stepTerminalTab(ring, 1, "tab-1", 1)).toEqual(ring[1]);
    expect(stepTerminalTab(ring, 2, "tab-1", 1)).toEqual(ring[0]);
  });
});

describe("next / prev terminal via \u2318\u21e7] and \u2318\u21e7[ (#328)", () => {
  function bracket(code: "BracketRight" | "BracketLeft"): KeyboardEvent {
    const e = new KeyboardEvent("keydown", {
      code,
      metaKey: true,
      shiftKey: true,
      cancelable: true,
    });
    window.dispatchEvent(e);
    return e;
  }

  it("\u2318\u21e7] steps within the active group", () => {
    const ctx = oneGroupCtx(makeTabs(2), "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = bracket("BracketRight");

    expect(ctx.focusTerminal).toHaveBeenCalledWith(1, "tab-2", "term-2");
    expect(e.defaultPrevented).toBe(true);
  });

  it("\u2318\u21e7] steps out of the last tab into the next group", () => {
    const { ctx, g2 } = twoGroupCtx(makeTabs(2), makeTabs(2), "tab-2");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    bracket("BracketRight");

    expect(ctx.focusTerminal).toHaveBeenCalledWith(2, g2[0].id, g2[0].activePaneId);
  });

  it("\u2318\u21e7[ wraps from the very first tab to the last group's last tab", () => {
    const { ctx, g2 } = twoGroupCtx(makeTabs(1), makeTabs(2), "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    bracket("BracketLeft");

    const last = g2[g2.length - 1];
    expect(ctx.focusTerminal).toHaveBeenCalledWith(2, last.id, last.activePaneId);
  });

  it("does nothing \u2014 and does not swallow the key \u2014 with a single terminal", () => {
    const ctx = makeCtx(); // one group, one tab
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = bracket("BracketRight");

    expect(ctx.focusTerminal).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("\u2318\u2325 1-9 stays a per-group tab index (#328)", () => {
  function digit(n: number): KeyboardEvent {
    const e = new KeyboardEvent("keydown", {
      code: `Digit${n}`,
      metaKey: true,
      altKey: true,
      cancelable: true,
    });
    window.dispatchEvent(e);
    return e;
  }

  it("jumps inside the active group and never steps into another group", () => {
    const { ctx } = twoGroupCtx(makeTabs(2), makeTabs(2), "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = digit(2);

    expect(ctx.selectTerminalTab).toHaveBeenCalledWith(1, "tab-2");
    expect(ctx.focusTerminal).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("9 jumps to the active group's last tab, not the ring's last terminal", () => {
    const { ctx } = twoGroupCtx(makeTabs(3), makeTabs(2), "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    digit(9);

    expect(ctx.selectTerminalTab).toHaveBeenCalledWith(1, "tab-3");
    expect(ctx.focusTerminal).not.toHaveBeenCalled();
  });

  it("does nothing when the active group has no tab at that index", () => {
    const { ctx } = twoGroupCtx(makeTabs(1), makeTabs(3), "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = digit(3);

    expect(ctx.selectTerminalTab).not.toHaveBeenCalled();
    expect(ctx.focusTerminal).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("isTabCycleChord (#323)", () => {
  const chord = (type: string, init: KeyboardEventInit = {}) =>
    isTabCycleChord(new KeyboardEvent(type, { code: "Tab", ctrlKey: true, ...init }));

  it("matches keydown Ctrl+Tab and Ctrl+Shift+Tab, including key repeat", () => {
    expect(chord("keydown")).toBe(true);
    expect(chord("keydown", { shiftKey: true })).toBe(true);
    expect(chord("keydown", { repeat: true })).toBe(true);
  });

  it("ignores keyup and keypress so xterm keeps its default handling there", () => {
    expect(chord("keyup")).toBe(false);
    expect(chord("keypress")).toBe(false);
  });

  it("rejects near-miss chords", () => {
    expect(chord("keydown", { metaKey: true })).toBe(false); // Cmd+Ctrl noise
    expect(chord("keydown", { altKey: true })).toBe(false); // Ctrl+Alt+Tab
    const noCtrl = (init: KeyboardEventInit) =>
      isTabCycleChord(new KeyboardEvent("keydown", { code: "Tab", ...init }));
    expect(noCtrl({ metaKey: true })).toBe(false); // Cmd+Tab
    expect(noCtrl({ metaKey: true, shiftKey: true })).toBe(false); // Cmd+Shift+Tab
    expect(noCtrl({ shiftKey: true })).toBe(false); // Shift+Tab
    expect(noCtrl({})).toBe(false); // plain Tab
  });
});

describe("terminal split shortcuts (#316)", () => {
  it("⌘D splits right", () => {
    const ctx = makeCtx();
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    press("KeyD");

    expect(ctx.handleSplit).toHaveBeenCalledWith("row");
  });

  it("⌘⇧D splits down", () => {
    const ctx = makeCtx();
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    press("KeyD", { shiftKey: true });

    expect(ctx.handleSplit).toHaveBeenCalledWith("column");
  });

  it("neither split fires without focus inside the terminal host", () => {
    const ctx = makeCtx();
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));
    (document.activeElement as HTMLElement | null)?.blur();

    press("KeyD");
    press("KeyD", { shiftKey: true });

    expect(ctx.handleSplit).not.toHaveBeenCalled();
  });
});
