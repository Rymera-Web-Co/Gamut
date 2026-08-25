# Review

Review is where you look over changes before they go any further — your own edits before
committing them, or someone else's pull request before merging it. Gamut has two review
workflows: **local self-review** of your own changes (the Review tab, `⌘/Ctrl+3`) and
**GitHub pull-request review** (the Pull Requests tab, `⌘/Ctrl+4`).

## Local self-review

A toggle at the top switches between two views of what's changed:

- **Working tree** — the files as they currently are on disk, including edits you haven't
  committed yet, whether or not you've staged them (more on staging below).
- **Branch vs base** — your current branch compared against its base branch, the branch
  yours will merge into (`trunk`/`main`/`master`, either your local copy or the one on
  your remote — `origin`, usually GitHub).

If you have no uncommitted changes but your branch differs from its base, Gamut shows
*Branch vs base* by default. The diff header reads `<base> → <head> · N file(s)`.

The file list shows each changed file with a count of lines added (`+`) and removed
(`−`), plus a badge for what happened to it — Added, Modified, Deleted, or Renamed
(A/M/D/R). Click a file to see a read-only diff: the old and new versions side by side,
with what changed highlighted. Binary files (images and the like) can't be shown this way,
so you'll see *"Binary file — diff not shown."*

### Staging, committing, stashing (working tree)

- **Changes** (files you've edited but haven't staged) and **Staged** (files marked to go
  into your next commit) appear in separate sections. Hover a file to **stage** it (`+`),
  **unstage** it (`−`), or **Undo** it — this discards the edit, and Gamut asks you to
  confirm first. Section headers offer *Stage all*, *Unstage all*, and *Discard all* to do
  the same to every file at once.
- **Commit** — save a snapshot of your staged changes, with a short message describing
  what you did. Type the message and click **Commit N file(s)**, or press
  `⌘/Ctrl+Enter`.
- **Stash** — set changes aside temporarily without committing them (optionally with a
  message, and including untracked files — new files git isn't tracking yet). From the
  stash list you can **pop** a stash (bring it back and remove it from the list), **apply**
  it (bring it back but keep it in the list), or **drop** it (delete it without
  restoring).
- **Edit** a file that hasn't been deleted to jump to it in the [Files](files.md) editor.

When there's nothing to review: *"Working tree clean."*

### Inline comments on a branch

If the branch you're reviewing has a matching open pull request, hover over a line in the
diff to reveal a `+` next to it, then click it (or select a range of lines first) to open
a comment box. You can post the comment right away with **Comment**, or **Start a
review** to collect it as a draft alongside others — nothing posts until you submit the
review. Drafts are stored on your machine until then.

## GitHub pull requests

The **Pull Requests** tab lists a repository's open pull requests — proposed changes
waiting to be reviewed and merged. Filter to **All** or just **Needs my review**
(available once you're signed in). Each row shows the PR number, title, a *draft* badge if
it's still a work in progress, the author, the base branch (what it will merge into) and
head branch (where the changes come from), and when it was last updated.

> Not connected? *"Connect your GitHub account to review pull requests."* See
> [GitHub integration](github.md).

Open a pull request to see:

- **Header** — title, branches, and actions: **Refresh**, **Copy link**, **Open in
  browser**, **Checkout** (switches your local copy over to the PR's branch, and switches
  the Review tab to *Branch vs base* so you can look at the same changes locally), and
  **Submit review**.
- **Details** — reviewers and whether each has approved, assignees, labels, milestone, and
  any issues this PR is linked to. Reviewers and assignees can be edited from here: use the
  pencil icon beside each to pick from the repo's assignable users (GitHub's
  `/repos/{owner}/{repo}/assignees` list — everyone who can be assigned or asked to review).
  A reviewer who has already submitted a review cannot be removed from here: GitHub only
  allows a still-pending review request to be withdrawn.
- **Description & conversation** — the PR's description, rendered from markdown, and a
  chronological timeline of comments, reviews, and events such as new commits, label
  changes, marking the PR ready or draft, and merges. Checkboxes in task lists can be
  ticked directly from here.
- **Review threads** — inline comments on the code, grouped by file and line, each showing
  the relevant piece of the diff, with **Reply…** and **Resolve / Unresolve** actions.

### Submitting a review

**Submit review** opens a box for an overall summary — written in markdown, and you can
@-mention people — plus a choice of **Comment**, **Approve**, or **Request changes**. Any
draft inline comments you started above are included automatically. **Approve** doesn't
need a summary; the other two need either a summary or at least one draft comment.

### Merging

For open pull requests, a **Merge pull request** bar lets you merge it into the base
branch three ways: **Create a merge commit** (keeps every commit from the branch, plus a
new commit tying them together), **Squash and merge** (combines all the branch's commits
into a single one), or **Rebase and merge** (replays the branch's commits on top of the
base branch, with no extra merge commit). Merged and closed PRs show that status instead
of the bar.

## Behind the scenes

*For contributors — where this feature lives in the code.*

`src/features/review/` talks to `src-tauri/src/commands/review.rs` (and the GitHub
commands). Local review: `reviewFiles`, `reviewFileDiff`, `worktreeStatus`,
`worktreeFileDiff`, `gitStage`/`gitUnstage`/`gitDiscard`/`gitCommit`, `gitStash*`. GitHub:
`githubListPrs`, `githubPrThread`, `githubPrTimeline`, `githubPrDetails`,
`githubReviewThreads`, `githubSubmitReview`, `githubPrComment`,
`githubReplyReviewComment`, `githubResolveThread`, `githubMergePr`, `gitCheckoutPr`.
Drafts live in the `reviewDrafts` Zustand store, keyed by `repoId:prNumber`.

---

See also: [Files](files.md) · [GitHub integration](github.md) · [Keyboard shortcuts](../keyboard-shortcuts.md) · [documentation hub](../README.md)
