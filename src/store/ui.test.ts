import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ipc } from "@/lib/ipc";
import { DEFAULTS, useSettings } from "@/lib/settings";
import { parseStoredTerminals, useUiStore, type TermTab } from "./ui";

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

/** A minimal well-formed persisted blob for one tab/pane, in the current flat shape. */
function blob(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    nextTermId: 5,
    terminals: {
      tabs: [
        {
          id: "tab-3",
          groupId: 1,
          title: "gamut",
          panes: [{ id: "term-3", cwd: "/repo" }],
          activePaneId: "term-3",
        },
      ],
      activeTabId: "tab-3",
    },
    ...overrides,
  });
}

describe("parseStoredTerminals", () => {
  it("round-trips a valid layout", () => {
    const { terminals, nextTermId } = parseStoredTerminals(blob());
    expect(terminals.tabs).toHaveLength(1);
    expect(terminals.activeTabId).toBe("tab-3");
    expect(terminals.tabs[0].panes[0].cwd).toBe("/repo");
    expect(terminals.tabs[0].groupId).toBe(1);
    // Counter is bumped past every restored id so new tabs can't collide.
    expect(nextTermId).toBe(4);
  });

  it("returns empty on corrupt JSON", () => {
    expect(parseStoredTerminals("{not json")).toEqual({
      terminals: { tabs: [], activeTabId: null },
      nextTermId: 1,
    });
  });

  it("returns empty when the shape is wrong", () => {
    expect(parseStoredTerminals(JSON.stringify({ terminals: [] }))).toEqual({
      terminals: { tabs: [], activeTabId: null },
      nextTermId: 1,
    });
  });

  it("reads the new flat blob shape", () => {
    const raw = JSON.stringify({
      terminals: {
        tabs: [
          {
            id: "tab-1",
            groupId: 3,
            title: "ok",
            panes: [{ id: "term-1", cwd: "/a" }],
            activePaneId: "term-1",
          },
        ],
        activeTabId: "tab-1",
      },
    });
    const { terminals } = parseStoredTerminals(raw);
    expect(terminals.tabs.map((t) => t.id)).toEqual(["tab-1"]);
    expect(terminals.tabs[0].groupId).toBe(3);
    expect(terminals.activeTabId).toBe("tab-1");
  });

  it("drops malformed tabs and legacy buckets with no valid tabs", () => {
    // Legacy per-group blob (pre-#340): { [groupId]: { tabs, activeTabId } }.
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
        2: { activeTabId: null, tabs: [{ id: "x", title: "y" }] }, // no valid tabs → bucket dropped
      },
    });
    const { terminals } = parseStoredTerminals(raw);
    expect(terminals.tabs.map((t) => t.id)).toEqual(["tab-1"]);
    // Stamped from its bucket's key.
    expect(terminals.tabs[0].groupId).toBe(1);
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
    expect(parseStoredTerminals(raw).terminals.activeTabId).toBe("tab-7");
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

  it("flattens a legacy per-group blob in ascending group-id order, stamps each tab's groupId, and bumps nextTermId past every restored id", () => {
    // Bucket 2 appears first in the source object, but ascending group-id
    // order means bucket 1's tabs land first in the flattened list.
    const raw = JSON.stringify({
      terminals: {
        2: {
          activeTabId: "tab-5",
          tabs: [
            {
              id: "tab-5",
              title: "b",
              panes: [{ id: "term-9", cwd: "/b" }],
              activePaneId: "term-9",
            },
          ],
        },
        1: {
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              title: "a",
              panes: [{ id: "term-1", cwd: "/a" }],
              activePaneId: "term-1",
            },
          ],
        },
      },
    });
    const { terminals, nextTermId } = parseStoredTerminals(raw);
    expect(terminals.tabs.map((t) => t.id)).toEqual(["tab-1", "tab-5"]);
    expect(terminals.tabs.map((t) => t.groupId)).toEqual([1, 2]);
    // The first bucket, in ascending order, that names a live tab wins.
    expect(terminals.activeTabId).toBe("tab-1");
    expect(nextTermId).toBe(10);
  });
});

