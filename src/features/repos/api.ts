import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";
import { toast } from "@/store/toast";

const keys = {
  repos: ["repos"] as const,
  groups: ["groups"] as const,
};

export function useRepos() {
  return useQuery({ queryKey: keys.repos, queryFn: ipc.listRepos });
}

export function useGroups() {
  return useQuery({ queryKey: keys.groups, queryFn: ipc.listGroups });
}

export function useRepoStatuses() {
  return useQuery({
    queryKey: ["repo-statuses"],
    queryFn: ipc.repoStatuses,
    staleTime: 30_000,
  });
}

/**
 * The repo's linked worktrees (main checkout excluded). Kept live by the
 * watcher: `git worktree add/remove` touches `.git/worktrees/`, which emits
 * `repos-changed` and invalidates `["linked-worktrees", repoId]` (scoped, see
 * useGitWatch).
 */
export function useLinkedWorktrees(repoId: number, enabled = true) {
  return useQuery({
    queryKey: ["linked-worktrees", repoId],
    queryFn: () => ipc.gitWorktreeList(repoId),
    staleTime: 30_000,
    enabled,
    select: (worktrees) => worktrees.filter((w) => !w.is_main),
  });
}

/**
 * The browser-openable https URL of a repo's `origin` remote, resolved lazily
 * for the repo sidebar's "Open remote repo" context-menu item. `null` when the
 * repo has no resolvable remote, so the caller hides the item.
 */
export function useRepoRemoteUrl(repoId: number | null, enabled = true) {
  return useQuery({
    queryKey: ["repo-remote-url", repoId],
    queryFn: () => ipc.repoRemoteUrl(repoId!),
    enabled: enabled && repoId != null,
    staleTime: 5 * 60_000,
  });
}

/** Git-derived query keys that a fetch can make stale (ahead/behind, branches…). */
const GIT_QUERY_KEYS = [
  "repo-statuses",
  "branches",
  "git-tags",
  "log",
  "review-files",
  "sync-status",
] as const;

/**
 * Fetch every repo in a group at once (the group-header fetch button). One repo
 * failing doesn't abort the rest — the backend returns a per-repo result list,
 * and any failures are surfaced as a single toast. Callers pass already-filtered
 * IDs (missing repos excluded).
 */
export function useFetchGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (repoIds: number[]) => {
      const results = await ipc.gitFetchMany(repoIds);
      // Keep the button spinning until the ahead/behind counts actually reflect
      // the fetch. `repo_statuses` is a gated full-fleet scan that lands a few
      // seconds after the fetch resolves; refetch it *inside* the mutation and
      // await it, so `isPending` (and the spinner) stays true until the counts
      // update instead of clearing the instant the fetch returns.
      await qc.refetchQueries({ queryKey: ["repo-statuses"] });
      return results;
    },
    onSuccess: (results) => {
      // The remaining git-derived views don't gate the spinner — refresh them
      // in the background. `repo-statuses` was already refetched above.
      for (const key of GIT_QUERY_KEYS) {
        if (key === "repo-statuses") continue;
        qc.invalidateQueries({ queryKey: [key] });
      }
      const failed = results.filter((r) => !r.ok);
      const fetched = results.length - failed.length;
      if (failed.length === 0) {
        toast.success(fetched === 1 ? "Fetched 1 repository" : `Fetched ${fetched} repositories`);
      } else {
        toast.error(`Fetched ${fetched} of ${results.length} — ${failed.length} failed`);
      }
    },
  });
}

/** Invalidate everything the sidebar tree depends on. */
function useInvalidateTree() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: keys.repos });
    qc.invalidateQueries({ queryKey: keys.groups });
  };
}

export function useRegisterRepo() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (path: string) => ipc.registerRepo(path),
    onSuccess: invalidate,
  });
}

/** Remove one or more repos in a single IPC round trip (not once per repo). */
export function useRemoveRepos() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (ids: number[]) => ipc.removeRepos(ids),
    onSuccess: invalidate,
  });
}

/**
 * Flip a repo's background auto-pull opt-in (#299). The flag lives on the repo
 * row, so the repos query is invalidated to re-read it — that query is what the
 * auto-pull engine and the sidebar's menu both read the flag from.
 *
 * A failed write is surfaced: the menu closes on click, so without a toast the
 * toggle would appear to have taken effect when it hadn't — and this flag is what
 * licenses background writes to the repo's working tree.
 */
export function useSetRepoAutoPull() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ repoId, enabled }: { repoId: number; enabled: boolean }) =>
      ipc.setRepoAutoPull(repoId, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.repos }),
    onError: (e: unknown) => toast.error(`Could not change auto-pull: ${String(e)}`),
  });
}

export function useCreateGroup() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: ({
      name,
      icon,
      folderPath = null,
    }: {
      name: string;
      icon: string | null;
      folderPath?: string | null;
    }) => ipc.createGroup(name, icon, null, folderPath),
    // A folder-bound group runs its initial scan right after creation so its
    // repos appear immediately; manual groups skip straight to invalidation.
    onSuccess: async (group) => {
      if (group.folder_path) {
        try {
          await ipc.syncGroupFolder(group.id);
        } catch {
          // Initial scan failure is non-fatal — the watcher will still pick up
          // repos as they appear; surface nothing here.
        }
      }
      invalidate();
    },
  });
}

export function useSyncGroupFolder() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (groupId: number) => ipc.syncGroupFolder(groupId),
    onSuccess: invalidate,
  });
}

/** First-bind an existing group to a folder, then run its initial scan. */
export function useBindGroupFolder() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: async ({ id, folderPath }: { id: number; folderPath: string }) => {
      await ipc.bindGroupFolder(id, folderPath);
      return ipc.syncGroupFolder(id);
    },
    onSuccess: invalidate,
  });
}

export function useUnbindGroupFolder() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (id: number) => ipc.unbindGroupFolder(id),
    onSuccess: invalidate,
  });
}

export function useUpdateGroup() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: ({ id, name, icon }: { id: number; name: string | null; icon: string | null }) =>
      ipc.updateGroup(id, name, icon),
    onSuccess: invalidate,
  });
}

export function useDeleteGroup() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (id: number) => ipc.deleteGroup(id),
    onSuccess: invalidate,
  });
}

export function useReorderRepos() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (repoIds: number[]) => ipc.reorderRepos(repoIds),
    onSuccess: invalidate,
  });
}

export function useReorderGroups() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (groupIds: number[]) => ipc.reorderGroups(groupIds),
    onSuccess: invalidate,
  });
}

export function useSetRepoGroups() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: ({ repoId, groupIds }: { repoId: number; groupIds: number[] }) =>
      ipc.setRepoGroups(repoId, groupIds),
    onSuccess: invalidate,
  });
}
