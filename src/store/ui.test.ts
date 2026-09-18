import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULTS, useSettings } from "@/lib/settings";
import { parseStoredTerminals, useUiStore } from "./ui";

const REPO_SIDEBAR_KEY = "gamut.repoSidebarHidden";

describe("repo sidebar store actions (#283)", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ repoSidebarHidden: true });
  });

  it("toggleRepoSidebar flips the flag and persists it (the ⌘B / button / menu action)", () => {
    useUiStore.getState().toggleRepoSidebar();
    expect(useUiStore.getState().repoSidebarHidden).toBe(false);
    expect(localStorage.getItem(REPO_SIDEBAR_KEY)).toBe("0");
    useUiStore.getState().toggleRepoSidebar();
    expect(useUiStore.getState().repoSidebarHidden).toBe(true);
    expect(localStorage.getItem(REPO_SIDEBAR_KEY)).toBe("1");
  });

  it("revealRepoSidebar shows the sidebar in-memory without persisting the preference", () => {
    localStorage.setItem(REPO_SIDEBAR_KEY, "1"); // saved preference: hidden
    useUiStore.getState().revealRepoSidebar();
    expect(useUiStore.getState().repoSidebarHidden).toBe(false);
    expect(localStorage.getItem(REPO_SIDEBAR_KEY)).toBe("1"); // preference untouched
  });
});

describe("openRepoConfig / closeRepoConfig (#306 follow-up)", () => {
  beforeEach(() => {
    useUiStore.setState({ repoConfigRepoId: null, activeRepoId: null });
  });

  it("openRepoConfig targets an explicit repo without touching activeRepoId", () => {
    useUiStore.getState().openRepoConfig(7);
    expect(useUiStore.getState().repoConfigRepoId).toBe(7);
    expect(useUiStore.getState().activeRepoId).toBeNull();

    // Already open, on a different repo — still jumps to the target.
    useUiStore.getState().openRepoConfig(9);
    expect(useUiStore.getState().repoConfigRepoId).toBe(9);
  });

  it("closeRepoConfig clears the target repo", () => {
    useUiStore.setState({ repoConfigRepoId: 7 });
    useUiStore.getState().closeRepoConfig();
    expect(useUiStore.getState().repoConfigRepoId).toBeNull();
  });
});

/** A minimal well-formed persisted blob for one group with one tab/pane. */
function blob(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    nextTermId: 5,
    terminals: {
      1: {
        activeTabId: "tab-3",
        tabs: [
          {
            id: "tab-3",
            title: "gamut",
            panes: [{ id: "term-3", cwd: "/repo" }],
            activePaneId: "term-3",
          },
        ],
      },
    },
    ...overrides,
  });
}

describe("parseStoredTerminals", () => {
  it("round-trips a valid layout", () => {
    const { terminals, nextTermId } = parseStoredTerminals(blob());
    expect(terminals[1].tabs).toHaveLength(1);
    expect(terminals[1].activeTabId).toBe("tab-3");
    expect(terminals[1].tabs[0].panes[0].cwd).toBe("/repo");
    // Counter is bumped past every restored id so new tabs can't collide.
    expect(nextTermId).toBe(4);
  });

  it("returns empty on corrupt JSON", () => {
    expect(parseStoredTerminals("{not json")).toEqual({ terminals: {}, nextTermId: 1 });
  });

  it("returns empty when the shape is wrong", () => {
    expect(parseStoredTerminals(JSON.stringify({ terminals: [] }))).toEqual({
      terminals: {},
      nextTermId: 1,
    });
  });

  it("drops malformed tabs and groups with no valid tabs", () => {
    const raw = JSON.stringify({
      terminals: {
        1: {
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              title: "ok",
              panes: [{ id: "term-1", cwd: "/a" }],
              activePaneId: "term-1",
            },
            { id: "tab-2", title: "bad", panes: [] }, // no panes → dropped
            {
              id: "tab-3",
              title: "bad2",
              panes: [{ id: "term-9", cwd: "/b" }],
              activePaneId: "nope",
            },
          ],
        },
        2: { activeTabId: null, tabs: [{ id: "x", title: "y" }] }, // no valid tabs → group dropped
      },
    });
    const { terminals } = parseStoredTerminals(raw);
    expect(Object.keys(terminals)).toEqual(["1"]);
    expect(terminals[1].tabs.map((t) => t.id)).toEqual(["tab-1"]);
  });

  it("repairs an activeTabId that names no surviving tab", () => {
    const raw = JSON.stringify({
      terminals: {
        1: {
          activeTabId: "gone",
          tabs: [
            {
              id: "tab-7",
              title: "t",
              panes: [{ id: "term-7", cwd: "/c" }],
              activePaneId: "term-7",
            },
          ],
        },
      },
    });
    expect(parseStoredTerminals(raw).terminals[1].activeTabId).toBe("tab-7");
  });

  it("computes nextTermId from the largest restored id", () => {
    const raw = JSON.stringify({
      terminals: {
        1: {
          activeTabId: "tab-2",
          tabs: [
            {
              id: "tab-2",
              title: "t",
              panes: [
                { id: "term-2", cwd: "/a" },
                { id: "term-42", cwd: "/b" },
              ],
              activePaneId: "term-2",
            },
          ],
        },
      },
    });
    expect(parseStoredTerminals(raw).nextTermId).toBe(43);
  });
});

