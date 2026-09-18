import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Repo } from "@/lib/ipc";
import { DEFAULTS, useSettings } from "@/lib/settings";

// The live xterm sessions are out of scope here: this suite is about WHICH
// tab's layout the pane drives. The hook is mocked so the options it receives
// (the panes and the active tab) are directly assertable, and no PTY or WebGL
// context is needed in jsdom.
const sessions = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  killPane: vi.fn(),
}));
vi.mock("./useTerminalSessions", () => ({
  useTerminalSessions: (options: Record<string, unknown>) => {
    sessions.options = options;
    return { deadKeys: new Set<string>(), killPane: sessions.killPane, restart: vi.fn() };
  },
}));

const mocks = vi.hoisted(() => ({ groups: [] as Group[], repos: [] as Repo[] }));
vi.mock("@/features/repos/api", () => ({
  useGroups: () => ({ data: mocks.groups }),
  useRepos: () => ({ data: mocks.repos }),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: { terminalRegistryReport: vi.fn(() => Promise.resolve()) },
}));

import { useUiStore } from "@/store/ui";
import { TerminalPane } from "./TerminalPane";

function group(id: number, name: string): Group {
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
  };
}

function repo(id: number, name: string, groupIds: number[]): Repo {
  return {
    id,
    path: `/repos/${name}`,
    name,
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

/**
 * One flat terminal list (#340): a single-pane tab opened in group 1, a split
 * tab opened in group 2 — active. The two groups pin that the pane follows
 * `activeTabId` alone, never the tab's own `groupId`.
 */
function seed() {
  useUiStore.setState({
    activeGroupId: 1,
    activeRepoId: null,
    activeWorktreePath: null,
    terminalOpen: true,
    terminals: {
      activeTabId: "g2-tab",
      tabs: [
        {
          id: "g1-tab",
          groupId: 1,
          title: "alpha",
          panes: [{ id: "g1-pane", cwd: "/repos/alpha" }],
          activePaneId: "g1-pane",
        },
        {
          id: "g2-tab",
          groupId: 2,
          title: "beta",
          panes: [
            { id: "g2-pane-a", cwd: "/repos/beta" },
            { id: "g2-pane-b", cwd: "/repos/beta" },
          ],
          activePaneId: "g2-pane-a",
        },
      ],
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  sessions.options = null;
  sessions.killPane.mockClear();
  mocks.groups = [group(1, "Default"), group(2, "Tools")];
  // Group 1 is the default group, which shows ungrouped repos — that is what
  // gives ⌘T a target there.
  mocks.repos = [repo(1, "alpha", []), repo(2, "beta", [2])];
  useSettings.setState({ values: { ...DEFAULTS } });
  seed();
});

// #340: the terminal list is one flat sequence, so the pane always renders
// whichever tab is `terminals.activeTabId` — never scoped to a group.
describe("TerminalPane renders the active tab, whatever its group (#340)", () => {
  it("drives the active tab's panes (A7)", () => {
    render(<TerminalPane />);

    const o = sessions.options!;
    expect((o.activeTab as { id: string }).id).toBe("g2-tab");
    expect((o.activePanes as { id: string }[]).map((p) => p.id)).toEqual([
      "g2-pane-a",
      "g2-pane-b",
    ]);
    expect(o.paneKey as string).toMatch(/^g2-tab\|/);
    // The list has tabs, so the empty state must not show even though the
    // active tab belongs to a group other than the active one.
    expect(screen.queryByText("No terminals open.")).toBeNull();
  });

  it("shows the empty state with no tabs open at all", () => {
    useUiStore.setState({ terminals: { tabs: [], activeTabId: null } });
    render(<TerminalPane />);

    expect(screen.getByText("No terminals open.")).toBeTruthy();
  });

  it("⌘T adds a tab to the active group and makes it the new active tab (A8)", () => {
    render(<TerminalPane />);
    const beforeG1 = useUiStore.getState().terminals.tabs.find((t) => t.id === "g1-tab");
    const beforeG2 = useUiStore.getState().terminals.tabs.find((t) => t.id === "g2-tab");

    fireEvent.keyDown(window, { code: "KeyT", metaKey: true });

    const s = useUiStore.getState();
    expect(s.terminals.tabs).toHaveLength(3);
    // The pre-existing tabs are untouched — same objects, not merely equal.
    expect(s.terminals.tabs.find((t) => t.id === "g1-tab")).toBe(beforeG1);
    expect(s.terminals.tabs.find((t) => t.id === "g2-tab")).toBe(beforeG2);
    // …and the new tab is the one now on screen.
    const added = s.terminals.tabs.find((t) => t.id !== "g1-tab" && t.id !== "g2-tab")!;
    expect(added.groupId).toBe(1);
    expect(s.terminals.activeTabId).toBe(added.id);
  });

  it("the close-tab chord closes the active tab (A9)", () => {
    render(<TerminalPane />);
    const beforeG1 = useUiStore.getState().terminals.tabs.find((t) => t.id === "g1-tab");

    // Non-macOS chord: jsdom reports no platform, so isMac() is false.
    fireEvent.keyDown(window, { code: "KeyW", ctrlKey: true, shiftKey: true });

    const s = useUiStore.getState();
    expect(s.terminals.tabs.find((t) => t.id === "g2-tab")).toBeUndefined();
    expect(s.terminals.tabs.find((t) => t.id === "g1-tab")).toBe(beforeG1);
    // Both panes' PTYs are killed, not just the active one.
    expect(sessions.killPane).toHaveBeenCalledWith("g2-pane-a");
    expect(sessions.killPane).toHaveBeenCalledWith("g2-pane-b");
  });

  it("the per-split close button closes a pane of the active tab (A9)", () => {
    render(<TerminalPane />);
    const beforeG1 = useUiStore.getState().terminals.tabs.find((t) => t.id === "g1-tab");

    fireEvent.click(screen.getAllByLabelText("Close split")[1]);

    const s = useUiStore.getState();
    expect(s.terminals.tabs.find((t) => t.id === "g2-tab")!.panes.map((p) => p.id)).toEqual([
      "g2-pane-a",
    ]);
    expect(s.terminals.tabs.find((t) => t.id === "g1-tab")).toBe(beforeG1);
  });

  it("a divider nudge resizes the active tab's panes only", () => {
    render(<TerminalPane />);
    const beforeG1 = useUiStore.getState().terminals.tabs.find((t) => t.id === "g1-tab");

    fireEvent.keyDown(screen.getByLabelText("Resize split columns (row 1)"), {
      key: "ArrowLeft",
    });

    const s = useUiStore.getState();
    const sizes = s.terminals.tabs
      .find((t) => t.id === "g2-tab")!
      .panes.map((p) => p.size ?? 1);
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(s.terminals.tabs.find((t) => t.id === "g1-tab")).toBe(beforeG1);
  });
});
