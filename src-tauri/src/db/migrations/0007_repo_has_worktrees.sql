-- Cache whether a repo has any linked worktrees (`git worktree add`). Computed
-- cheaply via git2 during the status scan; lets the UI skip the per-repo
-- `git worktree list` subprocess for the common case of a repo with none, so
-- opening a group doesn't fan out into one git process per repo. Default 0 =
-- "none known yet"; the first status scan corrects it.
ALTER TABLE repos ADD COLUMN has_worktrees INTEGER NOT NULL DEFAULT 0;
