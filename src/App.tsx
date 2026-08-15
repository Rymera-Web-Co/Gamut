import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ImperativePanelHandle } from "react-resizable-panels";

import { RepoConfigDialog } from "@/features/repos/RepoConfigDialog";
import { Sidebar } from "@/features/nav/Sidebar";
import { WorkspaceHeader } from "@/components/layout/WorkspaceHeader";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/toaster";
import { FilesView } from "@/features/files/FilesView";
import { HistoryView } from "@/features/history/HistoryView";
import { ReviewView } from "@/features/review/ReviewView";
import { PullsView } from "@/features/review/PullsView";
import { TerminalPane } from "@/features/terminal/TerminalPane";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { CompareDialog } from "@/features/compare/CompareDialog";
import { PublishBranchDialog } from "@/features/sync/PublishBranchDialog";
import { UpdateBanner } from "@/features/updates/UpdateBanner";
import { DragGhost } from "@/lib/usePointerDnd";
import { ipc } from "@/lib/ipc";
import { useSettings } from "@/lib/settings";
import { checkForUpdatesOnLaunch, startUpdatePolling } from "@/lib/updater";
import { useActiveRepoIsGit, useNonGitViewGuard } from "@/lib/useActiveRepo";
import { useActiveRepoReconciler } from "@/lib/useActiveRepoReconciler";
import { useAutoFetch } from "@/lib/useAutoFetch";
import { useAutoPull } from "@/lib/useAutoPull";
import { useEmptyGroupSidebarReveal } from "@/lib/useEmptyGroupSidebarReveal";
import { useGitWatch } from "@/lib/useGitWatch";
import { useKeyboardShortcuts } from "@/lib/useKeyboardShortcuts";
import { useMainThreadWatchdog } from "@/lib/useMainThreadWatchdog";
import { useRefreshOnFocus } from "@/lib/useRefreshOnFocus";
import { useUiNav } from "@/lib/useUiNav";
import { useUiStore } from "@/store/ui";

