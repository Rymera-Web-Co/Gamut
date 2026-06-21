-- Track whether a registered folder is an actual git repository. Plain folders
-- that are not git repos can be added too; they show only the Files tab and
-- skip all git operations. Existing rows are real git repos, hence default 1.
ALTER TABLE repos ADD COLUMN is_git_repo INTEGER NOT NULL DEFAULT 1;
