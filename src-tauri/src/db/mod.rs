use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use crate::error::AppResult;

/// Ordered list of migrations. Each is applied once and recorded in `_migrations`.
const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("migrations/0001_init.sql")),
    (
        "0002_groups_icon",
        include_str!("migrations/0002_groups_icon.sql"),
    ),
    (
        "0003_repo_sort",
        include_str!("migrations/0003_repo_sort.sql"),
    ),
    (
        "0004_groups_folder",
        include_str!("migrations/0004_groups_folder.sql"),
    ),
    (
        "0005_repo_is_git",
        include_str!("migrations/0005_repo_is_git.sql"),
    ),
];

/// How long a connection waits for a competing writer's lock before giving up
/// with "database is locked". The app and the `gamut` CLI open the same DB
/// concurrently (issue #15), so a non-zero timeout — paired with WAL, which lets
/// readers and a single writer coexist — keeps a CLI `commit` and the app's
/// background status scans from colliding.
const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// Open (creating if needed) the SQLite database at `path`, enable sane pragmas,
/// and run any pending migrations.
pub fn open<P: AsRef<Path>>(path: P) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Wait, don't immediately error, when another process (the app or the CLI)
    // holds the write lock — see [`BUSY_TIMEOUT`].
    conn.busy_timeout(BUSY_TIMEOUT)?;
    run_migrations(&conn)?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            name       TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    for (name, sql) in MIGRATIONS {
        let applied: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM _migrations WHERE name = ?1)",
            [name],
            |row| row.get(0),
        )?;
        if !applied {
            conn.execute_batch(sql)?;
            conn.execute("INSERT INTO _migrations (name) VALUES (?1)", [name])?;
        }
    }
    Ok(())
}
