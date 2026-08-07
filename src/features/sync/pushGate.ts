import { ipc } from "@/lib/ipc";

/**
 * The branch this push would *publish* — create on `origin` for the first time —
 * or `null` when it's an ordinary push to a branch that already tracks (#300).
 *
 * Resolved at press time rather than read off the cached fleet status, because
 * the cache is stale in exactly the flow this guard exists for: creating a
 * branch and immediately pushing it. `BranchSwitcher` deliberately leaves
 * `repo-statuses` to the filesystem watcher's coalesced round, so a freshly
 * created branch still looks like the old one for a moment — long enough to
 * publish it without being asked. `git_sync_status` is the cheap per-repo call
 * (no working-tree diff), and it reports the same value `git_push` acts on.
 *
 * A failure to determine it is not a reason to block the push: fall through to
 * the ordinary path and let the push itself report whatever is wrong.
 */
export async function branchAwaitingPublish(repoId: number): Promise<string | null> {
  try {
    return (await ipc.gitSyncStatus(repoId)).unpublished_branch;
  } catch {
    return null;
  }
}
