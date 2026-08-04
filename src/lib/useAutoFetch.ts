import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import { runAutoPull } from "@/lib/autoPull";
import { ipc } from "@/lib/ipc";
import { patchRepoStatuses, refreshScopedRepos } from "@/lib/repoStatusRefresh";
import { useSettings } from "@/lib/settings";

/**
 * Periodically fetch every registered repo in the background so ahead/behind
 * counts and remote branch lists stay current without manual action (issue #41).
 *
 * After each batch fetch this hook drives the refresh **directly** — it patches
 * `repo-statuses` for the repos that fetched successfully and invalidates their
 * scoped git-derived queries (issue #275). It used to rely on the filesystem
 * watcher noticing the fetch's `refs/remotes` writes, but a sequential fetch
 * lands those refs more than the watcher's coalesce window apart, so each repo
 * became its own `repos-changed` round and one fetch cycle fanned out into
 * ~one status scan per repo. The watcher now treats `refs/remotes` writes as
 * non-interesting (`watch.rs::is_interesting`), so remote-ref churn no longer
 * wakes it; this explicit refresh replaces it, collapsing the cascade into a
 * single scoped round.
 *
 * A consequence: a *pure* `git fetch` run in a terminal no longer live-refreshes
 * ahead/behind, since its only filesystem signal is now-ignored remote-ref
 * writes. The backstop depends on where it runs: an external terminal leaves the
 * Gamut window unfocused, so `useRefreshOnFocus` (30s-stale) refreshes on the
 * next focus regain; an *integrated* terminal keeps the window focused, so the
 * next auto-fetch tick (this hook's interval) is what catches it up. Either way a
 * terminal `git pull`/commit/branch-switch touches local refs/HEAD/the working
 * tree and still refreshes live, and the group-header fetch button
 * (`useFetchGroup`) refetches `repo-statuses` itself.
 *
 * Each cycle also drives auto-pull (#299) for the repos that opted in: right
 * after the batch fetch, any enabled repo the fetch left behind its upstream is
 * fast-forwarded, and that happens *before* the refresh below so both land in the
 * same round.
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
        if (ids.length === 0) return;
        const results = await ipc.gitFetchMany(ids);
        const succeeded = results.filter((r) => r.ok).map((r) => r.repo_id);
        if (succeeded.length > 0) {
          // Auto-pull the opted-in repos this fetch found behind (#299) *before*
          // the refresh below, so the fast-forward is already applied when the
          // statuses are re-read. One refresh round then covers both the fetch
          // and the pull, instead of the pull kicking off a second scan on top of
          // this one (#206/#275). Awaited, not fired off: the `running` guard
          // keeps the next tick from overlapping this round's pulls. `repos` is
          // handed over so the round doesn't re-list them, and the `catch` keeps a
          // pull problem from ever costing this cycle its status refresh.
          await runAutoPull(succeeded, repos).catch(() => {});
          // Refresh the repos that actually fetched — patch their ahead/behind into
          // the `repo-statuses` aggregate and invalidate their scoped queries. This
          // drives the post-fetch refresh directly instead of via the watcher (#275).
          void patchRepoStatuses(succeeded);
          refreshScopedRepos(succeeded);
        }
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
