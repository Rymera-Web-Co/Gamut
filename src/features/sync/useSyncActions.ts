import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";
import { toast } from "@/store/toast";

/**
 * Fetch/pull/push mutations for a repo, shared by the `SyncControls` buttons
 * and the global keyboard shortcuts (⌘⌥F / ⌘⇧P / ⌘⇧K). Pass `null` when no
 * repo is active — the mutations are still created (hooks must run every
 * render) but reject if triggered, so callers should guard on `repoId`.
 */
export function useSyncActions(repoId: number | null) {
  const qc = useQueryClient();

  function invalidate() {
    if (repoId == null) return;
    qc.invalidateQueries({ queryKey: ["sync-status", repoId] });
    qc.invalidateQueries({ queryKey: ["branches", repoId] });
    qc.invalidateQueries({ queryKey: ["log", repoId] });
    qc.invalidateQueries({ queryKey: ["review-files", repoId] });
    qc.invalidateQueries({ queryKey: ["repo-statuses"] });
  }

  function requireRepo() {
    if (repoId == null) throw new Error("No active repository");
    return repoId;
  }

  // Errors surface via the global mutation-cache toast handler.
  const fetch = useMutation({
    mutationFn: () => ipc.gitFetch(requireRepo()),
    onSuccess: () => {
      invalidate();
      toast.success("Fetched from remote");
    },
  });
  const pull = useMutation({
    mutationFn: () => ipc.gitPull(requireRepo()),
    onSuccess: (out) => {
      invalidate();
      toast.success(out || "Pulled");
    },
  });
  const push = useMutation({
    mutationFn: () => ipc.gitPush(requireRepo()),
    onSuccess: (out) => {
      invalidate();
      toast.success(out || "Pushed");
    },
  });

  const busy = fetch.isPending || pull.isPending || push.isPending;

  return { fetch, pull, push, busy };
}
