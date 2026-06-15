# Repositories

The left **sidebar** is where you register, organise, and select repositories. Each repo
row shows its branch and inline [sync](sync.md) controls; pick a repo to make it active
across the Files, History, Review, and Pull Requests tabs. Toggle the sidebar with
`⌘/Ctrl+B`.

## Adding repositories

- **Register one** — the **+** button in the sidebar header opens a folder picker. Gamut
  verifies it's a git repo and reads its name and current branch.
- **Auto-discover** — the **scan** (folder-search) icon opens *Scan folder for
  repositories*. Pick a directory and Gamut recursively finds `.git` folders (up to 6
  levels deep). It shows how many repos exist and how many are new; already-registered
  ones are greyed out. Tick the repos to add.

## Organising with groups

- **Default group** holds every repo that isn't in a custom group.
- **Custom groups** organise repos logically. The vertical **group rail** shows each
  group as a button (icon or initials); the **+** at the bottom creates one. Drag a repo
  onto a group to assign it; drag groups to reorder them.
- A repo can belong to multiple groups; the **Group dialog** sets a group's name and icon.

### Folder-bound groups

A group can stay in sync with a folder on disk:

- Enable *Keep this group in sync with a folder* and choose the folder. Gamut scans it
  immediately and **auto-adds** repos that appear there later.
- The bound path is **immutable** once set — you can **Rescan now** or **Unbind** (which
  stops auto-sync but keeps the repos already in the group).

## Managing repos

- **Reorder** — drag the grip handle on a repo row; the order is saved.
- **Terminal** — `⌘/Ctrl+click` a repo name, or click the terminal icon on hover, to open
  an integrated [terminal](terminal.md) at that repo.
- **Remove** — the trash icon, after confirming. This only removes the repo from Gamut's
  list; **your files on disk are not touched.**
- **Missing repos** — folders that were moved or deleted show a red warning and a
  strikethrough name.

## Status

Repo status is polled periodically: the current branch shows in the inline switcher, and
ahead/behind counts appear on the [sync](sync.md) pull/push buttons.

## Behind the scenes

`src/features/repos/` talks to `src-tauri/src/commands/repo.rs`. Key IPC commands:
`registerRepo`, `removeRepo`, `listRepos`, `discoverRepos`, `reorderRepos`, `touchRepo`,
`repoStatuses`, plus the group commands `createGroup`, `updateGroup`, `deleteGroup`,
`bindGroupFolder`, `unbindGroupFolder`, `syncGroupFolder`, `reorderGroups`,
`setRepoGroups`, `listGroups`. Registered repos are stored in SQLite, and a filesystem
watcher keeps branch/commit state live (see [Architecture](../ARCHITECTURE.md)).

---

See also: [Sync](sync.md) · [Terminal](terminal.md) · [GitHub integration](github.md) · [documentation hub](../README.md)
