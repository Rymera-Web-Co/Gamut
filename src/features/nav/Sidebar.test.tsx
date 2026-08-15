import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Repo } from "@/lib/ipc";
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
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listRepos: mocks.listRepos,
    listGroups: mocks.listGroups,
    repoStatuses: () => Promise.resolve([]),
    repoRemoteUrl: vi.fn().mockResolvedValue(null),
    gitWorktreeList: vi.fn().mockResolvedValue([]),
    removeRepos: vi.fn().mockResolvedValue(undefined),
    touchRepo: mocks.touchRepo,
    gitFetchMany: vi.fn().mockResolvedValue([]),
    registerRepo: vi.fn(),
    setRepoGroups: vi.fn(),
    discoverRepos: vi.fn(),
    setRepoAutoPull: vi.fn(),
    terminalKill: mocks.terminalKill,
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

  it("clicking a repo row activates the repo and touches it", async () => {
    renderSidebar();
    const rowA = await screen.findByTitle(A.path);

    fireEvent.click(rowA);
    expect(useUiStore.getState().activeRepoId).toBe(A.id);
    expect(mocks.touchRepo).toHaveBeenCalledWith(A.id);
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
    expect(screen.getByText("2 open")).toBeTruthy();
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
    const row = (await screen.findByText("beta shell")).closest('[role="button"]')!;

    fireEvent.click(within(row as HTMLElement).getByLabelText("Close beta shell terminal"));

    expect(mocks.terminalKill).toHaveBeenCalledWith("term-2");
    expect(mocks.terminalKill).toHaveBeenCalledWith("term-3");
    expect(useUiStore.getState().terminals[2].tabs).toHaveLength(0);
    expect(screen.queryByText("beta shell")).toBeNull();
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
