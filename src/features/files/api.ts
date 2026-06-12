import { useQuery } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";

/** Children of one working-tree directory (lazy — fetched when a dir expands). */
export function useDirChildren(
  repoId: number | null,
  path: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["dir", repoId, path],
    queryFn: () => ipc.listDir(repoId!, path),
    enabled: repoId != null && enabled,
  });
}

/** Contents of the selected working-tree file. */
export function useFileContent(repoId: number | null, path: string | null) {
  return useQuery({
    queryKey: ["file", repoId, path],
    queryFn: () => ipc.readFile(repoId!, path!),
    enabled: repoId != null && path != null,
  });
}

/** Staged + unstaged changes, used to highlight changed files in the tree. */
export function useWorktreeStatus(repoId: number | null) {
  return useQuery({
    queryKey: ["worktree-status", repoId],
    queryFn: () => ipc.worktreeStatus(repoId!),
    enabled: repoId != null,
  });
}
