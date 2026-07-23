import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings are read via selector: useSettings((s) => s.values.x).
let settingsValues = { autoFetch: true, autoFetchIntervalMinutes: 5 };
vi.mock("@/lib/settings", () => ({
  useSettings: (selector: (s: { values: typeof settingsValues }) => unknown) =>
    selector({ values: settingsValues }),
}));

const listRepos = vi.fn();
const gitFetchMany = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/ipc", () => ({
  ipc: {
    listRepos: (...args: unknown[]) => listRepos(...args),
    gitFetchMany: (...args: unknown[]) => gitFetchMany(...args),
  },
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

import { useAutoFetch } from "@/lib/useAutoFetch";

const INTERVAL_MS = 5 * 60_000;

// The tick() chain (listRepos -> gitFetchMany) is plain resolved-promise
// microtask work; a few turns drains it under fake timers.
async function drain() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setFocused(focused: boolean) {
  focusListener?.({ payload: focused });
}

// performance.now() drives the refocus "was a fetch due?" check; make it
// deterministic and independent of the fake timer clock.
let nowMs = 0;

describe("useAutoFetch (issue #273 — pause while unfocused)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    settingsValues = { autoFetch: true, autoFetchIntervalMinutes: 5 };
    focusListener = undefined;
    isFocused.mockResolvedValue(true);
    listRepos.mockResolvedValue([{ id: 1, missing: false, is_git_repo: true }]);
    gitFetchMany.mockClear();
    listRepos.mockClear();
    unlisten.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("A1: fetches on the interval while focused", async () => {
    renderHook(() => useAutoFetch());
    await drain();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(gitFetchMany).toHaveBeenCalledTimes(1);
    expect(gitFetchMany).toHaveBeenCalledWith([1]);
  });

  it("A2: clears the interval on focus loss — no fetch while unfocused", async () => {
    renderHook(() => useAutoFetch());
    await drain();

    setFocused(false);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(gitFetchMany).not.toHaveBeenCalled();
  });

  it("A3: runs one catch-up fetch on refocus when a full interval elapsed", async () => {
    renderHook(() => useAutoFetch());
    await drain();

    setFocused(false);
    nowMs = INTERVAL_MS; // a tick came due while unfocused
    setFocused(true);
    await drain();

    expect(gitFetchMany).toHaveBeenCalledTimes(1);
  });

  it("A4: does NOT catch up on a brief alt-tab (interval not yet due)", async () => {
    renderHook(() => useAutoFetch());
    await drain();

    setFocused(false);
    nowMs = 30_000; // away < interval
    setFocused(true);
    await drain();

    expect(gitFetchMany).not.toHaveBeenCalled();
  });

  it("A5: the in-flight running guard skips overlapping fetches", async () => {
    listRepos.mockReturnValue(new Promise(() => {})); // first fetch never settles
    renderHook(() => useAutoFetch());
    await drain();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // tick 1 starts, stays in flight
    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // tick 2 should early-return

    expect(listRepos).toHaveBeenCalledTimes(1);
  });

  it("A6: a window that starts unfocused doesn't fetch until focus is gained", async () => {
    isFocused.mockResolvedValue(false);
    renderHook(() => useAutoFetch());
    await drain(); // isFocused resolves false -> interval stopped

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(gitFetchMany).not.toHaveBeenCalled();

    nowMs = INTERVAL_MS; // a full interval has elapsed since mount
    setFocused(true);
    await drain();
    expect(gitFetchMany).toHaveBeenCalledTimes(1);
  });

  it("A7: after unmount, a focus change triggers no fetch and the listener is removed", async () => {
    const { unmount } = renderHook(() => useAutoFetch());
    await drain();

    unmount();
    await drain();
    expect(unlisten).toHaveBeenCalledTimes(1);

    nowMs = INTERVAL_MS;
    setFocused(true); // dead instance must not act
    await drain();
    expect(gitFetchMany).not.toHaveBeenCalled();
  });

  it("A6b: a focus event arriving before isFocused() resolves is not clobbered", async () => {
    isFocused.mockResolvedValue(false); // stale mount-time snapshot resolves later
    renderHook(() => useAutoFetch());

    setFocused(true); // live event says focused, before isFocused() resolves
    await drain(); // isFocused() resolves false but must NOT stop the interval

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(gitFetchMany).toHaveBeenCalledTimes(1);
  });

  it("A8: does nothing when autoFetch is disabled", async () => {
    settingsValues = { autoFetch: false, autoFetchIntervalMinutes: 5 };
    renderHook(() => useAutoFetch());
    await drain();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(gitFetchMany).not.toHaveBeenCalled();
  });
});
