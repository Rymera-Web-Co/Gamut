import { create } from "zustand";

export type View = "files" | "history" | "review" | "pulls";
export type ReviewMode = "working" | "branch";

/**
 * Integrated-terminal model. Terminals are scoped to a **group**: each group
 * keeps its own set of tabs, so switching repos never disturbs them and
 * switching groups swaps the whole set. A tab holds one or more side-by-side
 * panes (a split); each pane is an independent PTY session keyed by `pane.id`.
 */
export interface TermPane {
  /** Opaque, process-unique PTY session id (the backend treats it as a key). */
  id: string;
  /** Working directory the shell is rooted at. */
  cwd: string;
}
/**
 * Why a hidden pane is flagged as having unseen activity, ordered by salience
 * so a transient bell/exit isn't downgraded by a later output chunk:
 * `output` (PTY wrote bytes) < `bell` (xterm `\a`) < `exit` (shell process ended).
 */
export type TermActivityKind = "output" | "bell" | "exit";

export const ACTIVITY_PRIORITY: Record<TermActivityKind, number> = {
  output: 0,
  bell: 1,
  exit: 2,
};
export interface TermTab {
  id: string;
  title: string;
  panes: TermPane[];
  activePaneId: string;
}
export interface GroupTerminals {
  tabs: TermTab[];
  activeTabId: string | null;
}

const REPO_SIDEBAR_KEY = "gamut.repoSidebarHidden";
const TERMINAL_OPEN_KEY = "gamut.terminalOpen";

function storedRepoSidebarHidden(): boolean {
  return localStorage.getItem(REPO_SIDEBAR_KEY) === "1";
}

function storedTerminalOpen(): boolean {
  return localStorage.getItem(TERMINAL_OPEN_KEY) === "1";
}

