# History

The **History** tab (`⌘/Ctrl+2`) lets you look back through everything that has happened
in a repository — every saved change (a **commit**), who made it, and what it touched. Use
it to track down when a bug was introduced, review someone else's work, or just see how a
project evolved. It shows a visual graph of that history on the left, with details for the
selected commit — message, files, diffs, and blame — on the right, and it also handles
switching branches and cleaning up ones that are no longer needed.

## The commit graph

Next to each commit is a small graph showing how it fits into the project's branching
structure:

- **Lanes** — each colored column represents one line of development (for example, a
  feature branch running alongside the main line of work). Circles are commits, and the
  lines connecting them show which commit came from which. Straight lines mean simple,
  linear history; curves show where a line split off or merged back in.
- **Ref labels** appear above the commit's message:
  - **HEAD** — green badge marking whichever commit you currently have checked out (the
    one your working files are currently set to).
  - **Branch** — a local branch pointing at that commit.
  - **Remote** — a branch that lives on the shared remote server (e.g. `origin/main`),
    shown muted.
  - **Tag** — orange badge, a named marker on that commit (often used for releases).

History loads 300 commits at a time; a **Load more** button fetches older ones. The list
scrolls virtually, meaning only the rows you can actually see are rendered, so even huge
histories stay responsive.

## Filtering

The search box filters the commit list as you type, matching **message** or **author**
text anywhere in the field, or the start of a commit's **SHA** (its unique ID). A counter
shows matches out of the total, e.g. `2 / 145`.

## Commit details

Click a commit to load its details on the right:

- Its full message (rendered as markdown), author, timestamp, and full SHA (click to
  copy).
- A header reading *"N files changed"*, followed by a file tree of everything that commit
  touched. Each file shows a status badge (**A**/**D**/**M**/**R**/**C**/**T** — added,
  deleted, modified, renamed, copied, type-changed) and `+`/`−` line counts.

Click any file to open the **diff drawer**, which has two tabs:

- **Diff** — the old and new versions side by side, with syntax highlighting, so you can
  see exactly what changed. Binary (non-text) files show *"Binary file — diff not
  shown."*
- **Blame** — shows, for every line, which commit and author last changed it (labelled at
  the start of each run of lines that share the same commit), plus the line number and
  the line itself.

## Branch switcher

A dropdown in the repository header shows the name of the branch you're currently on — or
*detached* if you've checked out a specific commit instead of a branch, so there's no
branch name to display:

- Filter branches and tags by name.
- **Local branches** (the ones on your machine) are listed first, then **remote** ones
  (the ones on the shared server); the current branch has a checkmark, and tags appear
  below a divider.
- Click any branch or tag to check it out — switch your working files to match it. On
  success the history and all related views refresh. Checkout errors (e.g. uncommitted
  changes in the way) show inline.

## Clean up stale branches

The **Clean up stale branches…** button (at the bottom of the branch switcher) finds
local branches whose counterpart on the remote server has already been deleted —
typically because a pull request was merged and its branch cleaned up afterward.

1. Opening the dialog checks with the remote server for the latest state and lists the
   candidates (the branch you're currently on, and `main`/`master`, are never listed).
2. Each row shows the branch name, the remote branch it used to follow, and its last
   commit's SHA, subject, and age. All are pre-selected; uncheck any you'd rather keep, or
   use **Select all**.
3. **Delete N branch(es)** removes them. If any fail to delete, those are reported
   individually and left in the list so you can retry.

When nothing is stale: *"No stale branches — your local branches are all current."*

## Behind the scenes

*For contributors — where this feature lives in the code.*

`src/features/history/` talks to `src-tauri/src/commands/history.rs`. Key IPC commands:
`log` (paginated graph), `commit_detail`, `file_diff`, `blame`, `file_history`,
`listBranches`, `listGitTags`, `checkoutBranch`, `listStaleBranches`, `deleteBranches`.

---

See also: [Review](review.md) · [Sync](sync.md) · [Keyboard shortcuts](../keyboard-shortcuts.md) · [documentation hub](../README.md)
