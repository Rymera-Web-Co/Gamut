import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings are read via selector: useSettings((s) => s.values.x).
let settingsValues = { autoFetch: true, autoFetchIntervalMinutes: 5 };
vi.mock("@/lib/settings", () => ({
  useSettings: (selector: (s: { values: typeof settingsValues }) => unknown) =>
    selector({ values: settingsValues }),
}));

const listRepos = vi.fn();
// `git_fetch_many` returns a per-repo `FetchResult[]` (`{repo_id, ok, error}`).
const gitFetchMany = vi.fn().mockResolvedValue([{ repo_id: 1, ok: true, error: null }]);
const repoStatusesFor = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/ipc", () => ({
  ipc: {
    listRepos: (...args: unknown[]) => listRepos(...args),
    gitFetchMany: (...args: unknown[]) => gitFetchMany(...args),
    repoStatusesFor: (...args: unknown[]) => {
      callOrder.push("repoStatusesFor");
      return repoStatusesFor(...args);
    },
  },
}));

const invalidateQueries = vi.fn();
const setQueryData = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  queryClient: {
    invalidateQueries: (...args: unknown[]) => invalidateQueries(...args),
    setQueryData: (...args: unknown[]) => setQueryData(...args),
  },
}));

// Auto-pull rides on this hook's fetch cycle (#299). Recording its calls in the
// same order log as the status refresh is what pins the ordering the perf issues
// require: the pull lands *before* the post-fetch status read.
const callOrder: string[] = [];
const runAutoPull = vi.fn();
vi.mock("@/lib/autoPull", () => ({
  runAutoPull: (...args: unknown[]) => {
    callOrder.push("autoPull");
    return runAutoPull(...args);
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
    gitFetchMany.mockResolvedValue([{ repo_id: 1, ok: true, error: null }]);
    repoStatusesFor.mockResolvedValue([]);
    runAutoPull.mockResolvedValue([]);
    runAutoPull.mockClear();
    callOrder.length = 0;
    gitFetchMany.mockClear();
    listRepos.mockClear();
    repoStatusesFor.mockClear();
    invalidateQueries.mockClear();
    setQueryData.mockClear();
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

describe("useAutoFetch (issue #275 — drive post-fetch refresh directly)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    settingsValues = { autoFetch: true, autoFetchIntervalMinutes: 5 };
    focusListener = undefined;
    isFocused.mockResolvedValue(true);
    listRepos.mockResolvedValue([
      { id: 1, missing: false, is_git_repo: true },
      { id: 2, missing: false, is_git_repo: true },
    ]);
    gitFetchMany.mockResolvedValue([
      { repo_id: 1, ok: true, error: null },
      { repo_id: 2, ok: true, error: null },
    ]);
    repoStatusesFor.mockResolvedValue([]);
    runAutoPull.mockResolvedValue([]);
    runAutoPull.mockClear();
    callOrder.length = 0;
    gitFetchMany.mockClear();
    listRepos.mockClear();
    repoStatusesFor.mockClear();
    invalidateQueries.mockClear();
    setQueryData.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("A9: patches repo-statuses for the repos that fetched successfully", async () => {
    renderHook(() => useAutoFetch());
    await drain();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await drain();

    expect(repoStatusesFor).toHaveBeenCalledTimes(1);
    expect(repoStatusesFor).toHaveBeenCalledWith([1, 2]);
    // Scoped (patch) path, not a full-fleet invalidation, on the happy path.
    expect(setQueryData).toHaveBeenCalledWith(["repo-statuses"], expect.any(Function));
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["repo-statuses"] });
  });

  it("A10: excludes repos whose fetch failed from the refresh", async () => {
    gitFetchMany.mockResolvedValue([
      { repo_id: 1, ok: true, error: null },
      { repo_id: 2, ok: false, error: "boom" },
    ]);
    renderHook(() => useAutoFetch());
    await drain();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await drain();

    expect(repoStatusesFor).toHaveBeenCalledWith([1]);
  });

  it("A11: does not refresh when no repo fetched successfully", async () => {
    gitFetchMany.mockResolvedValue([
      { repo_id: 1, ok: false, error: "boom" },
      { repo_id: 2, ok: false, error: "boom" },
    ]);
    renderHook(() => useAutoFetch());
    await drain();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await drain();

    expect(repoStatusesFor).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(setQueryData).not.toHaveBeenCalled();
  });

  it("A12: invalidates the per-repo scoped queries for the succeeded repos", async () => {
    renderHook(() => useAutoFetch());
    await drain();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await drain();

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["branches", 1] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["branches", 2] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["sync-status", 1] });
  });
});

