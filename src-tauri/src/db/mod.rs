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
    (
        "0006_gh_user_cache",
        include_str!("migrations/0006_gh_user_cache.sql"),
    ),
    (
        "0007_repo_has_worktrees",
        include_str!("migrations/0007_repo_has_worktrees.sql"),
    ),
    (
        "0008_repo_auto_pull",
        include_str!("migrations/0008_repo_auto_pull.sql"),
    ),
];

/// How long a connection waits for a competing writer's lock before giving up
/// with "database is locked". The app may share this DB with another local
/// process opening it concurrently, so a non-zero timeout — paired with WAL,
/// which lets readers and a single writer coexist — keeps a concurrent write
/// and the app's background status scans from colliding.
const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// Open (creating if needed) the SQLite database at `path`, enable sane pragmas,
/// and run any pending migrations.
pub fn open<P: AsRef<Path>>(path: P) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Wait, don't immediately error, when another process holds the write
    // lock — see [`BUSY_TIMEOUT`].
    conn.busy_timeout(BUSY_TIMEOUT)?;
    run_migrations(&conn)?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> AppResult<()> {
    run_migrations_from(conn, MIGRATIONS)
}

/// Apply `migrations` in order, skipping any already recorded in `_migrations`.
/// Split out of [`run_migrations`] so a test can build a database at an *earlier*
/// schema revision (a prefix of [`MIGRATIONS`]) and then exercise the real
/// upgrade path over rows that already exist — the shape a user's DB actually
/// hits, which running every migration against an empty file never covers.
fn run_migrations_from(conn: &Connection, migrations: &[(&str, &str)]) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            name       TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    for (name, sql) in migrations {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The newest migration must be a safe *upgrade*, not just a valid schema for
    /// a fresh install: an existing DB is built one revision back, seeded with
    /// repo rows, and only then migrated. Guards the `auto_pull` opt-in (#299)
    /// defaulting to off for repos that predate it — the flag drives background
    /// pulls, so a wrong default would fast-forward repos nobody opted in.
    #[test]
    fn newest_migration_upgrades_existing_rows_with_auto_pull_off() {
        let dir = std::env::temp_dir().join(format!("gamut_migrate_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("gamut.db");

        let conn = Connection::open(&path).unwrap();
        // Schema revision immediately before the newest migration.
        let previous = &MIGRATIONS[..MIGRATIONS.len() - 1];
        run_migrations_from(&conn, previous).unwrap();
        conn.execute(
            "INSERT INTO repos (path, name) VALUES ('/tmp/legacy-a', 'legacy-a'), ('/tmp/legacy-b', 'legacy-b')",
            [],
        )
        .unwrap();

        // The real upgrade path over rows that already exist.
        run_migrations(&conn).unwrap();

        let off: i64 = conn
            .query_row("SELECT COUNT(*) FROM repos WHERE auto_pull = 0", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(off, 2, "pre-existing repos must default to auto_pull off");

        // NOT NULL DEFAULT 0: a fresh insert that names neither column succeeds
        // and lands opted out, and an explicit NULL is rejected.
        conn.execute(
            "INSERT INTO repos (path, name) VALUES ('/tmp/new', 'new')",
            [],
        )
        .unwrap();
        let new_flag: i64 = conn
            .query_row(
                "SELECT auto_pull FROM repos WHERE path = '/tmp/new'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(new_flag, 0, "new repos must default to auto_pull off");
        assert!(
            conn.execute(
                "INSERT INTO repos (path, name, auto_pull) VALUES ('/tmp/null', 'null', NULL)",
                [],
            )
            .is_err(),
            "auto_pull must be NOT NULL"
        );

        // Re-running migrations is a no-op (the column isn't added twice).
        run_migrations(&conn).unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }
}
