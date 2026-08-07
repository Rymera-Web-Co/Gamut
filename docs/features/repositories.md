# Repositories

The repository sidebar is where Gamut keeps track of every git project you work on, so
you can jump between them with a click instead of hunting through folders on disk. The
left **sidebar** lists your registered repos; each row shows its branch and inline
[sync](sync.md) controls, and picking a repo makes it active across the Files, History,
Review, and Pull Requests tabs. Toggle the sidebar with `⌘/Ctrl+B`.

## Adding repositories

- **Register one** — click the **+** button in the sidebar header to open a folder
  picker. Gamut checks that the folder is a git repository and reads its name and
  current branch.
- **Auto-discover** — click the **scan** (folder-search) icon to open *Scan folder for
  repositories*. Pick a directory and Gamut searches through it (up to 6 folder levels
  deep) for git repositories. It shows how many it found and how many are new to Gamut;
  repos you've already added appear greyed out. Tick the ones you want to add.

## Organising with groups

- **Default group** holds every repo that isn't in a custom group.
- **Custom groups** let you organise repos however makes sense to you — by client,
  project, or anything else. The vertical **group rail** shows each group as a button
  (an icon or initials); the **+** at the bottom creates a new one. Drag a repo onto a
  group to add it there, and drag groups to reorder them.
- A repo can belong to more than one group at once; the **Group dialog** sets a group's
  name and icon.

### Folder-bound groups

A group can stay in sync with a folder on disk:

- Enable *Keep this group in sync with a folder* and choose the folder. Gamut scans it
  right away, and any repos that later show up in that folder get **added
  automatically**.
- The bound folder can't be changed once set — but you can **Rescan now** to pick up new
  repos, or **Unbind** to stop the automatic syncing (this keeps the repos already in the
  group).

## Managing repos

- **Reorder** — drag the grip handle on a repo row; Gamut remembers the new order.
- **Terminal** — click the terminal icon that appears on hover to open an integrated
  [terminal](terminal.md) at that repo.
- **Select multiple** — `⌘/Ctrl+click` a repo row to toggle it into or out of the
  selection; `⇧+click` selects every row in between (in on-screen order, spanning the
  git-repos and Folders sections). A row's leading icon swaps for a checkbox on hover or
  while selected, so you can select without reaching for a modifier key.
- **Bulk actions** — as soon as anything is selected, the sidebar header turns into a
  bulk-action bar: how many rows are selected, a checkbox to select or deselect them all,
  and icon buttons to **clear** the selection, **pull** it, **push** it, or **remove** it.
  Pull and push skip what can't be synced — missing folders and plain (non-git) folders —
  and each button's tooltip names the number it will actually act on. One repo failing
  never stops the rest; you get a single summary either way. Clearing the selection brings
  the normal header back. (Fetching stays group-wide: the header's fetch button already
  covers every repo in the group.)
- **Remove** — click the trash icon and confirm. With multiple repos selected, the row's
  trash icon, the bar's remove button, or *Remove N repository folders* from the
  right-click menu all remove the whole selection behind one confirmation dialog listing
  every folder and its path. This only removes them from Gamut's list; **your files on
  disk are not touched.**
- **Missing repos** — if a folder was moved or deleted, its repo shows a red warning and
  a strikethrough name.

## Status

Gamut checks each repo's status periodically: the current branch shows in the inline
switcher, and how many commits you're ahead or behind appear on the
[sync](sync.md) pull/push buttons.

## Behind the scenes

*For contributors — where this feature lives in the code.*

`src/features/repos/` talks to `src-tauri/src/commands/repo.rs`. Key IPC commands:
`registerRepo`, `removeRepos`, `listRepos`, `discoverRepos`, `reorderRepos`, `touchRepo`,
`repoStatuses`, plus the batch sync commands `gitPullMany` / `gitPushMany` (in
`src-tauri/src/commands/sync.rs`) and the group commands `createGroup`, `updateGroup`,
`deleteGroup`, `bindGroupFolder`, `unbindGroupFolder`, `syncGroupFolder`, `reorderGroups`,
`setRepoGroups`, `listGroups`. Registered repos are stored in SQLite, and a filesystem
watcher keeps branch/commit state live (see [Architecture](../ARCHITECTURE.md)).

---

See also: [Sync](sync.md) · [Terminal](terminal.md) · [GitHub integration](github.md) · [documentation hub](../README.md)
