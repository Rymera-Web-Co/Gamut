import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ipc, type SyncResult } from "@/lib/ipc";
import { toast } from "@/store/toast";

/** Git-derived query keys a pull or push can make stale (ahead/behind, log…). */
const SYNC_QUERY_KEYS = [
  "repo-statuses",
  "branches",
  "log",
  "review-files",
  "sync-status",
] as const;

/**
 * Pull or push a set of repos in one IPC round trip — the repo sidebar's
 * bulk-action bar (#294). One repo failing never aborts the batch: the backend
 * returns a per-repo result list, and the mix is reported as a single toast
 * rather than one per repo, so a 20-repo bulk action can't bury the UI in
 * notifications.
 *
 * Per-repo pull/push (the row's `SyncControls` and the ⌘⇧P / ⌘⇧K shortcuts) live
 * in `useSyncActions` — that path reports git's own output for the one repo,
 * which has nowhere to go in a batch.
 */
function useSyncMany(run: (repoIds: number[]) => Promise<SyncResult[]>, verb: "Pulled" | "Pushed") {
  const qc = useQueryClient();
  return useMutation({
    // Wrapped rather than passed by reference: react-query hands `mutationFn` a
    // second (context) argument, which would otherwise reach the ipc wrapper.
    mutationFn: (repoIds: number[]) => run(repoIds),
    onSuccess: (results) => {
      // Refetch the ahead/behind counts and await them inside the mutation, so
      // the bar's spinner stays up until the numbers on the rows actually
      // reflect the run (matching `useFetchGroup`).
      for (const key of SYNC_QUERY_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      const failed = results.filter((r) => !r.ok);
      const done = results.length - failed.length;
      if (failed.length === 0) {
        toast.success(`${verb} ${done} ${done === 1 ? "repository" : "repositories"}`);
      } else if (done === 0) {
        // Nothing succeeded — lead with the reason rather than a bare count.
        toast.error(
          `Couldn't ${verb === "Pulled" ? "pull" : "push"} ${failed.length} ${
            failed.length === 1 ? "repository" : "repositories"
          }: ${failed[0].error ?? "unknown error"}`,
        );
      } else {
        toast.error(`${verb} ${done} of ${results.length} — ${failed.length} failed`);
      }
    },
  });
}

/** Pull every listed repo in one round trip. */
export function usePullMany() {
  return useSyncMany(ipc.gitPullMany, "Pulled");
}

/** Push every listed repo in one round trip. */
export function usePushMany() {
  return useSyncMany(ipc.gitPushMany, "Pushed");
}
