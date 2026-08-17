import { beforeEach, describe, expect, it } from "vitest";

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

describe("splitTerminal direction (#316)", () => {
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

  it("defaults to a row split", () => {
    useUiStore.getState().splitTerminal(1, "/repo");
    const tab = useUiStore.getState().terminals[1].tabs[0];
    expect(tab.panes).toHaveLength(2);
    expect(tab.direction).toBe("row");
  });

  it("splits down when asked (column)", () => {
    useUiStore.getState().splitTerminal(1, "/repo", "column");
    const tab = useUiStore.getState().terminals[1].tabs[0];
    expect(tab.panes).toHaveLength(2);
    expect(tab.direction).toBe("column");
  });

  it("an already-split tab keeps its direction — a later split only adds a pane", () => {
    useUiStore.getState().splitTerminal(1, "/repo", "column");
    useUiStore.getState().splitTerminal(1, "/repo", "row");
    const tab = useUiStore.getState().terminals[1].tabs[0];
    expect(tab.panes).toHaveLength(3);
    expect(tab.direction).toBe("column");
  });

  it("a tab back down to one pane can re-split the other way", () => {
    const s = useUiStore.getState();
    s.splitTerminal(1, "/repo", "row");
    const added = useUiStore.getState().terminals[1].tabs[0].panes[1].id;
    s.closeTerminalPane(1, "tab-1", added);
    useUiStore.getState().splitTerminal(1, "/repo", "column");
    expect(useUiStore.getState().terminals[1].tabs[0].direction).toBe("column");
  });
});

describe("parseStoredTerminals split direction (#316)", () => {
  function tabWith(direction: unknown) {
    return JSON.stringify({
      terminals: {
        1: {
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              title: "t",
              direction,
              panes: [
                { id: "term-1", cwd: "/a" },
                { id: "term-2", cwd: "/a" },
              ],
              activePaneId: "term-1",
            },
          ],
        },
      },
    });
  }

  it("restores a persisted column direction", () => {
    const { terminals } = parseStoredTerminals(tabWith("column"));
    expect(terminals[1].tabs[0].direction).toBe("column");
  });

  it("accepts a tab with no direction (older blobs)", () => {
    const { terminals } = parseStoredTerminals(blob());
    expect(terminals[1].tabs[0].direction).toBeUndefined();
  });

  it("drops a tab whose direction is malformed", () => {
    const { terminals } = parseStoredTerminals(tabWith("diagonal"));
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
