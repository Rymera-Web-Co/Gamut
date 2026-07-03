import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: { recordStall: vi.fn().mockResolvedValue(undefined) },
}));

let focusListener: ((event: { payload: boolean }) => void) | undefined;
const isFocused = vi.fn().mockResolvedValue(true);
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused,
    onFocusChanged: (cb: (event: { payload: boolean }) => void) => {
      focusListener = cb;
      return Promise.resolve(unlisten);
    },
  }),
}));

import { ipc } from "@/lib/ipc";
import { useMainThreadWatchdog } from "@/lib/useMainThreadWatchdog";

function setFocused(focused: boolean) {
  focusListener?.({ payload: focused });
}

describe("useMainThreadWatchdog (issue #209)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isFocused.mockResolvedValue(true);
    focusListener = undefined;
    unlisten.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(ipc.recordStall).mockClear();
    unlisten.mockClear();
  });

  it("stops ticking once the window loses focus", () => {
    renderHook(() => useMainThreadWatchdog());
    expect(vi.getTimerCount()).toBe(1);

    setFocused(false);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes ticking on refocus without reporting a false stall", () => {
    renderHook(() => useMainThreadWatchdog());

    setFocused(false);
    // Time passes while unfocused — in a real WebView this tick would have
    // been throttled or suspended entirely.
    vi.advanceTimersByTime(60_000);
    setFocused(true);
    expect(vi.getTimerCount()).toBe(1);

    // The first tick after resuming should measure from the resume point,
    // not from the last tick before losing focus, so it must not look like a
    // stall.
    vi.advanceTimersByTime(1000);
    expect(ipc.recordStall).not.toHaveBeenCalled();
  });

  it("unregisters the focus listener on unmount", () => {
    const { unmount } = renderHook(() => useMainThreadWatchdog());
    unmount();
    return Promise.resolve().then(() => {
      expect(unlisten).toHaveBeenCalledTimes(1);
    });
  });
});
