# Repo watcher resync

Covers `watch::resync` in `src-tauri/src/watch.rs` — the filesystem watcher
setup that runs on app startup and whenever a repo/group is added, removed, or
folder-bound. See issue #225: with enough registered repos this used to wedge
the main thread indefinitely (each per-directory watch on macOS does a
synchronous `FSEventStreamCreate`).

## Reproduce the hang (pre-fix) / confirm it's gone (post-fix)

Needs a Gamut database with a large repo fleet — 50+ repos with normal
directory depth is enough to make the pre-fix hang obvious within seconds.

1. Build the app: `cd src-tauri && cargo build`.
2. Launch the built binary directly against your real Gamut data, so it uses
   your actual `gamut.db`: `./target/debug/gamut`.
3. In a separate terminal, find the PID and watch CPU:
   `ps -o pid,pcpu,etime,command -p <pid>`.
4. Take a stack sample to see what the main thread is doing:
   `sample <pid> 3 -f /tmp/sample.txt`, then
   `grep -A5 "com.apple.main-thread" /tmp/sample.txt`.

Expected (fixed): CPU spikes briefly then settles to idle (single-digit %)
within a couple of minutes even with a large repo fleet, and every stack
sample of the main thread shows it inside the normal Cocoa run loop
(`mach_msg` / `__CFRunLoopServiceMachPort`), never inside
`gamut_lib::watch::resync`. The same `FSEventStreamCreate` work still happens
(that part isn't free), but it happens on a `tokio-rt-worker` thread, not the
main thread — confirm by grepping the sample for `watch::resync`, which should
only ever appear under a `tokio-rt-worker` thread header, never under
`com.apple.main-thread`.

Regressed (bug is back): CPU stays pegged near 100% indefinitely, the window
never becomes responsive, and every sample of `com.apple.main-thread` shows it
stuck in `gamut_lib::watch::resync -> RepoWatcher::sync -> FsEventWatcher::watch`.

## Functional check

After the app settles, confirm the watcher still works (this fix only changes
which thread it runs on, not what it does):

1. In a repo Gamut has open, make a commit or switch branches from an external
   terminal.
2. Confirm Gamut's UI picks up the change within the debounce window
   (`pref.watchDebounceMs`, default 400ms) without a manual refresh.
3. Add a new repo via the UI and confirm its working tree starts being watched
   (repeat step 1 for the new repo).

## Ordering under overlapping resyncs

`resync` now runs its rebuild on a background task, so two triggers close
together (e.g. bind-a-folder immediately followed by its initial scan, or a
bulk multi-repo import via the discover dialog) can race. `resync_locked`
re-reads the DB fresh only after acquiring `AppState::resync_lock`, so
whichever rebuild finishes last always reflects the current DB state rather
than a stale pre-lock snapshot.

1. Bulk-add several repos at once (the discover/import flow that registers
   many repos in a loop).
2. Once the app settles, confirm every added repo is actually being watched:
   repeat the "make a commit externally, confirm the UI picks it up" check
   from the functional check above for each of the newly added repos, not
   just the first or last one.

Regressed (the ordering bug is back): one or more of the repos added in the
same batch never reflects external changes until some unrelated repo
operation happens to trigger another resync.
