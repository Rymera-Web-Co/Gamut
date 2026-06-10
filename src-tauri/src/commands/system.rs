use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

/// Smoke-test command used to verify the IPC bridge round-trips.
#[tauri::command]
pub fn ping(name: Option<String>) -> String {
    match name {
        Some(n) if !n.is_empty() => format!("pong: {n}"),
        _ => "pong".to_string(),
    }
}

#[derive(Serialize)]
pub struct DbHealth {
    pub ok: bool,
    pub migrations: Vec<String>,
    pub repo_count: i64,
}

/// Reports database health: applied migrations and current repo count.
/// Confirms the SQLite file opened and schema migrations ran.
#[tauri::command]
pub fn db_health(state: State<AppState>) -> AppResult<DbHealth> {
    let conn = state
        .db
        .lock()
        .map_err(|e| crate::error::AppError::Other(format!("db lock poisoned: {e}")))?;

    let mut stmt = conn.prepare("SELECT name FROM _migrations ORDER BY name")?;
    let migrations = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let repo_count: i64 = conn.query_row("SELECT COUNT(*) FROM repos", [], |row| row.get(0))?;

    Ok(DbHealth {
        ok: true,
        migrations,
        repo_count,
    })
}
