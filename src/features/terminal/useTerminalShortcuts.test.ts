import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TermTab } from "@/store/ui";
import { isMac } from "@/lib/shortcuts";

// jsdom reports `navigator.platform` as "", so the real `isMac()` is always
// false — the macOS half of the close-tab chord would never run. Mock it so the
// suite can drive both platforms (#338).
vi.mock("@/lib/shortcuts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shortcuts")>()),
  isMac: vi.fn(() => false),
}));
import {
  flattenTerminalTabs,
  isCloseTabChord,
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
    viewGroupId: 1,
    gt: { tabs: [tab], activeTabId: tab.id },
    activeTab: tab,
    terminalOpen: true,
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

  // #339: the position now comes from the VIEWED group, which is null before
  // the first focus and has a null `activeTabId` when it holds no tabs. A null
  // here would dead-end Ctrl+Tab forever, so an unmatched position enters the
  // ring at its first tab instead.
  it("enters the ring from the end the step heads away from, with no position", () => {
    const a = makeTabs(2);
    const ring = flattenTerminalTabs([1], { 1: { tabs: a, activeTabId: a[0].id } });

    expect(stepTerminalTab(ring, 7, "tab-1", 1)).toEqual(ring[0]);
    expect(stepTerminalTab(ring, 1, "nope", 1)).toEqual(ring[0]);
    expect(stepTerminalTab(ring, null, null, 1)).toEqual(ring[0]);
    // Backwards enters from the far end, so Ctrl+⇧+Tab's first press walks
    // back rather than forward.
    expect(stepTerminalTab(ring, null, null, -1)).toEqual(ring[ring.length - 1]);
    expect(stepTerminalTab(ring, 7, "tab-1", -1)).toEqual(ring[ring.length - 1]);
  });

  it("returns null for an empty ring, whatever the position", () => {
    expect(stepTerminalTab([], 1, "tab-1", 1)).toBeNull();
    expect(stepTerminalTab([], null, null, 1)).toBeNull();
  });

  it("enters a single-tab ring from an unmatched position", () => {
    const ring = flattenTerminalTabs([1], { 1: { tabs: makeTabs(1), activeTabId: "tab-1" } });

    // One tab and nowhere to step from is still a tab worth showing; one tab
    // that is already the position stays a no-op.
    expect(stepTerminalTab(ring, null, null, 1)).toEqual(ring[0]);
    expect(stepTerminalTab(ring, 1, "tab-1", 1)).toBeNull();
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

describe.each([
  { platform: "macOS", mac: true },
  { platform: "Linux/Windows", mac: false },
])("$platform: the close-tab chord closes the active terminal tab (#338)", ({ mac }) => {
  beforeEach(() => {
    vi.mocked(isMac).mockReturnValue(mac);
  });

  /**
   * Press the close-tab chord — ⌘W on macOS, Ctrl+W elsewhere, matching what
   * `isCloseTabChord` accepts on this platform. Cancelable so
   * `defaultPrevented` reports the real `preventDefault()` call rather than a
   * spy that would also pass on a non-cancelable event.
   */
  function closeTab(init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent("keydown", {
      code: "KeyW",
      metaKey: mac,
      ctrlKey: !mac,
      shiftKey: !mac,
      cancelable: true,
      bubbles: true,
      ...init,
    });
    window.dispatchEvent(e);
    return e;
  }

  /**
   * Focus an element outside `host`, attached to the document so it can take
   * focus. Cleaned up in `afterEach` rather than by the caller, so a failed
   * assertion cannot leave a focused node behind for the next test.
   */
  const outside: HTMLElement[] = [];
  function focusOutside(tag: "button" | "input" | "textarea") {
    const el = document.createElement(tag);
    document.body.appendChild(el);
    outside.push(el);
    el.focus();
    return el;
  }

  afterEach(() => {
    for (const el of outside.splice(0)) el.remove();
  });

  it("closes the active tab exactly once with the terminal focused", () => {
    const ctx = makeCtx();
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = closeTab();

    // Exactly once: a second listener acting on the same chord would close two
    // tabs per press and still satisfy a bare toHaveBeenCalledWith.
    expect(ctx.handleCloseTab).toHaveBeenCalledTimes(1);
    expect(ctx.handleCloseTab).toHaveBeenCalledWith("tab-1");
    expect(e.defaultPrevented).toBe(true);
  });

  it("closes the active tab with nothing focused — the bug in #338", () => {
    const ctx = makeCtx();
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));
    (document.activeElement as HTMLElement | null)?.blur();

    const e = closeTab();

    expect(ctx.handleCloseTab).toHaveBeenCalledWith("tab-1");
    expect(e.defaultPrevented).toBe(true);
  });

  // The sidebar, the review pane and the editor are all "some other element has
  // focus" — including text fields, where the chord must still win.
  it.each(["button", "input", "textarea"] as const)(
    "closes the active tab with focus in a <%s> outside the terminal host",
    (tag) => {
      const ctx = makeCtx();
      renderHook(() => useTerminalShortcuts({ current: host }, ctx));
      focusOutside(tag);

      const e = closeTab();

      expect(ctx.handleCloseTab).toHaveBeenCalledWith("tab-1");
      expect(e.defaultPrevented).toBe(true);
    },
  );

  it("does nothing — but still swallows the key — with no tabs open", () => {
    const ctx = makeCtx({ gt: { tabs: [], activeTabId: null }, activeTab: undefined });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = closeTab();

    expect(ctx.handleCloseTab).not.toHaveBeenCalled();
    // Swallowed even as a no-op: un-prevented, the key reaches the native
    // "Close Window" accelerator and takes every terminal session with it.
    expect(e.defaultPrevented).toBe(true);
  });

  // The branch sits above the `viewGroupId == null` gate, so these two pin
  // that every "nothing to close" context state resolves through `activeTab`
  // alone — and that none of them lets the key reach the window.
  it("does nothing — but still swallows the key — with no viewed group", () => {
    const ctx = makeCtx({ viewGroupId: null, gt: undefined, activeTab: undefined });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = closeTab();

    expect(ctx.handleCloseTab).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("does nothing when the viewed group has no tabs but another group does", () => {
    const other = makeTabs(2);
    const ctx = makeCtx({
      viewGroupId: 1,
      gt: { tabs: [], activeTabId: null },
      activeTab: undefined,
      groupOrder: [1, 2],
      terminals: { 1: { tabs: [], activeTabId: null }, 2: { tabs: other, activeTabId: "tab-1" } },
    });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = closeTab();

    // "The active tab" is the viewed group's own tab: a populated sibling group
    // is not a candidate, and the chord never reaches into one.
    expect(ctx.handleCloseTab).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("closes nothing — but still swallows the key — while the terminal is hidden", () => {
    const ctx = makeCtx({ terminalOpen: false });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = closeTab();

    // The pane stays mounted and CSS-hidden, so without this gate the chord
    // would kill an off-screen session with nothing on screen to show it.
    expect(ctx.handleCloseTab).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("closes one tab when the chord is held down", () => {
    const ctx = makeCtx();
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    closeTab();
    closeTab({ repeat: true });
    closeTab({ repeat: true });

    // The close is async, so every repeat would still read the same activeTab
    // and kill a burst of sessions on one held keypress.
    expect(ctx.handleCloseTab).toHaveBeenCalledTimes(1);
  });

  it("leaves plain Ctrl+W to the shell's delete-previous-word", () => {
    const ctx = makeCtx();
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    // The reason the chord takes ⇧ off macOS: Ctrl+W must still reach the PTY
    // as readline's delete-previous-word, on every platform.
    const e = new KeyboardEvent("keydown", {
      code: "KeyW",
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(e);

    expect(ctx.handleCloseTab).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("ignores the other platform's chord", () => {
    const ctx = makeCtx();
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = new KeyboardEvent("keydown", {
      code: "KeyW",
      metaKey: !mac,
      ctrlKey: mac,
      shiftKey: mac,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(e);

    expect(ctx.handleCloseTab).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("ignores the chord with ⌥ held, or with ⇧ on the wrong side of the split", () => {
    const ctx = makeCtx();
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const alt = closeTab({ altKey: true });
    // ⇧ is part of the chord off macOS, so flipping it is a near miss either way.
    const shift = closeTab({ shiftKey: mac });

    expect(ctx.handleCloseTab).not.toHaveBeenCalled();
    expect(alt.defaultPrevented).toBe(false);
    expect(shift.defaultPrevented).toBe(false);
  });
});

describe("isCloseTabChord (#338)", () => {
  const ev = (init: KeyboardEventInit, type = "keydown") =>
    new KeyboardEvent(type, { code: "KeyW", ...init });

  it("is ⌘W on macOS, where ⌘⇧W and Ctrl+W are not the chord", () => {
    expect(isCloseTabChord(ev({ metaKey: true }), true)).toBe(true);
    expect(isCloseTabChord(ev({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isCloseTabChord(ev({ ctrlKey: true }), true)).toBe(false);
  });

  it("is Ctrl+⇧+W elsewhere, and never plain Ctrl+W", () => {
    expect(isCloseTabChord(ev({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
    // The whole point of the ⇧: this one belongs to the shell.
    expect(isCloseTabChord(ev({ ctrlKey: true }), false)).toBe(false);
    expect(isCloseTabChord(ev({ metaKey: true }), false)).toBe(false);
  });

  it("rejects near-miss chords on both platforms", () => {
    for (const mac of [true, false]) {
      const primary = mac ? { metaKey: true } : { ctrlKey: true, shiftKey: true };
      expect(isCloseTabChord(ev({ ...primary, altKey: true }), mac)).toBe(false);
      expect(isCloseTabChord(ev({ ...primary, metaKey: true, ctrlKey: true }), mac)).toBe(false);
      expect(isCloseTabChord(ev({}), mac)).toBe(false);
      // keyup/keypress must keep xterm's default handling, as for the cycle chord.
      expect(isCloseTabChord(ev(primary, "keyup"), mac)).toBe(false);
    }
  });

  it("matches only the W key", () => {
    expect(
      isCloseTabChord(new KeyboardEvent("keydown", { code: "KeyQ", metaKey: true }), true),
    ).toBe(false);
  });
});

describe("the pane-scoped chords keep their focus gate (#338)", () => {
  /** Dispatch a cancelable chord on window and hand it back for inspection. */
  function chord(init: KeyboardEventInit): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { metaKey: true, cancelable: true, ...init });
    window.dispatchEvent(e);
    return e;
  }

  it("does nothing with focus outside the host — only ⌘T and ⌘W are app-wide", () => {
    const tabs = makeTabs(2);
    const ctx = oneGroupCtx(tabs, "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));
    (document.activeElement as HTMLElement | null)?.blur();

    const events = [
      chord({ code: "KeyD" }),
      chord({ code: "KeyD", shiftKey: true }),
      chord({ code: "BracketRight", shiftKey: true }),
      chord({ code: "BracketLeft", shiftKey: true }),
      chord({ code: "Tab", metaKey: false, ctrlKey: true }),
      chord({ code: "Digit1", altKey: true }),
    ];

    expect(ctx.handleSplit).not.toHaveBeenCalled();
    expect(ctx.focusTerminal).not.toHaveBeenCalled();
    expect(ctx.selectTerminalTab).not.toHaveBeenCalled();
    for (const e of events) expect(e.defaultPrevented).toBe(false);
  });

  it("still fires those chords with focus inside the host", () => {
    const tabs = makeTabs(2);
    const ctx = oneGroupCtx(tabs, "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    // The counterpart to the case above: without this, deleting every
    // pane-scoped handler would leave that one green.
    chord({ code: "KeyD" });
    chord({ code: "KeyD", shiftKey: true });
    chord({ code: "BracketRight", shiftKey: true });
    chord({ code: "Digit1", altKey: true });

    expect(ctx.handleSplit).toHaveBeenCalledWith("row");
    expect(ctx.handleSplit).toHaveBeenCalledWith("column");
    expect(ctx.focusTerminal).toHaveBeenCalledWith(1, "tab-2", "term-2");
    expect(ctx.selectTerminalTab).toHaveBeenCalledWith(1, "tab-1");
  });
});

// The terminal view moves independently of the active group (#339), so every
// pane-scoped chord must act on the group whose session is on screen. The
// context carries that group as `viewGroupId`; `gt` / `activeTab` come from the
// same group, exactly as TerminalPane derives them.
describe("the pane-scoped chords act on the viewed group (#339)", () => {
  /** Group 1 active + two tabs; group 2 viewed + two tabs, first one active. */
  function viewingGroup2() {
    const g1 = makeTabs(2);
    const g2 = makeTabs(2).map((t) => ({
      ...t,
      id: `g2-${t.id}`,
      panes: t.panes.map((p) => ({ ...p, id: `g2-${p.id}` })),
      activePaneId: `g2-${t.activePaneId}`,
    }));
    const terminals = {
      1: { tabs: g1, activeTabId: g1[0].id },
      2: { tabs: g2, activeTabId: g2[0].id },
    };
    return { g1, g2, terminals };
  }

  function key(init: KeyboardEventInit): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
    window.dispatchEvent(e);
    return e;
  }

  beforeEach(() => {
    vi.mocked(isMac).mockReturnValue(false);
  });

  it("Ctrl+Tab steps from the viewed group's tab, not the active group's", () => {
    const { g2, terminals } = viewingGroup2();
    const ctx = makeCtx({
      viewGroupId: 2,
      gt: terminals[2],
      activeTab: g2[0],
      groupOrder: [1, 2],
      terminals,
    });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    key({ code: "Tab", ctrlKey: true });

    // Group 1's active tab is tab-1, so a coupled ring would have landed on
    // tab-2 of group 1. The viewed ring starts at g2's tab-1 instead.
    expect(ctx.focusTerminal).toHaveBeenCalledWith(2, g2[1].id, g2[1].activePaneId);
  });

  it("steps again from the tab the previous press landed on", () => {
    const { g1, g2, terminals } = viewingGroup2();
    // The state after the press above: the view is on g2's last tab.
    const advanced = { 1: terminals[1], 2: { tabs: g2, activeTabId: g2[1].id } };
    const ctx = makeCtx({
      viewGroupId: 2,
      gt: advanced[2],
      activeTab: g2[1],
      groupOrder: [1, 2],
      terminals: advanced,
    });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    key({ code: "Tab", ctrlKey: true });

    // Last tab of the last group wraps to the very first — the ring still walks
    // every group, only the terminal view moves with it.
    expect(ctx.focusTerminal).toHaveBeenCalledWith(1, g1[0].id, g1[0].activePaneId);
  });

  it("Ctrl+Shift+Tab steps backwards from the viewed group's tab", () => {
    const { g1, g2, terminals } = viewingGroup2();
    const ctx = makeCtx({
      viewGroupId: 2,
      gt: terminals[2],
      activeTab: g2[0],
      groupOrder: [1, 2],
      terminals,
    });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    key({ code: "Tab", ctrlKey: true, shiftKey: true });

    expect(ctx.focusTerminal).toHaveBeenCalledWith(1, g1[1].id, g1[1].activePaneId);
  });

  it("⌘⌥1-9 indexes the viewed group's tabs", () => {
    const { g2, terminals } = viewingGroup2();
    const ctx = makeCtx({
      viewGroupId: 2,
      gt: terminals[2],
      activeTab: g2[0],
      groupOrder: [1, 2],
      terminals,
    });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = key({ code: "Digit2", metaKey: true, altKey: true });

    // Group id 2, and g2's own second tab: the rename to `viewGroupId` is what
    // makes it impossible to select a viewed tab id against the active group.
    expect(ctx.selectTerminalTab).toHaveBeenCalledWith(2, g2[1].id);
    expect(e.defaultPrevented).toBe(true);
  });

  it("the close-tab chord closes the viewed group's active tab", () => {
    const { g2, terminals } = viewingGroup2();
    const ctx = makeCtx({
      viewGroupId: 2,
      gt: terminals[2],
      activeTab: g2[0],
      groupOrder: [1, 2],
      terminals,
    });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    key({ code: "KeyW", ctrlKey: true, shiftKey: true });

    expect(ctx.handleCloseTab).toHaveBeenCalledWith(g2[0].id);
  });
});
