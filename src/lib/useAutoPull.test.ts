import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auto-pull follows the global Auto-fetch setting (the one master switch for
// background git work), read via selector: useSettings((s) => s.values.x).
let settingsValues = { autoFetch: true };
vi.mock("@/lib/settings", () => ({
  useSettings: (selector: (s: { values: typeof settingsValues }) => unknown) =>
    selector({ values: settingsValues }),
}));

const runAutoPull = vi.fn();
vi.mock("@/lib/autoPull", () => ({
  runAutoPull: (...args: unknown[]) => runAutoPull(...args),
}));

const patchRepoStatuses = vi.fn();
const refreshScopedRepos = vi.fn();
vi.mock("@/lib/repoStatusRefresh", () => ({
  patchRepoStatuses: (...args: unknown[]) => patchRepoStatuses(...args),
  refreshScopedRepos: (...args: unknown[]) => refreshScopedRepos(...args),
}));

// The hook must not initiate any fetch of its own — launch stays as quiet as
// `useAutoFetch` deliberately keeps it. Spy on the whole ipc surface it could
// reach for so a future fetch call would fail this suite loudly.
const gitFetch = vi.fn();
const gitFetchMany = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    gitFetch: (...args: unknown[]) => gitFetch(...args),
    gitFetchMany: (...args: unknown[]) => gitFetchMany(...args),
  },
}));

let focusListener: ((event: { payload: boolean }) => void) | undefined;
const isFocused = vi.fn();
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

import { AUTO_PULL_MIN_GAP_MS, useAutoPull } from "@/lib/useAutoPull";

async function drain() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setFocused(focused: boolean) {
  focusListener?.({ payload: focused });
}

// performance.now() drives the focus throttle; make it deterministic.
let nowMs = 0;

