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

## Auto-pull

Some repositories you only ever *consume* — a shared library, a docs repo, a config repo you
never commit to. For those, clicking **Pull** every time Gamut tells you they're behind is
busywork. **Auto-pull** does it for you.

Turn it on per repository: **right-click the repository in the sidebar → Auto-pull**. The item
shows the current state (`Auto-pull: on` / `Auto-pull: off`); it's **off** for every repository
until you switch it on, and it's remembered between launches. It's deliberately per repository
rather than per group, because a group usually mixes repos you commit to with repos you don't.

An enabled repository is brought up to date at these moments:

- **When you come back to Gamut** — on launch, and when the window regains focus (at most once
  every 30 seconds, so flipping between apps doesn't cause a flurry of git activity).
- **On the background fetch cycle** — whenever the periodic auto-fetch finds the repository has
  fallen behind, it's fast-forwarded right away.

No new round starts while the window is in the background, the same rule the background fetch
follows (a round already under way when you switch away finishes rather than stopping
half-done).

### It will only ever fast-forward

Auto-pull is deliberately timid. It moves your branch forward only when doing so cannot lose or
reshape any work — that is, when the working tree is clean and your branch is purely *behind*
its upstream. Fast-forwarding then just replays the commits you were missing.

In every other case it **does nothing and tells you why** (a small toast, nothing blocking):

| Situation | What auto-pull does |
| --- | --- |
| Behind, clean working tree | Fast-forwards, and shows the same one-line summary as a manual pull |
| Uncommitted changes | Skips — your work is left exactly as it is. It never stashes |
| Branch has diverged (you have local commits *and* there are new remote ones) | Skips — it never creates a merge commit and never rebases |
| No upstream branch (or a detached HEAD) | Skips — there's nothing to pull from |
| Not behind | Nothing to do, and nothing to report |
| The pull itself fails (no network, a `post-merge` hook fails, …) | Reports the problem; your branch is wherever git left it |

Those skipped cases are yours to resolve, exactly as they are today: commit or stash your work,
or pull by hand and decide how to reconcile the histories. A warning is shown once per
repository per reason, not on every cycle, and it comes back if the reason changes or recurs
after a successful pull.

The fast-forward-only rule is enforced by git itself (`git pull --ff-only`), not just by the
check beforehand — so even if the remote moves on mid-pull, the worst outcome is that nothing
happens. Auto-pull also disables git's autostash for its own pulls, so a repository that
becomes dirty *while* the pull is running is still left untouched rather than stashed, and it
never updates submodules on your behalf.

## Behind the scenes

*For contributors — where this feature lives in the code.*

`src/features/sync/SyncControls.tsx` talks to `src-tauri/src/commands/sync.rs`. Key IPC
commands: `gitFetch`, `gitPull`, `gitPush`, `gitSyncStatus`. Network operations shell out
to the `git` CLI (see [Architecture](../ARCHITECTURE.md)).

Auto-pull is `src/lib/autoPull.ts` (the engine — candidate selection, one-line summaries,
de-duplicated warnings) driven by `src/lib/useAutoPull.ts` (launch + focus) and by
`src/lib/useAutoFetch.ts` (the fetch cycle, where it folds into that cycle's single status
refresh). The safety decision lives in the backend's `git_pull_ff_many`, which reuses the same
ahead/behind logic as `git_sync_status` and the same "is it dirty" check as the sidebar's dirty
dot, and runs `git pull --ff-only` — so a fast-forward is the only outcome git will allow, even
if the upstream moves between the check and the pull. The opt-in itself is the `repos.auto_pull`
column, set via `set_repo_auto_pull`.

---

See also: [Repositories](repositories.md) · [History](history.md) · [documentation hub](../README.md)
