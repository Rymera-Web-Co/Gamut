import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Repo } from "@/lib/ipc";
import { DEFAULTS, useSettings } from "@/lib/settings";
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

function renderSidebar(repos: Repo[] = [A, B], groups: Group[] = [G1, G2]) {
  mocks.listRepos.mockResolvedValue(repos);
  mocks.listGroups.mockResolvedValue(groups);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Sidebar />
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
    terminals: {},
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
    expect(s.terminals[1]?.tabs).toHaveLength(1);
    expect(s.terminals[1].tabs[0].panes[0].cwd).toBe(A.path);
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
        1: {
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              title: "alpha shell",
              panes: [{ id: "term-1", cwd: "/repos/alpha" }],
              activePaneId: "term-1",
            },
          ],
        },
        2: {
          activeTabId: "tab-2",
          tabs: [
            {
              id: "tab-2",
              title: "beta shell",
              panes: [
                { id: "term-2", cwd: "/repos/beta" },
                { id: "term-3", cwd: "/repos/beta" },
              ],
              activePaneId: "term-2",
            },
          ],
        },
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

  it("clicking a terminal row focuses it (group + tab + panel)", async () => {
    seedTerminals();
    renderSidebar();
    fireEvent.click(await screen.findByText("beta shell"));

    const s = useUiStore.getState();
    expect(s.activeGroupId).toBe(2);
    expect(s.terminalOpen).toBe(true);
    expect(s.terminals[2].activeTabId).toBe("tab-2");
  });

  it("the hover close control kills every pane PTY and drops the tab (#280)", async () => {
    seedTerminals();
    renderSidebar();
    const row = (await screen.findByText("beta shell")).closest('[class*="group/term"]')!;

    fireEvent.click(within(row as HTMLElement).getByLabelText("Close beta shell terminal"));

    expect(mocks.terminalKill).toHaveBeenCalledWith("term-2");
    expect(mocks.terminalKill).toHaveBeenCalledWith("term-3");
    expect(useUiStore.getState().terminals[2].tabs).toHaveLength(0);
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
    expect(useUiStore.getState().terminals[2].tabs).toHaveLength(0);
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

    expect(useUiStore.getState().terminals[1].tabs[0].customTitle).toBe("build loop");
    expect(screen.getByText("build loop")).toBeTruthy();
  });

  it("New terminal roots at the active repo and opens in the active group", async () => {
    useUiStore.setState({ activeRepoId: A.id });
    renderSidebar();
    await screen.findByTitle(A.path);

    fireEvent.click(screen.getByText("New terminal"));

    const s = useUiStore.getState();
    expect(s.terminals[1]?.tabs).toHaveLength(1);
    expect(s.terminals[1].tabs[0].title).toBe("alpha");
    expect(s.terminals[1].tabs[0].panes[0].cwd).toBe(A.path);
  });

  it("New terminal is disabled with no repo selected and no group folder", async () => {
    renderSidebar();
    await screen.findByTitle(A.path);
    const btn = screen.getByText("New terminal").closest("button")!;
    expect(btn.disabled).toBe(true);
  });
});
