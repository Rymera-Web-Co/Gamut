import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { ipc, type SearchQuery } from "@/lib/ipc";

/** Children of one working-tree directory (lazy — fetched when a dir expands). */
export function useDirChildren(repoId: number | null, path: string, enabled: boolean) {
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

/** An image file loaded as a `data:` URL for inline preview. Only fires for the
 * image-preview path — `useFileContent` is disabled for images. */
export function useImageFile(repoId: number | null, path: string | null) {
  return useQuery({
    queryKey: ["image", repoId, path],
    queryFn: () => ipc.readImageFile(repoId!, path!),
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

/** Repo-wide content search. Runs only once `query` is non-null with a non-empty
 * term (the panel sets it on a debounce). Previous results stay visible while a
 * new query runs so the list doesn't flash empty. */
export function useRepoSearch(repoId: number | null, query: SearchQuery | null) {
  return useQuery({
    queryKey: ["repo-search", repoId, query],
    queryFn: () => ipc.searchRepo(repoId!, query!),
    enabled: repoId != null && query != null && query.query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
