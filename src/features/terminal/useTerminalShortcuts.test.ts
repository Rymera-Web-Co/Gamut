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
  isCloseTabChord,
  isTabCycleChord,
  stepTerminalTab,
  useTerminalShortcuts,
  type TerminalShortcutContext,
} from "./useTerminalShortcuts";

const tab: TermTab = {
  id: "tab-1",
  groupId: 1,
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
    activeTab: tab,
    terminalOpen: true,
    terminals: { tabs: [tab], activeTabId: tab.id },
    ...overrides,
  };
}

/**
 * Context for a flat terminal list — the rail order the cycle chord walks
 * (#340). `activeTabId` sets the current position.
 */
function ringCtx(tabs: TermTab[], activeTabId: string | null): TerminalShortcutContext {
  return makeCtx({
    terminals: { tabs, activeTabId },
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

function makeTabs(n: number, groupId = 1): TermTab[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tab-${i + 1}`,
    groupId,
    title: `t${i + 1}`,
    panes: [{ id: `term-${i + 1}`, cwd: "/repo" }],
    activePaneId: `term-${i + 1}`,
  }));
}

/**
 * Two groups' tabs interleaved into one flat rail-order list, prefixed so ids
 * stay unique. The ring no longer cares which group a tab belongs to — this
 * pins that groupId plays no part in the step order (#340).
 */
function interleavedTabs(a: TermTab[], b: TermTab[]): TermTab[] {
  const renamed = b.map((t) => ({
    ...t,
    groupId: 2,
    id: `g2-${t.id}`,
    panes: t.panes.map((p) => ({ ...p, id: `g2-${p.id}` })),
    activePaneId: `g2-${t.activePaneId}`,
  }));
  return [...a, ...renamed];
}

/** Dispatch a keydown on window and return it, so defaultPrevented is checkable. */
function cycle(init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { code: "Tab", ctrlKey: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}

describe("Ctrl+Tab terminal tab cycling (#156, #323, #340)", () => {
  it("Ctrl+Tab selects the next tab and wraps last→first", () => {
    const tabs = makeTabs(2);
    const ctx = ringCtx(tabs, "tab-2");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = cycle();

    expect(ctx.focusTerminal).toHaveBeenCalledTimes(1);
    expect(ctx.focusTerminal).toHaveBeenCalledWith("tab-1", "term-1");
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl+Shift+Tab selects the previous tab and wraps first→last", () => {
    const tabs = makeTabs(2);
    const ctx = ringCtx(tabs, "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = cycle({ shiftKey: true });

    expect(ctx.focusTerminal).toHaveBeenCalledTimes(1);
    expect(ctx.focusTerminal).toHaveBeenCalledWith("tab-2", "term-2");
    expect(e.defaultPrevented).toBe(true);
  });

  it("steps both ways from a middle tab (no first/last shortcut)", () => {
    const tabs = makeTabs(3);
    const ctx = ringCtx(tabs, "tab-2");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    cycle();
    expect(ctx.focusTerminal).toHaveBeenLastCalledWith("tab-3", "term-3");
    cycle({ shiftKey: true });
    expect(ctx.focusTerminal).toHaveBeenLastCalledWith("tab-1", "term-1");
  });

  it("steps again from the tab the previous press landed on", () => {
    const tabs = interleavedTabs(makeTabs(2), makeTabs(2));
    // The state the app is in after a press landed on the ring's last tab: the
    // chord reads its position from `activeTabId`, so the next press must
    // continue from there and wrap, not restart from where the first began.
    const last = tabs[tabs.length - 1];
    const ctx = ringCtx(tabs, last.id);
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    cycle();

    expect(ctx.focusTerminal).toHaveBeenCalledWith(tabs[0].id, tabs[0].activePaneId);
  });

  it("selects nothing with fewer than 2 tabs but still swallows the chord", () => {
    const ctx = makeCtx(); // single tab
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = cycle();

    expect(ctx.focusTerminal).not.toHaveBeenCalled();
    // Swallowed even as a no-op — un-prevented, the chord would fall through
    // to the webview's own Tab handling (focus traversal on WebKitGTK).
    expect(e.defaultPrevented).toBe(true);
  });

  it("declines the chord when focus is outside the terminal host", () => {
    const tabs = makeTabs(2);
    const ctx = ringCtx(tabs, "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));
    (document.activeElement as HTMLElement | null)?.blur();

    const e = cycle();

    expect(ctx.focusTerminal).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  // ── The ring interleaves groups (#340) ─────────────────────────────────────

  it("steps from a tab of one group straight into the next group's tab, in rail order", () => {
    const tabs = interleavedTabs(makeTabs(2), makeTabs(2));
    const ctx = ringCtx(tabs, "tab-2");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    cycle();

    expect(ctx.focusTerminal).toHaveBeenCalledWith("g2-tab-1", "g2-term-1");
  });

  it("wraps from the very first tab back to the ring's last tab, whatever its group", () => {
    const tabs = interleavedTabs(makeTabs(2), makeTabs(2));
    const ctx = ringCtx(tabs, "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    cycle({ shiftKey: true });

    const last = tabs[tabs.length - 1];
    expect(ctx.focusTerminal).toHaveBeenCalledWith(last.id, last.activePaneId);
  });

  it("reaches another group's terminal even when the ring otherwise has just one tab either side", () => {
    const tabs = interleavedTabs(makeTabs(1), makeTabs(1));
    const ctx = ringCtx(tabs, "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = cycle();

    expect(ctx.focusTerminal).toHaveBeenCalledWith("g2-tab-1", "g2-term-1");
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("stepTerminalTab (#340)", () => {
  it("returns null with fewer than two terminals in the ring", () => {
    const ring = makeTabs(1);
    expect(stepTerminalTab(ring, "tab-1", 1)).toBeNull();
  });

  // #339: the position can be unmatched — null before the first focus, or a
  // stale id. A null return here would dead-end Ctrl+Tab forever, so an
  // unmatched position enters the ring at its first tab instead.
  it("enters the ring from the end the step heads away from, with no matching position", () => {
    const ring = makeTabs(2);

    expect(stepTerminalTab(ring, "nope", 1)).toEqual(ring[0]);
    expect(stepTerminalTab(ring, null, 1)).toEqual(ring[0]);
    // Backwards enters from the far end, so Ctrl+⇧+Tab's first press walks
    // back rather than forward.
    expect(stepTerminalTab(ring, null, -1)).toEqual(ring[ring.length - 1]);
    expect(stepTerminalTab(ring, "nope", -1)).toEqual(ring[ring.length - 1]);
  });

  it("returns null for an empty ring, whatever the position", () => {
    expect(stepTerminalTab([], "tab-1", 1)).toBeNull();
    expect(stepTerminalTab([], null, 1)).toBeNull();
  });

  it("enters a single-tab ring from an unmatched position", () => {
    const ring = makeTabs(1);

    // One tab and nowhere to step from is still a tab worth showing; one tab
    // that is already the position stays a no-op.
    expect(stepTerminalTab(ring, null, 1)).toEqual(ring[0]);
    expect(stepTerminalTab(ring, "tab-1", 1)).toBeNull();
  });

  it("steps by rail order across an interleaved ring, ignoring groupId", () => {
    const ring = interleavedTabs(makeTabs(1), makeTabs(1));

    expect(stepTerminalTab(ring, "tab-1", 1)).toEqual(ring[1]);
    expect(stepTerminalTab(ring, "g2-tab-1", 1)).toEqual(ring[0]);
  });
});

describe("next / prev terminal via ⌘⇧] and ⌘⇧[ (#340)", () => {
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

  it("⌘⇧] steps to the next tab in the flat list", () => {
    const ctx = ringCtx(makeTabs(2), "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = bracket("BracketRight");

    expect(ctx.focusTerminal).toHaveBeenCalledWith("tab-2", "term-2");
    expect(e.defaultPrevented).toBe(true);
  });

  it("⌘⇧] steps out of one group's last tab into the next group's first", () => {
    const tabs = interleavedTabs(makeTabs(2), makeTabs(2));
    const ctx = ringCtx(tabs, "tab-2");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    bracket("BracketRight");

    expect(ctx.focusTerminal).toHaveBeenCalledWith("g2-tab-1", "g2-term-1");
  });

  it("⌘⇧[ wraps from the very first tab to the ring's last tab", () => {
    const tabs = interleavedTabs(makeTabs(1), makeTabs(2));
    const ctx = ringCtx(tabs, "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    bracket("BracketLeft");

    const last = tabs[tabs.length - 1];
    expect(ctx.focusTerminal).toHaveBeenCalledWith(last.id, last.activePaneId);
  });

  it("does nothing — and does not swallow the key — with a single terminal", () => {
    const ctx = makeCtx(); // one tab
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = bracket("BracketRight");

    expect(ctx.focusTerminal).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("⌘⌥ 1-9 jumps by index into the flat list (#340)", () => {
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

  it("jumps to the tab at that rail position, whatever its group", () => {
    const tabs = interleavedTabs(makeTabs(2), makeTabs(2));
    const ctx = ringCtx(tabs, "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = digit(3);

    expect(ctx.selectTerminalTab).toHaveBeenCalledWith("g2-tab-1");
    expect(ctx.focusTerminal).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("9 jumps to the ring's last tab", () => {
    const tabs = interleavedTabs(makeTabs(3), makeTabs(2));
    const ctx = ringCtx(tabs, "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    digit(9);

    expect(ctx.selectTerminalTab).toHaveBeenCalledWith(tabs[tabs.length - 1].id);
    expect(ctx.focusTerminal).not.toHaveBeenCalled();
  });

  it("does nothing when the list has no tab at that index", () => {
    const ctx = ringCtx(makeTabs(1), "tab-1");
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
    const ctx = makeCtx({ terminals: { tabs: [], activeTabId: null }, activeTab: undefined });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = closeTab();

    expect(ctx.handleCloseTab).not.toHaveBeenCalled();
    // Swallowed even as a no-op: un-prevented, the key reaches the native
    // "Close Window" accelerator and takes every terminal session with it.
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
    const ctx = ringCtx(makeTabs(2), "tab-1");
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
    const ctx = ringCtx(makeTabs(2), "tab-1");
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    // The counterpart to the case above: without this, deleting every
    // pane-scoped handler would leave that one green.
    chord({ code: "KeyD" });
    chord({ code: "KeyD", shiftKey: true });
    chord({ code: "BracketRight", shiftKey: true });
    chord({ code: "Digit1", altKey: true });

    expect(ctx.handleSplit).toHaveBeenCalledWith("row");
    expect(ctx.handleSplit).toHaveBeenCalledWith("column");
    expect(ctx.focusTerminal).toHaveBeenCalledWith("tab-2", "term-2");
    expect(ctx.selectTerminalTab).toHaveBeenCalledWith("tab-1");
  });
});