describe("splitTerminal grid (#316)", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({
      terminals: {
        tabs: [
          {
            id: "tab-1",
            groupId: 1,
            title: "t",
            panes: [{ id: "term-1", cwd: "/repo" }],
            activePaneId: "term-1",
          },
        ],
        activeTabId: "tab-1",
      },
      nextTermId: 2,
    });
  });

  /** The grid as `[row][paneIds]`, from the flat row-major pane list. */
  function grid() {
    const tab = useUiStore.getState().terminals.tabs[0];
    const rows: string[][] = [];
    for (const p of tab.panes) {
      const r = p.row ?? 0;
      (rows[r] ??= []).push(p.id);
    }
    return rows;
  }

  it("a row split adds a pane beside the active one (default)", () => {
    useUiStore.getState().splitTerminal("/repo");
    expect(grid()).toEqual([["term-1", "term-2"]]);
  });

  it("a column split adds a new row below the active pane's row", () => {
    useUiStore.getState().splitTerminal("/repo", "column");
    expect(grid()).toEqual([["term-1"], ["term-2"]]);
  });

  it("mixes freely: 50/50 over 100", () => {
    const s = useUiStore.getState();
    s.splitTerminal("/repo", "column"); // rows: [1], [2] — active = 2
    s.setActivePane("tab-1", "term-1");
    s.splitTerminal("/repo", "row"); // beside 1 in row 0
    expect(grid()).toEqual([["term-1", "term-3"], ["term-2"]]);
  });

  it("mixes freely: 33/33/33 over 50/50", () => {
    const s = useUiStore.getState();
    s.splitTerminal("/repo", "column"); // row 1: term-2 (active)
    s.splitTerminal("/repo", "row"); // beside it: row 1 = 2,3
    s.setActivePane("tab-1", "term-1");
    s.splitTerminal("/repo", "row"); // row 0 = 1,4
    s.splitTerminal("/repo", "row"); // row 0 = 1,4,5 (active was 4)
    expect(grid()).toEqual([
      ["term-1", "term-4", "term-5"],
      ["term-2", "term-3"],
    ]);
  });

  it("a column split in the middle shifts the rows below it down", () => {
    const s = useUiStore.getState();
    s.splitTerminal("/repo", "column"); // rows: [1], [2]
    s.setActivePane("tab-1", "term-1");
    s.splitTerminal("/repo", "column"); // new row below row 0
    expect(grid()).toEqual([["term-1"], ["term-3"], ["term-2"]]);
  });

  it("closing a row's last pane collapses the row and drops its height weight", () => {
    const s = useUiStore.getState();
    s.splitTerminal("/repo", "column"); // rows: [1], [2]
    s.splitTerminal("/repo", "column"); // active was 2 → rows: [1], [2], [3]
    useUiStore.getState().resizeTerminalSplit("tab-1", { rowSizes: [2, 1, 1] });
    useUiStore.getState().closeTerminalPane("tab-1", "term-2");
    const tab = useUiStore.getState().terminals.tabs[0];
    expect(grid()).toEqual([["term-1"], ["term-3"]]);
    expect(tab.rowSizes).toEqual([2, 1]);
  });

  it("resizeTerminalSplit rebalances pane width weights", () => {
    const s = useUiStore.getState();
    s.splitTerminal("/repo", "row");
    useUiStore
      .getState()
      .resizeTerminalSplit("tab-1", { paneSizes: { "term-1": 1.5, "term-2": 0.5 } });
    const tab = useUiStore.getState().terminals.tabs[0];
    expect(tab.panes.map((p) => p.size)).toEqual([1.5, 0.5]);
  });
});

