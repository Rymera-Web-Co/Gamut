import { create } from "zustand";

import { moveAdjacent } from "@/lib/dnd";
import { useSettings } from "@/lib/settings";

export type View = "files" | "history" | "review" | "pulls";
export type ReviewMode = "working" | "branch";

/** Seed for the File Compare dialog (#130): an optional repo + file to prefill. */
export interface CompareSeed {
  repoId?: number;
  /** Repo-relative path, for the across-refs / with-revision modes. */
  path?: string;
  /**
   * Two absolute file paths to diff immediately (VSCode-style "Compare with
   * Selected"). When set, the dialog opens in two-files mode and runs the
   * comparison straight away.
   */
  files?: { leftPath: string; rightPath: string };
}

/** A file picked via "Select for Compare", awaiting a "Compare with Selected". */
export interface CompareSelection {
  repoId: number;
  /** Repo-relative path. */
  path: string;
}

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
  /** Auto-derived default label (group/repo name), set once at creation. */
  title: string;
  /**
   * User-chosen label that overrides `title` when set. Cleared (back to the
   * default) by renaming to an empty string. In-memory like the rest of the
   * terminal state — survives group switches, lost on restart.
   */
  customTitle?: string;
  panes: TermPane[];
  activePaneId: string;
}

/** The label shown for a tab: the user's custom name, else the default. */
export function termTabLabel(tab: TermTab): string {
  return tab.customTitle ?? tab.title;
}
export interface GroupTerminals {
  tabs: TermTab[];
  activeTabId: string | null;
}

/**
 * What a group remembers between visits: the repo that was selected and the
 * view tab that was open. Restored on return so switching groups feels like
 * stepping back into where you left off — the terminal already works this way
 * via `terminals`. In-memory only, like the terminal state.
 */
export interface GroupSelection {
  repoId: number | null;
  view: View;
}

const REPO_SIDEBAR_KEY = "gamut.repoSidebarHidden";
const TERMINAL_OPEN_KEY = "gamut.terminalOpen";
const FILES_PANEL_KEY = "gamut.filesPanel";
// The terminal layout (tabs/splits/cwds per group) so it can be reopened on the
// next launch (#155). Bigger than the boolean prefs above, but still client-only
// view state, so it stays in localStorage rather than the DB-backed settings.
const TERMINALS_KEY = "gamut.terminals";

/** Which sidebar mode the Files view shows: the file tree or repo-wide search. */
export type FilesPanel = "tree" | "search";

function storedRepoSidebarHidden(): boolean {
  return localStorage.getItem(REPO_SIDEBAR_KEY) === "1";
}

function storedTerminalOpen(): boolean {
  return localStorage.getItem(TERMINAL_OPEN_KEY) === "1";
}

function storedFilesPanel(): FilesPanel {
  return localStorage.getItem(FILES_PANEL_KEY) === "search" ? "search" : "tree";
}

/** Shape-check one persisted pane: an id + a cwd string. */
function isValidPane(p: unknown): p is TermPane {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as TermPane).id === "string" &&
    typeof (p as TermPane).cwd === "string"
  );
}

/** Shape-check one persisted tab: an id, title, a non-empty pane list, and an
 * activePaneId that names one of its panes. */
function isValidTab(t: unknown): t is TermTab {
  if (typeof t !== "object" || t === null) return false;
  const tab = t as TermTab;
  return (
    typeof tab.id === "string" &&
    typeof tab.title === "string" &&
    (tab.customTitle === undefined || typeof tab.customTitle === "string") &&
    Array.isArray(tab.panes) &&
    tab.panes.length > 0 &&
    tab.panes.every(isValidPane) &&
    tab.panes.some((p) => p.id === tab.activePaneId)
  );
}

/**
 * Parse the persisted terminal layout, dropping anything malformed so a corrupt
 * or stale blob can never break startup. Returns the layout plus the next id
 * counter, bumped past every restored id so freshly-added tabs/panes can't
 * collide with a restored session.
 */
