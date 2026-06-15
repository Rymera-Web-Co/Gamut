-- Bind a group to a folder on disk for automatic repo sync.
-- `folder_path` NULL/empty means a normal, fully-manual group (current
-- behaviour). A set path makes the group folder-bound: repos discovered under
-- the folder are auto-registered and added to it, and it keeps syncing as new
-- repos appear. The path is immutable once set.
ALTER TABLE groups ADD COLUMN folder_path TEXT;

-- Timestamp (UTC, SQLite datetime) of the last folder scan, for the sync
-- status line in the Edit Group dialog. NULL until the first scan runs.
ALTER TABLE groups ADD COLUMN last_scan_at TEXT;
