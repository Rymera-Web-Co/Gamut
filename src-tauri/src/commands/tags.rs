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
        "SELECT id, name, parent_id, sort, icon, is_default FROM groups
         ORDER BY sort, name COLLATE NOCASE",
    )?;
    let groups = stmt
        .query_map([], |row| {
            Ok(Group {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                sort: row.get(3)?,
                icon: row.get(4)?,
                is_default: row.get::<_, i64>(5)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(groups)
}

#[tauri::command]
pub fn create_group(
    state: State<AppState>,
    name: String,
    parent_id: Option<i64>,
    icon: Option<String>,
) -> AppResult<Group> {
    let conn = lock(&state)?;
    conn.execute(
        "INSERT INTO groups (name, parent_id, icon) VALUES (?1, ?2, ?3)",
        rusqlite::params![name, parent_id, icon],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Group {
        id,
        name,
        parent_id,
        sort: 0,
        icon,
        is_default: false,
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