export function parseStoredTerminals(raw: string): {
  terminals: Record<number, GroupTerminals>;
  nextTermId: number;
} {
  const empty = { terminals: {}, nextTermId: 1 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const src = (parsed as { terminals?: unknown }).terminals;
  if (typeof src !== "object" || src === null) return empty;

  const terminals: Record<number, GroupTerminals> = {};
  let maxId = 0;
  const noteId = (id: string) => {
    const n = Number(id.split("-").pop());
    if (Number.isFinite(n) && n > maxId) maxId = n;
  };
  for (const [gid, value] of Object.entries(src as Record<string, unknown>)) {
    const groupId = Number(gid);
    if (!Number.isFinite(groupId)) continue;
    const g = value as GroupTerminals;
    if (typeof g !== "object" || g === null || !Array.isArray(g.tabs)) continue;
    const tabs = g.tabs.filter(isValidTab);
    if (tabs.length === 0) continue;
    tabs.forEach((t) => {
      noteId(t.id);
      t.panes.forEach((p) => noteId(p.id));
    });
    const activeTabId = tabs.some((t) => t.id === g.activeTabId) ? g.activeTabId : tabs[0].id;
    terminals[groupId] = { tabs, activeTabId };
  }
  return { terminals, nextTermId: maxId + 1 };
}

/** The terminal layout to start with: the saved one if session restore is on
 * and a valid blob exists, otherwise empty. */
function storedTerminals(): { terminals: Record<number, GroupTerminals>; nextTermId: number } {
  const empty = { terminals: {}, nextTermId: 1 };
  if (!useSettings.getState().values.terminalRestoreSessions) return empty;
  const raw = localStorage.getItem(TERMINALS_KEY);
  return raw ? parseStoredTerminals(raw) : empty;
}

/** Write the current terminal layout so the next launch can reopen it. Called on
 * every mutation (not just clean quit) so a crash still leaves it restorable. */
function persistTerminals(terminals: Record<number, GroupTerminals>, nextTermId: number) {
  try {
    localStorage.setItem(TERMINALS_KEY, JSON.stringify({ terminals, nextTermId }));
  } catch {
    // Ignore quota / unavailable storage — restore is best-effort.
  }
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
  // Per-group memory of the last-selected repo and view tab, keyed by group id.
  // Switching groups restores the entry for the group being entered (the repo
  // is re-validated against the group's actual membership by the
  // useActiveRepoReconciler hook). In-memory, like `terminals`.
  groupSelections: Record<number, GroupSelection>;
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
  // Whether the Settings panel (⌘,) is open. In-memory only.
  settingsOpen: boolean;
  // Whether the ⌘/Ctrl+K command palette is open. In-memory only.
  commandPaletteOpen: boolean;
  // File Compare dialog (#130). `null` when closed; otherwise the seed it opened
  // with — an optional repo + file to prefill the ref/revision modes.
  compare: CompareSeed | null;
  // The file picked via "Select for Compare", pending a "Compare with Selected"
  // (VSCode-style). App-global so the pick survives switching files/repos.
  compareSelection: CompareSelection | null;
  // Which sidebar the Files view shows (tree vs. repo search). Persisted.
  filesPanel: FilesPanel;
  // Monotonic counter bumped to ask the search panel to focus its input — lets
  // ⌘/Ctrl+⇧+F re-focus search even when it's already the active panel.
  searchFocusNonce: number;
  // Monotonic counter bumped to ask the terminal pane to focus its active xterm
  // — lets the command palette / notification click land keyboard focus inside
  // the terminal even when its tab/pane state didn't change.
  terminalFocusNonce: number;
  setView: (view: View) => void;
  setReviewMode: (mode: ReviewMode) => void;
  setActiveRepo: (id: number | null) => void;
  setActiveGroup: (id: number | null) => void;
  setSelectedPr: (n: number | null) => void;
  setHistorySha: (sha: string | null) => void;
  setFilesPath: (path: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  toggleSettings: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  // Open the File Compare dialog, optionally seeded with a repo + file (which
  // prefills the across-refs / with-revision modes). Pass nothing for a blank
  // two-files comparison.
  openCompare: (seed?: CompareSeed) => void;
  closeCompare: () => void;
  setCompareSelection: (sel: CompareSelection | null) => void;
  setFilesPanel: (panel: FilesPanel) => void;
  /** Switch to the Files view's search panel and focus its input. */
  focusRepoSearch: () => void;
  toggleRepoSidebar: () => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setTerminalMaximized: (max: boolean) => void;
  toggleTerminalMaximized: () => void;
  /** Open a new terminal tab in a group rooted at `cwd`, reveal the pane, and
   * return the new pane's id (so callers can queue input for it — see
   * `gamut term`). */
  addTerminalTab: (groupId: number, cwd: string, title: string) => string;
  /** Split the group's active tab, adding a side-by-side pane rooted at `cwd`. */
  splitTerminal: (groupId: number, cwd: string) => void;
  selectTerminalTab: (groupId: number, tabId: string) => void;
  /**
   * Reorder a tab within its group's strip, moving `srcId` adjacent to
   * `targetId`. Leaves the active tab and all pane/PTY state untouched.
   */
  reorderTerminalTab: (
    groupId: number,
    srcId: string,
    targetId: string,
    position: "before" | "after",
  ) => void;
  /** Rename a tab; an empty/blank title reverts to the auto-derived default. */
  renameTerminalTab: (groupId: number, tabId: string, title: string) => void;
  setActivePane: (groupId: number, tabId: string, paneId: string) => void;
  /**
   * Reveal a terminal pane and put keyboard focus in it: open the panel, switch
   * to its group/tab/pane, then bump `terminalFocusNonce` so the pane re-focuses
   * its xterm even when none of that state changed. Used by the command palette
   * and notification-click handler.
   */
  focusTerminal: (groupId: number, tabId: string, paneId: string) => void;
  /** Remove a tab (caller kills its panes' PTYs first). */
  closeTerminalTab: (groupId: number, tabId: string) => void;
  /** Remove one split pane; removes the tab if it was the last pane. */
  closeTerminalPane: (groupId: number, tabId: string, paneId: string) => void;
  /** Flag a hidden pane as having unseen activity (escalating by salience). */
  markTermActivity: (paneId: string, kind: TermActivityKind) => void;
  /** Clear a pane's unseen-activity flag (on focus or when the pane is gone). */
  clearTermActivity: (paneId: string) => void;
}

// Hydrate the saved terminal layout synchronously so restored tabs are present
// on first paint (#155). The panes themselves respawn lazily when their group's
// tab is first viewed — TerminalPane spawns a fresh PTY per pane at its cwd.
const restoredTerminals = storedTerminals();

export const useUiStore = create<UiState>((set, get) => ({
  view: "files",
  reviewMode: "working",
  activeRepoId: null,
  activeGroupId: null,
  selectedPrNumber: null,
  repoSidebarHidden: storedRepoSidebarHidden(),
  terminalOpen: storedTerminalOpen(),
  terminalMaximized: false,
  terminals: restoredTerminals.terminals,
  groupSelections: {},
  termActivity: {},
  nextTermId: restoredTerminals.nextTermId,
  historySha: null,
  filesPath: null,
  settingsOpen: false,
  commandPaletteOpen: false,
  compare: null,
  compareSelection: null,
  filesPanel: storedFilesPanel(),
  searchFocusNonce: 0,
  terminalFocusNonce: 0,
  setView: (view) => set({ view }),
  setReviewMode: (reviewMode) => set({ reviewMode }),
  // Reset the selected PR when switching repos — it's repo-specific.
  setActiveRepo: (id) => set({ activeRepoId: id, selectedPrNumber: null }),
  // Switching groups stashes the outgoing group's repo + view, then restores
  // the group being entered. A repo that's since left the group (or a group
  // never visited, hence no memory) leaves `activeRepoId` pointing nowhere
  // valid; useActiveRepoReconciler corrects that to the group's first repo so
  // the content area never shows a repo outside the active group.
  setActiveGroup: (id) =>
    set((s) => {
      if (id === s.activeGroupId) return {};
      const groupSelections =
        s.activeGroupId == null
          ? s.groupSelections
          : {
              ...s.groupSelections,
              [s.activeGroupId]: { repoId: s.activeRepoId, view: s.view },
            };
      const remembered = id != null ? groupSelections[id] : undefined;
      return {
        activeGroupId: id,
        groupSelections,
        activeRepoId: remembered ? remembered.repoId : null,
        view: remembered ? remembered.view : s.view,
        selectedPrNumber: null,
      };
    }),
  setSelectedPr: (selectedPrNumber) => set({ selectedPrNumber }),
  setHistorySha: (historySha) => set({ historySha }),
  setFilesPath: (filesPath) => set({ filesPath }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  openCompare: (seed) => set({ compare: seed ?? {}, commandPaletteOpen: false }),
  closeCompare: () => set({ compare: null }),
  setCompareSelection: (compareSelection) => set({ compareSelection }),
  setFilesPanel: (filesPanel) => {
    localStorage.setItem(FILES_PANEL_KEY, filesPanel);
    set({ filesPanel });
  },
  focusRepoSearch: () => {
    localStorage.setItem(FILES_PANEL_KEY, "search");
    set((s) => ({
      view: "files",
      filesPanel: "search",
      searchFocusNonce: s.searchFocusNonce + 1,
    }));
  },
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
    const paneId = `term-${n}`;
    const tab: TermTab = {
      id: `tab-${n}`,
      title,
      panes: [{ id: paneId, cwd }],
      activePaneId: paneId,
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
    return paneId;
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
  reorderTerminalTab: (groupId, srcId, targetId, position) =>
    set((s) => {
      const g = s.terminals[groupId];
      if (!g || srcId === targetId) return {};
      const order = moveAdjacent(
        g.tabs.map((t) => t.id),
        srcId,
        targetId,
        position,
      );
      // Rebuild from the new id order; reordering never adds/drops a tab, and
      // `activeTabId` is preserved so the active tab stays active.
      const byId = new Map(g.tabs.map((t) => [t.id, t]));
      const tabs = order.map((id) => byId.get(id)!);
      return { terminals: { ...s.terminals, [groupId]: { ...g, tabs } } };
    }),
  renameTerminalTab: (groupId, tabId, title) =>
    set((s) => {
      const g = s.terminals[groupId];
      if (!g) return {};
      const customTitle = title.trim() || undefined;
      const tabs = g.tabs.map((t) => (t.id === tabId ? { ...t, customTitle } : t));
      return { terminals: { ...s.terminals, [groupId]: { ...g, tabs } } };
    }),
  setActivePane: (groupId, tabId, paneId) =>
    set((s) => {
      const g = s.terminals[groupId];
      if (!g) return {};
      const tabs = g.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t));
      return { terminals: { ...s.terminals, [groupId]: { ...g, tabs } } };
    }),
  focusTerminal: (groupId, tabId, paneId) => {
    const ui = get();
    ui.setActiveGroup(groupId);
    ui.setTerminalOpen(true);
    ui.selectTerminalTab(groupId, tabId);
    ui.setActivePane(groupId, tabId, paneId);
    set((s) => ({ terminalFocusNonce: s.terminalFocusNonce + 1 }));
  },
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
      const tabs = g.tabs.map((t) => (t.id === tabId ? { ...t, panes, activePaneId } : t));
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

// Persist the terminal layout whenever it changes (#155). The reference check
// keeps this near-free on unrelated state updates — every terminal mutation
// produces a fresh `terminals` object — and persisting per-mutation (rather than
// only on clean quit) means a crash still leaves the layout restorable.
useUiStore.subscribe((s, prev) => {
  if (s.terminals !== prev.terminals || s.nextTermId !== prev.nextTermId) {
    persistTerminals(s.terminals, s.nextTermId);
  }
});