describe("useAutoPull (issue #299 — launch and focus triggers)", () => {
  beforeEach(() => {
    nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    focusListener = undefined;
    settingsValues = { autoFetch: true };
    // `clearAllMocks` wipes calls, not implementations — so seed them after it.
    vi.clearAllMocks();
    isFocused.mockResolvedValue(true);
    runAutoPull.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("A16: pulls once on mount when the window is focused", async () => {
    renderHook(() => useAutoPull());
    await drain();

    expect(runAutoPull).toHaveBeenCalledTimes(1);
    // No candidate filter on the launch round: every opted-in repo is eligible.
    expect(runAutoPull).toHaveBeenCalledWith();
  });

  it("A16: a window that starts unfocused pulls nothing until focus is gained", async () => {
    isFocused.mockResolvedValue(false);
    renderHook(() => useAutoPull());
    await drain();

    expect(runAutoPull).not.toHaveBeenCalled();

    nowMs = AUTO_PULL_MIN_GAP_MS;
    setFocused(true);
    await drain();

    expect(runAutoPull).toHaveBeenCalledTimes(1);
  });

  it("A16: focus loss never triggers a round", async () => {
    isFocused.mockResolvedValue(false);
    renderHook(() => useAutoPull());
    await drain();

    nowMs = AUTO_PULL_MIN_GAP_MS * 3;
    setFocused(false);
    await drain();

    expect(runAutoPull).not.toHaveBeenCalled();
  });

  it("A16: initiates no fetch — the hook never calls git_fetch/git_fetch_many", async () => {
    renderHook(() => useAutoPull());
    await drain();

    nowMs = AUTO_PULL_MIN_GAP_MS;
    setFocused(true);
    await drain();

    expect(runAutoPull).toHaveBeenCalledTimes(2);
    expect(gitFetch).not.toHaveBeenCalled();
    expect(gitFetchMany).not.toHaveBeenCalled();
  });

  it("A16: does nothing after unmount, and removes its focus listener", async () => {
    const { unmount } = renderHook(() => useAutoPull());
    await drain();
    runAutoPull.mockClear();

    unmount();
    await drain();
    expect(unlisten).toHaveBeenCalledTimes(1);

    nowMs = AUTO_PULL_MIN_GAP_MS * 2;
    setFocused(true);
    await drain();
    expect(runAutoPull).not.toHaveBeenCalled();
  });

  it("A17: a regain just under the gap does not trigger a second round", async () => {
    renderHook(() => useAutoPull());
    await drain(); // launch round at nowMs = 0

    nowMs = AUTO_PULL_MIN_GAP_MS - 1;
    setFocused(true);
    await drain();

    expect(runAutoPull).toHaveBeenCalledTimes(1);
  });

  it("A17: a regain at the gap triggers exactly one more round", async () => {
    renderHook(() => useAutoPull());
    await drain();

    nowMs = AUTO_PULL_MIN_GAP_MS;
    setFocused(true);
    await drain();

    expect(runAutoPull).toHaveBeenCalledTimes(2);

    // …and immediately flipping back is throttled again from the new baseline.
    setFocused(true);
    await drain();
    expect(runAutoPull).toHaveBeenCalledTimes(2);
  });
});

describe("useAutoPull — refresh scoping (issue #299)", () => {
  beforeEach(() => {
    nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    focusListener = undefined;
    settingsValues = { autoFetch: true };
    vi.clearAllMocks();
    isFocused.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("A18: refreshes exactly the repos that pulled", async () => {
    runAutoPull.mockResolvedValue([3, 7]);
    renderHook(() => useAutoPull());
    await drain();

    expect(patchRepoStatuses).toHaveBeenCalledTimes(1);
    expect(patchRepoStatuses).toHaveBeenCalledWith([3, 7]);
    expect(refreshScopedRepos).toHaveBeenCalledWith([3, 7]);
  });

  it("A18: refreshes nothing when nothing was pulled", async () => {
    runAutoPull.mockResolvedValue([]);
    renderHook(() => useAutoPull());
    await drain();

    expect(patchRepoStatuses).not.toHaveBeenCalled();
    expect(refreshScopedRepos).not.toHaveBeenCalled();
  });

  it("A18: a round that resolves after unmount refreshes nothing", async () => {
    let release: (ids: number[]) => void = () => {};
    runAutoPull.mockReturnValue(
      new Promise<number[]>((resolve) => {
        release = resolve;
      }),
    );
    const { unmount } = renderHook(() => useAutoPull());
    await drain();

    unmount();
    release([5]);
    await drain();

    expect(patchRepoStatuses).not.toHaveBeenCalled();
    expect(refreshScopedRepos).not.toHaveBeenCalled();
  });
});

describe("useAutoPull — gated on the global Auto-fetch setting (issue #299)", () => {
  beforeEach(() => {
    nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    focusListener = undefined;
    settingsValues = { autoFetch: true };
    vi.clearAllMocks();
    isFocused.mockResolvedValue(true);
    runAutoPull.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("A25: with Auto-fetch off, launch pulls nothing", async () => {
    settingsValues = { autoFetch: false };
    renderHook(() => useAutoPull());
    await drain();

    expect(runAutoPull).not.toHaveBeenCalled();
  });

  it("A25: with Auto-fetch off, a focus regain pulls nothing either", async () => {
    settingsValues = { autoFetch: false };
    renderHook(() => useAutoPull());
    await drain();

    nowMs = AUTO_PULL_MIN_GAP_MS * 2;
    setFocused(true);
    await drain();

    expect(runAutoPull).not.toHaveBeenCalled();
  });

  it("A25: switching Auto-fetch back on pulls once, like coming back to the app", async () => {
    settingsValues = { autoFetch: false };
    const { rerender } = renderHook(() => useAutoPull());
    await drain();
    expect(runAutoPull).not.toHaveBeenCalled();

    settingsValues = { autoFetch: true };
    rerender();
    await drain();

    expect(runAutoPull).toHaveBeenCalledTimes(1);
  });

  it("A25: switching Auto-fetch off tears the triggers down", async () => {
    const { rerender } = renderHook(() => useAutoPull());
    await drain();
    runAutoPull.mockClear();

    settingsValues = { autoFetch: false };
    rerender();
    await drain();

    nowMs = AUTO_PULL_MIN_GAP_MS * 3;
    setFocused(true);
    await drain();

    expect(runAutoPull).not.toHaveBeenCalled();
  });
});
