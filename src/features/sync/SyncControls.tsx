import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { toast } from "@/store/toast";

export function SyncControls({ repoId }: { repoId: number }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["sync-status", repoId],
    queryFn: () => ipc.gitSyncStatus(repoId),
  });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["sync-status", repoId] });
    qc.invalidateQueries({ queryKey: ["branches", repoId] });
    qc.invalidateQueries({ queryKey: ["log", repoId] });
    qc.invalidateQueries({ queryKey: ["review-files", repoId] });
    qc.invalidateQueries({ queryKey: ["repo-statuses"] });
  }

  // Errors surface via the global mutation-cache toast handler.
  const fetch = useMutation({
    mutationFn: () => ipc.gitFetch(repoId),
    onSuccess: () => {
      invalidate();
      toast.success("Fetched from remote");
    },
  });
  const pull = useMutation({
    mutationFn: () => ipc.gitPull(repoId),
    onSuccess: (out) => {
      invalidate();
      toast.success(out || "Pulled");
    },
  });
  const push = useMutation({
    mutationFn: () => ipc.gitPush(repoId),
    onSuccess: (out) => {
      invalidate();
      toast.success(out || "Pushed");
    },
  });

  const busy = fetch.isPending || pull.isPending || push.isPending;
  const ahead = status.data?.ahead ?? 0;
  const behind = status.data?.behind ?? 0;

  return (
    <div className="flex items-center">
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs"
        title="Fetch all remotes"
        disabled={busy}
        onClick={() => fetch.mutate()}
      >
        {fetch.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs"
        title="Pull"
        disabled={busy}
        onClick={() => pull.mutate()}
      >
        {pull.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <ArrowDownToLine className="size-3.5" />
        )}
        {behind > 0 && <span>{behind}</span>}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs"
        title="Push"
        disabled={busy}
        onClick={() => push.mutate()}
      >
        {push.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <ArrowUpFromLine className="size-3.5" />
        )}
        {ahead > 0 && <span>{ahead}</span>}
      </Button>
    </div>
  );
}
