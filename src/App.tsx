import { useQuery } from "@tanstack/react-query";

import { Sidebar } from "@/components/layout/Sidebar";
import { ReposView } from "@/features/repos/ReposView";
import { HistoryView } from "@/features/history/HistoryView";
import { ReviewView } from "@/features/pulls/ReviewView";
import { ipc } from "@/lib/ipc";
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

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-auto">
          {view === "repos" && <ReposView />}
          {view === "history" && <HistoryView />}
          {view === "review" && <ReviewView />}
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
