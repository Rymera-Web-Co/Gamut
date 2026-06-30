use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: String,
}

#[derive(Serialize)]
pub struct Group {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub sort: i64,
    pub icon: Option<String>,
    pub is_default: bool,
    /// When set, the group is bound to this folder and auto-synced with it.
    /// NULL/empty = a normal manual group. Immutable once set.
    pub folder_path: Option<String>,
    /// UTC timestamp of the last folder scan (NULL until first scan).
    pub last_scan_at: Option<String>,
    /// The repos-row id of the bound folder itself (the synced root), once it has
    /// been registered by a scan. `None` for manual groups or before the first
    /// scan. Lets the UI tag the root entry apart from discovered subfolders.
    pub root_repo_id: Option<i64>,
}

/// Canonicalize a bound folder path the same way `register_path` stores repo
/// paths, so synced-root lookups match regardless of symlinks.
fn canonicalize_folder(folder_path: &str) -> String {
    std::path::Path::new(folder_path)
        .canonicalize()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| folder_path.to_string())
}

/// Resolve the repos-row id of the synced-root entry for each given canonical
/// folder path, in a single query (avoids an N+1 across bound groups). Paths
/// with no registered entry are simply absent from the map.
fn root_repo_ids_by_path(conn: &Connection, canonical_paths: &[String]) -> HashMap<String, i64> {
    let mut out = HashMap::new();
    if canonical_paths.is_empty() {
        return out;
    }
    let placeholders = vec!["?"; canonical_paths.len()].join(",");
    let sql = format!("SELECT path, id FROM repos WHERE path IN ({placeholders})");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return out;
    };
    let rows = stmt.query_map(rusqlite::params_from_iter(canonical_paths), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    });
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            out.insert(row.0, row.1);
        }
    }
    out
}

fn lock(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
    state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))
}

// ---- Tags ----

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> AppResult<Vec<Tag>> {
    let conn = lock(&state)?;
    let mut stmt = conn.prepare("SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE")?;
    let tags = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(tags)
}

#[tauri::command]
pub fn create_tag(state: State<AppState>, name: String, color: String) -> AppResult<Tag> {
    let conn = lock(&state)?;
    conn.execute(
        "INSERT INTO tags (name, color) VALUES (?1, ?2)
         ON CONFLICT(name) DO UPDATE SET color = excluded.color",
        rusqlite::params![name, color],
    )?;
    let id: i64 = conn.query_row("SELECT id FROM tags WHERE name = ?1", [&name], |r| r.get(0))?;
    Ok(Tag { id, name, color })
}

#[tauri::command]
pub fn delete_tag(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM tags WHERE id = ?1", [id])?;
    Ok(())
}

