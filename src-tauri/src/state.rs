use std::sync::Mutex;

use rusqlite::Connection;

use crate::watch::RepoWatcher;

/// Shared application state, managed by Tauri and injected into commands via `State`.
pub struct AppState {
    /// SQLite connection. `rusqlite::Connection` is not `Sync`, so guard it with a `Mutex`.
    pub db: Mutex<Connection>,
    /// In-memory cache of the GitHub token so the OS keychain is read at most
    /// once per process run (avoids repeated keychain prompts).
    pub gh_token: Mutex<Option<String>>,
    /// Filesystem watcher over registered repos' `.git` (set up after launch).
    pub watcher: Mutex<Option<RepoWatcher>>,
}
