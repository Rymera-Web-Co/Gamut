import { useRef } from "react";
import { Plus, RotateCw, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

import { useGroups, useRepos } from "@/features/repos/api";
import { visibleRepos } from "@/lib/groupRepos";
import { useSettings } from "@/lib/settings";
import { useTheme } from "@/lib/theme";
import { useUiStore, type SplitDirection } from "@/store/ui";
import { ActivityDot } from "./activity";
import { xtermTheme } from "./terminalTheme";
import { useTerminalSessions } from "./useTerminalSessions";
import { useTerminalShortcuts } from "./useTerminalShortcuts";

/**
 * The integrated terminal pane: a per-group set of tabs, each with one or more
 * split panes — side by side or stacked (#316). The live xterm instances, their layout/spawn and
 * theme/resize coordination live in {@link useTerminalSessions}; the keyboard
 * shortcuts are {@link useTerminalShortcuts}. The sidebar's terminal rail is
 * the tab list, and the header above carries the session controls — this
 * component renders the viewport host the sessions mount into (#143).
 */
export function TerminalPane() {
  const terminalOpen = useUiStore((s) => s.terminalOpen);
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const activeRepoId = useUiStore((s) => s.activeRepoId);
  const activeWorktreePath = useUiStore((s) => s.activeWorktreePath);
  const terminals = useUiStore((s) => s.terminals);
  const addTerminalTab = useUiStore((s) => s.addTerminalTab);
  const splitTerminal = useUiStore((s) => s.splitTerminal);
  const selectTerminalTab = useUiStore((s) => s.selectTerminalTab);
  const setActivePane = useUiStore((s) => s.setActivePane);
  const closeTerminalTab = useUiStore((s) => s.closeTerminalTab);
  const closeTerminalPane = useUiStore((s) => s.closeTerminalPane);
  const termActivity = useUiStore((s) => s.termActivity);
  const markTermActivity = useUiStore((s) => s.markTermActivity);
  const clearTermActivity = useUiStore((s) => s.clearTermActivity);
  const terminalFocusNonce = useUiStore((s) => s.terminalFocusNonce);
  const newTabDir = useSettings((s) => s.values.terminalNewTabDir);
  const theme = useTheme((s) => s.theme);

  const repos = useRepos();
  const groups = useGroups();
  const repoList = repos.data ?? [];
  const groupList = groups.data ?? [];

  const hostRef = useRef<HTMLDivElement>(null);

  const gt = activeGroupId != null ? terminals[activeGroupId] : undefined;
  const activeTab = gt?.tabs.find((t) => t.id === gt.activeTabId);
  const activePanes = activeTab?.panes ?? [];
  // Stable dep so the layout effect re-runs on tab/split changes. Includes the
  // split direction so a direction flip relays the panes out (#316).
  const direction = activeTab?.direction ?? "row";
  const paneKey = `${activeGroupId}|${activeTab?.id ?? ""}|${direction}|${activePanes
    .map((p) => p.id)
    .join(",")}`;

  // The one pane the user is actually looking at: the focused pane of the
  // active tab while the panel is open.
  const visiblePaneId = terminalOpen && activeTab ? activeTab.activePaneId : null;

  const { deadKeys, killPane, restart } = useTerminalSessions({
    hostRef,
    terminalOpen,
    activePanes,
    activeTab,
    paneKey,
    theme,
    visiblePaneId,
    terminalFocusNonce,
    activeGroupId,
    markTermActivity,
    clearTermActivity,
    setActivePane,
  });

  // The cwd/title a brand-new tab should default to. The repo selected in the
  // active group always wins (an explicit per-action intent); when none is
  // selected, the `terminalNewTabDir` setting picks the fallback — the group's
  // bound folder or the first repo shown in the group — each with the other as a
  // secondary fallback so a folderless group or a repoless group still resolves.
  function defaultTarget(): { cwd: string; title: string } | null {
    const group = groupList.find((g) => g.id === activeGroupId);
    const visible = visibleRepos(repoList, group);
    const selected = visible.find((r) => r.id === activeRepoId && !r.missing);
    if (selected) {
      // A selected linked worktree of the repo wins over its main checkout.
      if (activeWorktreePath) {
        const base = activeWorktreePath.split("/").filter(Boolean).pop() ?? selected.name;
        return { cwd: activeWorktreePath, title: `${selected.name} (${base})` };
      }
      return { cwd: selected.path, title: selected.name };
    }

    const groupFolder = group?.folder_path ? { cwd: group.folder_path, title: group.name } : null;
    const firstRepo = (() => {
      const r = visible.find((repo) => !repo.missing);
      return r ? { cwd: r.path, title: r.name } : null;
    })();

    return newTabDir === "group" ? (groupFolder ?? firstRepo) : (firstRepo ?? groupFolder);
  }

  function handleNewTab() {
    const target = defaultTarget();
    if (target && activeGroupId != null) {
      addTerminalTab(activeGroupId, target.cwd, target.title);
    }
  }

  function handleSplit(splitDirection: SplitDirection) {
    if (activeGroupId == null || !activeTab) return;
    // One direction per tab (#316): ignore a request for the other direction
    // while the tab is split — the same case the header's buttons disable —
    // rather than silently adding a pane in the direction the user didn't ask
    // for.
    if (activeTab.panes.length > 1 && (activeTab.direction ?? "row") !== splitDirection) return;
    const active =
      activeTab.panes.find((p) => p.id === activeTab.activePaneId) ?? activeTab.panes[0];
    splitTerminal(activeGroupId, active.cwd, splitDirection);
  }

  function handleCloseTab(tabId: string) {
    if (activeGroupId == null) return;
    const tab = gt?.tabs.find((t) => t.id === tabId);
    tab?.panes.forEach((p) => killPane(p.id));
    closeTerminalTab(activeGroupId, tabId);
  }

  function handleClosePane(paneId: string) {
    if (activeGroupId == null || !activeTab) return;
    killPane(paneId);
    closeTerminalPane(activeGroupId, activeTab.id, paneId);
  }

  useTerminalShortcuts(hostRef, {
    handleNewTab,
    handleSplit,
    handleCloseTab,
    selectTerminalTab,
    activeGroupId,
    gt,
    activeTab,
  });

  const tabs = gt?.tabs ?? [];
  const canNewTab = defaultTarget() != null;
  const n = activePanes.length;
  const activeDead = activeTab != null && deadKeys.has(activeTab.activePaneId);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ background: xtermTheme(theme).background }}
    >
      {/* Viewport. Pane nodes are appended/positioned imperatively into the
          host; the overlay carries React-managed per-split close buttons.
          There is no tab strip — the sidebar's terminal rail is the tab list;
          split/new/close stay reachable via the header and shortcuts. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={hostRef} className="pointer-events-none absolute inset-1.5" />
        {/* The active shell exited — offer a restart where the strip's
            Restart button used to live. */}
        {activeDead && activeTab && (
          <button
            onClick={() => restart(activeTab.activePaneId)}
            className="absolute right-3 top-2 z-10 flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2.5 py-1 text-xs font-medium text-[var(--color-secondary-foreground)] hover:text-[var(--color-foreground)]"
          >
            <RotateCw className="size-3.5" />
            Restart shell
          </button>
        )}
        {/* Per-split close buttons (only when the active tab is split), pinned
            to each pane's top-right corner in either direction (#316). */}
        {n > 1 &&
          activePanes.map((pane, i) => (
            <button
              key={pane.id}
              title="Close split"
              aria-label="Close split"
              onClick={() => handleClosePane(pane.id)}
              style={
                direction === "column"
                  ? { right: "0.25rem", top: `calc(${(i * 100) / n}% + 0.25rem)` }
                  : { left: `calc(${((i + 1) * 100) / n}% - 1.5rem)`, top: "0.25rem" }
              }
              className="absolute z-10 flex size-5 items-center justify-center rounded bg-[var(--color-sidebar)]/80 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              <X className="size-3.5" />
            </button>
          ))}
        {/* Per-split activity markers: which split changed while you were away.
            The focused pane is cleared, so this only marks the others. Pinned
            to each pane's top-left corner in either direction (#316). */}
        {n > 1 &&
          activePanes.map((pane, i) => {
            const kind = termActivity[pane.id];
            // Guard the focused pane explicitly: the clear effect runs after
            // paint, so without this it could flash a dot for one frame.
            if (!kind || pane.id === activeTab?.activePaneId) return null;
            return (
              <span
                key={`act-${pane.id}`}
                title="Unseen activity in this pane"
                style={
                  direction === "column"
                    ? { left: "0.5rem", top: `calc(${(i * 100) / n}% + 0.5rem)` }
                    : { left: `calc(${(i * 100) / n}% + 0.5rem)`, top: "0.5rem" }
                }
                className="absolute z-10"
              >
                <ActivityDot kind={kind} />
              </span>
            );
          })}
        {tabs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-xs text-[var(--color-muted-foreground)]">
            <span>No terminals open in this group.</span>
            <button
              disabled={!canNewTab}
              onClick={handleNewTab}
              className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[var(--color-foreground)] hover:bg-[var(--color-accent)] disabled:opacity-40"
            >
              <Plus className="size-3.5" />
              New terminal
            </button>
            {!canNewTab && <span>Add a repository or bind a folder to this group first.</span>}
          </div>
        )}
      </div>
    </div>
  );
}
