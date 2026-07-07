import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let focusListener: ((event: { payload: boolean }) => void) | undefined;
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: (cb: (event: { payload: boolean }) => void) => {
      focusListener = cb;
      return Promise.resolve(unlisten);
    },
  }),
}));

const getQueryState = vi.fn();
const invalidateQueries = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  queryClient: {
    getQueryState: (...args: unknown[]) => getQueryState(...args),
    invalidateQueries: (...args: unknown[]) => invalidateQueries(...args),
  },
}));

import { REPO_SCOPED_KEYS } from "@/lib/useGitWatch";
import { useRefreshOnFocus } from "@/lib/useRefreshOnFocus";

const NOW = 1_000_000;

function setFocused(focused: boolean) {
  focusListener?.({ payload: focused });
}

describe("useRefreshOnFocus (issue #227)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    focusListener = undefined;
    getQueryState.mockReset();
    invalidateQueries.mockReset();
    unlisten.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes repo-statuses and scoped keys when the data is stale on focus regain", () => {
    getQueryState.mockReturnValue({ dataUpdatedAt: NOW - 60_000 });
    renderHook(() => useRefreshOnFocus());

    setFocused(true);

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["repo-statuses"] });
    // repo-statuses + one invalidation per repo-scoped key.
    expect(invalidateQueries).toHaveBeenCalledTimes(1 + REPO_SCOPED_KEYS.length);
  });

  it("refreshes when the query has never run (no cached state)", () => {
    getQueryState.mockReturnValue(undefined);
    renderHook(() => useRefreshOnFocus());

    setFocused(true);

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["repo-statuses"] });
  });

  it("skips the refresh when the status data is still fresh", () => {
    getQueryState.mockReturnValue({ dataUpdatedAt: NOW - 5_000 });
    renderHook(() => useRefreshOnFocus());

    setFocused(true);

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("ignores focus-loss events", () => {
    getQueryState.mockReturnValue({ dataUpdatedAt: 0 });
    renderHook(() => useRefreshOnFocus());

    setFocused(false);

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("unregisters the focus listener on unmount", () => {
    const { unmount } = renderHook(() => useRefreshOnFocus());
    unmount();
    return Promise.resolve().then(() => {
      expect(unlisten).toHaveBeenCalledTimes(1);
    });
  });
});
