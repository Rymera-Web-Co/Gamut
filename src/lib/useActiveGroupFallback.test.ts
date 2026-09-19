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

  // #340: the terminal list is global, so a deleted group no longer takes its
  // terminals off screen with it. An orphan would keep a live shell while naming
  // no group and offering no row to close it from, so it is re-homed instead.
  it("re-homes a terminal whose group was deleted onto the fallback group", () => {
    useUiStore.setState({
      activeGroupId: 1,
      terminals: {
        activeTabId: "tab-9",
        tabs: [
          {
            id: "tab-1",
            groupId: 1,
            title: "kept",
            panes: [{ id: "term-1", cwd: "/a" }],
            activePaneId: "term-1",
          },
          {
            id: "tab-9",
            groupId: 9,
            title: "orphan",
            panes: [{ id: "term-9", cwd: "/b" }],
            activePaneId: "term-9",
          },
        ],
      },
    });
    useGroupsMock.mockReturnValue({ data: [group(1, true), group(2)] });

    renderHook(() => useActiveGroupFallback());

    const { tabs, activeTabId } = useUiStore.getState().terminals;
    expect(tabs.map((t) => t.groupId)).toEqual([1, 1]);
    // Only the group moves: the tab, its order and the active selection stay.
    expect(tabs.map((t) => t.id)).toEqual(["tab-1", "tab-9"]);
    expect(tabs[1].panes[0].id).toBe("term-9");
    expect(activeTabId).toBe("tab-9");
  });

  it("leaves terminals alone when every group is still live", () => {
    const tabs = [
      {
        id: "tab-1",
        groupId: 2,
        title: "kept",
        panes: [{ id: "term-1", cwd: "/a" }],
        activePaneId: "term-1",
      },
    ];
    useUiStore.setState({ activeGroupId: 2, terminals: { activeTabId: "tab-1", tabs } });
    useGroupsMock.mockReturnValue({ data: [group(1, true), group(2)] });

    renderHook(() => useActiveGroupFallback());

    // Reference-identical: a needless rewrite would wake the persistence
    // subscriber and re-report the registry on every group query.
    expect(useUiStore.getState().terminals.tabs).toBe(tabs);
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
