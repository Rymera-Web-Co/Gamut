import { useEffect } from "react";

import { ipc } from "@/lib/ipc";
import { useSettings } from "@/lib/settings";

/**
 * Periodically fetch every registered repo in the background so ahead/behind
 * counts and remote branch lists stay current without manual action (issue #41).
 *
 * The fetch only updates `.git/refs/remotes` + `FETCH_HEAD`, which the
 * filesystem watcher (`watch.rs` → `repos-changed`) already treats as
 * interesting — so `useGitWatch` invalidates the git-derived queries and the UI
 * refreshes naturally; this hook deliberately doesn't touch the query cache.
 *
 * Missing repos are skipped (the backend also guards this). Fetches run on a
 * configurable interval; the first one fires after the interval, not on mount,
 * to keep launch quiet.
 */
export function useAutoFetch() {
  const enabled = useSettings((s) => s.values.autoFetch);
  const intervalMinutes = useSettings((s) => s.values.autoFetchIntervalMinutes);

  useEffect(() => {
    if (!enabled) return;
    // Clamp to a sane floor so a corrupt/zero setting can't busy-loop the network.
    const minutes = Math.max(1, intervalMinutes || 0);

    let running = false;
    const tick = async () => {
      // Skip if a previous fetch is still in flight (a slow network shouldn't
      // stack overlapping batches).
      if (running) return;
      running = true;
      try {
        const repos = await ipc.listRepos();
        const ids = repos.filter((r) => !r.missing).map((r) => r.id);
        if (ids.length > 0) await ipc.gitFetchMany(ids);
      } catch {
        // Background fetch failures are non-fatal and stay silent — the manual
        // group fetch surfaces errors when the user explicitly asks for one.
      } finally {
        running = false;
      }
    };

    const id = setInterval(tick, minutes * 60_000);
    return () => clearInterval(id);
  }, [enabled, intervalMinutes]);
}