describe("splitTerminal grid (#316)", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({
      terminals: {
        1: {
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              title: "t",
              panes: [{ id: "term-1", cwd: "/repo" }],
              activePaneId: "term-1",
            },
          ],
        },
      },
      nextTermId: 2,
    });
  });

  /** The grid as `[row][paneIds]`, from the flat row-major pane list. */
  function grid() {
    const tab = useUiStore.getState().terminals[1].tabs[0];
    const rows: string[][] = [];
    for (const p of tab.panes) {
      const r = p.row ?? 0;
      (rows[r] ??= []).push(p.id);
    }
    return rows;
  }

  it("a row split adds a pane beside the active one (default)", () => {
    useUiStore.getState().splitTerminal(1, "/repo");
    expect(grid()).toEqual([["term-1", "term-2"]]);
  });

  it("a column split adds a new row below the active pane's row", () => {
    useUiStore.getState().splitTerminal(1, "/repo", "column");
    expect(grid()).toEqual([["term-1"], ["term-2"]]);
  });

  it("mixes freely: 50/50 over 100", () => {
    const s = useUiStore.getState();
    s.splitTerminal(1, "/repo", "column"); // rows: [1], [2] — active = 2
    s.setActivePane(1, "tab-1", "term-1");
    s.splitTerminal(1, "/repo", "row"); // beside 1 in row 0
    expect(grid()).toEqual([["term-1", "term-3"], ["term-2"]]);
  });

  it("mixes freely: 33/33/33 over 50/50", () => {
    const s = useUiStore.getState();
    s.splitTerminal(1, "/repo", "column"); // row 1: term-2 (active)
    s.splitTerminal(1, "/repo", "row"); // beside it: row 1 = 2,3
    s.setActivePane(1, "tab-1", "term-1");
    s.splitTerminal(1, "/repo", "row"); // row 0 = 1,4
    s.splitTerminal(1, "/repo", "row"); // row 0 = 1,4,5 (active was 4)
    expect(grid()).toEqual([
      ["term-1", "term-4", "term-5"],
      ["term-2", "term-3"],
    ]);
  });

  it("a column split in the middle shifts the rows below it down", () => {
    const s = useUiStore.getState();
    s.splitTerminal(1, "/repo", "column"); // rows: [1], [2]
    s.setActivePane(1, "tab-1", "term-1");
    s.splitTerminal(1, "/repo", "column"); // new row below row 0
    expect(grid()).toEqual([["term-1"], ["term-3"], ["term-2"]]);
  });

  it("closing a row's last pane collapses the row and drops its height weight", () => {
    const s = useUiStore.getState();
    s.splitTerminal(1, "/repo", "column"); // rows: [1], [2]
    s.splitTerminal(1, "/repo", "column"); // active was 2 → rows: [1], [2], [3]
    useUiStore.getState().resizeTerminalSplit(1, "tab-1", { rowSizes: [2, 1, 1] });
    useUiStore.getState().closeTerminalPane(1, "tab-1", "term-2");
    const tab = useUiStore.getState().terminals[1].tabs[0];
    expect(grid()).toEqual([["term-1"], ["term-3"]]);
    expect(tab.rowSizes).toEqual([2, 1]);
  });

  it("resizeTerminalSplit rebalances pane width weights", () => {
    const s = useUiStore.getState();
    s.splitTerminal(1, "/repo", "row");
    useUiStore
      .getState()
      .resizeTerminalSplit(1, "tab-1", { paneSizes: { "term-1": 1.5, "term-2": 0.5 } });
    const tab = useUiStore.getState().terminals[1].tabs[0];
    expect(tab.panes.map((p) => p.size)).toEqual([1.5, 0.5]);
  });
});