interface UiState {
  view: View;
  reviewMode: ReviewMode;
  activeRepoId: number | null;
  activeGroupId: number | null;
  selectedPrNumber: number | null;
  // Whether the repo sidebar column is hidden. Persisted to localStorage.
  repoSidebarHidden: boolean;
  // Integrated terminal pane. `terminalOpen` (persisted) toggles the bottom
  // pane; `terminals` holds each group's tabs/panes (in-memory, by group id).
  terminalOpen: boolean;
  // Whether the terminal pane is maximized to (near) full content-area height.
  // In-memory only — distinct from open/close and reset when the pane is hidden.
  terminalMaximized: boolean;
  terminals: Record<number, GroupTerminals>;
  // Per-pane "unseen activity" flag, keyed by pane id, set when a *hidden* pane
  // emits output, rings the bell, or its process exits. Drives the activity
  // badges on inactive tabs/groups; cleared when the pane becomes visible.
  termActivity: Record<string, TermActivityKind>;
  // Monotonic counter for minting unique pane/tab ids.
  nextTermId: number;
  // One-shot navigation target: a commit to reveal in the History tab. The
  // History view consumes it (selects + scrolls to it) and clears it.
  historySha: string | null;
  // One-shot navigation target: a repo-relative file to open in the Files tab.
  // The Files view consumes it (opens it in the editor) and clears it.
  filesPath: string | null;
  setView: (view: View) => void;
  setReviewMode: (mode: ReviewMode) => void;
  setActiveRepo: (id: number | null) => void;
  setActiveGroup: (id: number | null) => void;
  setSelectedPr: (n: number | null) => void;
  setHistorySha: (sha: string | null) => void;
  setFilesPath: (path: string | null) => void;
  toggleRepoSidebar: () => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setTerminalMaximized: (max: boolean) => void;
  toggleTerminalMaximized: () => void;
  /** Open a new terminal tab in a group rooted at `cwd`, and reveal the pane. */
  addTerminalTab: (groupId: number, cwd: string, title: string) => void;
  /** Split the group's active tab, adding a side-by-side pane rooted at `cwd`. */
  splitTerminal: (groupId: number, cwd: string) => void;
  selectTerminalTab: (groupId: number, tabId: string) => void;
  setActivePane: (groupId: number, tabId: string, paneId: string) => void;
  /** Remove a tab (caller kills its panes' PTYs first). */
  closeTerminalTab: (groupId: number, tabId: string) => void;
  /** Remove one split pane; removes the tab if it was the last pane. */
  closeTerminalPane: (groupId: number, tabId: string, paneId: string) => void;
  /** Flag a hidden pane as having unseen activity (escalating by salience). */
  markTermActivity: (paneId: string, kind: TermActivityKind) => void;
  /** Clear a pane's unseen-activity flag (on focus or when the pane is gone). */
  clearTermActivity: (paneId: string) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  view: "files",
  reviewMode: "working",
  activeRepoId: null,
  activeGroupId: null,
  selectedPrNumber: null,
  repoSidebarHidden: storedRepoSidebarHidden(),
  terminalOpen: storedTerminalOpen(),
  terminalMaximized: false,
  terminals: {},
  termActivity: {},
  nextTermId: 1,
  historySha: null,
  filesPath: null,
  setView: (view) => set({ view }),
  setReviewMode: (reviewMode) => set({ reviewMode }),
  // Reset the selected PR when switching repos — it's repo-specific.
  setActiveRepo: (id) => set({ activeRepoId: id, selectedPrNumber: null }),
  setActiveGroup: (id) => set({ activeGroupId: id }),
  setSelectedPr: (selectedPrNumber) => set({ selectedPrNumber }),
  setHistorySha: (historySha) => set({ historySha }),
  setFilesPath: (filesPath) => set({ filesPath }),
  toggleRepoSidebar: () => {
    const repoSidebarHidden = !get().repoSidebarHidden;
    localStorage.setItem(REPO_SIDEBAR_KEY, repoSidebarHidden ? "1" : "0");
    set({ repoSidebarHidden });
  },
  setTerminalOpen: (open) => {
    localStorage.setItem(TERMINAL_OPEN_KEY, open ? "1" : "0");
    // Hiding the pane drops the maximized state so reopening starts from the
    // normal split height rather than a stale "maximized" flag.
    set(open ? { terminalOpen: true } : { terminalOpen: false, terminalMaximized: false });
  },
  toggleTerminal: () => get().setTerminalOpen(!get().terminalOpen),
  setTerminalMaximized: (max) => {
    if (max) get().setTerminalOpen(true);
    set({ terminalMaximized: max });
  },
  toggleTerminalMaximized: () => get().setTerminalMaximized(!get().terminalMaximized),
  addTerminalTab: (groupId, cwd, title) => {
    const n = get().nextTermId;
    const tab: TermTab = {
      id: `tab-${n}`,
      title,
      panes: [{ id: `term-${n}`, cwd }],
      activePaneId: `term-${n}`,
    };
    get().setTerminalOpen(true);
    set((s) => {
      const g = s.terminals[groupId] ?? { tabs: [], activeTabId: null };
      return {
        nextTermId: n + 1,
        terminals: {
          ...s.terminals,
          [groupId]: { tabs: [...g.tabs, tab], activeTabId: tab.id },
        },
      };
    });
  },
  splitTerminal: (groupId, cwd) => {
    const n = get().nextTermId;
    const paneId = `term-${n}`;
    set((s) => {
      const g = s.terminals[groupId];
      if (!g || !g.activeTabId) return {};
      const tabs = g.tabs.map((t) =>
        t.id === g.activeTabId
          ? { ...t, panes: [...t.panes, { id: paneId, cwd }], activePaneId: paneId }
          : t,
      );
      return {
        nextTermId: n + 1,
        terminals: { ...s.terminals, [groupId]: { ...g, tabs } },
      };
    });
  },
  selectTerminalTab: (groupId, tabId) =>
    set((s) => {
      const g = s.terminals[groupId];
      if (!g) return {};
      return { terminals: { ...s.terminals, [groupId]: { ...g, activeTabId: tabId } } };
    }),
  setActivePane: (groupId, tabId, paneId) =>
    set((s) => {
      const g = s.terminals[groupId];
      if (!g) return {};
      const tabs = g.tabs.map((t) =>
        t.id === tabId ? { ...t, activePaneId: paneId } : t,
      );
      return { terminals: { ...s.terminals, [groupId]: { ...g, tabs } } };
    }),
  closeTerminalTab: (groupId, tabId) =>
    set((s) => {
      const g = s.terminals[groupId];
      if (!g) return {};
      const idx = g.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return {};
      const tabs = g.tabs.filter((t) => t.id !== tabId);
      const activeTabId =
        g.activeTabId === tabId
          ? tabs.length
            ? tabs[Math.min(idx, tabs.length - 1)].id
            : null
          : g.activeTabId;
      return { terminals: { ...s.terminals, [groupId]: { tabs, activeTabId } } };
    }),
  closeTerminalPane: (groupId, tabId, paneId) =>
    set((s) => {
      const g = s.terminals[groupId];
      if (!g) return {};
      const tab = g.tabs.find((t) => t.id === tabId);
      if (!tab) return {};
      const { [paneId]: _gone, ...termActivity } = s.termActivity;
      void _gone;
      const patch = paneId in s.termActivity ? { termActivity } : {};
      const panes = tab.panes.filter((p) => p.id !== paneId);
      if (panes.length === 0) {
        const idx = g.tabs.findIndex((t) => t.id === tabId);
        const tabs = g.tabs.filter((t) => t.id !== tabId);
        const activeTabId =
          g.activeTabId === tabId
            ? tabs.length
              ? tabs[Math.min(idx, tabs.length - 1)].id
              : null
            : g.activeTabId;
        return { ...patch, terminals: { ...s.terminals, [groupId]: { tabs, activeTabId } } };
      }
      const activePaneId =
        tab.activePaneId === paneId ? panes[panes.length - 1].id : tab.activePaneId;
      const tabs = g.tabs.map((t) =>
        t.id === tabId ? { ...t, panes, activePaneId } : t,
      );
      return { ...patch, terminals: { ...s.terminals, [groupId]: { ...g, tabs } } };
    }),
  markTermActivity: (paneId, kind) =>
    set((s) => {
      const cur = s.termActivity[paneId];
      if (cur && ACTIVITY_PRIORITY[cur] >= ACTIVITY_PRIORITY[kind]) return {};
      return { termActivity: { ...s.termActivity, [paneId]: kind } };
    }),
  clearTermActivity: (paneId) =>
    set((s) => {
      if (!(paneId in s.termActivity)) return {};
      const { [paneId]: _gone, ...termActivity } = s.termActivity;
      void _gone;
      return { termActivity };
    }),
}));
