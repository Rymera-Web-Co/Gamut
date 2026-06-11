import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import { queryClient } from "@/lib/queryClient";

/**
 * Listen for the backend's `repos-changed` event (emitted when a watched repo's
 * `.git` changes outside the app — e.g. a branch switch or commit in a terminal)
 * and refetch the git-derived queries so the UI stays live.
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
    ];
    const unlisten = listen("repos-changed", () => {
      for (const key of keys) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);
}
