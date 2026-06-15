# History

The **History** tab (`⌘/Ctrl+2`) explores a repository's commit history: a rendered
commit graph on the left, and details for the selected commit — message, files, diffs,
and blame — on the right. It also hosts branch switching and stale-branch cleanup.

## The commit graph

Each commit row carries a graph drawing of the repository's branching structure:

- **Lanes** — each colored column is a line of development; circles are commits and lines
  show parent/child relationships. Straight lines are linear history; curves move between
  lanes (merges, branch points).
- **Ref labels** appear above the subject line:
  - **HEAD** — green badge, the currently checked-out commit.
  - **Branch** — local branch.
  - **Remote** — remote branch (e.g. `origin/main`), shown muted.
  - **Tag** — orange badge.

History is paginated (300 commits at a time); a **Load more** button fetches older
commits. The list scrolls virtually, so very large histories stay responsive.

## Filtering

The search box filters commits live by **message** or **author** (substring) or **SHA**
(prefix). The counter shows matches over total, e.g. `2 / 145`.

## Commit details

Click a commit to load its details on the right:

- Full commit message (rendered as markdown), author, timestamp, and the full SHA
  (click to copy).
- A header reading *"N files changed"*, followed by a file tree of everything the commit
  touched. Each file shows a status badge (**A**/**D**/**M**/**R**/**C**/**T**) and
  `+`/`−` line counts.

Click any file to open the **diff drawer**, which has two tabs:

- **Diff** — side-by-side old vs. new with syntax highlighting. Binary files show
  *"Binary file — diff not shown."*
- **Blame** — per-line attribution: commit SHA + author (on the first line of each hunk),
  line number, and source.

## Branch switcher

A dropdown in the repository header (labelled with the current branch, or *detached*):

- Filter branches and tags by name.
- **Local branches** first, then **remote**; the current branch has a checkmark; tags
  appear under a divider.
- Click any branch or tag to check it out. On success the history and all related views
  refresh. Checkout errors (e.g. uncommitted changes) show inline.

## Clean up stale branches

The **Clean up stale branches…** button (bottom of the branch switcher) finds local
branches whose upstream was deleted on the remote — typically after a PR merge.

1. Opening the dialog runs a prune fetch and lists candidates (the current branch and
   `main`/`master` are never listed).
2. Each row shows the branch name, its former upstream, and the last commit's SHA,
   subject, and age. All are pre-selected; uncheck any you want to keep, or use
   **Select all**.
3. **Delete N branch(es)** removes them. Partial failures are reported per-branch and
   left in the list to retry.

When nothing is stale: *"No stale branches — your local branches are all current."*

## Behind the scenes

`src/features/history/` talks to `src-tauri/src/commands/history.rs`. Key IPC commands:
`log` (paginated graph), `commit_detail`, `file_diff`, `blame`, `file_history`,
`listBranches`, `listGitTags`, `checkoutBranch`, `listStaleBranches`, `deleteBranches`.

---

See also: [Review](review.md) · [Sync](sync.md) · [Keyboard shortcuts](../keyboard-shortcuts.md) · [documentation hub](../README.md)
