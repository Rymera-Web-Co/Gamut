import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { toast } from "@/store/toast";

export function SyncControls({
  repoId,
  ahead = 0,
  behind = 0,
}: {
  repoId: number;
  ahead?: number;
  behind?: number;
}) {
  const qc = useQueryClient();

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["sync-status", repoId] });
    qc.invalidateQueries({ queryKey: ["branches", repoId] });
    qc.invalidateQueries({ queryKey: ["log", repoId] });
    qc.invalidateQueries({ queryKey: ["review-files", repoId] });
    qc.invalidateQueries({ queryKey: ["repo-statuses"] });
  }

  // Errors surface via the global mutation-cache toast handler. Fetching is
  // driven from the group header (fetch-all), not per-repo — see RepoSidebar.
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

  const busy = pull.isPending || push.isPending;

  return (
    <div className="flex items-center">
      <Button
        size="sm"
        variant="ghost"
        className="h-6 gap-0.5 px-1.5 text-[11px] [&_svg]:size-3"
        title="Pull"
        disabled={busy}
        onClick={() => pull.mutate()}
      >
        {pull.isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <ArrowDownToLine className="size-3" />
        )}
        {behind > 0 && <span>{behind}</span>}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 gap-0.5 px-1.5 text-[11px] [&_svg]:size-3"
        title="Push"
        disabled={busy}
        onClick={() => push.mutate()}
      >
        {push.isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <ArrowUpFromLine className="size-3" />
        )}
        {ahead > 0 && <span>{ahead}</span>}
      </Button>
    </div>
  );
}
