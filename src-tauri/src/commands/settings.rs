//! Generic key/value app settings backed by the `settings` SQLite table.
//!
//! Every user-facing preference is namespaced under `pref.` so the whole set
//! can be listed, exported and reset as a group without ever touching the
//! credential rows (`github_token`, `github_login`) that also live in this
//! table. The frontend reads/writes these through the generic commands below;
//! backend features read their own keys directly via the helpers.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Prefix for every user-preference key. List/reset operate on this namespace.
const PREF_PREFIX: &str = "pref.";

fn lock(state: &AppState) -> AppResult<MutexGuard<'_, Connection>> {
    state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))
}

/// Read a raw setting using an already-held connection (no locking). Use this
/// from code paths that already hold the db lock to avoid a re-entrant deadlock.
pub fn get_conn(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

/// Read + parse a setting from a held connection, falling back to `default`.
pub fn parsed_conn<T: FromStr>(conn: &Connection, key: &str, default: T) -> T {
    get_conn(conn, key)
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Read a raw setting (locks the db).
pub fn get(state: &AppState, key: &str) -> AppResult<Option<String>> {
    let conn = lock(state)?;
    Ok(get_conn(&conn, key))
}

/// Read + parse a setting (locks the db), falling back to `default`.
pub fn parsed<T: FromStr>(state: &AppState, key: &str, default: T) -> T {
    match lock(state) {
        Ok(conn) => parsed_conn(&conn, key, default),
        Err(_) => default,
    }
}

/// Read a setting as a trimmed, non-empty comma-separated list (locks the db).
/// Returns `default` when the key is unset or holds only blanks.
pub fn csv_or(state: &AppState, key: &str, default: Vec<String>) -> Vec<String> {
    match get(state, key) {
        Ok(Some(raw)) => {
            let list = parse_csv(&raw);
            if list.is_empty() {
                default
            } else {
                list
            }
        }
        _ => default,
    }
}

/// Split a comma-separated setting into trimmed, non-empty entries.
pub fn parse_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

pub fn set(state: &AppState, key: &str, value: &str) -> AppResult<()> {
    lock(state)?.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> AppResult<Option<String>> {
    get(&state, &key)
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> AppResult<()> {
    set(&state, &key, &value)
}

#[tauri::command]
pub fn delete_setting(state: State<AppState>, key: String) -> AppResult<()> {
    lock(&state)?.execute(
        "DELETE FROM settings WHERE key = ?1",
        rusqlite::params![key],
    )?;
    Ok(())
}

/// All user preferences (the `pref.` namespace only — never credentials).
#[tauri::command]
pub fn get_settings(state: State<AppState>) -> AppResult<HashMap<String, String>> {
    let conn = lock(&state)?;
    let mut stmt = conn.prepare("SELECT key, value FROM settings WHERE key LIKE ?1")?;
    let rows = stmt.query_map([format!("{PREF_PREFIX}%")], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (k, v) = row?;
        out.insert(k, v);
    }
    Ok(out)
}

/// Reset every user preference to its default by clearing the `pref.` namespace.
/// Credential rows (`github_token`, `github_login`) are intentionally untouched.
#[tauri::command]
pub fn reset_settings(state: State<AppState>) -> AppResult<()> {
    lock(&state)?.execute(
        "DELETE FROM settings WHERE key LIKE ?1",
        [format!("{PREF_PREFIX}%")],
    )?;
    Ok(())
}
