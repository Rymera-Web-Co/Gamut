# Review

Gamut has two review workflows: **local self-review** of your own changes (the Review
tab, `⌘/Ctrl+3`) and **GitHub pull-request review** (the Pull Requests tab, `⌘/Ctrl+4`).

## Local self-review

A segmented control at the top switches between two sources:

- **Working tree** — uncommitted changes (staging area + untracked vs. HEAD).
- **Branch vs base** — your current branch against its base (`trunk`/`main`/`master`,
  local or `origin/…`).

If the working tree is clean but the branch has changes, Gamut defaults to *Branch vs
base*. The diff header reads `<base> → <head> · N file(s)`.

The file tree lists changed files with `+`/`−` counts and a status badge (A/M/D/R). Click
a file for a read-only side-by-side diff; binary files show *"Binary file — diff not
shown."*

### Staging, committing, stashing (working tree)

- **Changes** (unstaged) and **Staged** sections. Hover a file to **stage** (`+`),
  **unstage** (`−`), or **Undo** (discard, with confirmation). Section headers offer
  *Stage all*, *Unstage all*, and *Discard all*.
- **Commit** — type a message and click **Commit N file(s)**, or press `⌘/Ctrl+Enter`.
- **Stash** — save changes (optionally with a message and untracked files); pop, apply,
  or drop existing stashes from the list.
- **Edit** a non-deleted file to jump to it in the [Files](files.md) editor.

When there's nothing to review: *"Working tree clean."*

### Inline comments on a branch

If the branch you're reviewing has a matching open PR, hover a line in the diff to reveal
a `+` in the gutter, then click it (or select a range first) to open a composer. You can
**Comment** immediately or **Start a review** to batch the comment as a draft. Drafts are
stored client-side until you submit the review.

## GitHub pull requests

The **Pull Requests** tab lists open PRs. Filter with **All** or **Needs my review**
(enabled when signed in). Each row shows the number, title, a *draft* badge, author, the
base ← head branches, and when it was last updated.

> Not connected? *"Connect your GitHub account to review pull requests."* See
> [GitHub integration](github.md).

Open a PR to see:

- **Header** — title, branches, and actions: **Refresh**, **Copy link**, **Open in
  browser**, **Checkout** (checks out the PR branch and switches Review to *Branch vs
  base*), and **Submit review**.
- **Details** — reviewers (with approval state), assignees, labels, milestone, and linked
  issues.
- **Description & conversation** — markdown-rendered body and a chronological timeline of
  comments, reviews, and events (commits, label changes, ready/draft, merges, …). Task-
  list checkboxes toggle inline.
- **Review threads** — inline code comments grouped by file and line, with the diff hunk,
  **Reply…**, and **Resolve / Unresolve**.

### Submitting a review

**Submit review** opens a composer with a markdown summary (supports @-mentions) and a
choice of **Comment**, **Approve**, or **Request changes**. Any pending inline drafts are
included. *Approve* needs no body; the others need a body or at least one draft comment.

### Merging

For open PRs, a **Merge pull request** bar offers **Create a merge commit**, **Squash and
merge**, or **Rebase and merge**. Merged and closed PRs say so instead.

## Behind the scenes

`src/features/review/` talks to `src-tauri/src/commands/review.rs` (and the GitHub
commands). Local review: `reviewFiles`, `reviewFileDiff`, `worktreeStatus`,
`worktreeFileDiff`, `gitStage`/`gitUnstage`/`gitDiscard`/`gitCommit`, `gitStash*`. GitHub:
`githubListPrs`, `githubPrThread`, `githubPrTimeline`, `githubPrDetails`,
`githubReviewThreads`, `githubSubmitReview`, `githubPrComment`,
`githubReplyReviewComment`, `githubResolveThread`, `githubMergePr`, `gitCheckoutPr`.
Drafts live in the `reviewDrafts` Zustand store, keyed by `repoId:prNumber`.

---

See also: [Files](files.md) · [GitHub integration](github.md) · [Keyboard shortcuts](../keyboard-shortcuts.md) · [documentation hub](../README.md)
