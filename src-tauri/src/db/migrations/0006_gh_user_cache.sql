-- Cache of GitHub identities resolved from commit-author emails (#195).
--
-- A repo's history is dominated by a handful of authors, so keying by email
-- (not by commit SHA) means one GitHub lookup per distinct author, and the
-- result survives app restarts. `avatar_url` NULL is a valid, cached negative:
-- the email maps to no GitHub account, so we shouldn't keep refetching it.
CREATE TABLE IF NOT EXISTS gh_user_cache (
    email      TEXT PRIMARY KEY,
    login      TEXT,
    avatar_url TEXT,
    fetched_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
