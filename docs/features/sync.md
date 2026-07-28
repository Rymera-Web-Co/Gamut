# Sync

Sync keeps your local copy of a repository in step with the shared version on GitHub (or
wherever your remote lives): pulling down changes other people made, and pushing up your
own, all without opening a terminal. Each repository row in the
[sidebar](repositories.md) has inline **sync controls** for fetching, pulling, and pushing
— with live counts of how far ahead or behind you are — without leaving the list.

## Controls

| Control | Runs | Notes |
| --- | --- | --- |
| **Fetch** | `git fetch --all --prune` | Checks the remote (the shared copy of the repository, e.g. on GitHub) for new branches and tags, and updates what Gamut knows about them — without touching any of your own files. Refreshes the ahead/behind counts. |
| **Pull** | `git pull` | Fetches, then merges those remote changes into your current branch. Shows a **behind** badge when the remote has commits you don't have yet. |
| **Push** | `git push` (or `git push --set-upstream origin <branch>` when there's no upstream yet) | Sends your local commits to the remote. Shows an **ahead** badge when you have local commits the remote doesn't have yet. |

While any one of these is running, all three buttons are disabled and a spinner shows, so
you can't start two operations on the same repository at once. If it succeeds, Gamut
refreshes everything affected (sync status, branches, log, review files); if it fails, the
git error appears as a toast — a brief pop-up notification in the corner of the window.

The ahead/behind counts come from comparing your branch against its upstream — the remote
branch it's linked to and tracks — using information already stored locally. They're
refreshed after a fetch, so fetch first if you want accurate numbers.

## Behind the scenes

*For contributors — where this feature lives in the code.*

`src/features/sync/SyncControls.tsx` talks to `src-tauri/src/commands/sync.rs`. Key IPC
commands: `gitFetch`, `gitPull`, `gitPush`, `gitSyncStatus`. Network operations shell out
to the `git` CLI (see [Architecture](../ARCHITECTURE.md)).

---

See also: [Repositories](repositories.md) · [History](history.md) · [documentation hub](../README.md)
