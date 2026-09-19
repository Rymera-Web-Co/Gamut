import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Repo } from "@/lib/ipc";

// Capture the `ui-nav` listener the hook registers, so a test can deliver a
// control-channel payload without a Tauri runtime.
const handlers = vi.hoisted(() => ({ uiNav: null as ((ev: { payload: unknown }) => void) | null }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (ev: { payload: unknown }) => void) => {
    if (name === "ui-nav") handlers.uiNav = cb;
    return Promise.resolve(() => {});
  }),
}));

const mocks = vi.hoisted(() => ({
  listRepos: vi.fn(),
  listGroups: vi.fn(),
  terminalWrite: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    listRepos: mocks.listRepos,
    listGroups: mocks.listGroups,
    terminalWrite: mocks.terminalWrite,
    // The store reports its terminal registry to the backend on every mutation.
    terminalRegistryReport: vi.fn(() => Promise.resolve()),
  },
}));

import { useUiNav } from "@/lib/useUiNav";
import { useUiStore } from "@/store/ui";

function group(id: number, is_default = false): Group {
  return {
    id,
    name: `group-${id}`,
    parent_id: null,
    sort: id,
    icon: null,
    is_default,
    folder_path: null,
    last_scan_at: null,
    root_repo_id: null,
  };
}

function repo(id: number, groupIds: number[]): Repo {
  return {
    id,
    path: `/repos/r${id}`,
    name: `r${id}`,
    default_branch: "main",
    last_opened: null,
    created_at: "",
    tag_ids: [],
    group_ids: groupIds,
    missing: false,
    is_git_repo: true,
    has_worktrees: false,
    auto_pull: false,
  };
}

/** Deliver a `ui-nav` payload and let openTerm's awaited ipc calls settle. */
async function nav(payload: Record<string, unknown>) {
  handlers.uiNav!({ payload });
  await vi.waitFor(() => expect(mocks.listGroups).toHaveBeenCalled());
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  handlers.uiNav = null;
  mocks.listRepos.mockReset().mockResolvedValue([repo(1, [1]), repo(2, [2])]);
  mocks.listGroups.mockReset().mockResolvedValue([group(1, true), group(2)]);
  mocks.terminalWrite.mockClear();
  localStorage.clear();
  useUiStore.setState({
    activeGroupId: 1,
    activeRepoId: null,
    terminalOpen: false,
    terminals: {
      activeTabId: "tab-2",
      tabs: [
        {
          id: "tab-2",
          groupId: 2,
          title: "worker",
          panes: [{ id: "term-2", cwd: "/repos/r2" }],
          activePaneId: "term-2",
        },
      ],
    },
  });
});

// #339: the `term` control command must reveal the tab it actually opened (or
// reused) — otherwise the pane shows a different session than the one the
// command just drove.
describe("useUiNav term (#339)", () => {
  it("reveals the tab it reused", async () => {
    renderHook(() => useUiNav());

    await nav({ action: "term", repo_id: 2, title: "worker", reuse: true });

    const s = useUiStore.getState();
    expect(s.activeGroupId).toBe(2);
    expect(s.terminalOpen).toBe(true);
    expect(s.terminals.activeTabId).toBe("tab-2");
  });

  it("reveals the group it opened a new tab in", async () => {
    renderHook(() => useUiNav());

    await nav({ action: "term", repo_id: 2, title: "fresh" });

    const s = useUiStore.getState();
    expect(s.activeGroupId).toBe(2);
    expect(s.terminals.tabs.some((t) => t.title === "fresh")).toBe(true);
  });

  it("a silent term leaves the active group and the terminal panel alone", async () => {
    renderHook(() => useUiNav());

    await nav({ action: "term", repo_id: 2, title: "bg", silent: true });

    const s = useUiStore.getState();
    // Nothing is revealed, so nothing on screen may move either.
    expect(s.activeGroupId).toBe(1);
    expect(s.terminals.activeTabId).toBe("tab-2");
    expect(s.terminalOpen).toBe(false);
  });
});

// #340: the terminal list is one flat sequence, but a tab name is only unique
// within a repo's own groups — two different repos can each hold a
// `loop-worker` tab. `term-send` / `term-close` / `term-rename` must resolve
// the tab that belongs to the ADDRESSED repo's group(s), not whichever
// same-named tab happens to come first in the list.
describe("useUiNav anti-collision across same-named tabs (#340)", () => {
  function seedCollidingTabs() {
    useUiStore.setState({
      terminals: {
        activeTabId: null,
        tabs: [
          {
            id: "tab-g1",
            groupId: 1,
            title: "loop-worker",
            panes: [{ id: "term-g1", cwd: "/repos/r1" }],
            activePaneId: "term-g1",
          },
          {
            id: "tab-g2",
            groupId: 2,
            title: "loop-worker",
            panes: [{ id: "term-g2", cwd: "/repos/r2" }],
            activePaneId: "term-g2",
          },
        ],
      },
    });
  }

  it("term-send resolves the group-2 tab for a repo that belongs to group 2", async () => {
    seedCollidingTabs();
    renderHook(() => useUiNav());

    await nav({ action: "term-send", repo_id: 2, title: "loop-worker", text: "hello" });

    expect(mocks.terminalWrite).toHaveBeenCalledWith("term-g2", expect.anything());
    expect(mocks.terminalWrite).not.toHaveBeenCalledWith("term-g1", expect.anything());
    expect(useUiStore.getState().terminals.activeTabId).toBe("tab-g2");
  });

  it("term-close resolves and closes the group-2 tab for a repo that belongs to group 2", async () => {
    seedCollidingTabs();
    renderHook(() => useUiNav());

    await nav({ action: "term-close", repo_id: 2, title: "loop-worker" });

    const tabs = useUiStore.getState().terminals.tabs;
    expect(tabs.some((t) => t.id === "tab-g2")).toBe(false);
    expect(tabs.some((t) => t.id === "tab-g1")).toBe(true);
  });

  it("term-rename resolves and renames the group-2 tab for a repo that belongs to group 2", async () => {
    seedCollidingTabs();
    renderHook(() => useUiNav());

    await nav({
      action: "term-rename",
      repo_id: 2,
      title: "loop-worker",
      rename_to: "renamed",
    });

    const tabs = useUiStore.getState().terminals.tabs;
    const g1 = tabs.find((t) => t.id === "tab-g1")!;
    const g2 = tabs.find((t) => t.id === "tab-g2")!;
    expect(g2.customTitle).toBe("renamed");
    expect(g1.customTitle).toBeUndefined();
  });
});
