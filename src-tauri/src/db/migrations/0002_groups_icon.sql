-- Group icons + a guaranteed default group.
-- `icon` holds an icon key (see frontend GROUP_ICONS); NULL means use initials.
ALTER TABLE groups ADD COLUMN icon TEXT;
ALTER TABLE groups ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- Ensure exactly one default group exists.
INSERT INTO groups (name, is_default, sort)
SELECT 'Default', 1, -1
WHERE NOT EXISTS (SELECT 1 FROM groups WHERE is_default = 1);