describe("useAutoFetch (issue #299 — auto-pull rides the fetch cycle)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    settingsValues = { autoFetch: true, autoFetchIntervalMinutes: 5 };
    focusListener = undefined;
    // `clearAllMocks` wipes calls, not implementations — so seed them after it.
    vi.clearAllMocks();
    callOrder.length = 0;
    isFocused.mockResolvedValue(true);
    listRepos.mockResolvedValue([
      { id: 1, missing: false, is_git_repo: true },
      { id: 2, missing: false, is_git_repo: true },
    ]);
    gitFetchMany.mockResolvedValue([
      { repo_id: 1, ok: true, error: null },
      { repo_id: 2, ok: true, error: null },
    ]);
    repoStatusesFor.mockResolvedValue([]);
    runAutoPull.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("A14: auto-pulls the repos whose fetch succeeded", async () => {
    gitFetchMany.mockResolvedValue([
      { repo_id: 1, ok: true, error: null },
      { repo_id: 2, ok: false, error: "boom" },
    ]);
    renderHook(() => useAutoFetch());
    await drain();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await drain();

    expect(runAutoPull).toHaveBeenCalledTimes(1);
    // The already-fetched repo list rides along so the round doesn't re-list.
    expect(runAutoPull).toHaveBeenCalledWith(
      [1],
      [
        { id: 1, missing: false, is_git_repo: true },
        { id: 2, missing: false, is_git_repo: true },
      ],
    );
  });

  it("A14: the pull completes before the post-fetch status read", async () => {
    runAutoPull.mockResolvedValue([1]);
    renderHook(() => useAutoFetch());
    await drain();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await drain();

    expect(callOrder).toEqual(["autoPull", "repoStatusesFor"]);
  });

  it("A15: one status round covers both the fetch and the pull", async () => {
    runAutoPull.mockResolvedValue([1, 2]);
    renderHook(() => useAutoFetch());
    await drain();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await drain();

    // The pull rode along inside the fetch's own refresh — not a second round.
    expect(repoStatusesFor).toHaveBeenCalledTimes(1);
    expect(repoStatusesFor).toHaveBeenCalledWith([1, 2]);
  });

  it("A14: no repo fetched successfully → no pull round at all", async () => {
    gitFetchMany.mockResolvedValue([
      { repo_id: 1, ok: false, error: "boom" },
      { repo_id: 2, ok: false, error: "boom" },
    ]);
    renderHook(() => useAutoFetch());
    await drain();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await drain();

    expect(runAutoPull).not.toHaveBeenCalled();
  });

  it("a failing pull round never costs the fetch cycle its status refresh", async () => {
    runAutoPull.mockRejectedValue(new Error("pull exploded"));
    renderHook(() => useAutoFetch());
    await drain();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await drain();

    // The fetch succeeded, so its own refresh must still happen — a rejected pull
    // must not divert the tick into its catch and leave stale ahead/behind counts
    // for a whole interval.
    expect(repoStatusesFor).toHaveBeenCalledTimes(1);
    expect(repoStatusesFor).toHaveBeenCalledWith([1, 2]);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["branches", 1] });

    // …and the next tick still runs.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await drain();
    expect(runAutoPull).toHaveBeenCalledTimes(2);
  });
});