/// Replace the full set of tags assigned to a repo.
#[tauri::command]
pub fn set_repo_tags(state: State<AppState>, repo_id: i64, tag_ids: Vec<i64>) -> AppResult<()> {
    let mut conn = lock(&state)?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM repo_tags WHERE repo_id = ?1", [repo_id])?;
    {
        let mut stmt =
            tx.prepare("INSERT OR IGNORE INTO repo_tags (repo_id, tag_id) VALUES (?1, ?2)")?;
        for tag_id in tag_ids {
            stmt.execute(rusqlite::params![repo_id, tag_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

// ---- Groups ----

#[tauri::command]
pub fn list_groups(state: State<AppState>) -> AppResult<Vec<Group>> {
    let conn = lock(&state)?;
    // Ordered purely by the persisted sort (then name as a tie-break), so
    // drag-and-drop reordering applies to every group including the default
    // one. The default group ships with sort = -1, so it starts first but can
    // be moved like any other.
    let mut stmt = conn.prepare(
        "SELECT id, name, parent_id, sort, icon, is_default, folder_path, last_scan_at
         FROM groups ORDER BY sort, name COLLATE NOCASE",
    )?;
    let mut groups = stmt
        .query_map([], |row| {
            Ok(Group {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                sort: row.get(3)?,
                icon: row.get(4)?,
                is_default: row.get::<_, i64>(5)? != 0,
                folder_path: row.get(6)?,
                last_scan_at: row.get(7)?,
                root_repo_id: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    // Resolve every bound group's synced-root entry in one query so the UI can
    // tag it (canonical path → repos id), keyed back to each group by path.
    let canon: Vec<Option<String>> = groups
        .iter()
        .map(|g| g.folder_path.as_deref().map(canonicalize_folder))
        .collect();
    let lookup: Vec<String> = canon.iter().flatten().cloned().collect();
    let ids = root_repo_ids_by_path(&conn, &lookup);
    for (g, path) in groups.iter_mut().zip(&canon) {
        g.root_repo_id = path.as_deref().and_then(|p| ids.get(p).copied());
    }
    Ok(groups)
}

#[tauri::command]
pub fn create_group(
    state: State<AppState>,
    name: String,
    parent_id: Option<i64>,
    icon: Option<String>,
    folder_path: Option<String>,
) -> AppResult<Group> {
    // Treat an empty string as "no folder" so a blank picker doesn't bind.
    let folder_path = folder_path.filter(|p| !p.trim().is_empty());
    let id = {
        let conn = lock(&state)?;
        conn.execute(
            "INSERT INTO groups (name, parent_id, icon, folder_path) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![name, parent_id, icon, folder_path],
        )?;
        conn.last_insert_rowid()
    };
    // A freshly bound folder should start being watched even before its first
    // scan completes, so new repos are picked up immediately.
    if folder_path.is_some() {
        crate::watch::resync(&state);
    }
    Ok(Group {
        id,
        name,
        parent_id,
        sort: 0,
        icon,
        is_default: false,
        folder_path,
        // No scan has run yet, so the root entry isn't registered; the next
        // list_groups (after the initial sync) resolves it.
        last_scan_at: None,
        root_repo_id: None,
    })
}

/// Update a group's icon (None reverts to name initials) and optionally its name.
#[tauri::command]
pub fn update_group(
    state: State<AppState>,
    id: i64,
    name: Option<String>,
    icon: Option<String>,
) -> AppResult<()> {
    let conn = lock(&state)?;
    if let Some(name) = name {
        conn.execute(
            "UPDATE groups SET name = ?1 WHERE id = ?2",
            rusqlite::params![name, id],
        )?;
    }
    // icon is always set (Some(key) to set, None to clear).
    conn.execute(
        "UPDATE groups SET icon = ?1 WHERE id = ?2",
        rusqlite::params![icon, id],
    )?;
    // Note: `folder_path` is intentionally not updatable here — a bound folder
    // is immutable. Use `unbind_group_folder` to detach it entirely.
    Ok(())
}

/// Bind a currently-unbound group to a folder (first bind). No-op if the group
/// is already bound — the path is immutable once set. The caller should follow
/// up with `sync_group_folder` to run the initial scan.
#[tauri::command]
pub fn bind_group_folder(state: State<AppState>, id: i64, folder_path: String) -> AppResult<()> {
    let folder = folder_path.trim();
    if folder.is_empty() {
        return Ok(());
    }
    {
        let conn = lock(&state)?;
        conn.execute(
            "UPDATE groups SET folder_path = ?1
             WHERE id = ?2 AND (folder_path IS NULL OR folder_path = '')",
            rusqlite::params![folder, id],
        )?;
    }
    crate::watch::resync(&state);
    Ok(())
}

/// Detach a group from its bound folder, converting it back to a plain manual
/// group. Existing members are kept; the folder is simply no longer watched.
#[tauri::command]
pub fn unbind_group_folder(state: State<AppState>, id: i64) -> AppResult<()> {
    {
        let conn = lock(&state)?;
        conn.execute(
            "UPDATE groups SET folder_path = NULL, last_scan_at = NULL WHERE id = ?1",
            [id],
        )?;
    }
    // Stop watching the now-detached folder.
    crate::watch::resync(&state);
    Ok(())
}

/// Persist a new ordering for groups (drag-and-drop in the rail). Every group,
/// including the default one, can be placed anywhere; list_groups returns rows
/// in this persisted `sort` order.
#[tauri::command]
pub fn reorder_groups(state: State<AppState>, group_ids: Vec<i64>) -> AppResult<()> {
    let mut conn = lock(&state)?;
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE groups SET sort = ?1 WHERE id = ?2")?;
        for (idx, id) in group_ids.iter().enumerate() {
            stmt.execute(rusqlite::params![idx as i64, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn delete_group(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock(&state)?;
    let is_default: bool = conn
        .query_row("SELECT is_default FROM groups WHERE id = ?1", [id], |r| {
            r.get::<_, i64>(0)
        })
        .map(|v| v != 0)
        .unwrap_or(false);
    if is_default {
        return Err(AppError::Other(
            "the default group cannot be deleted".into(),
        ));
    }
    conn.execute("DELETE FROM groups WHERE id = ?1", [id])?;
    Ok(())
}

/// Replace the full set of groups a repo belongs to.
#[tauri::command]
pub fn set_repo_groups(state: State<AppState>, repo_id: i64, group_ids: Vec<i64>) -> AppResult<()> {
    let mut conn = lock(&state)?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM repo_groups WHERE repo_id = ?1", [repo_id])?;
    {
        let mut stmt =
            tx.prepare("INSERT OR IGNORE INTO repo_groups (repo_id, group_id) VALUES (?1, ?2)")?;
        for group_id in group_ids {
            stmt.execute(rusqlite::params![repo_id, group_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_repo_id_matches_a_bound_folder_by_canonical_path() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE repos (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 path TEXT NOT NULL UNIQUE,
                 name TEXT NOT NULL
             );",
        )
        .unwrap();

        // A real temp dir (uniquely named per process to avoid cross-run
        // collisions), registered under its canonical path the way folder sync
        // stores repo paths.
        let raw =
            std::env::temp_dir().join(format!("gamut_root_repo_id_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&raw);
        std::fs::create_dir_all(&raw).unwrap();
        let canonical = raw.canonicalize().unwrap().display().to_string();
        conn.execute(
            "INSERT INTO repos (path, name) VALUES (?1, 'root')",
            [&canonical],
        )
        .unwrap();
        let id: i64 = conn
            .query_row("SELECT id FROM repos WHERE path = ?1", [&canonical], |r| {
                r.get(0)
            })
            .unwrap();

        // Canonicalizing the raw (possibly symlinked, e.g. /var) folder_path and
        // resolving in one batch still maps back to the canonical entry, while an
        // unknown path is simply absent.
        let raw_str = raw.display().to_string();
        let canon = canonicalize_folder(&raw_str);
        assert_eq!(canon, canonical);
        let ids =
            root_repo_ids_by_path(&conn, &[canon.clone(), "/nope/not/registered".to_string()]);
        assert_eq!(ids.get(&canon).copied(), Some(id));
        assert_eq!(
            ids.get("/nope/not/registered"),
            None,
            "unregistered folder has no root entry"
        );

        std::fs::remove_dir_all(&raw).unwrap();
    }
}
