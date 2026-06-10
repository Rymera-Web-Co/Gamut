-- Manual ordering for repos (drag-and-drop within a group).
ALTER TABLE repos ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
