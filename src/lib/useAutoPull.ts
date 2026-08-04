import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import { runAutoPull } from "@/lib/autoPull";
import { patchRepoStatuses, refreshScopedRepos } from "@/lib/repoStatusRefresh";

/**
 * Shortest gap between two focus-driven auto-pull rounds. Mirrors
 * `useRefreshOnFocus`'s `STALE_MS` so a rapid alt-tab away and back is quiet,
 * and deliberately independent of the user's auto-fetch interval: this window is
 * about how often *focus* may trigger work, not about how fresh remote refs are.
 */
export const AUTO_PULL_MIN_GAP_MS = 30_000;

/**
 * Drives auto-pull (#299) from the two user-facing moments the issue calls for:
 * **app launch** and **window-focus regain** — "so you come back to up-to-date
 * checkouts". The third trigger, the background fetch cycle, lives in
 * `useAutoFetch` where it can fold into that cycle's existing refresh.
 *
 * Only repos the user opted in are touched, and only ever as a clean
 * fast-forward; `lib/autoPull.ts` and the backend own those rules.
 *
 * Focus discipline matches auto-fetch (#273): nothing runs while the window is
 * unfocused, so the app can't be caught doing background git work behind the
 * user's back (or tripping macOS's "Using Significant Energy"). Unlike the fetch
 * cycle there is no interval — a repo only gets pulled when the user is actually
 * coming back to the app, or when a fetch tick reveals it is behind.
 *
 * This hook starts **no fetch round of its own** — no `git_fetch`/`git_fetch_many`
 * — so launch never triggers a fleet-wide fetch the way a tick does, and stays as
 * quiet as `useAutoFetch` deliberately keeps it. (`git pull --ff-only` does fetch
 * the one repo it is pulling; that per-repo fetch is what keeps a launch/focus
 * round acting on current remote state.) Eligibility is decided in the backend
 * from the repo's own refs at pull time, never from the frontend's cached
 * `repo-statuses`, so a stale cached "behind" can't cause a wrong pull.
 *
 * Focus is checked when a round *starts*, not continuously: a round already under
 * way when the window loses focus finishes rather than being torn down mid-pull,
 * exactly as an in-flight `useAutoFetch` tick does.
 */
export function useAutoPull() {
  useEffect(() => {
    let disposed = false;
    // Time of the last round this hook started. Initialised a full gap in the
    // past so the launch round isn't suppressed by its own throttle.
    let lastRunAt = performance.now() - AUTO_PULL_MIN_GAP_MS;

    const run = () => {
      lastRunAt = performance.now();
      void runAutoPull().then((pulled) => {
        // Nothing moved — don't touch the query cache at all.
        if (disposed || pulled.length === 0) return;
        // Refresh exactly the repos that were fast-forwarded: patch their
        // ahead/behind into the `repo-statuses` aggregate and invalidate their
        // scoped queries. Never a full-fleet invalidation, which would run a git
        // scan of every repo (#206/#275).
        void patchRepoStatuses(pulled);
        refreshScopedRepos(pulled);
      });
    };

    // Launch: pull once, but only if the window is actually focused — starting
    // the app in the background shouldn't move anyone's branches.
    const win = getCurrentWindow();
    void win
      .isFocused()
      .then((focused) => {
        if (disposed || !focused) return;
        run();
      })
      .catch(() => {});

    const unlistenPromise = win.onFocusChanged(({ payload }) => {
      if (disposed || !payload) return;
      // Throttled so flipping between windows doesn't spawn a round per flip.
      if (performance.now() - lastRunAt < AUTO_PULL_MIN_GAP_MS) return;
      run();
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((off) => off()).catch(() => {});
    };
  }, []);
}
