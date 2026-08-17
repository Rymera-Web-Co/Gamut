import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Group } from "@/lib/ipc";

// Feed the hook controlled group data without a QueryClient.
const useGroupsMock = vi.fn();
vi.mock("@/features/repos/api", () => ({
  useGroups: () => useGroupsMock(),
}));

import { useActiveGroupFallback } from "@/lib/useActiveGroupFallback";
import { useUiStore } from "@/store/ui";

function group(id: number, is_default = false): Group {
  return {
    id,
    name: is_default ? "All" : `group-${id}`,
    parent_id: null,
    sort: id,
    icon: null,
    is_default,
    folder_path: null,
    last_scan_at: null,
    root_repo_id: null,
  };
}

beforeEach(() => {
  useGroupsMock.mockReset();
  useUiStore.setState({ activeGroupId: null, groupSelections: {} });
});

describe("useActiveGroupFallback (hidden-sidebar boot regression)", () => {
  it("selects the default group when nothing is active (boot)", () => {
    useGroupsMock.mockReturnValue({ data: [group(1), group(2, true)] });
    renderHook(() => useActiveGroupFallback());
    expect(useUiStore.getState().activeGroupId).toBe(2);
  });

  it("falls back to the first group when none is flagged default", () => {
    useGroupsMock.mockReturnValue({ data: [group(3), group(4)] });
    renderHook(() => useActiveGroupFallback());
    expect(useUiStore.getState().activeGroupId).toBe(3);
  });

  it("re-targets when the active group has been deleted", () => {
    useUiStore.setState({ activeGroupId: 9 });
    useGroupsMock.mockReturnValue({ data: [group(1, true), group(2)] });
    renderHook(() => useActiveGroupFallback());
    expect(useUiStore.getState().activeGroupId).toBe(1);
  });

  it("leaves a valid selection alone", () => {
    useUiStore.setState({ activeGroupId: 2 });
    useGroupsMock.mockReturnValue({ data: [group(1, true), group(2)] });
    renderHook(() => useActiveGroupFallback());
    expect(useUiStore.getState().activeGroupId).toBe(2);
  });

  it("does nothing while the group list is empty or unloaded", () => {
    useGroupsMock.mockReturnValue({ data: [] });
    renderHook(() => useActiveGroupFallback());
    expect(useUiStore.getState().activeGroupId).toBeNull();

    useGroupsMock.mockReturnValue({ data: undefined });
    renderHook(() => useActiveGroupFallback());
    expect(useUiStore.getState().activeGroupId).toBeNull();
  });
});
