import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import { queryClient } from "@/lib/queryClient";
import { REPO_SCOPED_KEYS } from "@/lib/useGitWatch";

/**
 * How stale the repo-status data must be before a focus-regain forces a
 * refresh. Matches the global query `staleTime`, so a quick alt-tab away and
 * back doesn't trigger a full-fleet git scan, but a genuine gap does.
 */
const STALE_MS = 30_000;

/**
 * Refresh the git-derived queries when the Gamut window regains focus — a
 * recovery path for `repos-changed` watcher events that were missed or arrived
 * late (issue #227).
 *
 * The sidebar dirty dot and ahead/behind counts (`repo-statuses`), and the
 * repo-scoped queries, otherwise only refresh on a watcher event, a manual
 * fetch, or an in-app git mutation. A single missed event (e.g. a sleep/wake
 * FSEvents gap) then freezes those indicators at their last-scanned values
 * until the user fetches by hand — there is no other recovery.
 *
 * `refetchOnWindowFocus` is off globally because browser focus events are
 * unreliable in the Tauri webview, so this uses Tauri's `onFocusChanged` — the
 * same window-focus signal already used by `useMainThreadWatchdog.ts` and
 * `useTerminalSessions.ts`. Polling was rejected on purpose: a periodic
 * full-fleet status scan would reintroduce the git-status convoy (#89). The
 * refresh is gated on `repo-statuses` actually being stale so rapid focus flips
 * don't stampede scans, and the invalidation set mirrors the watcher's own
 * full-invalidate round.
 */
export function useRefreshOnFocus() {
  useEffect(() => {
    let disposed = false;

    const refreshIfStale = () => {
      const state = queryClient.getQueryState(["repo-statuses"]);
      // Fresh enough (a recent watcher round / fetch already covered it) — skip.
      if (state && Date.now() - state.dataUpdatedAt < STALE_MS) return;
      queryClient.invalidateQueries({ queryKey: ["repo-statuses"] });
      for (const key of REPO_SCOPED_KEYS) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    };

    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (disposed || !payload) return;
      refreshIfStale();
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((off) => off()).catch(() => {});
    };
  }, []);
}
