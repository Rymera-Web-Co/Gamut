import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Repo } from "@/lib/ipc";
import { DEFAULTS, useSettings } from "@/lib/settings";

// The live xterm sessions are out of scope here: this suite is about WHICH
// group's layout the pane drives. The hook is mocked so the options it receives
// (the panes, the tab and the group id that routes `setActivePane`) are directly
// assertable, and no PTY or WebGL context is needed in jsdom.
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

/** Group 1 (active) with one single-pane tab; group 2 (viewed) with a split tab. */
function seed() {
  useUiStore.setState({
    activeGroupId: 1,
    terminalViewGroupId: 2,
    activeRepoId: null,
    activeWorktreePath: null,
    terminalOpen: true,
    terminals: {
      1: {
        activeTabId: "g1-tab",
        tabs: [
          {
            id: "g1-tab",
            title: "alpha",
            panes: [{ id: "g1-pane", cwd: "/repos/alpha" }],
            activePaneId: "g1-pane",
          },
        ],
      },
      2: {
        activeTabId: "g2-tab",
        tabs: [
          {
            id: "g2-tab",
            title: "beta",
            panes: [
              { id: "g2-pane-a", cwd: "/repos/beta" },
              { id: "g2-pane-b", cwd: "/repos/beta" },
            ],
            activePaneId: "g2-pane-a",
          },
        ],
      },
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

// #339: the pane renders the VIEWED group's session, which need not be the
// active group's. ⌘T is the one exception — it opens a terminal for the
// workspace you are looking at, so it targets the active group and drags the
// view there.
describe("TerminalPane viewed vs active group (#339)", () => {
  it("drives the viewed group's tab, not the active group's (A7)", () => {
    render(<TerminalPane />);

    const o = sessions.options!;
    expect((o.activeTab as { id: string }).id).toBe("g2-tab");
    expect((o.activePanes as { id: string }[]).map((p) => p.id)).toEqual([
      "g2-pane-a",
      "g2-pane-b",
    ]);
    // The group id that routes `setActivePane` from a pane click (A18).
    expect(o.viewGroupId).toBe(2);
    expect(o.paneKey as string).toMatch(/^2\|g2-tab\|/);
    // Group 2 has tabs, so the "no terminals" empty state must not show even
    // though the ACTIVE group's own tab list is irrelevant here.
    expect(screen.queryByText("No terminals open in this group.")).toBeNull();
  });

  it("falls back to the active group before the first focus (boot, A23)", () => {
    // The boot window: `terminalViewGroupId` is null until something focuses a
    // terminal, so the pane must still render the active group's restored tabs.
    useUiStore.setState({ terminalViewGroupId: null, activeGroupId: 1 });
    render(<TerminalPane />);

    const o = sessions.options!;
    expect(o.viewGroupId).toBe(1);
    expect((o.activeTab as { id: string }).id).toBe("g1-tab");
  });

  it("shows the empty state for a viewed group with no tabs, not the active one's tabs", () => {
    useUiStore.setState({ terminalViewGroupId: 3 });
    mocks.groups = [...mocks.groups, group(3, "Empty")];
    render(<TerminalPane />);

    expect(screen.getByText("No terminals open in this group.")).toBeTruthy();
  });

  it("⌘T adds a tab to the ACTIVE group and moves the view there (A8)", () => {
    render(<TerminalPane />);
    const beforeG2 = useUiStore.getState().terminals[2];

    fireEvent.keyDown(window, { code: "KeyT", metaKey: true });

    const s = useUiStore.getState();
    expect(s.terminals[1].tabs).toHaveLength(2);
    // The viewed group's record is untouched — same object, not merely equal.
    expect(s.terminals[2]).toBe(beforeG2);
    // …and the new tab is visible, rather than added off-screen in group 1.
    expect(s.terminalViewGroupId).toBe(1);
  });

  it("the close-tab chord closes the VIEWED group's tab (A9)", () => {
    render(<TerminalPane />);
    const beforeG1 = useUiStore.getState().terminals[1];

    // Non-macOS chord: jsdom reports no platform, so isMac() is false.
    fireEvent.keyDown(window, { code: "KeyW", ctrlKey: true, shiftKey: true });

    const s = useUiStore.getState();
    expect(s.terminals[2].tabs).toHaveLength(0);
    expect(s.terminals[1]).toBe(beforeG1);
    // Both panes' PTYs are killed, not just the active one.
    expect(sessions.killPane).toHaveBeenCalledWith("g2-pane-a");
    expect(sessions.killPane).toHaveBeenCalledWith("g2-pane-b");
  });

  it("the per-split close button closes a pane of the VIEWED group (A9)", () => {
    render(<TerminalPane />);
    const beforeG1 = useUiStore.getState().terminals[1];

    fireEvent.click(screen.getAllByLabelText("Close split")[1]);

    const s = useUiStore.getState();
    expect(s.terminals[2].tabs[0].panes.map((p) => p.id)).toEqual(["g2-pane-a"]);
    expect(s.terminals[1]).toBe(beforeG1);
  });

  it("a divider nudge resizes the VIEWED group's panes (A9)", () => {
    render(<TerminalPane />);
    const beforeG1 = useUiStore.getState().terminals[1];

    fireEvent.keyDown(screen.getByLabelText("Resize split columns (row 1)"), {
      key: "ArrowLeft",
    });

    const s = useUiStore.getState();
    const sizes = s.terminals[2].tabs[0].panes.map((p) => p.size ?? 1);
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(s.terminals[1]).toBe(beforeG1);
  });
});