describe("parseStoredTerminals split grid (#316)", () => {
  function tabWith(overrides: Record<string, unknown>, panes?: unknown[]) {
    return JSON.stringify({
      terminals: {
        1: {
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              title: "t",
              panes: panes ?? [
                { id: "term-1", cwd: "/a", row: 0, size: 2 },
                { id: "term-2", cwd: "/a", row: 0, size: 1 },
                { id: "term-3", cwd: "/a", row: 1 },
              ],
              activePaneId: "term-1",
              ...overrides,
            },
          ],
        },
      },
    });
  }

  it("round-trips rows, pane width weights, and row height weights", () => {
    const { terminals } = parseStoredTerminals(tabWith({ rowSizes: [3, 1] }));
    const tab = terminals[1].tabs[0];
    expect(tab.panes.map((p) => [p.row ?? 0, p.size ?? 1])).toEqual([
      [0, 2],
      [0, 1],
      [1, 1],
    ]);
    expect(tab.rowSizes).toEqual([3, 1]);
  });

  it("accepts a tab with no grid fields (older blobs) as one row", () => {
    const { terminals } = parseStoredTerminals(blob());
    expect(terminals[1].tabs[0].panes.every((p) => (p.row ?? 0) === 0)).toBe(true);
  });

  it("normalizes gappy or out-of-order rows to contiguous row-major order", () => {
    const { terminals } = parseStoredTerminals(
      tabWith({}, [
        { id: "term-3", cwd: "/a", row: 4 },
        { id: "term-1", cwd: "/a", row: 0 },
        { id: "term-2", cwd: "/a", row: 0 },
      ]),
    );
    const tab = terminals[1].tabs[0];
    expect(tab.panes.map((p) => [p.id, p.row ?? 0])).toEqual([
      ["term-1", 0],
      ["term-2", 0],
      ["term-3", 1],
    ]);
  });

  it("drops a tab whose row is malformed", () => {
    const { terminals } = parseStoredTerminals(tabWith({}, [{ id: "term-1", cwd: "/a", row: -1 }]));
    expect(terminals[1]).toBeUndefined();
  });

  it("drops a tab whose rowSizes carry a non-positive weight", () => {
    const { terminals } = parseStoredTerminals(tabWith({ rowSizes: [1, 0] }));
    expect(terminals[1]).toBeUndefined();
  });
});

describe("showView (intentional workspace navigation)", () => {
  it("sets the view and leaves the full-screen terminal", () => {
    useUiStore.setState({ view: "files", terminalOpen: true });
    useUiStore.getState().showView("history");
    const s = useUiStore.getState();
    expect(s.view).toBe("history");
    expect(s.terminalOpen).toBe(false);
  });

  it("plain setView never touches the terminal (guards keep using it)", () => {
    useUiStore.setState({ view: "history", terminalOpen: true });
    useUiStore.getState().setView("files");
    const s = useUiStore.getState();
    expect(s.view).toBe("files");
    expect(s.terminalOpen).toBe(true);
  });
});

