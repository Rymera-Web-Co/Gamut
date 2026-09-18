import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Repo } from "@/lib/ipc";
import { DEFAULTS, useSettings } from "@/lib/settings";
import { DragGhost } from "@/lib/usePointerDnd";
import { useUiStore } from "@/store/ui";

// Every ipc entry point reachable from the mounted tree (Sidebar + its
// children: DiscoverDialog, GroupDialog, ConfirmRemoveReposDialog). Most are
// never invoked in these tests — they're stubbed so an accidental call fails
// loudly instead of throwing "not a function".
const mocks = vi.hoisted(() => ({
  listRepos: vi.fn(),
  listGroups: vi.fn(),
  touchRepo: vi.fn(),
  terminalKill: vi.fn(() => Promise.resolve()),
  repoStatuses: vi.fn(() => Promise.resolve([] as import("@/lib/ipc").RepoStatus[])),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
  gitSyncStatus: vi.fn(),
  repoStatus: vi.fn(),
  listBranches: vi.fn(),
  listGitTags: vi.fn(),
  checkoutBranch: vi.fn(),
  removeRepos: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listRepos: mocks.listRepos,
    listGroups: mocks.listGroups,
    repoStatuses: mocks.repoStatuses,
    // Called on every successful pull/push (`useSyncActions.refreshRepoStatus`);
    // resolves so the sync tests take the normal cache-patch path.
    repoStatus: mocks.repoStatus,
    gitPull: mocks.gitPull,
    gitPush: mocks.gitPush,
    gitSyncStatus: mocks.gitSyncStatus,
    repoRemoteUrl: vi.fn().mockResolvedValue(null),
    gitWorktreeList: vi.fn().mockResolvedValue([]),
    removeRepos: mocks.removeRepos,
    touchRepo: mocks.touchRepo,
    gitFetchMany: vi.fn().mockResolvedValue([]),
    registerRepo: vi.fn(),
    setRepoGroups: vi.fn(),
    discoverRepos: vi.fn(),
    setRepoAutoPull: vi.fn(),
    terminalKill: mocks.terminalKill,
    listBranches: mocks.listBranches,
    listGitTags: mocks.listGitTags,
    checkoutBranch: mocks.checkoutBranch,
    createBranch: vi.fn(),
    terminalRegistryReport: vi.fn(() => Promise.resolve()),
    dbHealth: vi.fn().mockResolvedValue({ migrations: [], repo_count: 0 }),
  },
  pickDirectory: vi.fn(),
}));

// GitHub auth lives behind its own query stack — out of scope here.
vi.mock("@/features/github/GitHubConnect", () => ({ GitHubConnect: () => null }));

import { Sidebar } from "./Sidebar";

