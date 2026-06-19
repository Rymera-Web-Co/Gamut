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
 * Listen for the backend's `repos-changed` event (emitted when a watched repo's
 * working tree changes outside the app — a branch switch or commit in a
 * terminal, or a file edited in another editor/IDE) and refetch the
 * git-derived queries so the UI stays live. Bursts are coalesced so one storm
 * of events triggers one invalidation round rather than many.
 */
export function useGitWatch() {
  useEffect(() => {
    const keys = [
      "repo-statuses",
      "branches",
      "git-tags",
      "log",
      "review-files",
      "worktree-status",
      "worktree-file-diff",
      "stash-list",
      "sync-status",
      // Files tab: directory listings and open-file contents.
      "dir",
      "file",
    ];

    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      for (const key of keys) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    };

    const unlisten = listen("repos-changed", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, COALESCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unlisten.then((off) => off());
    };
  }, []);
}