// #339: the terminal view and the workspace move independently. `focusTerminal`
// is a "reveal this terminal" intent from the sidebar rail, the palette, the
// cycle chords and the notification click — none of them asks for the workspace
// to jump. `terminalFollowGroup` opts back into the old coupled behaviour.
describe("terminal view group decoupling (#339)", () => {
  /** Two groups, one tab each, so a focus can cross a group boundary. */
  function seedTerminals() {
    return {
      1: {
        activeTabId: "tab-1",
        tabs: [
          {
            id: "tab-1",
            title: "g1",
            panes: [{ id: "term-1", cwd: "/a" }],
            activePaneId: "term-1",
          },
        ],
      },
      2: {
        activeTabId: "tab-2",
        tabs: [
          {
            id: "tab-2",
            title: "g2",
            panes: [{ id: "term-2", cwd: "/b" }],
            activePaneId: "term-2",
          },
        ],
      },
    };
  }

  beforeEach(() => {
    localStorage.clear();
    useSettings.setState({ values: { ...DEFAULTS } });
    useUiStore.setState({
      activeGroupId: 1,
      terminalViewGroupId: 1,
      activeRepoId: 11,
      activeWorktreePath: null,
      selectedPrNumber: 4,
      view: "history",
      groupSelections: {},
      terminalOpen: false,
      terminalFocusNonce: 0,
      terminals: seedTerminals(),
    });
  });

  describe("focusTerminal with terminalFollowGroup off (the default)", () => {
    it("leaves the active group where it is (A1) and moves the view alone (A2)", () => {
      useUiStore.getState().focusTerminal(2, "tab-2", "term-2");

      const s = useUiStore.getState();
      expect(s.activeGroupId).toBe(1);
      expect(s.terminalViewGroupId).toBe(2);
    });

    it("leaves every other workspace selection byte-identical (A3)", () => {
      const before = useUiStore.getState();
      const snapshot = {
        activeRepoId: before.activeRepoId,
        view: before.view,
        activeWorktreePath: before.activeWorktreePath,
        selectedPrNumber: before.selectedPrNumber,
        groupSelections: before.groupSelections,
      };

      useUiStore.getState().focusTerminal(2, "tab-2", "term-2");

      const after = useUiStore.getState();
      expect(after.activeRepoId).toBe(snapshot.activeRepoId);
      expect(after.view).toBe(snapshot.view);
      expect(after.activeWorktreePath).toBe(snapshot.activeWorktreePath);
      expect(after.selectedPrNumber).toBe(snapshot.selectedPrNumber);
      // Same object, not merely equal: setActiveGroup would have rewritten the
      // outgoing group's remembered repo/view into a fresh map.
      expect(after.groupSelections).toBe(snapshot.groupSelections);
    });

    it("still opens the terminal, selects the tab, sets the pane and bumps the nonce (A5)", () => {
      useUiStore.setState({
        terminals: {
          ...seedTerminals(),
          2: {
            activeTabId: "tab-2",
            tabs: [
              {
                id: "tab-2",
                title: "g2",
                panes: [
                  { id: "term-2", cwd: "/b" },
                  { id: "term-3", cwd: "/b" },
                ],
                activePaneId: "term-2",
              },
            ],
          },
        },
      });

      useUiStore.getState().focusTerminal(2, "tab-2", "term-3");

      const s = useUiStore.getState();
      expect(s.terminalOpen).toBe(true);
      expect(s.terminals[2].activeTabId).toBe("tab-2");
      expect(s.terminals[2].tabs[0].activePaneId).toBe("term-3");
      expect(s.terminalFocusNonce).toBe(1);
    });
  });

  describe("focusTerminal with terminalFollowGroup on", () => {
    beforeEach(() => {
      useSettings.setState({ values: { ...DEFAULTS, terminalFollowGroup: true } });
    });

    it("moves the active group and the view together (A4)", () => {
      useUiStore.getState().focusTerminal(2, "tab-2", "term-2");

      const s = useUiStore.getState();
      expect(s.activeGroupId).toBe(2);
      expect(s.terminalViewGroupId).toBe(2);
    });

    it("still opens the terminal, selects the tab and bumps the nonce (A5)", () => {
      useUiStore.getState().focusTerminal(2, "tab-2", "term-2");

      const s = useUiStore.getState();
      expect(s.terminalOpen).toBe(true);
      expect(s.terminals[2].activeTabId).toBe("tab-2");
      expect(s.terminals[2].tabs[0].activePaneId).toBe("term-2");
      expect(s.terminalFocusNonce).toBe(1);
    });
  });

  describe("setActiveGroup drags the terminal view with it (A6)", () => {
    it("moves the view when the group changes", () => {
      useUiStore.getState().setActiveGroup(2);

      const s = useUiStore.getState();
      expect(s.activeGroupId).toBe(2);
      expect(s.terminalViewGroupId).toBe(2);
    });

    it("pulls a stranded view back even when the group is already active", () => {
      // The user is viewing group 2's terminal while group 1 is active, then
      // clicks group 1 in the sidebar to get back. Without this, the early
      // return in setActiveGroup makes that click do nothing at all.
      useUiStore.setState({ activeGroupId: 1, terminalViewGroupId: 2 });

      useUiStore.getState().setActiveGroup(1);

      const s = useUiStore.getState();
      expect(s.activeGroupId).toBe(1);
      expect(s.terminalViewGroupId).toBe(1);
    });

    it("leaves the rest of the state alone on the already-active path", () => {
      useUiStore.setState({ activeGroupId: 1, terminalViewGroupId: 2 });
      const before = useUiStore.getState();

      useUiStore.getState().setActiveGroup(1);

      const after = useUiStore.getState();
      expect(after.activeRepoId).toBe(before.activeRepoId);
      expect(after.view).toBe(before.view);
      expect(after.selectedPrNumber).toBe(before.selectedPrNumber);
      expect(after.groupSelections).toBe(before.groupSelections);
    });
  });

  describe("addTerminalTab pulls the view to the group it reveals a tab in", () => {
    // Regression guard: the view moves independently of the active group now,
    // so every "New terminal" affordance that targets a group other than the
    // viewed one — the rail's +, "Open terminal here" on a repo/worktree row,
    // the file-tree folder menu, ⌘T — would otherwise spawn a live shell out
    // of sight and look like it did nothing at all.
    it("moves the view to the new tab's group", () => {
      useUiStore.setState({ activeGroupId: 1, terminalViewGroupId: 2 });

      useUiStore.getState().addTerminalTab(1, "/a", "fresh");

      const s = useUiStore.getState();
      expect(s.terminalViewGroupId).toBe(1);
      expect(s.terminalOpen).toBe(true);
      const added = s.terminals[1].tabs[s.terminals[1].tabs.length - 1];
      expect(added.title).toBe("fresh");
      expect(s.terminals[1].activeTabId).toBe(added.id);
    });

    it("leaves the view put for a background tab", () => {
      useUiStore.setState({ activeGroupId: 1, terminalViewGroupId: 2 });

      useUiStore.getState().addTerminalTab(1, "/a", "quiet", { background: true });

      const s = useUiStore.getState();
      // Not stealing the user's view is the whole point of the flag.
      expect(s.terminalViewGroupId).toBe(2);
      expect(s.terminalOpen).toBe(false);
      expect(s.terminals[1].activeTabId).toBe("tab-1");
    });
  });

  describe("closing the viewed group's last tab snaps the view back (A22)", () => {
    it("snaps back when the viewed group is not the active group", () => {
      useUiStore.setState({ activeGroupId: 1, terminalViewGroupId: 2 });

      useUiStore.getState().closeTerminalTab(2, "tab-2");

      const s = useUiStore.getState();
      expect(s.terminals[2].tabs).toEqual([]);
      // Otherwise the pane strands on an empty group whose "New terminal"
      // button targets a different one, with no rail row left to get back from.
      expect(s.terminalViewGroupId).toBe(1);
    });

    it("snaps back when the last pane of the last tab closes", () => {
      useUiStore.setState({ activeGroupId: 1, terminalViewGroupId: 2 });

      useUiStore.getState().closeTerminalPane(2, "tab-2", "term-2");

      const s = useUiStore.getState();
      expect(s.terminals[2].tabs).toEqual([]);
      expect(s.terminalViewGroupId).toBe(1);
    });

    it("leaves the view alone while the viewed group still has tabs", () => {
      useUiStore.setState({
        activeGroupId: 1,
        terminalViewGroupId: 2,
        terminals: {
          ...seedTerminals(),
          2: {
            activeTabId: "tab-2",
            tabs: [
              {
                id: "tab-2",
                title: "g2",
                panes: [{ id: "term-2", cwd: "/b" }],
                activePaneId: "term-2",
              },
              {
                id: "tab-3",
                title: "g2b",
                panes: [{ id: "term-3", cwd: "/b" }],
                activePaneId: "term-3",
              },
            ],
          },
        },
      });

      useUiStore.getState().closeTerminalTab(2, "tab-2");

      expect(useUiStore.getState().terminalViewGroupId).toBe(2);
    });

    it("leaves the view alone when the emptied group is the active one", () => {
      useUiStore.setState({ activeGroupId: 2, terminalViewGroupId: 2 });

      useUiStore.getState().closeTerminalTab(2, "tab-2");

      // Nothing to snap to: the pane's "New terminal" button already targets
      // this group, so the empty state is the correct thing to show.
      expect(useUiStore.getState().terminalViewGroupId).toBe(2);
    });
  });

  it("setTerminalViewGroup moves the view without touching the active group", () => {
    useUiStore.getState().setTerminalViewGroup(2);

    const s = useUiStore.getState();
    expect(s.terminalViewGroupId).toBe(2);
    expect(s.activeGroupId).toBe(1);
  });
});
