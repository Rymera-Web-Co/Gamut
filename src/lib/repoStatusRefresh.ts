import { ipc, type RepoStatus } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";

/**
 * Query keys that carry a repo id as their second element (`[key, repoId]`),
 * so invalidation can be scoped to just the repos that changed instead of every
 * repo (#206).
 *
 * Lives here (rather than in `useGitWatch`) because two callers now drive the
 * same scoped refresh: the filesystem-watcher round (`useGitWatch`) and the
 * background auto-fetch (`useAutoFetch`, #275). `useGitWatch` re-exports it for
 * back-compat with existing importers.
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
  // Files tab: directory listings, open-file contents, and image previews.
  // Invalidation refetches only *active* queries, so just the displayed file
  // (or image) and the expanded dir listings actually reload; everything else
  // is merely marked stale for its next mount.
  "dir",
  "file",
  "image",
];

/**
 * All writes to the aggregate `repo-statuses` cache are chained behind the
 * previous one, so they apply in submission order. Without this, a second write
 * could start while an earlier scoped fetch is still in flight, and the older
 * response — resolving last — would overwrite the fresher patch.
 *
 * The chain is **module-level** so every writer serializes through it, not just
 * repeated rounds of a single hook: the watcher round (`useGitWatch`) and the
 * post-fetch refresh (`useAutoFetch`) can otherwise run concurrently (a commit
 * in a terminal landing while a background fetch is in flight), and the slower
 * scan response would clobber the fresher one (#275). Because it is
 * process-lifetime (never reset on unmount, unlike the old per-hook chain),
 * every round ends in a `.catch` that swallows failures: a single rejected
 * round must not poison the chain and silently kill all future refreshes.
 */
let aggregateChain: Promise<unknown> = Promise.resolve();

/**
 * Refresh the `repo-statuses` aggregate for exactly `ids`: fetch just those
 * repos' statuses (`repo_statuses_for`) and patch them into the cached
 * aggregate. `repo-statuses` is a single aggregate query with no per-repo
 * variant, so invalidating it would run a full-fleet git scan per round, which
 * on a busy fleet pegs the CPU with back-to-back scans; a scoped patch avoids
 * that. Chained onto {@link aggregateChain} so overlapping writers apply in
 * order.
 */
export function patchRepoStatuses(ids: number[]): Promise<unknown> {
  aggregateChain = aggregateChain
    .then(() => ipc.repoStatusesFor(ids))
    .then((fresh) => {
      queryClient.setQueryData<RepoStatus[]>(["repo-statuses"], (prev) => {
        // No cached aggregate yet — leave it to the full query.
        if (!prev) return prev;
        const byId = new Map(fresh.map((s) => [s.id, s]));
        return prev.map((s) => byId.get(s.id) ?? s);
      });
    })
    .catch(() =>
      // Scoped refresh failed; fall back to the full scan.
      queryClient.invalidateQueries({ queryKey: ["repo-statuses"] }),
    )
    // Never let a failed round reject the shared chain (see above).
    .catch(() => {});
  return aggregateChain;
}

/**
 * Full-fleet `repo-statuses` invalidation (a git scan of every repo), chained
 * onto {@link aggregateChain} so it orders against scoped patches — used when
 * the changed scope can't be narrowed down.
 */
export function invalidateRepoStatuses(): Promise<unknown> {
  aggregateChain = aggregateChain
    .then(() => queryClient.invalidateQueries({ queryKey: ["repo-statuses"] }))
    // Never let a failed round reject the shared chain (see above).
    .catch(() => {});
  return aggregateChain;
}

/**
 * Invalidate the per-repo scoped queries for each of `ids`. Invalidation
 * refetches only *active* queries, so most of these are merely marked stale for
 * their next mount; only the currently-displayed repo's queries actually
 * refetch.
 */
export function refreshScopedRepos(ids: number[]): void {
  for (const id of ids) {
    for (const key of REPO_SCOPED_KEYS) {
      queryClient.invalidateQueries({ queryKey: [key, id] });
    }
  }
}
