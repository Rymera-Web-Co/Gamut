import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

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
 * queries rather than re-scanning the whole fleet — `repo-statuses` is a
 * single aggregate query with no per-repo variant, so it's always refreshed.
 */
export function useGitWatch() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let repoIds = new Set<number>();
    let fullInvalidate = false;

    const flush = () => {
      timer = null;
      queryClient.invalidateQueries({ queryKey: ["repo-statuses"] });
      if (fullInvalidate) {
        for (const key of REPO_SCOPED_KEYS) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
      } else {
        for (const id of repoIds) {
          for (const key of REPO_SCOPED_KEYS) {
            queryClient.invalidateQueries({ queryKey: [key, id] });
          }
        }
      }
      repoIds = new Set();
      fullInvalidate = false;
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
