import { getCurrentWindow } from "@tauri-apps/api/window";
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
 *
 * The interval is paused while the Gamut window is unfocused (issue #273): a
 * full-fleet fetch spawns a `git` subprocess per repo and macOS flags the
 * sustained background work as "Using Significant Energy," yet nothing consumes
 * the fetched refs while the user is looking at another app (the UI refreshes
 * off the watcher, which resumes on focus). On refocus we run a single catch-up
 * fetch — but only when one was actually due (a full interval has elapsed since
 * the last tick), so a brief alt-tab away and back doesn't spawn a fresh
 * full-fleet fetch. This follows the same `onFocusChanged` pattern already used
 * by `useMainThreadWatchdog.ts` (#209) and `useTerminalSessions.ts` (#47).
 */
export function useAutoFetch() {
  const enabled = useSettings((s) => s.values.autoFetch);
  const intervalMinutes = useSettings((s) => s.values.autoFetchIntervalMinutes);

  useEffect(() => {
    if (!enabled) return;
    // Clamp to a sane floor so a corrupt/zero setting can't busy-loop the network.
    const minutes = Math.max(1, intervalMinutes || 0);
    const intervalMs = minutes * 60_000;

    let running = false;
    // Timestamp of the last tick's start. Initialised to mount time so the first
    // fetch still fires a full interval after mount (launch stays quiet) and a
    // refocus only catches up once a fetch is genuinely due. Persists across
    // focus-loss pauses so the elapsed check spans the whole time backgrounded.
    let lastTickAt = performance.now();
    let id: ReturnType<typeof setInterval> | undefined;
    let disposed = false;
    // A live `onFocusChanged` event can arrive before the initial `isFocused()`
    // query resolves; once one has, it wins over the stale mount-time snapshot.
    let sawFocusEvent = false;

    const tick = async () => {
      // Skip if a previous fetch is still in flight (a slow network shouldn't
      // stack overlapping batches).
      if (running) return;
      running = true;
      lastTickAt = performance.now();
      try {
        const repos = await ipc.listRepos();
        // Skip missing folders and non-git entries (nothing to fetch).
        const ids = repos.filter((r) => !r.missing && r.is_git_repo).map((r) => r.id);
        if (ids.length > 0) await ipc.gitFetchMany(ids);
      } catch {
        // Background fetch failures are non-fatal and stay silent — the manual
        // group fetch surfaces errors when the user explicitly asks for one.
      } finally {
        running = false;
      }
    };

    const start = () => {
      if (disposed || id !== undefined) return;
      id = setInterval(tick, intervalMs);
    };

    const stop = () => {
      if (id === undefined) return;
      clearInterval(id);
      id = undefined;
    };

    // Assume focused until proven otherwise, so the common case (already
    // focused) starts the interval without waiting on an async round-trip.
    start();

    const win = getCurrentWindow();
    void win
      .isFocused()
      .then((focused) => {
        // A focus event already told us the live state — don't clobber it.
        if (disposed || sawFocusEvent) return;
        if (!focused) stop();
      })
      .catch(() => {});
    const unlistenPromise = win.onFocusChanged(({ payload }) => {
      if (disposed) return;
      sawFocusEvent = true;
      if (payload) {
        // Refocus: catch up one fetch if a tick came due while unfocused (the
        // in-flight `running` guard inside tick() still prevents overlap), then
        // resume the interval.
        if (performance.now() - lastTickAt >= intervalMs) void tick();
        start();
      } else {
        stop();
      }
    });

    return () => {
      disposed = true;
      stop();
      void unlistenPromise.then((off) => off()).catch(() => {});
    };
  }, [enabled, intervalMinutes]);
}
