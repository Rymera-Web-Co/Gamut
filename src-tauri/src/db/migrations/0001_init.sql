-- Gamut initial schema: repo registry, groups, tags, and settings.

CREATE TABLE IF NOT EXISTS repos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    path           TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    default_branch TEXT,
    last_opened    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Nestable folders for organising repos in the sidebar.
CREATE TABLE IF NOT EXISTS groups (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    parent_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    sort      INTEGER NOT NULL DEFAULT 0
);

-- Colored labels, many-to-many with repos.
CREATE TABLE IF NOT EXISTS tags (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#888888'
);

CREATE TABLE IF NOT EXISTS repo_tags (
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (repo_id, tag_id)
);

CREATE TABLE IF NOT EXISTS repo_groups (
    repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (repo_id, group_id)
);

-- Key/value app settings (theme, scan roots, prefs). Never store secrets here.
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
