import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import { queryClient } from "@/lib/queryClient";

/**
 * Listen for the backend's `repos-changed` event (emitted when a watched repo's
 * working tree changes outside the app — a branch switch or commit in a
 * terminal, or a file edited in another editor/IDE) and refetch the
 * git-derived queries so the UI stays live.
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
