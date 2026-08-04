use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tokio::sync::Semaphore;

use crate::claude_ide::IdeHandle;
use crate::commands::diagnostics::{ErrorEntry, OpTiming};
use crate::commands::terminal::{Session, TerminalInfo};
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

/// One watched entry root in [`AppState::watched_entry_dirs`].
#[derive(Clone)]
pub struct WatchedDir {
    /// The repos-table id of the entry.
    pub id: i64,
    /// Whether the entry is a git repo. Plain folders resolve changed paths
    /// for query scoping like repos do, but must NOT mask new-repo discovery:
    /// a path under a registered folder (a workspace, a bound group's root
    /// entry) can still be a brand-new clone.
    pub is_git: bool,
}

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
    /// Watched entry root directory → entry, refreshed on each watcher resync.
    /// Covers git repos (working tree, or git dir for a bare repo) and
    /// registered plain folders. Lets the debounced watch callback resolve a
    /// changed path back to the specific entries it belongs to, so
    /// `repos-changed` can carry only the affected ids instead of forcing
    /// every repo's queries to refetch (#206).
    pub watched_entry_dirs: Mutex<HashMap<PathBuf, WatchedDir>>,
    /// Serializes `watch::resync`'s blocking rebuild so overlapping calls
    /// (e.g. adding two repos in quick succession) can't run concurrently and
    /// finish out of order, which would let an older rebuild clobber a newer
    /// one's watcher state (#226).
    pub resync_lock: Mutex<()>,
    /// Live PTY-backed terminal sessions, keyed by an opaque scope id
    /// (`repo:<id>` / `group:<id>`). Persist across tab switches so background
    /// processes keep running; see `commands::terminal`.
    pub terminals: Mutex<HashMap<String, Session>>,
    /// Mirror of the webview's open terminal tabs (names, group, cwd), pushed by
    /// the frontend on every layout change. The PTY registry above is keyed by
    /// opaque pane id with no names, so the control channel's `term-list` query
    /// reads this human-meaningful snapshot instead. See `terminal_registry_report`.
    pub terminal_registry: Mutex<Vec<TerminalInfo>>,
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
    /// Rolling in-memory log of captured error-toast messages (#301) — the
    /// single source of truth for both the Diagnostics panel's "Recent
    /// errors" section and the Copy/Save bundle. Mirrors `errors.log` in the
    /// app data dir (hydrated on setup, appended to on every capture) and is
    /// capped at `commands::diagnostics::ERROR_LOG_CAP`.
    pub error_log: Mutex<VecDeque<ErrorEntry>>,
    /// Handle to the Claude Code IDE WebSocket server, once started (best-effort:
    /// `None` if the bind failed). Terminals read its port to advertise
    /// `CLAUDE_CODE_SSE_PORT`; the frontend pushes editor selections through it.
    pub ide: Mutex<Option<IdeHandle>>,
}
