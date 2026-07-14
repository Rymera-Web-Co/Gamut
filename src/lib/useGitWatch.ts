import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import { ipc, type RepoStatus } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";

/**
 * How long to wait after the last `repos-changed` event before invalidating
 * queries. The backend watcher already debounces filesystem noise, but distinct
 * events still arrive in bursts (e.g. a background auto-fetch landing refs in
 * 40-50 repos one after another, or a wake-from-idle FSEvents replay). Each
 * invalidation fans out into a refetch of every git-derived query — including a
 * status scan per repo — so coalescing the burst into a single round keeps those
 * scans from stampeding (issue #89).
 */
const COALESCE_MS = 250;

/**
 * Query keys that carry a repo id as their second element (`[key, repoId]`),
 * so invalidation can be scoped to just the repos the watcher says changed
 * instead of every repo (#206).
 */
export const REPO_SCOPED_KEYS = [
  "branches",
  "git-tags",
  "log",
  "review-files",
  "worktree-status",
  "worktree-file-diff",
  "linked-worktrees",
  "stash-list",
  "sync-status",
  // Files tab: directory listings and open-file contents.
  "dir",
  "file",
];

/**
 * Listen for the backend's `repos-changed` event (emitted when a watched repo's
 * working tree changes outside the app — a branch switch or commit in a
 * terminal, or a file edited in another editor/IDE) and refetch the
 * git-derived queries so the UI stays live. Bursts are coalesced so one storm
 * of events triggers one invalidation round rather than many. The event
 * carries the ids of the repos that actually changed (or `null` when the
 * backend can't narrow it down), so a round only refetches those repos'
 * queries rather than re-scanning the whole fleet. `repo-statuses` is a
 * single aggregate query with no per-repo variant, so scoped rounds fetch just
 * the changed repos' statuses (`repo_statuses_for`) and patch them into the
 * aggregate cache — invalidating it instead would run a full-fleet git scan
 * per round, which on a busy fleet (build tools and editors writing
 * constantly) pegged the CPU with back-to-back scans.
 */
export function useGitWatch() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let repoIds = new Set<number>();
    let fullInvalidate = false;
    // All writes to the aggregate `repo-statuses` cache are chained behind the
    // previous round, so they apply in submission order. Without this, a second
    // flush could start while an earlier scoped fetch is still in flight, and
    // the older response — resolving last — would overwrite the fresher patch.
    // Chaining (rather than dropping superseded responses) also keeps updates
    // for repos that only appeared in the earlier round. Rounds never reject:
    // each round's failure is handled inside it.
    let aggregateChain: Promise<unknown> = Promise.resolve();

    const flush = () => {
      timer = null;
      const ids = [...repoIds];
      const full = fullInvalidate;
      repoIds = new Set();
      fullInvalidate = false;

      if (full) {
        aggregateChain = aggregateChain.then(() =>
          queryClient.invalidateQueries({ queryKey: ["repo-statuses"] }),
        );
        for (const key of REPO_SCOPED_KEYS) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
        return;
      }

      aggregateChain = aggregateChain.then(() =>
        ipc
          .repoStatusesFor(ids)
          .then((fresh) => {
            queryClient.setQueryData<RepoStatus[]>(["repo-statuses"], (prev) => {
              // No cached aggregate yet — leave it to the full query.
              if (!prev) return prev;
              const byId = new Map(fresh.map((s) => [s.id, s]));
              return prev.map((s) => byId.get(s.id) ?? s);
            });
          })
          .catch(() => {
            // Scoped refresh failed; fall back to the full scan.
            return queryClient.invalidateQueries({ queryKey: ["repo-statuses"] });
          }),
      );
      for (const id of ids) {
        for (const key of REPO_SCOPED_KEYS) {
          queryClient.invalidateQueries({ queryKey: [key, id] });
        }
      }
    };

    const unlisten = listen<number[] | null>("repos-changed", (event) => {
      if (event.payload == null) fullInvalidate = true;
      else for (const id of event.payload) repoIds.add(id);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, COALESCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unlisten.then((off) => off());
    };
  }, []);
}