function repo(id: number, name: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${name}`,
    name,
    default_branch: "main",
    last_opened: null,
    created_at: "",
    tag_ids: [],
    group_ids: [],
    missing: false,
    is_git_repo: true,
    has_worktrees: false,
    auto_pull: false,
    ...overrides,
  };
}

function group(id: number, name: string, overrides: Partial<Group> = {}): Group {
  return {
    id,
    name,
    parent_id: null,
    sort: id,
    icon: null,
    is_default: id === 1,
    folder_path: null,
    last_scan_at: null,
    root_repo_id: null,
    ...overrides,
  };
}

const G1 = group(1, "Default");
const G2 = group(2, "Tools");
const A = repo(1, "alpha", { group_ids: [] }); // default group
const B = repo(2, "beta", { group_ids: [2] });

function renderSidebar(repos: Repo[] = [A, B], groups: Group[] = [G1, G2], withGhost = false) {
  mocks.listRepos.mockResolvedValue(repos);
  mocks.listGroups.mockResolvedValue(groups);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Sidebar />
      {withGhost && <DragGhost />}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.listRepos.mockReset();
  mocks.listGroups.mockReset();
  mocks.touchRepo.mockReset().mockResolvedValue(undefined);
  mocks.terminalKill.mockClear();
  mocks.repoStatuses.mockReset().mockResolvedValue([]);
  mocks.gitPull.mockReset().mockResolvedValue("Already up to date.");
  mocks.gitPush.mockReset().mockResolvedValue("");
  mocks.gitSyncStatus
    .mockReset()
    .mockResolvedValue({ upstream: "origin/main", ahead: 0, behind: 0, unpublished_branch: null });
  mocks.listBranches.mockReset().mockResolvedValue([
    { name: "feat/very-long-branch-name", is_head: true, is_remote: false },
    { name: "main", is_head: false, is_remote: false },
  ]);
  mocks.listGitTags.mockReset().mockResolvedValue([]);
  mocks.checkoutBranch.mockReset().mockResolvedValue(undefined);
  mocks.repoStatus.mockReset().mockResolvedValue({
    id: A.id,
    branch: "feat/very-long-branch-name",
    ahead: 0,
    behind: 2,
    has_uncommitted_changes: false,
    has_worktrees: false,
  });
  mocks.removeRepos.mockReset().mockResolvedValue(undefined);
  useSettings.setState({ values: { ...DEFAULTS } });
  useUiStore.setState({
    activeGroupId: 1,
    activeRepoId: null,
    activeWorktreePath: null,
    terminalOpen: false,
    terminals: { tabs: [], activeTabId: null },
    termActivity: {},
    groupSelections: {},
  });
});

describe("Sidebar groups accordion", () => {
  it("expands the active group and shows its repos", async () => {
    renderSidebar();
    // Active group (1) starts expanded — alpha is visible, beta (group 2) is not.
    expect(await screen.findByTitle(A.path)).toBeTruthy();
    expect(screen.queryByTitle(B.path)).toBeNull();
  });

  it("clicking another group activates and expands it, collapsing the first", async () => {
    renderSidebar();
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByText("Tools"));
    expect(useUiStore.getState().activeGroupId).toBe(2);
    expect(await screen.findByTitle(B.path)).toBeTruthy();
    expect(screen.queryByTitle(A.path)).toBeNull();
  });

  it("lists git repos before plain folders, under a Folders divider", async () => {
    // The folder comes FIRST in the source list — the sidebar must reorder.
    const folder = repo(3, "assets", { is_git_repo: false, group_ids: [] });
    renderSidebar([folder, A, B]);
    const rowFolder = await screen.findByTitle(folder.path);
    const rowA = screen.getByTitle(A.path);

    // rowA precedes rowFolder in document order.
    expect(rowA.compareDocumentPosition(rowFolder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Folders")).toBeTruthy();
  });

  it("clicking a repo row activates the repo, touches it, and leaves the terminal view", async () => {
    useUiStore.setState({ terminalOpen: true });
    renderSidebar();
    const rowA = await screen.findByTitle(A.path);

    fireEvent.click(rowA);
    expect(useUiStore.getState().activeRepoId).toBe(A.id);
    expect(mocks.touchRepo).toHaveBeenCalledWith(A.id);
    expect(useUiStore.getState().terminalOpen).toBe(false);
  });

  it("expanding a group leaves the terminal view", async () => {
    useUiStore.setState({ terminalOpen: true });
    renderSidebar();
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByText("Tools"));
    expect(useUiStore.getState().terminalOpen).toBe(false);
  });
});

describe("Sidebar repo row branch line (#312)", () => {
  function seedStatus(overrides: Partial<import("@/lib/ipc").RepoStatus> = {}) {
    mocks.repoStatuses.mockResolvedValue([
      {
        id: A.id,
        branch: "feat/very-long-branch-name",
        ahead: 3,
        behind: 2,
        has_uncommitted_changes: false,
        has_worktrees: false,
        ...overrides,
      },
    ]);
  }

  it("renders the branch on its own line under the repo name", async () => {
    seedStatus();
    renderSidebar();
    const branch = await screen.findByText("feat/very-long-branch-name");
    const name = screen.getByText("alpha");

    // Different flex lines: the branch is NOT inside the same line container
    // as the repo name button.
    expect(name.parentElement).not.toBe(branch.parentElement);
    expect(name.parentElement!.contains(branch)).toBe(false);
    // Both still live in the same repo row.
    const row = screen.getByTitle(A.path);
    expect(row.contains(name)).toBe(true);
    expect(row.contains(branch)).toBe(true);
  });

  it("shows ahead and behind counts on the branch line", async () => {
    seedStatus();
    renderSidebar();
    await screen.findByText("feat/very-long-branch-name");
    expect(screen.getByTitle("3 commits ahead of upstream").textContent).toBe("3↑");
    expect(screen.getByTitle("2 commits behind upstream").textContent).toBe("2↓");
  });

  it("omits the branch line for a git repo with no branch", async () => {
    seedStatus({ branch: null });
    renderSidebar([A]);
    const row = await screen.findByTitle(A.path);
    // Line one only — no second (branch) line rendered.
    expect(row.querySelectorAll(":scope > div")).toHaveLength(1);
    expect(screen.queryByTitle("Pull")).toBeNull();
  });

  it("omits the branch line for a non-git folder even when a status carries a branch", async () => {
    const folder = repo(3, "assets", { is_git_repo: false, group_ids: [] });
    mocks.repoStatuses.mockResolvedValue([
      {
        id: folder.id,
        branch: "main",
        ahead: 0,
        behind: 0,
        has_uncommitted_changes: false,
        has_worktrees: false,
      },
    ]);
    renderSidebar([folder]);
    await screen.findByTitle(folder.path);
    expect(screen.queryByText("main")).toBeNull();
    expect(screen.queryByTitle("Pull")).toBeNull();
  });

  it("keeps the sync controls inside the hover/focus reveal wrapper", async () => {
    seedStatus();
    renderSidebar();
    const pull = await screen.findByTitle("Pull");
    // jsdom can't exercise :hover, so pin the reveal contract structurally:
    // hidden at rest, revealed by row hover or focus-within.
    const wrapper = pull.closest("span[class*='group-hover/repo']");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("hidden");
    expect(wrapper!.className).toContain("group-focus-within/repo:block");
  });

  it("the branch name opens the switcher and lists branches without activating the repo (#315)", async () => {
    seedStatus();
    renderSidebar();
    await screen.findByText("feat/very-long-branch-name");

    // Nothing is fetched until the switcher opens (#315: many rows must add
    // no query load at rest).
    expect(mocks.listBranches).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("Switch branch or tag"));

    // The lazy branch query fires for THIS row's repo, and the row's
    // activate() never ran.
    await vi.waitFor(() => expect(mocks.listBranches).toHaveBeenCalledWith(A.id));
    expect(useUiStore.getState().activeRepoId).toBeNull();
  });

  it("picking a branch checks it out on that repo without activating it (#315)", async () => {
    seedStatus();
    renderSidebar();
    await screen.findByText("feat/very-long-branch-name");

    fireEvent.click(screen.getByTitle("Switch branch or tag"));
    fireEvent.click(await screen.findByText("main"));

    await vi.waitFor(() => expect(mocks.checkoutBranch).toHaveBeenCalledWith(A.id, "main"));
    expect(useUiStore.getState().activeRepoId).toBeNull();
  });

  it("the row's pull button pulls that repo without activating it", async () => {
    seedStatus();
    renderSidebar();
    await screen.findByText("feat/very-long-branch-name");

    fireEvent.click(screen.getByTitle("Pull"));

    await vi.waitFor(() => expect(mocks.gitPull).toHaveBeenCalledWith(A.id));
    expect(useUiStore.getState().activeRepoId).toBeNull();
  });

  it("the row's push button pushes that repo without activating it", async () => {
    seedStatus();
    renderSidebar();
    await screen.findByText("feat/very-long-branch-name");

    fireEvent.click(screen.getByTitle("Push"));

    // The pre-push publish check resolves (tracking branch), then pushes.
    await vi.waitFor(() => expect(mocks.gitPush).toHaveBeenCalledWith(A.id));
    expect(useUiStore.getState().activeRepoId).toBeNull();
  });

  it("the relocated terminal action still opens a terminal for its repo", async () => {
    seedStatus();
    renderSidebar();
    await screen.findByText("feat/very-long-branch-name");

    fireEvent.click(screen.getByLabelText(`Open terminal in ${A.name}`));

    const s = useUiStore.getState();
    expect(s.terminals.tabs).toHaveLength(1);
    expect(s.terminals.tabs[0].panes[0].cwd).toBe(A.path);
    expect(s.activeRepoId).toBeNull();
  });

  it("the relocated remove action opens the remove dialog, not the repo", async () => {
    seedStatus();
    renderSidebar();
    await screen.findByText("feat/very-long-branch-name");

    fireEvent.click(screen.getByLabelText(`Remove ${A.name} from Gamut`));

    expect(await screen.findByText("Remove 1 repository folder?")).toBeTruthy();
    expect(useUiStore.getState().activeRepoId).toBeNull();
  });
});

describe("Group context menu — Remove N missing (#317)", () => {
  const M1 = repo(4, "gone-one", { group_ids: [2], missing: true });
  const M2 = repo(5, "gone-two", { group_ids: [2], missing: true });

  /** Right-click a group's header row (the label bubbles to the row div). */
  async function openGroupMenu(name: string, totalRepos: number) {
    // The derivation reads the repos query — wait for it to land first, via
    // the sidebar's global "{n} repos" counter (whole-sidebar total, not the
    // group's own count).
    await screen.findByText(`${totalRepos} repos`);
    fireEvent.contextMenu(screen.getByText(name));
  }

  it("shows a count-labelled entry when the group has missing rows", async () => {
    renderSidebar([B, M1, M2]);
    await openGroupMenu("Tools", 3);
    expect(screen.getByText("Remove 2 missing")).toBeTruthy();
  });

  it("labels a single missing row as 'Remove 1 missing'", async () => {
    renderSidebar([B, M1]);
    await openGroupMenu("Tools", 2);
    expect(screen.getByText("Remove 1 missing")).toBeTruthy();
  });

  it("hides the entry when the group has no missing rows", async () => {
    renderSidebar([A, B]);
    await openGroupMenu("Tools", 2);
    expect(screen.getByText("Edit group")).toBeTruthy();
    expect(screen.queryByText(/Remove \d+ missing/)).toBeNull();
  });

  it("opens the confirm dialog with exactly the missing repos, and confirming removes those ids", async () => {
    renderSidebar([B, M1, M2]);
    await openGroupMenu("Tools", 3);

    const label = screen.getByText("Remove 2 missing");
    fireEvent.click(label);

    // The context menu closed — its overlay would otherwise sit above the dialog.
    expect(screen.queryByText("Edit group")).toBeNull();
    // Dialog lists both missing rows, not the healthy one.
    expect(await screen.findByText("Remove 2 repository folders?")).toBeTruthy();
    expect(screen.getByText("gone-one")).toBeTruthy();
    expect(screen.getByText("gone-two")).toBeTruthy();
    expect(screen.queryByText("beta")).toBeNull();
    // No root in the selection — no root warning.
    expect(screen.queryByText(/synced root folder/)).toBeNull();

    fireEvent.click(screen.getByText("Remove 2"));
    await vi.waitFor(() => expect(mocks.removeRepos).toHaveBeenCalledTimes(1));
    const ids = mocks.removeRepos.mock.calls[0][0] as number[];
    expect(ids).toEqual([M1.id, M2.id]);
    // The advertised count matches the removal set.
    expect(ids).toHaveLength(2);
  });

  it("scopes to the right-clicked group when other groups also hold missing rows", async () => {
    const G3 = group(3, "Other");
    const M3 = repo(6, "gone-elsewhere", { group_ids: [3], missing: true });
    renderSidebar([B, M1, M3], [G1, G2, G3]);
    await openGroupMenu("Tools", 3);

    fireEvent.click(screen.getByText("Remove 1 missing"));
    fireEvent.click(await screen.findByText("Remove 1"));
    await vi.waitFor(() => expect(mocks.removeRepos).toHaveBeenCalledWith([M1.id]));
  });

  it("ignores the current repo selection — targets the missing set regardless", async () => {
    useUiStore.setState({ activeRepoId: B.id });
    renderSidebar([B, M1, M2]);
    await openGroupMenu("Tools", 3);

    fireEvent.click(screen.getByText("Remove 2 missing"));
    fireEvent.click(await screen.findByText("Remove 2"));
    await vi.waitFor(() => expect(mocks.removeRepos).toHaveBeenCalledWith([M1.id, M2.id]));
  });

  it("warns when a missing target is the group's synced root", async () => {
    const boundG2 = group(2, "Tools", { folder_path: "/repos", root_repo_id: M1.id });
    renderSidebar([B, M1], [G1, boundG2]);
    await openGroupMenu("Tools", 2);

    fireEvent.click(screen.getByText("Remove 1 missing"));
    expect(await screen.findByText(/synced root folder/)).toBeTruthy();
  });

  it("excludes a synced root hidden by the setting from the count and the set", async () => {
    useSettings.setState({ values: { ...DEFAULTS, showSyncedRoot: false } });
    const boundG2 = group(2, "Tools", { folder_path: "/repos", root_repo_id: M1.id });
    renderSidebar([B, M1, M2], [G1, boundG2]);
    await openGroupMenu("Tools", 3);

    fireEvent.click(screen.getByText("Remove 1 missing"));
    fireEvent.click(await screen.findByText("Remove 1"));
    await vi.waitFor(() => expect(mocks.removeRepos).toHaveBeenCalledWith([M2.id]));
  });

  it("shows no entry when the group's only missing row is a hidden synced root", async () => {
    useSettings.setState({ values: { ...DEFAULTS, showSyncedRoot: false } });
    const boundG2 = group(2, "Tools", { folder_path: "/repos", root_repo_id: M1.id });
    renderSidebar([B, M1], [G1, boundG2]);
    await openGroupMenu("Tools", 2);

    expect(screen.getByText("Edit group")).toBeTruthy();
    expect(screen.queryByText(/Remove \d+ missing/)).toBeNull();
  });

  it("styles the entry destructive, matching the repo menu's Remove repo", async () => {
    renderSidebar([B, M1, M2]);
    await openGroupMenu("Tools", 3);
    const item = screen.getByText("Remove 2 missing").closest("button")!;
    expect(item.className).toContain("text-[var(--color-destructive)]");
  });

  it("cancelling the dialog removes nothing", async () => {
    renderSidebar([B, M1, M2]);
    await openGroupMenu("Tools", 3);

    fireEvent.click(screen.getByText("Remove 2 missing"));
    fireEvent.click(await screen.findByText("Cancel"));
    expect(mocks.removeRepos).not.toHaveBeenCalled();
    expect(screen.queryByText("Remove 2 repository folders?")).toBeNull();
  });

  it("adds nothing to the repo context menu, even on a missing repo", async () => {
    const missingInDefault = repo(7, "gone-default", { group_ids: [], missing: true });
    renderSidebar([missingInDefault]);
    const row = await screen.findByTitle("Folder no longer exists on disk");

    fireEvent.contextMenu(row);
    expect(screen.getByText("Remove repo")).toBeTruthy();
    expect(screen.queryByText(/Remove \d+ missing/)).toBeNull();
  });
});

describe("Sidebar terminal rail", () => {
  function seedTerminals() {
    useUiStore.setState({
      terminals: {
        activeTabId: "tab-1",
        tabs: [
          {
            id: "tab-1",
            groupId: 1,
            title: "alpha shell",
            panes: [{ id: "term-1", cwd: "/repos/alpha" }],
            activePaneId: "term-1",
          },
          {
            id: "tab-2",
            groupId: 2,
            title: "beta shell",
            panes: [
              { id: "term-2", cwd: "/repos/beta" },
              { id: "term-3", cwd: "/repos/beta" },
            ],
            activePaneId: "term-2",
          },
        ],
      },
    });
  }

  it("lists every open terminal across all groups, flat", async () => {
    seedTerminals();
    renderSidebar();
    expect(await screen.findByText("alpha shell")).toBeTruthy();
    expect(screen.getByText("beta shell")).toBeTruthy();
    expect(screen.getByText("2 running")).toBeTruthy();
  });

  it("clicking a terminal row shows it without moving the active group (#339)", async () => {
    seedTerminals();
    renderSidebar();
    fireEvent.click(await screen.findByText("beta shell"));

    const s = useUiStore.getState();
    // The rail is global — focusing a tab from group 2 doesn't move the
    // active group, so the sidebar, repo list and main view do not jump.
    expect(s.activeGroupId).toBe(1);
    expect(s.terminalOpen).toBe(true);
    expect(s.terminals.activeTabId).toBe("tab-2");
  });

  it("clicking a terminal row still switches group with terminalFollowGroup on", async () => {
    useSettings.setState({ values: { ...DEFAULTS, terminalFollowGroup: true } });
    seedTerminals();
    renderSidebar();
    fireEvent.click(await screen.findByText("beta shell"));

    const s = useUiStore.getState();
    expect(s.activeGroupId).toBe(2);
    expect(s.terminalOpen).toBe(true);
    expect(s.terminals.activeTabId).toBe("tab-2");
  });

  it("highlights the focused row keyed off the active tab, not the active group (#339)", async () => {
    seedTerminals();
    useUiStore.setState((s) => ({
      activeGroupId: 1,
      terminalOpen: true,
      terminals: { ...s.terminals, activeTabId: "tab-2" },
    }));
    renderSidebar();

    // Keyed off the active tab, not the active group.
    expect((await screen.findByText("beta shell")).getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("alpha shell").getAttribute("aria-current")).toBeNull();
  });

  it("the hover close control kills every pane PTY and drops the tab (#280)", async () => {
    seedTerminals();
    renderSidebar();
    const row = (await screen.findByText("beta shell")).closest('[class*="group/term"]')!;

    fireEvent.click(within(row as HTMLElement).getByLabelText("Close beta shell terminal"));

    expect(mocks.terminalKill).toHaveBeenCalledWith("term-2");
    expect(mocks.terminalKill).toHaveBeenCalledWith("term-3");
    expect(useUiStore.getState().terminals.tabs.find((t) => t.id === "tab-2")).toBeUndefined();
    expect(screen.queryByText("beta shell")).toBeNull();
  });

  it("the context menu closes a terminal (kills PTYs, drops the tab)", async () => {
    seedTerminals();
    renderSidebar();
    const row = (await screen.findByText("beta shell")).closest('[class*="group/term"]')!;

    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText("Close terminal"));

    expect(mocks.terminalKill).toHaveBeenCalledWith("term-2");
    expect(mocks.terminalKill).toHaveBeenCalledWith("term-3");
    expect(useUiStore.getState().terminals.tabs.find((t) => t.id === "tab-2")).toBeUndefined();
  });

  it("the context menu renames a terminal inline", async () => {
    seedTerminals();
    renderSidebar();
    const row = (await screen.findByText("alpha shell")).closest('[class*="group/term"]')!;

    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText("Rename terminal"));
    const input = screen.getByLabelText("Rename terminal");
    fireEvent.change(input, { target: { value: "build loop" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      useUiStore.getState().terminals.tabs.find((t) => t.id === "tab-1")?.customTitle,
    ).toBe("build loop");
    expect(screen.getByText("build loop")).toBeTruthy();
  });

  it("New terminal roots at the active repo and opens in the active group", async () => {
    useUiStore.setState({ activeRepoId: A.id });
    renderSidebar();
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByText("New terminal"));

    const s = useUiStore.getState();
    expect(s.terminals.tabs).toHaveLength(1);
    expect(s.terminals.tabs[0].title).toBe("alpha");
    expect(s.terminals.tabs[0].panes[0].cwd).toBe(A.path);
  });

  it("New terminal is disabled with no repo selected and no group folder", async () => {
    renderSidebar();
    await screen.findByTitle(A.path);
    const btn = screen.getByText("New terminal").closest("button")!;
    expect(btn.disabled).toBe(true);
  });
});

describe("Sidebar terminal rail drag-to-reorder (#340)", () => {
  // Group 1 (id 1) gets three terminals, group 2 (id 2) gets two — the sizes
  // the contract's boundary/adjacency assertions need. Labels are distinct
  // from any repo/group name in this file so text queries can't collide.
  function tab(id: string, title: string, groupId: number) {
    return {
      id,
      groupId,
      title,
      panes: [{ id: `pane-${id}`, cwd: `/repos/${id}` }],
      activePaneId: `pane-${id}`,
    };
  }

  function seedRail() {
    useUiStore.setState({
      terminals: {
        activeTabId: "t-a",
        tabs: [
          tab("t-a", "term-a", 1),
          tab("t-b", "term-b", 1),
          tab("t-c", "term-c", 1),
          tab("t-e", "term-e", 2),
          tab("t-f", "term-f", 2),
        ],
      },
    });
  }

  // jsdom returns an all-zero rect for every element, so the drop target's
  // hit-testing/edge math never engages without a stub. Recipe from
  // src/lib/usePointerDnd.test.tsx.
  function rect(left: number, top: number, right: number, bottom: number): DOMRect {
    return {
      left,
      top,
      right,
      bottom,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  function win(type: string, x: number, y: number) {
    act(() => {
      window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
    });
  }

  // Locates a row by its close button's accessible name, which stays fixed
  // to the tab's ORIGINAL label even while the row is mid-rename (unlike its
  // visible text, which becomes an <input> and is unreachable by getByText).
  function rowFor(label: string): HTMLElement {
    return screen
      .getByLabelText(`Close ${label} terminal`)
      .closest('[class*="group/term"]') as HTMLElement;
  }

  // Stacks the given rows' stubbed rects 20px tall, top to bottom, in order.
  function stubRects(labelsInOrder: string[]) {
    labelsInOrder.forEach((label, i) => {
      rowFor(label).getBoundingClientRect = () => rect(0, i * 20, 100, i * 20 + 20);
    });
  }

  // Reads rendered order off the close buttons' accessible names — stable
  // even mid-rename, unlike the visible label (which becomes an <input>).
  function railOrder(): string[] {
    return [...document.querySelectorAll('[aria-label^="Close "]')].map((el) =>
      (el.getAttribute("aria-label") ?? "").replace(/^Close /, "").replace(/ terminal$/, ""),
    );
  }

  afterEach(() => {
    // A leaked drag session (a test that asserts mid-drag and never releases)
    // must never bleed into the next test.
    win("pointercancel", 0, 0);
  });

  it("A14: dropping on a row's lower half places the dragged row after it", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 35); // past the threshold, over term-b's lower half (rect 20-40)
    win("pointerup", 5, 35);

    expect(railOrder()).toEqual(["term-b", "term-a", "term-c", "term-e", "term-f"]);
  });

  it("A15: dropping on a row's upper half places the dragged row before it", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    fireEvent.pointerDown(rowFor("term-c"), { button: 0, clientX: 5, clientY: 45 });
    win("pointermove", 5, 22); // past the threshold, over term-b's upper half (rect 20-40)
    win("pointerup", 5, 22);

    expect(railOrder()).toEqual(["term-a", "term-c", "term-b", "term-e", "term-f"]);
  });

  it("A16: a cross-group drop is accepted and reorders the flat list", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 65); // term-e's upper half (rect 60-80, midpoint 70), a different group
    win("pointerup", 5, 65);

    // The rail is one flat list — the tab moves into group 2's stretch, and
    // its groupId does not change (it still labels its own group's name).
    expect(railOrder()).toEqual(["term-b", "term-c", "term-a", "term-e", "term-f"]);
    expect(useUiStore.getState().terminals.tabs.find((t) => t.id === "t-a")?.groupId).toBe(1);
  });

  it("A17: exactly one row carries the drop-edge attribute, matching the pointer's half", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 35); // term-b's lower half → "after"

    expect(rowFor("term-b").getAttribute("data-drop-edge")).toBe("after");
    const flagged = [...document.querySelectorAll("[data-drop-edge]")].filter((el) =>
      el.getAttribute("data-drop-edge"),
    );
    expect(flagged).toHaveLength(1);

    win("pointerup", 5, 35);
  });

  it("A18: the source row shows no indicator during its own drag, and dropping on it reorders nothing", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 2 });
    win("pointermove", 5, 15); // still inside term-a's own rect (0-20)

    expect(document.querySelectorAll("[data-drop-edge]")).toHaveLength(0);

    win("pointerup", 5, 15);
    expect(railOrder()).toEqual(["term-a", "term-b", "term-c", "term-e", "term-f"]);
  });

  it("A19: the indicator shows mid-drag and clears on both a drop and a cancel", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 35);
    expect(document.querySelectorAll("[data-drop-edge]")).toHaveLength(1);
    win("pointerup", 5, 35);
    expect(document.querySelectorAll("[data-drop-edge]")).toHaveLength(0);

    // Re-stub: the rows just reordered, so the old rects no longer match the
    // rendered order.
    stubRects(["term-b", "term-a", "term-c", "term-e", "term-f"]);

    // Same drag, ended by a cancel instead — indicator clears and nothing moves.
    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 55);
    expect(document.querySelectorAll("[data-drop-edge]")).toHaveLength(1);
    win("pointercancel", 5, 55);
    expect(document.querySelectorAll("[data-drop-edge]")).toHaveLength(0);
    expect(railOrder()).toEqual(["term-b", "term-a", "term-c", "term-e", "term-f"]);
  });

  it("A20: the rail's grouping invariant survives a reorder inside group 2", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    fireEvent.pointerDown(rowFor("term-e"), { button: 0, clientX: 5, clientY: 65 });
    win("pointermove", 5, 95); // term-f's lower half (rect 80-100)
    win("pointerup", 5, 95);

    expect(railOrder()).toEqual(["term-a", "term-b", "term-c", "term-f", "term-e"]);
  });

  it("A21: a one-terminal group can be pressed and dragged without error, reordering nothing", async () => {
    useUiStore.setState({
      terminals: {
        activeTabId: "t-solo",
        tabs: [tab("t-solo", "term-solo", 1), tab("t-x", "term-x", 2), tab("t-y", "term-y", 2)],
      },
    });
    renderSidebar();
    await screen.findByText("term-solo");
    stubRects(["term-solo", "term-x", "term-y"]);

    // Drop on itself.
    fireEvent.pointerDown(rowFor("term-solo"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 12);
    win("pointerup", 5, 12);
    expect(useUiStore.getState().terminals.tabs.map((t) => t.id)).toEqual(["t-solo", "t-x", "t-y"]);

    // Release over empty rail space.
    fireEvent.pointerDown(rowFor("term-solo"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 500);
    win("pointerup", 5, 500);
    expect(useUiStore.getState().terminals.tabs.map((t) => t.id)).toEqual(["t-solo", "t-x", "t-y"]);
  });

  it("A21: a two-terminal group swaps in both directions", async () => {
    useUiStore.setState({
      terminals: {
        activeTabId: "t-solo",
        tabs: [tab("t-solo", "term-solo", 1), tab("t-x", "term-x", 2), tab("t-y", "term-y", 2)],
      },
    });
    renderSidebar();
    await screen.findByText("term-x");
    stubRects(["term-solo", "term-x", "term-y"]);

    fireEvent.pointerDown(rowFor("term-x"), { button: 0, clientX: 5, clientY: 25 });
    win("pointermove", 5, 55); // term-y's lower half (rect 40-60, midpoint 50)
    win("pointerup", 5, 55);
    expect(useUiStore.getState().terminals.tabs.map((t) => t.id)).toEqual([
      "t-solo",
      "t-y",
      "t-x",
    ]);

    stubRects(["term-solo", "term-y", "term-x"]);
    fireEvent.pointerDown(rowFor("term-x"), { button: 0, clientX: 5, clientY: 45 });
    win("pointermove", 5, 22); // term-y's upper half (rect 20-40)
    win("pointerup", 5, 22);
    expect(useUiStore.getState().terminals.tabs.map((t) => t.id)).toEqual([
      "t-solo",
      "t-x",
      "t-y",
    ]);
  });

  it("A22: a below-threshold press still clicks; an above-threshold press does not", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    // 3px move — below the 4px threshold — still acts as a click.
    fireEvent.pointerDown(rowFor("term-b"), { button: 0, clientX: 5, clientY: 22 });
    win("pointermove", 5, 25);
    win("pointerup", 5, 25);
    fireEvent.click(rowFor("term-b"));
    expect(useUiStore.getState().terminals.activeTabId).toBe("t-b");

    useUiStore.setState((s) => ({
      terminals: { ...s.terminals, activeTabId: "t-a" },
    }));

    // 12px move — above the threshold — is a drag, and the resulting click
    // must not also focus the row.
    fireEvent.pointerDown(rowFor("term-c"), { button: 0, clientX: 5, clientY: 41 });
    win("pointermove", 5, 53);
    win("pointerup", 5, 53);
    fireEvent.click(rowFor("term-c"));
    expect(useUiStore.getState().terminals.activeTabId).toBe("t-a");
  });

  it("A23: pressing and dragging the close button still just closes the tab", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);
    const closeBtn = within(rowFor("term-a")).getByLabelText("Close term-a terminal");

    fireEvent.pointerDown(closeBtn, { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 30);
    win("pointerup", 5, 30);
    fireEvent.click(closeBtn);

    expect(useUiStore.getState().terminals.tabs.map((t) => t.id)).toEqual([
      "t-b",
      "t-c",
      "t-e",
      "t-f",
    ]);
  });

  it("A24: a press-and-move on a row mid-rename starts no drag", async () => {
    seedRail();
    renderSidebar(undefined, undefined, true);
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    fireEvent.contextMenu(rowFor("term-a"));
    fireEvent.click(screen.getByText("Rename terminal"));
    expect(screen.getByLabelText("Rename terminal")).toBeTruthy();

    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 35);
    win("pointerup", 5, 35);

    expect(document.querySelectorAll("[data-drop-edge]")).toHaveLength(0);
    // The drag ghost (mounted alongside Sidebar here) renders only while a
    // drag is active — it must never appear for a disabled (renaming) row.
    expect(
      [...document.querySelectorAll("div")].some((el) => el.className.includes("z-[200]")),
    ).toBe(false);
    expect(railOrder()).toEqual(["term-a", "term-b", "term-c", "term-e", "term-f"]);
  });

  it("A25: a right-click still opens the menu and rename still works after a completed drag", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 35);
    win("pointerup", 5, 35);
    expect(railOrder()).toEqual(["term-b", "term-a", "term-c", "term-e", "term-f"]);

    fireEvent.contextMenu(rowFor("term-a"));
    expect(screen.getByText("Rename terminal")).toBeTruthy();
    fireEvent.click(screen.getByText("Rename terminal"));

    const input = screen.getByLabelText("Rename terminal");
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      useUiStore.getState().terminals.tabs.find((t) => t.id === "t-a")?.customTitle,
    ).toBe("renamed");
  });

  it("A26: a double-click does not drag, reorder, or enter rename mode", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    // A real double-click is two press/release pairs at the same point, with
    // no movement between them — below the 4px drag threshold each time.
    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointerup", 5, 5);
    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointerup", 5, 5);
    fireEvent.doubleClick(rowFor("term-a"));

    expect(screen.queryByLabelText("Rename terminal")).toBeNull();
    expect(document.querySelectorAll("[data-drop-edge]")).toHaveLength(0);
    expect(railOrder()).toEqual(["term-a", "term-b", "term-c", "term-e", "term-f"]);
  });

  it("A27: releasing outside the rail reorders nothing and changes no focus", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);
    const before = useUiStore.getState().terminals.activeTabId;

    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 5000); // well outside every stubbed row
    win("pointerup", 5, 5000);

    expect(railOrder()).toEqual(["term-a", "term-b", "term-c", "term-e", "term-f"]);
    expect(useUiStore.getState().terminals.activeTabId).toBe(before);
  });

  it("A28: dropping on the '+ New terminal' button reorders and creates nothing", async () => {
    seedRail();
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);
    // Stub the button's rect to actually sit below the last stubbed row
    // (rect 80-100), so the release genuinely lands on it.
    const newTermButton = screen.getByText("New terminal").closest("button") as HTMLElement;
    newTermButton.getBoundingClientRect = () => rect(0, 100, 100, 120);
    const newTermCount = useUiStore.getState().terminals.tabs.length;

    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 110); // over the "+ New terminal" button's stubbed rect
    win("pointerup", 5, 110);

    expect(railOrder()).toEqual(["term-a", "term-b", "term-c", "term-e", "term-f"]);
    expect(useUiStore.getState().terminals.tabs.length).toBe(newTermCount);
    expect(document.querySelectorAll("[data-drop-edge]")).toHaveLength(0);
  });

  it("A29: a cross-group drop calls reorderTerminalTab with just (srcId, targetId, edge)", async () => {
    seedRail();
    const reorderSpy = vi.spyOn(useUiStore.getState(), "reorderTerminalTab");
    renderSidebar();
    await screen.findByText("term-a");
    stubRects(["term-a", "term-b", "term-c", "term-e", "term-f"]);

    // term-a belongs to group 1, term-e to group 2 — the drop used to be
    // rejected across groups; now the rail is one flat list and it's accepted.
    fireEvent.pointerDown(rowFor("term-a"), { button: 0, clientX: 5, clientY: 5 });
    win("pointermove", 5, 65); // term-e's upper half (rect 60-80, midpoint 70) → "before"
    win("pointerup", 5, 65);

    expect(reorderSpy).toHaveBeenCalledTimes(1);
    expect(reorderSpy).toHaveBeenCalledWith("t-a", "t-e", "before");
    expect(railOrder()).toEqual(["term-b", "term-c", "term-a", "term-e", "term-f"]);
  });
});