describe("parseStoredTerminals split grid (#316)", () => {
  function tabWith(overrides: Record<string, unknown>, panes?: unknown[]) {
    return JSON.stringify({
      terminals: {
        tabs: [
          {
            id: "tab-1",
            groupId: 1,
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
        activeTabId: "tab-1",
      },
    });
  }

  it("round-trips rows, pane width weights, and row height weights", () => {
    const { terminals } = parseStoredTerminals(tabWith({ rowSizes: [3, 1] }));
    const tab = terminals.tabs[0];
    expect(tab.panes.map((p) => [p.row ?? 0, p.size ?? 1])).toEqual([
      [0, 2],
      [0, 1],
      [1, 1],
    ]);
    expect(tab.rowSizes).toEqual([3, 1]);
  });

  it("accepts a tab with no grid fields (older blobs) as one row", () => {
    const { terminals } = parseStoredTerminals(blob());
    expect(terminals.tabs[0].panes.every((p) => (p.row ?? 0) === 0)).toBe(true);
  });

  it("normalizes gappy or out-of-order rows to contiguous row-major order", () => {
    const { terminals } = parseStoredTerminals(
      tabWith({}, [
        { id: "term-3", cwd: "/a", row: 4 },
        { id: "term-1", cwd: "/a", row: 0 },
        { id: "term-2", cwd: "/a", row: 0 },
      ]),
    );
    const tab = terminals.tabs[0];
    expect(tab.panes.map((p) => [p.id, p.row ?? 0])).toEqual([
      ["term-1", 0],
      ["term-2", 0],
      ["term-3", 1],
    ]);
  });

  it("drops a tab whose row is malformed", () => {
    const { terminals } = parseStoredTerminals(tabWith({}, [{ id: "term-1", cwd: "/a", row: -1 }]));
    expect(terminals.tabs).toEqual([]);
  });

  it("drops a tab whose rowSizes carry a non-positive weight", () => {
    const { terminals } = parseStoredTerminals(tabWith({ rowSizes: [1, 0] }));
    expect(terminals.tabs).toEqual([]);
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

// #339: the terminal view and the active group move independently.
// `focusTerminal` is a "reveal this terminal" intent from the sidebar rail,
// the palette, the cycle chords and the notification click — none of them
// asks for the workspace to jump. `terminalFollowGroup` opts back into the
// old coupled behaviour. #340 flattened the terminal list, so there is no
// more per-group "viewed group" to snap back to — the terminal is simply
// `terminals.activeTabId`.
describe("focusTerminal (#339)", () => {
  function seedTerminals() {
    return {
      tabs: [
        {
          id: "tab-1",
          groupId: 1,
          title: "g1",
          panes: [{ id: "term-1", cwd: "/a" }],
          activePaneId: "term-1",
        },
        {
          id: "tab-2",
          groupId: 2,
          title: "g2",
          panes: [{ id: "term-2", cwd: "/b" }],
          activePaneId: "term-2",
        },
      ],
      activeTabId: "tab-1",
    };
  }

  beforeEach(() => {
    localStorage.clear();
    useSettings.setState({ values: { ...DEFAULTS } });
    useUiStore.setState({
      activeGroupId: 1,
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

  describe("with terminalFollowGroup off (the default)", () => {
    it("leaves the active group where it is when focusing a tab from another group", () => {
      useUiStore.getState().focusTerminal("tab-2", "term-2");
      expect(useUiStore.getState().activeGroupId).toBe(1);
    });

    it("leaves every other workspace selection byte-identical", () => {
      const before = useUiStore.getState();
      const snapshot = {
        activeRepoId: before.activeRepoId,
        view: before.view,
        activeWorktreePath: before.activeWorktreePath,
        selectedPrNumber: before.selectedPrNumber,
        groupSelections: before.groupSelections,
      };

      useUiStore.getState().focusTerminal("tab-2", "term-2");

      const after = useUiStore.getState();
      expect(after.activeRepoId).toBe(snapshot.activeRepoId);
      expect(after.view).toBe(snapshot.view);
      expect(after.activeWorktreePath).toBe(snapshot.activeWorktreePath);
      expect(after.selectedPrNumber).toBe(snapshot.selectedPrNumber);
      // Same object, not merely equal.
      expect(after.groupSelections).toBe(snapshot.groupSelections);
    });

    it("opens the terminal, selects the tab, sets the pane and bumps the nonce", () => {
      useUiStore.setState({
        terminals: {
          tabs: [
            seedTerminals().tabs[0],
            {
              id: "tab-2",
              groupId: 2,
              title: "g2",
              panes: [
                { id: "term-2", cwd: "/b" },
                { id: "term-3", cwd: "/b" },
              ],
              activePaneId: "term-2",
            },
          ],
          activeTabId: "tab-1",
        },
      });

      useUiStore.getState().focusTerminal("tab-2", "term-3");

      const s = useUiStore.getState();
      expect(s.terminalOpen).toBe(true);
      expect(s.terminals.activeTabId).toBe("tab-2");
      expect(s.terminals.tabs.find((t) => t.id === "tab-2")!.activePaneId).toBe("term-3");
      expect(s.terminalFocusNonce).toBe(1);
    });
  });

  describe("with terminalFollowGroup on", () => {
    beforeEach(() => {
      useSettings.setState({ values: { ...DEFAULTS, terminalFollowGroup: true } });
    });

    it("moves the active group to the focused tab's group", () => {
      useUiStore.getState().focusTerminal("tab-2", "term-2");
      expect(useUiStore.getState().activeGroupId).toBe(2);
    });

    it("still opens the terminal, selects the tab and bumps the nonce", () => {
      useUiStore.getState().focusTerminal("tab-2", "term-2");

      const s = useUiStore.getState();
      expect(s.terminalOpen).toBe(true);
      expect(s.terminals.activeTabId).toBe("tab-2");
      expect(s.terminalFocusNonce).toBe(1);
    });
  });
});

describe("addTerminalTab", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({
      terminals: { tabs: [], activeTabId: null },
      nextTermId: 1,
      terminalOpen: false,
    });
  });

  it("opens the terminal and makes the new tab active, stamped with its group", () => {
    useUiStore.getState().addTerminalTab(1, "/a", "fresh");

    const s = useUiStore.getState();
    expect(s.terminalOpen).toBe(true);
    const added = s.terminals.tabs[s.terminals.tabs.length - 1];
    expect(added.title).toBe("fresh");
    expect(added.groupId).toBe(1);
    expect(s.terminals.activeTabId).toBe(added.id);
  });

  it("a background tab is appended without switching the active tab or opening the panel", () => {
    useUiStore.getState().addTerminalTab(1, "/a", "first");
    const firstId = useUiStore.getState().terminals.activeTabId;
    useUiStore.setState({ terminalOpen: false });

    useUiStore.getState().addTerminalTab(2, "/b", "quiet", { background: true });

    const s = useUiStore.getState();
    expect(s.terminalOpen).toBe(false);
    expect(s.terminals.activeTabId).toBe(firstId);
    expect(s.terminals.tabs.map((t) => t.title)).toEqual(["first", "quiet"]);
  });

  it("a background tab adopts the active slot when there was none", () => {
    useUiStore.getState().addTerminalTab(1, "/a", "quiet", { background: true });

    const s = useUiStore.getState();
    expect(s.terminalOpen).toBe(false);
    expect(s.terminals.activeTabId).toBe(s.terminals.tabs[0].id);
  });
});

describe("closeTerminalTab", () => {
  function seed() {
    useUiStore.setState({
      terminals: {
        tabs: [
          {
            id: "tab-1",
            groupId: 1,
            title: "a",
            panes: [{ id: "term-1", cwd: "/a" }],
            activePaneId: "term-1",
          },
          {
            id: "tab-2",
            groupId: 1,
            title: "b",
            panes: [{ id: "term-2", cwd: "/b" }],
            activePaneId: "term-2",
          },
          {
            id: "tab-3",
            groupId: 2,
            title: "c",
            panes: [{ id: "term-3", cwd: "/c" }],
            activePaneId: "term-3",
          },
        ],
        activeTabId: "tab-2",
      },
    });
  }

  beforeEach(() => {
    localStorage.clear();
    seed();
  });

  it("closing the active tab hands activeTabId to its neighbour", () => {
    useUiStore.getState().closeTerminalTab("tab-2");

    const s = useUiStore.getState();
    expect(s.terminals.tabs.map((t) => t.id)).toEqual(["tab-1", "tab-3"]);
    expect(s.terminals.activeTabId).toBe("tab-3");
  });

  it("closing a tab that isn't active leaves activeTabId untouched", () => {
    useUiStore.getState().closeTerminalTab("tab-1");

    const s = useUiStore.getState();
    expect(s.terminals.tabs.map((t) => t.id)).toEqual(["tab-2", "tab-3"]);
    expect(s.terminals.activeTabId).toBe("tab-2");
  });

  it("closing the last remaining tab clears activeTabId", () => {
    useUiStore.setState({
      terminals: {
        tabs: [
          {
            id: "tab-1",
            groupId: 1,
            title: "a",
            panes: [{ id: "term-1", cwd: "/a" }],
            activePaneId: "term-1",
          },
        ],
        activeTabId: "tab-1",
      },
    });

    useUiStore.getState().closeTerminalTab("tab-1");

    const s = useUiStore.getState();
    expect(s.terminals.tabs).toEqual([]);
    expect(s.terminals.activeTabId).toBeNull();
  });
});

describe("reorderTerminalTab (#340)", () => {
  // Fixture: four tabs in group 1, two in group 2, all in one flat list — the
  // sizes the contract's boundary/adjacency assertions need.
  function mkTab(id: string, groupId: number): TermTab {
    return {
      id,
      groupId,
      title: id,
      panes: [{ id: `pane-${id}`, cwd: `/repo/${id}` }],
      activePaneId: `pane-${id}`,
    };
  }

  function seed() {
    useUiStore.setState({
      terminals: {
        tabs: [
          mkTab("A", 1),
          mkTab("B", 1),
          mkTab("C", 1),
          mkTab("D", 1),
          mkTab("E", 2),
          mkTab("F", 2),
        ],
        activeTabId: "B",
      },
      activeGroupId: 1,
    });
  }

  function order(): string[] {
    return useUiStore.getState().terminals.tabs.map((t) => t.id);
  }

  beforeEach(() => {
    localStorage.clear();
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("A1: moves the source before the target, from both sides of it", () => {
    useUiStore.getState().reorderTerminalTab("A", "C", "before");
    expect(order()).toEqual(["B", "A", "C", "D", "E", "F"]);

    seed();
    useUiStore.getState().reorderTerminalTab("D", "B", "before");
    expect(order()).toEqual(["A", "D", "B", "C", "E", "F"]);
  });

  it("A2: moves the source after the target, from both sides of it", () => {
    useUiStore.getState().reorderTerminalTab("A", "C", "after");
    expect(order()).toEqual(["B", "C", "A", "D", "E", "F"]);

    seed();
    useUiStore.getState().reorderTerminalTab("D", "B", "after");
    expect(order()).toEqual(["A", "B", "D", "C", "E", "F"]);
  });

  it("A3: adjacent rows, both directions and both positions", () => {
    useUiStore.getState().reorderTerminalTab("A", "B", "before");
    expect(order()).toEqual(["A", "B", "C", "D", "E", "F"]); // a genuine no-op

    seed();
    useUiStore.getState().reorderTerminalTab("A", "B", "after");
    expect(order()).toEqual(["B", "A", "C", "D", "E", "F"]);

    seed();
    useUiStore.getState().reorderTerminalTab("B", "A", "after");
    expect(order()).toEqual(["A", "B", "C", "D", "E", "F"]);

    seed();
    useUiStore.getState().reorderTerminalTab("B", "A", "before");
    expect(order()).toEqual(["B", "A", "C", "D", "E", "F"]);
  });

  it("A4: boundaries — first row to last, last row to first", () => {
    useUiStore.getState().reorderTerminalTab("A", "F", "after");
    expect(order()).toEqual(["B", "C", "D", "E", "F", "A"]);

    seed();
    useUiStore.getState().reorderTerminalTab("F", "A", "before");
    expect(order()).toEqual(["F", "A", "B", "C", "D", "E"]);
  });

  it("A5: dropping a row onto itself is a no-op for both positions", () => {
    useUiStore.getState().reorderTerminalTab("B", "B", "before");
    expect(order()).toEqual(["A", "B", "C", "D", "E", "F"]);

    useUiStore.getState().reorderTerminalTab("B", "B", "after");
    expect(order()).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("A6: a no-op writes nothing — no IPC report, no localStorage write", () => {
    const spy = vi.spyOn(ipc, "terminalRegistryReport").mockResolvedValue(undefined);
    localStorage.removeItem("gamut.terminals");

    useUiStore.getState().reorderTerminalTab("B", "B", "before");
    expect(order()).toEqual(["A", "B", "C", "D", "E", "F"]);

    expect(spy).not.toHaveBeenCalled();
    expect(localStorage.getItem("gamut.terminals")).toBeNull();

    // The adjacency no-op: "A" dropped just "before" its own neighbour "B"
    // recomputes the same slot it already occupies — no write either.
    useUiStore.getState().reorderTerminalTab("A", "B", "before");
    expect(order()).toEqual(["A", "B", "C", "D", "E", "F"]);

    expect(spy).not.toHaveBeenCalled();
    expect(localStorage.getItem("gamut.terminals")).toBeNull();
  });

  it("A7: every guard leaves the list unchanged", () => {
    const before = order();

    useUiStore.getState().reorderTerminalTab("Z", "B", "before"); // unknown src
    useUiStore.getState().reorderTerminalTab("A", "Z", "before"); // unknown target

    expect(order()).toEqual(before);
  });

  it("A8: activeTabId and its resolved tab object survive a reorder — dragged row active", () => {
    useUiStore.setState((s) => ({ terminals: { ...s.terminals, activeTabId: "A" } }));
    const activeBefore = useUiStore.getState().terminals.tabs.find((t) => t.id === "A")!;

    useUiStore.getState().reorderTerminalTab("A", "C", "after");

    const g = useUiStore.getState().terminals;
    expect(g.activeTabId).toBe("A");
    expect(g.tabs.find((t) => t.id === "A")).toBe(activeBefore);
  });

  it("A8: activeTabId and its resolved tab object survive a reorder — target row active", () => {
    useUiStore.setState((s) => ({ terminals: { ...s.terminals, activeTabId: "C" } }));
    const activeBefore = useUiStore.getState().terminals.tabs.find((t) => t.id === "C")!;

    useUiStore.getState().reorderTerminalTab("A", "C", "after");

    const g = useUiStore.getState().terminals;
    expect(g.activeTabId).toBe("C");
    expect(g.tabs.find((t) => t.id === "C")).toBe(activeBefore);
  });

  it("A8: activeTabId and its resolved tab object survive a reorder — a third row active", () => {
    useUiStore.setState((s) => ({ terminals: { ...s.terminals, activeTabId: "D" } }));
    const activeBefore = useUiStore.getState().terminals.tabs.find((t) => t.id === "D")!;

    useUiStore.getState().reorderTerminalTab("A", "C", "after");

    const g = useUiStore.getState().terminals;
    expect(g.activeTabId).toBe("D");
    expect(g.tabs.find((t) => t.id === "D")).toBe(activeBefore);
  });

  it("A9: reorder is a pure permutation — every tab and its panes array keep identity", () => {
    const beforeById = new Map(useUiStore.getState().terminals.tabs.map((t) => [t.id, t]));
    const idsAndPaneIdsBefore = () => {
      const tabs = useUiStore.getState().terminals.tabs;
      return {
        tabIds: tabs.map((t) => t.id).sort(),
        paneIds: tabs.flatMap((t) => t.panes.map((p) => p.id)).sort(),
      };
    };
    const before = idsAndPaneIdsBefore();

    useUiStore.getState().reorderTerminalTab("B", "D", "after");

    const afterTabs = useUiStore.getState().terminals.tabs;
    for (const t of afterTabs) {
      const prior = beforeById.get(t.id)!;
      expect(t).toBe(prior);
      expect(t.panes).toBe(prior.panes);
    }
    expect(idsAndPaneIdsBefore()).toEqual(before);
  });

  it("A10: reorder issues no terminal lifecycle IPC", () => {
    const spawnSpy = vi.spyOn(ipc, "terminalSpawn");
    const killSpy = vi.spyOn(ipc, "terminalKill").mockResolvedValue(undefined);
    const resizeSpy = vi.spyOn(ipc, "terminalResize").mockResolvedValue(undefined);

    useUiStore.getState().reorderTerminalTab("A", "C", "after");

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(resizeSpy).not.toHaveBeenCalled();
  });

  it("A11: activeGroupId is unchanged by a reorder", () => {
    useUiStore.setState({ activeGroupId: 1 });

    useUiStore.getState().reorderTerminalTab("A", "C", "after");

    expect(useUiStore.getState().activeGroupId).toBe(1);
  });

  it("A12: a real reorder persists through the existing report + localStorage write path", () => {
    const spy = vi.spyOn(ipc, "terminalRegistryReport").mockResolvedValue(undefined);
    localStorage.removeItem("gamut.terminals");

    useUiStore.getState().reorderTerminalTab("A", "C", "after");

    expect(spy).toHaveBeenCalledTimes(1);
    const raw = localStorage.getItem("gamut.terminals");
    expect(raw).not.toBeNull();
    expect(parseStoredTerminals(raw!).terminals.tabs.map((t) => t.id)).toEqual([
      "B",
      "C",
      "A",
      "D",
      "E",
      "F",
    ]);
  });

  it("A13: reorder moves a tab across group boundaries without changing its groupId", () => {
    useUiStore.setState({
      terminals: {
        tabs: [mkTab("A", 1), mkTab("B", 1), mkTab("C", 2)],
        activeTabId: "A",
      },
    });

    useUiStore.getState().reorderTerminalTab("C", "A", "before");

    const s = useUiStore.getState();
    expect(s.terminals.tabs.map((t) => t.id)).toEqual(["C", "A", "B"]);
    expect(s.terminals.tabs.find((t) => t.id === "C")!.groupId).toBe(2);
  });
});
