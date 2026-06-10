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
    let mut stmt = conn.prepare(
        "SELECT id, name, parent_id, sort FROM groups ORDER BY sort, name COLLATE NOCASE",
    )?;
    let groups = stmt
        .query_map([], |row| {
            Ok(Group {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                sort: row.get(3)?,
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
) -> AppResult<Group> {
    let conn = lock(&state)?;
    conn.execute(
        "INSERT INTO groups (name, parent_id) VALUES (?1, ?2)",
        rusqlite::params![name, parent_id],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Group {
        id,
        name,
        parent_id,
        sort: 0,
    })
}

#[tauri::command]
pub fn delete_group(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock(&state)?;
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