function StatusBar() {
  const { data, isError } = useQuery({
    queryKey: ["db-health"],
    queryFn: ipc.dbHealth,
  });
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const terminals = useUiStore((s) => s.terminals);
  const groupTerms = activeGroupId != null ? (terminals[activeGroupId]?.tabs.length ?? 0) : 0;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t bg-[var(--color-sidebar)] px-3 text-[11px] text-[var(--color-muted-foreground)]">
      <span>Gamut</span>
      <span aria-hidden>·</span>
      {isError ? (
        <span className="text-[var(--color-destructive)]">backend offline</span>
      ) : data ? (
        <span>
          db ok · {data.migrations.length} migration
          {data.migrations.length === 1 ? "" : "s"} · {data.repo_count} repos
        </span>
      ) : (
        <span>connecting…</span>
      )}
      {groupTerms > 0 && (
        <span className="text-[var(--color-primary)]">
          {groupTerms} terminal{groupTerms === 1 ? "" : "s"} in this group
        </span>
      )}
      <span className="ml-auto hidden sm:inline">⌘K jump · ⌘` terminal · ⌘B sidebar</span>
    </footer>
  );
}

export default function App() {
  const view = useUiStore((s) => s.view);
  const repoSidebarHidden = useUiStore((s) => s.repoSidebarHidden);
  const terminalOpen = useUiStore((s) => s.terminalOpen);
  const terminalMaximized = useUiStore((s) => s.terminalMaximized);
  const setTerminalOpen = useUiStore((s) => s.setTerminalOpen);
  const loadSettings = useSettings((s) => s.load);
  const isGitRepo = useActiveRepoIsGit();
  useKeyboardShortcuts();
  useGitWatch();
  useRefreshOnFocus();
  useUiNav();
  useAutoFetch();
  useAutoPull();
  useActiveRepoReconciler();
  useEmptyGroupSidebarReveal();
  useNonGitViewGuard();
  useMainThreadWatchdog();

  // Reconcile preferences with the DB once on startup (state is mirror-hydrated
  // synchronously, so this only corrects drift / picks up another window's edits).
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Check for an app update once on launch, then keep polling daily so a
  // long-lived window still picks up a release cut after it opened. Both are
  // silent (no toast if up to date or offline) and no-ops outside the bundled
  // desktop app.
  useEffect(() => {
    checkForUpdatesOnLaunch();
    return startUpdatePolling();
  }, []);

  // Suppress the webview's native right-click menu — this is a desktop app, so a
  // browser context menu is out of place. Editable fields are exempt so their
  // native copy/paste/cut menu is preserved. Our own cursor-anchored menus still
  // open: they call preventDefault in their own handler and set state regardless
  // of this listener.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Imperatively collapse/expand the terminal panel to match `terminalOpen`,
  // which can change from the keyboard shortcut, the close button, or opening a
  // group terminal. The guard avoids a feedback loop with onCollapse/onExpand.
  const terminalPanelRef = useRef<ImperativePanelHandle>(null);
  useEffect(() => {
    const panel = terminalPanelRef.current;
    if (!panel) return;
    if (terminalOpen && panel.isCollapsed()) panel.expand();
    else if (!terminalOpen && panel.isExpanded()) panel.collapse();
  }, [terminalOpen]);

  // Maximize/restore the terminal panel. Maximizing collapses the content panel
  // to zero (its minSize drops to 0 while maximized) so the terminal fills the
  // whole right column below the persistent top bar; restoring returns it to the
  // size captured just before maximizing. Resets while the pane is hidden so
  // reopening never restores into a stale size.
  const preMaximizeSizeRef = useRef<number | null>(null);
  useEffect(() => {
    const panel = terminalPanelRef.current;
    if (!panel) return;
    if (!terminalOpen) {
      preMaximizeSizeRef.current = null;
      return;
    }
    if (terminalMaximized) {
      preMaximizeSizeRef.current = panel.getSize();
      panel.resize(100);
    } else if (preMaximizeSizeRef.current != null) {
      panel.resize(preMaximizeSizeRef.current);
      preMaximizeSizeRef.current = null;
    }
  }, [terminalMaximized, terminalOpen]);

  return (
    <div className="flex h-full w-full flex-col">
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        {!repoSidebarHidden && <Sidebar />}
        {/* Vertical split to the right of the sidebar: main content on top,
            the integrated terminal pinned to the bottom. The sidebar stays
            outside so the terminal spans the full width minus it. While the
            terminal is maximized the content panel collapses to zero, so a
            persistent header is rendered above the split to keep view tabs and
            the maximize toggle reachable. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {terminalMaximized && <WorkspaceHeader />}
          <PanelGroup direction="vertical" className="min-h-0 flex-1">
            <Panel id="content" order={1} minSize={terminalMaximized ? 0 : 20} className="min-h-0">
              <main className="flex h-full min-w-0 flex-col">
                <WorkspaceHeader />
                <div className="min-h-0 flex-1 overflow-hidden">
                  {view === "files" && <FilesView />}
                  {isGitRepo && view === "history" && <HistoryView />}
                  {isGitRepo && view === "review" && <ReviewView />}
                  {isGitRepo && view === "pulls" && <PullsView />}
                </div>
              </main>
            </Panel>
            <ResizeHandle
              horizontal
              className={terminalOpen && !terminalMaximized ? "" : "hidden"}
            />
            <Panel
              id="terminal"
              order={2}
              ref={terminalPanelRef}
              collapsible
              collapsedSize={0}
              defaultSize={terminalOpen ? 32 : 0}
              minSize={12}
              onCollapse={() => setTerminalOpen(false)}
              onExpand={() => setTerminalOpen(true)}
              className="min-h-0"
            >
              <TerminalPane />
            </Panel>
          </PanelGroup>
        </div>
      </div>
      <StatusBar />
      <Toaster />
      <SettingsDialog />
      <RepoConfigDialog />
      <CommandPalette />
      <CompareDialog />
      <PublishBranchDialog />
      <DragGhost />
    </div>
  );
}
