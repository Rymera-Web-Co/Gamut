# Sync

Each repository row in the [sidebar](repositories.md) has inline **sync controls** for
fetching, pulling, and pushing — with live ahead/behind counts — without leaving the list.

## Controls

| Control | Runs | Notes |
| --- | --- | --- |
| **Fetch** | `git fetch --all --prune` | Updates knowledge of remote branches/tags; doesn't touch your working tree. Refreshes the ahead/behind counts. |
| **Pull** | `git pull` | Fetch + merge into the current branch. Shows an **ahead** badge when the remote has commits you don't. |
| **Push** | `git push` (or `git push --set-upstream origin <branch>` when there's no upstream yet) | Shows a **behind** badge when you have local commits the remote doesn't. |

While any one operation runs, all three buttons are disabled and a spinner shows, so you
can't kick off concurrent operations on the same repo. On success Gamut refreshes the
affected views (sync status, branches, log, review files); on failure the git error
surfaces as a toast.

The counts come from a local comparison of your branch against its upstream and are
refreshed after a fetch — so fetch first for accurate numbers.

## Behind the scenes

`src/features/sync/SyncControls.tsx` talks to `src-tauri/src/commands/sync.rs`. Key IPC
commands: `gitFetch`, `gitPull`, `gitPush`, `gitSyncStatus`. Network operations shell out
to the `git` CLI (see [Architecture](../ARCHITECTURE.md)).

---

See also: [Repositories](repositories.md) · [History](history.md) · [documentation hub](../README.md)
