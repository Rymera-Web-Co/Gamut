import { useQuery } from "@tanstack/react-query";

import { GroupRail } from "@/features/repos/GroupRail";
import { RepoSidebar } from "@/features/repos/RepoSidebar";
import { TopTabs } from "@/components/layout/TopTabs";
import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/toaster";
import { HistoryView } from "@/features/history/HistoryView";
import { ReviewView } from "@/features/review/ReviewView";
import { PullsView } from "@/features/review/PullsView";
import { ipc } from "@/lib/ipc";
import { useGitWatch } from "@/lib/useGitWatch";
import { useKeyboardShortcuts } from "@/lib/useKeyboardShortcuts";
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
  useKeyboardShortcuts();
  useGitWatch();

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex min-h-0 flex-1">
        <GroupRail />
        <PanelGroup
          direction="horizontal"
          autoSaveId="gamut.layout.main"
          className="min-w-0 flex-1"
        >
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
                {view === "history" && <HistoryView />}
                {view === "review" && <ReviewView />}
                {view === "pulls" && <PullsView />}
              </div>
            </main>
          </Panel>
        </PanelGroup>
      </div>
      <StatusBar />
      <Toaster />
    </div>
  );
}
