use std::sync::Mutex;

use rusqlite::Connection;

/// Shared application state, managed by Tauri and injected into commands via `State`.
pub struct AppState {
    /// SQLite connection. `rusqlite::Connection` is not `Sync`, so guard it with a `Mutex`.
    pub db: Mutex<Connection>,
}
