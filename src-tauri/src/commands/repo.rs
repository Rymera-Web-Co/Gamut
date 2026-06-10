use std::path::PathBuf;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git;
use crate::state::AppState;

#[derive(Serialize)]
pub struct Repo {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub last_opened: Option<String>,
    pub created_at: String,
    pub tag_ids: Vec<i64>,
    pub group_ids: Vec<i64>,
}

#[derive(Serialize)]
pub struct DiscoveredRepo {
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub already_registered: bool,
}

fn lock(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
    state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))
}

fn ids_for(conn: &Connection, sql: &str, repo_id: i64) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(sql)?;
    let ids = stmt
        .query_map([repo_id], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

fn load_repo(conn: &Connection, id: i64) -> AppResult<Repo> {
    let (path, name, default_branch, last_opened, created_at) = conn.query_row(
        "SELECT path, name, default_branch, last_opened, created_at FROM repos WHERE id = ?1",
        [id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        },
    )?;

    Ok(Repo {
        id,
        path,
        name,
        default_branch,
        last_opened,
        created_at,
        tag_ids: ids_for(conn, "SELECT tag_id FROM repo_tags WHERE repo_id = ?1", id)?,
        group_ids: ids_for(conn, "SELECT group_id FROM repo_groups WHERE repo_id = ?1", id)?,
    })
}

#[tauri::command]
pub fn list_repos(state: State<AppState>) -> AppResult<Vec<Repo>> {
    let conn = lock(&state)?;
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM repos ORDER BY name COLLATE NOCASE")?;
        let ids = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    };
    ids.into_iter().map(|id| load_repo(&conn, id)).collect()
}

/// Register a repo by path. Validates it's a git repo, derives name and
/// current branch. If the path is already registered, returns the existing row.
#[tauri::command]
pub fn register_repo(state: State<AppState>, path: String) -> AppResult<Repo> {
    let pb = PathBuf::from(&path);
    let repo = git::open(&pb)?;
    let name = git::repo_name(&pb);
    let branch = git::current_branch(&repo);

    let conn = lock(&state)?;
    let canonical = pb
        .canonicalize()
        .map(|p| p.display().to_string())
        .unwrap_or(path);

    conn.execute(
        "INSERT INTO repos (path, name, default_branch) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, default_branch = excluded.default_branch",
        rusqlite::params![canonical, name, branch],
    )?;
    let id: i64 = conn.query_row("SELECT id FROM repos WHERE path = ?1", [&canonical], |r| {
        r.get(0)
    })?;
    load_repo(&conn, id)
}

#[tauri::command]
pub fn remove_repo(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM repos WHERE id = ?1", [id])?;
    Ok(())
}

#[tauri::command]
pub fn touch_repo(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock(&state)?;
    conn.execute(
        "UPDATE repos SET last_opened = datetime('now') WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// Scan a directory for git repos, flagging which are already registered.
#[tauri::command]
pub fn discover_repos(
    state: State<AppState>,
    root: String,
    max_depth: Option<usize>,
) -> AppResult<Vec<DiscoveredRepo>> {
    let found = git::discover(&PathBuf::from(&root), max_depth.unwrap_or(6));
    let conn = lock(&state)?;

    found
        .into_iter()
        .map(|d| {
            let canonical = d
                .path
                .canonicalize()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| d.path.display().to_string());
            let already_registered: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM repos WHERE path = ?1)",
                [&canonical],
                |r| r.get(0),
            )?;
            Ok(DiscoveredRepo {
                path: canonical,
                name: d.name,
                default_branch: d.default_branch,
                already_registered,
            })
        })
        .collect()
}
