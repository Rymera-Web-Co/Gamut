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
- **Terminal** — `⌘/Ctrl+click` a repo name, or click the terminal icon that appears on
  hover, to open an integrated [terminal](terminal.md) at that repo.
- **Remove** — click the trash icon and confirm. This only removes the repo from
  Gamut's list; **your files on disk are not touched.**
- **Missing repos** — if a folder was moved or deleted, its repo shows a red warning and
  a strikethrough name.

## Status

Gamut checks each repo's status periodically: the current branch shows in the inline
switcher, and how many commits you're ahead or behind appear on the
[sync](sync.md) pull/push buttons.

## Behind the scenes

*For contributors — where this feature lives in the code.*

`src/features/repos/` talks to `src-tauri/src/commands/repo.rs`. Key IPC commands:
`registerRepo`, `removeRepo`, `listRepos`, `discoverRepos`, `reorderRepos`, `touchRepo`,
`repoStatuses`, plus the group commands `createGroup`, `updateGroup`, `deleteGroup`,
`bindGroupFolder`, `unbindGroupFolder`, `syncGroupFolder`, `reorderGroups`,
`setRepoGroups`, `listGroups`. Registered repos are stored in SQLite, and a filesystem
watcher keeps branch/commit state live (see [Architecture](../ARCHITECTURE.md)).

---

See also: [Sync](sync.md) · [Terminal](terminal.md) · [GitHub integration](github.md) · [documentation hub](../README.md)
