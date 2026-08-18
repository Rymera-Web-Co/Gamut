import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TermTab } from "@/store/ui";
import {
  isTabCycleChord,
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
    activeGroupId: 1,
    gt: { tabs: [tab], activeTabId: tab.id },
    activeTab: tab,
    ...overrides,
  };
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

/** Dispatch a keydown on window and return it, so defaultPrevented is checkable. */
function cycle(init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { code: "Tab", ctrlKey: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}

describe("Ctrl+Tab terminal tab cycling (#156, #323)", () => {
  it("Ctrl+Tab selects the next tab and wraps last→first", () => {
    const tabs = makeTabs(2);
    const ctx = makeCtx({ gt: { tabs, activeTabId: "tab-2" } });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = cycle();

    expect(ctx.selectTerminalTab).toHaveBeenCalledTimes(1);
    expect(ctx.selectTerminalTab).toHaveBeenCalledWith(1, "tab-1");
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl+Shift+Tab selects the previous tab and wraps first→last", () => {
    const tabs = makeTabs(2);
    const ctx = makeCtx({ gt: { tabs, activeTabId: "tab-1" } });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = cycle({ shiftKey: true });

    expect(ctx.selectTerminalTab).toHaveBeenCalledTimes(1);
    expect(ctx.selectTerminalTab).toHaveBeenCalledWith(1, "tab-2");
    expect(e.defaultPrevented).toBe(true);
  });

  it("steps both ways from a middle tab (no first/last shortcut)", () => {
    const tabs = makeTabs(3);
    const ctx = makeCtx({ gt: { tabs, activeTabId: "tab-2" } });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    cycle();
    expect(ctx.selectTerminalTab).toHaveBeenLastCalledWith(1, "tab-3");
    cycle({ shiftKey: true });
    expect(ctx.selectTerminalTab).toHaveBeenLastCalledWith(1, "tab-1");
  });

  it("selects nothing with fewer than 2 tabs but still swallows the chord", () => {
    const ctx = makeCtx(); // single tab
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));

    const e = cycle();

    expect(ctx.selectTerminalTab).not.toHaveBeenCalled();
    // Swallowed even as a no-op — un-prevented, the chord would fall through
    // to the webview's own Tab handling (focus traversal on WebKitGTK).
    expect(e.defaultPrevented).toBe(true);
  });

  it("declines the chord when focus is outside the terminal host", () => {
    const tabs = makeTabs(2);
    const ctx = makeCtx({ gt: { tabs, activeTabId: "tab-1" } });
    renderHook(() => useTerminalShortcuts({ current: host }, ctx));
    (document.activeElement as HTMLElement | null)?.blur();

    const e = cycle();

    expect(ctx.selectTerminalTab).not.toHaveBeenCalled();
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
