import { create } from "zustand";

import { ipc } from "@/lib/ipc";
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
 * switching groups swaps the whole set. A tab holds a **grid** of split panes
 * (#316): one or more rows, each row holding one or more side-by-side panes —
 * so `50/50` above `100`, or `33/33/33` above `50/50`, are all reachable.
 * Each pane is an independent PTY session keyed by `pane.id`.
 */
export interface TermPane {
  /** Opaque, process-unique PTY session id (the backend treats it as a key). */
  id: string;
  /** Working directory the shell is rooted at. */
  cwd: string;
  /**
   * Grid row this pane sits in (0-based, kept contiguous; absent = 0, which is
   * also how blobs persisted before the grid model restore). The `panes` array
   * is kept in row-major order.
   */
  row?: number;
  /**
   * Width weight within the pane's row (absent = 1). Widths are proportional —
   * a pane's share of the row is `size / (sum of the row's sizes)` — so a
   * divider drag only rebalances the two neighbours it sits between.
   */
  size?: number;
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
/** Where a split puts the new pane: `row` = beside the active pane (in its
 * row), `column` = in a new row of its own, directly below the active pane's
 * row. */
export type SplitDirection = "row" | "column";

export interface TermTab {
  id: string;
  /** Auto-derived default label (group/repo name), set once at creation. */
  title: string;
  /**
   * Height weights per grid row, by row index (absent = every row equal).
   * Proportional like `TermPane.size`: a row's share of the tab's height is
   * `rowSizes[i] / (sum of rowSizes)`. Kept aligned with the contiguous row
   * numbering by the split/close actions.
   */
  rowSizes?: number[];
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

/** A usable split weight: finite and positive. */
function isValidWeight(w: unknown): boolean {
  return typeof w === "number" && Number.isFinite(w) && w > 0;
}

/** Shape-check one persisted pane: an id + a cwd string, plus the optional
 * grid fields (`row`: non-negative integer, `size`: positive weight). */
function isValidPane(p: unknown): p is TermPane {
  if (typeof p !== "object" || p === null) return false;
  const pane = p as TermPane;
  return (
    typeof pane.id === "string" &&
    typeof pane.cwd === "string" &&
    (pane.row === undefined || (Number.isInteger(pane.row) && pane.row >= 0)) &&
    (pane.size === undefined || isValidWeight(pane.size))
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
    (tab.rowSizes === undefined ||
      (Array.isArray(tab.rowSizes) && tab.rowSizes.every(isValidWeight))) &&
    Array.isArray(tab.panes) &&
    tab.panes.length > 0 &&
    tab.panes.every(isValidPane) &&
    tab.panes.some((p) => p.id === tab.activePaneId)
  );
}

/**
 * Re-establish the grid invariants on a restored tab: panes in row-major order
 * and row numbers contiguous from 0. A blob written by the running app already
 * satisfies both; this guards hand-edited or partially-stale storage so the
 * split/close actions can rely on the invariants.
 */
function normalizeTabGrid(tab: TermTab): TermTab {
  const rowValues = [...new Set(tab.panes.map((p) => p.row ?? 0))].sort((a, b) => a - b);
  const remap = new Map(rowValues.map((rv, i) => [rv, i]));
  const panes = [...tab.panes]
    .sort((a, b) => (a.row ?? 0) - (b.row ?? 0)) // stable: keeps in-row order
    .map((p) => {
      const row = remap.get(p.row ?? 0)!;
      return row === (p.row ?? 0) ? p : { ...p, row };
    });
  return { ...tab, panes };
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
    const tabs = g.tabs.filter(isValidTab).map(normalizeTabGrid);
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
  // When set, a linked worktree of the active repo is selected instead of its
  // main checkout: new terminals root there, while repo-scoped views (history,
  // PRs, …) keep following `activeRepoId`. Cleared whenever the selection moves
  // back to a plain repo (every one-argument `setActiveRepo` call).
  activeWorktreePath: string | null;
  activeGroupId: number | null;
  selectedPrNumber: number | null;
  // Whether the repo sidebar column is hidden. Persisted to localStorage.
  repoSidebarHidden: boolean;
  // The ⌘⇧K shortcut's pending "publish this branch to origin?" question (#300),
  // or null when there isn't one. The shortcut can fire with the sidebar hidden
  // — or on a repo whose row isn't rendered — so its confirmation is an
  // app-level dialog rather than the popover anchored to a row's push button.
  // Carries the branch name so the dialog needs no query of its own.
  pushConfirm: { repoId: number; branch: string } | null;
  // Integrated terminal view. `terminalOpen` (persisted) switches the main
  // area to the full-height terminal; `terminals` holds each group's
  // tabs/panes (in-memory, by group id).
  terminalOpen: boolean;
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
  // The repo config dialog's target repo (#306 follow-up): `null` when closed,
  // otherwise the id of the repo it's showing. Explicit rather than following
  // `activeRepoId` — opening it (the sidebar gear / context-menu item) must
  // configure the row that was clicked without navigating the app to it. In-memory only.
  repoConfigRepoId: number | null;
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
  // Pane ids of background ("silent") terminals awaiting an eager PTY spawn. The
  // terminal session manager drains this: it spawns each pane's shell even though
  // the pane isn't the visible/active one (so a queued command runs), then clears
  // the id. Lets a control-channel `term --silent` start work without the UI
  // jumping to it.
  terminalBgQueue: string[];
  setView: (view: View) => void;
  /**
   * Intentional navigation to a workspace view (palette, CLI nav, in-terminal
   * links): sets the view AND leaves the full-screen terminal so the change is
   * actually visible. Guards/reconcilers that merely correct `view` keep using
   * plain `setView`, which never yanks the user out of a terminal.
   */
  showView: (view: View) => void;
  setReviewMode: (mode: ReviewMode) => void;
  setActiveRepo: (id: number | null, worktreePath?: string | null) => void;
  setActiveGroup: (id: number | null) => void;
  setSelectedPr: (n: number | null) => void;
  setHistorySha: (sha: string | null) => void;
  setFilesPath: (path: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  toggleSettings: () => void;
  /** Open the repo config dialog for an explicit repo — e.g. the sidebar row's
   * gear button — without touching `activeRepoId`. */
  openRepoConfig: (repoId: number) => void;
  closeRepoConfig: () => void;
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
  /**
   * Show the repo sidebar without persisting the choice — a transient reveal
   * (used when entering an empty group, see useEmptyGroupSidebarReveal) that
   * leaves the user's saved hidden/shown preference untouched.
   */
  revealRepoSidebar: () => void;
  /** Ask the user to confirm publishing `branch` to `origin` (#300). */
  requestPushConfirm: (repoId: number, branch: string) => void;
  clearPushConfirm: () => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  /** Open a new terminal tab in a group rooted at `cwd` and return the new pane's
   * id (so callers can queue input for it). Reveals the pane and makes the tab
   * active, unless `opts.background` — a background tab is appended without
   * switching the active tab or opening the panel (for silent control-channel
   * terminals); pair it with `requestBackgroundTerminal` to spawn its shell. */
  addTerminalTab: (
    groupId: number,
    cwd: string,
    title: string,
    opts?: { background?: boolean },
  ) => string;
  /** Queue a pane for an eager background PTY spawn (see `terminalBgQueue`). */
  requestBackgroundTerminal: (paneId: string) => void;
  /** Drop a pane id from the background-spawn queue once it's been spawned. */
  clearBackgroundTerminal: (paneId: string) => void;
  /**
   * Split the group's active tab, adding a pane rooted at `cwd` (#316):
   * `row` (the default) puts it beside the active pane, in its row; `column`
   * puts it in a new row of its own, directly below the active pane's row.
   * Any mix is allowed — the tab is a grid of rows.
   */
  splitTerminal: (groupId: number, cwd: string, direction?: SplitDirection) => void;
  /**
   * Rebalance split weights after a divider drag (#316): per-pane width
   * weights (keyed by pane id) and/or the tab's per-row height weights.
   */
  resizeTerminalSplit: (
    groupId: number,
    tabId: string,
    patch: { paneSizes?: Record<string, number>; rowSizes?: number[] },
  ) => void;
  selectTerminalTab: (groupId: number, tabId: string) => void;
  /** Rename a tab; an empty/blank title reverts to the auto-derived default. */
  renameTerminalTab: (groupId: number, tabId: string, title: string) => void;
  setActivePane: (groupId: number, tabId: string, paneId: string) => void;
  /**
   * Reveal a terminal pane and put keyboard focus in it: open the panel, switch
   * to its group/tab/pane, then bump `terminalFocusNonce` so the pane re-focuses
   * its xterm even when none of that state changed. Used by the command palette,
   * the notification-click handler, the sidebar terminal rail, and the terminal
   * next/prev-terminal chords (#328).
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
// The terminal view now takes over the whole main area, so booting into it
// only makes sense when there are restored sessions to show — otherwise a
// persisted `terminalOpen` would greet the user with an empty terminal.
const hasRestoredTabs = Object.keys(restoredTerminals.terminals).length > 0;

export const useUiStore = create<UiState>((set, get) => ({
  view: "files",
  reviewMode: "working",
  activeRepoId: null,
  activeWorktreePath: null,
  activeGroupId: null,
  selectedPrNumber: null,
  repoSidebarHidden: storedRepoSidebarHidden(),
  pushConfirm: null,
  terminalOpen: storedTerminalOpen() && hasRestoredTabs,
  terminals: restoredTerminals.terminals,
  groupSelections: {},
  termActivity: {},
  nextTermId: restoredTerminals.nextTermId,
  historySha: null,
  filesPath: null,
  settingsOpen: false,
  repoConfigRepoId: null,
  commandPaletteOpen: false,
  compare: null,
  compareSelection: null,
  filesPanel: storedFilesPanel(),
  searchFocusNonce: 0,
  terminalFocusNonce: 0,
  terminalBgQueue: [],
  setView: (view) => set({ view }),
  showView: (view) => {
    localStorage.setItem(TERMINAL_OPEN_KEY, "0");
    set({ view, terminalOpen: false });
  },
  setReviewMode: (reviewMode) => set({ reviewMode }),
  // Reset the selected PR when switching repos — it's repo-specific.
  setActiveRepo: (id, worktreePath = null) =>
    set({ activeRepoId: id, activeWorktreePath: worktreePath, selectedPrNumber: null }),
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
        activeWorktreePath: null,
        view: remembered ? remembered.view : s.view,
        selectedPrNumber: null,
      };
    }),
  setSelectedPr: (selectedPrNumber) => set({ selectedPrNumber }),
  setHistorySha: (historySha) => set({ historySha }),
  setFilesPath: (filesPath) => set({ filesPath }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  openRepoConfig: (repoId) => set({ repoConfigRepoId: repoId }),
  closeRepoConfig: () => set({ repoConfigRepoId: null }),
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
    // An intentional workspace navigation — leave the full-screen terminal.
    localStorage.setItem(TERMINAL_OPEN_KEY, "0");
    set((s) => ({
      view: "files",
      filesPanel: "search",
      terminalOpen: false,
      searchFocusNonce: s.searchFocusNonce + 1,
    }));
  },
  toggleRepoSidebar: () => {
    const repoSidebarHidden = !get().repoSidebarHidden;
    localStorage.setItem(REPO_SIDEBAR_KEY, repoSidebarHidden ? "1" : "0");
    set({ repoSidebarHidden });
  },
  // In-memory only: no localStorage write, so the persisted preference survives.
  revealRepoSidebar: () => set({ repoSidebarHidden: false }),
  requestPushConfirm: (repoId, branch) => set({ pushConfirm: { repoId, branch } }),
  clearPushConfirm: () => set({ pushConfirm: null }),
  setTerminalOpen: (open) => {
    localStorage.setItem(TERMINAL_OPEN_KEY, open ? "1" : "0");
    set({ terminalOpen: open });
  },
  toggleTerminal: () => get().setTerminalOpen(!get().terminalOpen),
  addTerminalTab: (groupId, cwd, title, opts) => {
    const n = get().nextTermId;
    const paneId = `term-${n}`;
    const tab: TermTab = {
      id: `tab-${n}`,
      title,
      panes: [{ id: paneId, cwd }],
      activePaneId: paneId,
    };
    const background = opts?.background ?? false;
    // A background tab must not steal the user's view: don't reveal the panel and
    // don't switch the group's active tab (only adopt it if the group had none).
    if (!background) get().setTerminalOpen(true);
    set((s) => {
      const g = s.terminals[groupId] ?? { tabs: [], activeTabId: null };
      return {
        nextTermId: n + 1,
        terminals: {
          ...s.terminals,
          [groupId]: {
            tabs: [...g.tabs, tab],
            activeTabId: background ? (g.activeTabId ?? tab.id) : tab.id,
          },
        },
      };
    });
    return paneId;
  },
  requestBackgroundTerminal: (paneId) =>
    set((s) =>
      s.terminalBgQueue.includes(paneId) ? {} : { terminalBgQueue: [...s.terminalBgQueue, paneId] },
    ),
  clearBackgroundTerminal: (paneId) =>
    set((s) => ({ terminalBgQueue: s.terminalBgQueue.filter((id) => id !== paneId) })),
  splitTerminal: (groupId, cwd, direction = "row") => {
    const n = get().nextTermId;
    const paneId = `term-${n}`;
    set((s) => {
      const g = s.terminals[groupId];
      if (!g || !g.activeTabId) return {};
      const tabs = g.tabs.map((t) => {
        if (t.id !== g.activeTabId) return t;
        const active = t.panes.find((p) => p.id === t.activePaneId) ?? t.panes[t.panes.length - 1];
        const activeRow = active.row ?? 0;
        if (direction === "column") {
          // A new row of its own directly below the active pane's row; every
          // row after it shifts down one (rows stay contiguous).
          const shifted = t.panes.map((p) =>
            (p.row ?? 0) > activeRow ? { ...p, row: (p.row ?? 0) + 1 } : p,
          );
          // Insert after the active row's last pane (row-major order). Plain
          // loop: the TS lib target predates Array#findLastIndex.
          let at = 0;
          shifted.forEach((p, i) => {
            if ((p.row ?? 0) <= activeRow) at = i + 1;
          });
          const panes = [
            ...shifted.slice(0, at),
            { id: paneId, cwd, row: activeRow + 1 },
            ...shifted.slice(at),
          ];
          // Give the new row an average height weight so it takes an equal-ish
          // share whatever the existing rows were dragged to.
          let rowSizes = t.rowSizes;
          if (rowSizes && rowSizes.length > 0) {
            const avg = rowSizes.reduce((a, b) => a + b, 0) / rowSizes.length;
            rowSizes = [...rowSizes.slice(0, activeRow + 1), avg, ...rowSizes.slice(activeRow + 1)];
          }
          return { ...t, panes, rowSizes, activePaneId: paneId };
        }
        // `row`: insert beside the active pane, in its row, with an average
        // width weight so it takes an equal-ish share of the row.
        const idx = t.panes.indexOf(active);
        const rowPanes = t.panes.filter((p) => (p.row ?? 0) === activeRow);
        const avg = rowPanes.reduce((a, p) => a + (p.size ?? 1), 0) / rowPanes.length;
        const panes = [
          ...t.panes.slice(0, idx + 1),
          { id: paneId, cwd, row: activeRow, size: avg },
          ...t.panes.slice(idx + 1),
        ];
        return { ...t, panes, activePaneId: paneId };
      });
      return {
        nextTermId: n + 1,
        terminals: { ...s.terminals, [groupId]: { ...g, tabs } },
      };
    });
  },
  resizeTerminalSplit: (groupId, tabId, patch) =>
    set((s) => {
      const g = s.terminals[groupId];
      if (!g) return {};
      const tabs = g.tabs.map((t) => {
        if (t.id !== tabId) return t;
        const panes = patch.paneSizes
          ? t.panes.map((p) =>
              patch.paneSizes![p.id] !== undefined ? { ...p, size: patch.paneSizes![p.id] } : p,
            )
          : t.panes;
        return { ...t, panes, rowSizes: patch.rowSizes ?? t.rowSizes };
      });
      return { terminals: { ...s.terminals, [groupId]: { ...g, tabs } } };
    }),
  selectTerminalTab: (groupId, tabId) =>
    set((s) => {
      const g = s.terminals[groupId];
      if (!g) return {};
      return { terminals: { ...s.terminals, [groupId]: { ...g, activeTabId: tabId } } };
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
      const removed = tab.panes.find((p) => p.id === paneId);
      let panes = tab.panes.filter((p) => p.id !== paneId);
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
      // If that was the row's last pane, the row collapses: rows below shift
      // up and its height weight is dropped, so numbering stays contiguous.
      const removedRow = removed?.row ?? 0;
      let rowSizes = tab.rowSizes;
      if (!panes.some((p) => (p.row ?? 0) === removedRow)) {
        panes = panes.map((p) => ((p.row ?? 0) > removedRow ? { ...p, row: (p.row ?? 0) - 1 } : p));
        rowSizes = rowSizes?.filter((_, i) => i !== removedRow);
        // A single remaining row is equal-height by definition.
        if (rowSizes && rowSizes.length < 2) rowSizes = undefined;
      }
      const activePaneId =
        tab.activePaneId === paneId ? panes[panes.length - 1].id : tab.activePaneId;
      const tabs = g.tabs.map((t) =>
        t.id === tabId ? { ...t, panes, rowSizes, activePaneId } : t,
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

// Flatten the per-group terminal layout into the snapshot the backend mirrors
// for the `term-list` control query (one entry per open tab).
function reportTerminals(terminals: Record<number, GroupTerminals>) {
  const entries = Object.entries(terminals).flatMap(([groupId, g]) =>
    g.tabs.map((t) => ({
      group_id: Number(groupId),
      tab_id: t.id,
      name: termTabLabel(t),
      panes: t.panes.length,
      cwd: t.panes[0]?.cwd || undefined,
    })),
  );
  // Fire-and-forget; outside Tauri (tests) or before the backend is up, ignore.
  ipc.terminalRegistryReport(entries).catch(() => {});
}

// Persist the terminal layout whenever it changes (#155). The reference check
// keeps this near-free on unrelated state updates — every terminal mutation
// produces a fresh `terminals` object — and persisting per-mutation (rather than
// only on clean quit) means a crash still leaves the layout restorable. The same
// change is mirrored to the backend so `gamut term-list` can report open tabs.
useUiStore.subscribe((s, prev) => {
  if (s.terminals !== prev.terminals || s.nextTermId !== prev.nextTermId) {
    persistTerminals(s.terminals, s.nextTermId);
    reportTerminals(s.terminals);
  }
});
