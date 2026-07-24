import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Repo } from "@/lib/ipc";

// Feed the hook controlled repo/group data without a QueryClient.
const useReposMock = vi.fn();
const useGroupsMock = vi.fn();
vi.mock("@/features/repos/api", () => ({
  useRepos: () => useReposMock(),
  useGroups: () => useGroupsMock(),
}));

import { useEmptyGroupSidebarReveal } from "@/lib/useEmptyGroupSidebarReveal";
import { useUiStore } from "@/store/ui";

const REPO_SIDEBAR_KEY = "gamut.repoSidebarHidden";

function group(id: number, isDefault = false): Group {
  return {
    id,
    name: `g${id}`,
    parent_id: null,
    sort: id,
    icon: null,
    is_default: isDefault,
    folder_path: null,
    last_scan_at: null,
    root_repo_id: null,
  };
}

function repo(id: number, groupIds: number[]): Repo {
  return {
    id,
    path: `/r${id}`,
    name: `r${id}`,
    default_branch: "main",
    last_opened: null,
    created_at: "",
    tag_ids: [],
    group_ids: groupIds,
    missing: false,
    is_git_repo: true,
    has_worktrees: false,
  };
}

// group 1 = default (owns ungrouped repos), 2 = manual with a repo, 3 = empty manual.
const GROUPS = [group(1, true), group(2), group(3)];
// r10 → default (group 1), r20 → group 2. group 3 has no members (empty).
const REPOS = [repo(10, []), repo(20, [2])];

/** Mount the hook with a given starting active group. */
function mount(startGroupId: number | null) {
  useUiStore.setState({ activeGroupId: startGroupId });
  return renderHook(() => useEmptyGroupSidebarReveal());
}

function switchTo(id: number | null) {
  act(() => useUiStore.setState({ activeGroupId: id }));
}

describe("useEmptyGroupSidebarReveal (#283)", () => {
  beforeEach(() => {
    localStorage.clear();
    useReposMock.mockReturnValue({ data: REPOS });
    useGroupsMock.mockReturnValue({ data: GROUPS });
    useUiStore.setState({ activeGroupId: null, repoSidebarHidden: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("B1: reveals the sidebar when switching to an empty group while hidden", () => {
    mount(2); // start in a non-empty group
    expect(useUiStore.getState().repoSidebarHidden).toBe(true);
    switchTo(3); // group 3 has no repos
    expect(useUiStore.getState().repoSidebarHidden).toBe(false);
  });

  it("B2: does not change the sidebar when switching to a non-empty group", () => {
    mount(3); // start somewhere (non-null so the next switch is a real one)
    useUiStore.setState({ repoSidebarHidden: true });
    switchTo(1); // default group has r10 → non-empty
    expect(useUiStore.getState().repoSidebarHidden).toBe(true);
  });

  it("B3: leaves an already-shown sidebar shown when entering an empty group", () => {
    useUiStore.setState({ repoSidebarHidden: false });
    mount(2);
    switchTo(3);
    expect(useUiStore.getState().repoSidebarHidden).toBe(false);
  });

  it("B4: does not auto-open on the initial mount transition (null → first group)", () => {
    mount(null); // app boot: no group yet
    switchTo(3); // first group assignment lands on an empty group
    expect(useUiStore.getState().repoSidebarHidden).toBe(true);
  });

  it("B5: does not re-open a user-hidden sidebar on a repos-data refetch (no group switch)", () => {
    mount(3); // sitting in the empty group, hidden by the user
    expect(useUiStore.getState().repoSidebarHidden).toBe(true);
    // A background refetch hands the hook a fresh array reference, same content.
    act(() => {
      useReposMock.mockReturnValue({ data: [...REPOS] });
      useUiStore.setState({}); // nudge a re-render without changing the group
    });
    expect(useUiStore.getState().repoSidebarHidden).toBe(true);
  });

  it("B6: an auto-open does not touch the persisted sidebar preference", () => {
    localStorage.setItem(REPO_SIDEBAR_KEY, "1"); // user's saved preference: hidden
    mount(2);
    switchTo(3);
    expect(useUiStore.getState().repoSidebarHidden).toBe(false); // revealed in-memory
    expect(localStorage.getItem(REPO_SIDEBAR_KEY)).toBe("1"); // preference untouched
  });
});
