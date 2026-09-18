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
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    listRepos: mocks.listRepos,
    listGroups: mocks.listGroups,
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
  localStorage.clear();
  useUiStore.setState({
    activeGroupId: 1,
    terminalViewGroupId: 1,
    activeRepoId: null,
    terminalOpen: false,
    terminals: {
      2: {
        activeTabId: "tab-2",
        tabs: [
          {
            id: "tab-2",
            title: "worker",
            panes: [{ id: "term-2", cwd: "/repos/r2" }],
            activePaneId: "term-2",
          },
        ],
      },
    },
  });
});

// #339: the `term` control command must leave the terminal view on the group it
// actually opened (or reused) a tab in — otherwise the pane shows a different
// group's session than the one the command just drove.
describe("useUiNav term (#339)", () => {
  it("points the terminal view at the group it reused a tab in", async () => {
    renderHook(() => useUiNav());

    await nav({ action: "term", repo_id: 2, title: "worker", reuse: true });

    const s = useUiStore.getState();
    expect(s.terminalViewGroupId).toBe(2);
    expect(s.terminalOpen).toBe(true);
    expect(s.terminals[2].activeTabId).toBe("tab-2");
  });

  it("points the terminal view at the group it opened a new tab in", async () => {
    renderHook(() => useUiNav());

    await nav({ action: "term", repo_id: 2, title: "fresh" });

    const s = useUiStore.getState();
    expect(s.terminalViewGroupId).toBe(2);
    expect(s.terminals[2].tabs.some((t) => t.title === "fresh")).toBe(true);
  });

  it("a silent term leaves both the active group and the terminal view alone", async () => {
    renderHook(() => useUiNav());

    await nav({ action: "term", repo_id: 2, title: "bg", silent: true });

    const s = useUiStore.getState();
    // Nothing is revealed, so nothing on screen may move either.
    expect(s.activeGroupId).toBe(1);
    expect(s.terminalViewGroupId).toBe(1);
    expect(s.terminalOpen).toBe(false);
  });
});
