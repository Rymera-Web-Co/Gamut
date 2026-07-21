import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ImperativePanelHandle } from "react-resizable-panels";

import { GroupRail } from "@/features/repos/GroupRail";
import { RepoSidebar } from "@/features/repos/RepoSidebar";
import { TopTabs } from "@/components/layout/TopTabs";
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
import { UpdateBanner } from "@/features/updates/UpdateBanner";
import { DragGhost } from "@/lib/usePointerDnd";
import { ipc } from "@/lib/ipc";
import { useSettings } from "@/lib/settings";
import { checkForUpdatesOnLaunch } from "@/lib/updater";
import { useActiveRepoIsGit, useNonGitViewGuard } from "@/lib/useActiveRepo";
import { useActiveRepoReconciler } from "@/lib/useActiveRepoReconciler";
import { useAutoFetch } from "@/lib/useAutoFetch";
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

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t px-3 text-xs text-[var(--color-muted-foreground)]">
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
  useActiveRepoReconciler();
  useNonGitViewGuard();
  useMainThreadWatchdog();

  // Reconcile preferences with the DB once on startup (state is mirror-hydrated
  // synchronously, so this only corrects drift / picks up another window's edits).
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Check for an app update once on launch (silent — no toast if up to date or
  // offline). A no-op outside the bundled desktop app.
  useEffect(() => {
    checkForUpdatesOnLaunch();
  }, []);

  // Suppress the webview's native right-click menu everywhere — this is a
  // desktop app, so a browser context menu is out of place. Our own
  // cursor-anchored menus still open: they call preventDefault in their own
  // handler and set state regardless of this listener.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
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
        <GroupRail />
        {/* Vertical split to the right of the group rail: main content on top,
            the integrated terminal pinned to the bottom. The rail stays outside
            so the terminal spans the full width minus the rail. While the
            terminal is maximized the content panel collapses to zero, so a
            persistent top bar is rendered above the split to keep view tabs and
            the maximize toggle reachable. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {terminalMaximized && <TopTabs />}
          <PanelGroup direction="vertical" className="min-h-0 flex-1">
            <Panel id="content" order={1} minSize={terminalMaximized ? 0 : 20} className="min-h-0">
              <PanelGroup direction="horizontal" autoSaveId="gamut.layout.main" className="min-w-0">
                {!repoSidebarHidden && (
                  <Panel
                    id="repos"
                    order={1}
                    defaultSize={20}
                    minSize={12}
                    maxSize={40}
                    className="min-w-0"
                  >
                    <RepoSidebar />
                  </Panel>
                )}
                {!repoSidebarHidden && <ResizeHandle />}
                <Panel id="main" order={2} className="min-w-0">
                  <main className="flex h-full min-w-0 flex-col">
                    <TopTabs />
                    <div className="min-h-0 flex-1 overflow-hidden">
                      {view === "files" && <FilesView />}
                      {isGitRepo && view === "history" && <HistoryView />}
                      {isGitRepo && view === "review" && <ReviewView />}
                      {isGitRepo && view === "pulls" && <PullsView />}
                    </div>
                  </main>
                </Panel>
              </PanelGroup>
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
      <CommandPalette />
      <CompareDialog />
      <DragGhost />
    </div>
  );
}
