import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
  // Files tab: directory listings, open-file contents, and image previews.
  // Invalidation refetches only *active* queries, so just the displayed file
  // (or image) and the expanded dir listings actually reload; everything else
  // is merely marked stale for its next mount.
  "dir",
  "file",
  "image",
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
 *
 * Flushes are held while the Gamut window is unfocused (issue #273): the
 * integrated terminals and other local processes keep writing into watched
 * working trees, so `repos-changed` keeps firing and each flush spawns a git
 * status scan per changed repo — sustained background work macOS flags as
 * "Using Significant Energy," with nothing looking at the result. While hidden
 * we keep accumulating the changed repo ids (and the full-invalidate flag) but
 * hold the flush; on refocus we run a single coalesced round for everything
 * that piled up. Follows the same `onFocusChanged` pattern as
 * `useMainThreadWatchdog.ts` (#209) and `useTerminalSessions.ts` (#47).
 */
export function useGitWatch() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let repoIds = new Set<number>();
    let fullInvalidate = false;
    // Whether the Gamut window is focused. Assumed true until `isFocused()`
    // resolves so an event arriving before then isn't dropped.
    let focused = true;
    let disposed = false;
    // A live `onFocusChanged` event can arrive before the initial `isFocused()`
    // query resolves; once one has, it wins over the stale mount-time snapshot.
    let sawFocusEvent = false;
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

    // Schedule a coalesced flush — but only while focused. When unfocused we
    // still accumulate (above) and simply hold the flush until refocus.
    const schedule = () => {
      if (!focused) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, COALESCE_MS);
    };

    const unlisten = listen<number[] | null>("repos-changed", (event) => {
      if (event.payload == null) fullInvalidate = true;
      else for (const id of event.payload) repoIds.add(id);
      schedule();
    });

    const win = getCurrentWindow();
    void win
      .isFocused()
      .then((f) => {
        // A focus event already told us the live state — don't clobber it.
        if (disposed || sawFocusEvent) return;
        focused = f;
        // If we optimistically scheduled a flush before learning we're hidden,
        // hold it — the accumulated ids wait for refocus.
        if (!f && timer) {
          clearTimeout(timer);
          timer = null;
        }
      })
      .catch(() => {});
    const unlistenFocus = win.onFocusChanged(({ payload }) => {
      if (disposed) return;
      sawFocusEvent = true;
      focused = payload;
      if (payload) {
        // Refocus: run one coalesced round for whatever accumulated while hidden.
        // (`useRefreshOnFocus` also fires now and does a *full* stale round when
        // repo-statuses is >30s old; this scoped round covers the fresh case it
        // skips, so the two are complementary, not a missed refresh.)
        if (repoIds.size > 0 || fullInvalidate) {
          if (timer) clearTimeout(timer);
          timer = null;
          flush();
        }
      } else if (timer) {
        // Focus loss: hold the pending flush; its accumulated state waits.
        clearTimeout(timer);
        timer = null;
      }
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten.then((off) => off());
      void unlistenFocus.then((off) => off()).catch(() => {});
    };
  }, []);
}
