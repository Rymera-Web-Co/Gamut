import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let reposChangedCb: ((event: { payload: number[] | null }) => void) | undefined;
const reposUnlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (event: { payload: number[] | null }) => void) => {
    if (name === "repos-changed") reposChangedCb = cb;
    return Promise.resolve(reposUnlisten);
  },
}));

let focusListener: ((event: { payload: boolean }) => void) | undefined;
const isFocused = vi.fn().mockResolvedValue(true);
const focusUnlisten = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused,
    onFocusChanged: (cb: (event: { payload: boolean }) => void) => {
      focusListener = cb;
      return Promise.resolve(focusUnlisten);
    },
  }),
}));

const invalidateQueries = vi.fn();
const setQueryData = vi.fn();
const getQueryState = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  queryClient: {
    invalidateQueries: (...args: unknown[]) => invalidateQueries(...args),
    setQueryData: (...args: unknown[]) => setQueryData(...args),
    getQueryState: (...args: unknown[]) => getQueryState(...args),
  },
}));

const repoStatusesFor = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: { repoStatusesFor: (...args: unknown[]) => repoStatusesFor(...args) },
}));

import { REPO_SCOPED_KEYS, useGitWatch } from "@/lib/useGitWatch";

const COALESCE_MS = 250;

async function drain() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function emit(payload: number[] | null) {
  reposChangedCb?.({ payload });
}
function setFocused(focused: boolean) {
  focusListener?.({ payload: focused });
}

describe("useGitWatch (issue #273 — hold flush while unfocused)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reposChangedCb = undefined;
    focusListener = undefined;
    isFocused.mockResolvedValue(true);
    repoStatusesFor.mockResolvedValue([]);
    invalidateQueries.mockClear();
    setQueryData.mockClear();
    repoStatusesFor.mockClear();
    reposUnlisten.mockClear();
    focusUnlisten.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("B1: coalesces and flushes changed repos while focused", async () => {
    renderHook(() => useGitWatch());
    await drain();

    emit([1, 2]);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(repoStatusesFor).toHaveBeenCalledWith([1, 2]);
  });

  it("B2: holds the flush while unfocused — no scan runs", async () => {
    renderHook(() => useGitWatch());
    await drain();

    setFocused(false);
    emit([1, 2]);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(repoStatusesFor).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("B3 (scoped): runs one round for the accumulated ids on refocus", async () => {
    renderHook(() => useGitWatch());
    await drain();

    setFocused(false);
    emit([1, 2]);
    await vi.advanceTimersByTimeAsync(COALESCE_MS); // still held
    expect(repoStatusesFor).not.toHaveBeenCalled();

    setFocused(true);
    await drain();

    expect(repoStatusesFor).toHaveBeenCalledTimes(1);
    expect(repoStatusesFor).toHaveBeenCalledWith([1, 2]);
    // Scoped repo keys invalidated for each accumulated id.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["branches", 1] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["branches", 2] });
  });

  it("B3 (full): a null payload while hidden becomes one full invalidation on refocus", async () => {
    renderHook(() => useGitWatch());
    await drain();

    setFocused(false);
    emit(null);
    setFocused(true);
    await drain();

    expect(repoStatusesFor).not.toHaveBeenCalled();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["repo-statuses"] });
    for (const key of REPO_SCOPED_KEYS) {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: [key] });
    }
  });

  it("B4: refocus with nothing accumulated runs no flush", async () => {
    renderHook(() => useGitWatch());
    await drain();

    setFocused(false);
    setFocused(true);
    await drain();

    expect(repoStatusesFor).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("B5: a pending flush is held (not fired) when focus is lost, then applied on refocus", async () => {
    renderHook(() => useGitWatch());
    await drain();

    emit([7]); // schedules a flush timer while focused
    setFocused(false); // ... lost before COALESCE_MS elapses
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(repoStatusesFor).not.toHaveBeenCalled();

    setFocused(true);
    await drain();
    expect(repoStatusesFor).toHaveBeenCalledTimes(1);
    expect(repoStatusesFor).toHaveBeenCalledWith([7]);
  });

  it("B7: an event arriving before isFocused() resolves false does not flush while hidden", async () => {
    isFocused.mockResolvedValue(false);
    renderHook(() => useGitWatch());

    emit([3]); // optimistically scheduled (focused assumed true)
    await drain(); // isFocused resolves false -> pending timer held
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(repoStatusesFor).not.toHaveBeenCalled();
  });

  it("B7b: a focus event arriving before isFocused() resolves is not clobbered", async () => {
    isFocused.mockResolvedValue(false); // stale mount-time snapshot resolves later
    renderHook(() => useGitWatch());

    setFocused(true); // live event says focused, before isFocused() resolves
    await drain(); // isFocused() resolves false but must NOT flip us to hidden

    emit([5]);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(repoStatusesFor).toHaveBeenCalledWith([5]);
  });

  it("B8: cleans up on unmount — no orphaned or dead-instance flush", async () => {
    const { unmount } = renderHook(() => useGitWatch());
    await drain();

    emit([1]); // pending flush timer
    unmount();
    await drain();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(reposUnlisten).toHaveBeenCalledTimes(1);
    expect(focusUnlisten).toHaveBeenCalledTimes(1);
    expect(repoStatusesFor).not.toHaveBeenCalled();

    setFocused(true); // dead instance must not flush
    await drain();
    expect(repoStatusesFor).not.toHaveBeenCalled();
  });
});
