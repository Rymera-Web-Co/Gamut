use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tokio::sync::Semaphore;

use crate::commands::diagnostics::OpTiming;
use crate::commands::terminal::Session;
use crate::watch::RepoWatcher;

/// Maximum number of git working-tree status/diff scans allowed to run at once.
///
/// These scans walk the working tree and, on macOS, repeatedly open and close
/// libiconv converters for Unicode path normalization — all contending a single
/// process-global lock. Letting dozens run concurrently (one per repo when a
/// `repos-changed` burst refreshes every repo's status at once) produced a
/// libiconv lock convoy that hung the app for minutes (issue #89). A small
/// ceiling keeps status refreshes from stampeding while still overlapping a few.
pub const GIT_STATUS_CONCURRENCY: usize = 4;

/// Shared application state, managed by Tauri and injected into commands via `State`.
pub struct AppState {
    /// SQLite connection. `rusqlite::Connection` is not `Sync`, so guard it with a `Mutex`.
    pub db: Mutex<Connection>,
    /// In-memory cache of the GitHub token so the OS keychain is read at most
    /// once per process run (avoids repeated keychain prompts).
    pub gh_token: Mutex<Option<String>>,
    /// Filesystem watcher over registered repos' `.git` (set up after launch).
    pub watcher: Mutex<Option<RepoWatcher>>,
    /// Canonicalized paths of folder-bound groups, refreshed on each watcher
    /// resync. Lets the debounced watch callback cheaply tell whether a change
    /// landed under a bound folder (and thus warrants an auto-sync) without
    /// hitting the DB on every event.
    pub bound_folders: Mutex<Vec<PathBuf>>,
    /// Live PTY-backed terminal sessions, keyed by an opaque scope id
    /// (`repo:<id>` / `group:<id>`). Persist across tab switches so background
    /// processes keep running; see `commands::terminal`.
    pub terminals: Mutex<HashMap<String, Session>>,
    /// Limits concurrent git status/diff scans; see [`GIT_STATUS_CONCURRENCY`].
    pub git_gate: Semaphore,
    /// Cache of `repo_id → (owner, repo)` parsed from each repo's `origin`
    /// remote, so GitHub commands and PR-link resolution don't re-open the repo
    /// and re-parse the remote on every call (#136). Only successful GitHub
    /// resolutions are cached; invalidated when a repo is registered or removed.
    pub origin_slug_cache: Mutex<HashMap<i64, (String, String)>>,
    /// Rolling in-memory log of git operation timings for diagnostics (#90);
    /// capped at `commands::diagnostics::OP_LOG_CAP`.
    pub op_log: Mutex<VecDeque<OpTiming>>,
}
