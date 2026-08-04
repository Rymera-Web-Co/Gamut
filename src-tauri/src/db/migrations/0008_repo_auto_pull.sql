-- Per-repo opt-in to background auto-pull (#299). When set, the app
-- fast-forwards this repo's current branch whenever it notices the branch is
-- behind its upstream — but only when the pull is a clean fast-forward (clean
-- working tree, behind-only, upstream present); anything else is skipped with a
-- warning rather than stashed, merged, or rebased. Default 0 = opted out, so
-- existing repos keep today's fully-manual pull behaviour until the user turns
-- it on per repo.
ALTER TABLE repos ADD COLUMN auto_pull INTEGER NOT NULL DEFAULT 0;
