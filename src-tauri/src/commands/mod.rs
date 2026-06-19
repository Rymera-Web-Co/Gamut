pub mod cleanup;
pub mod files;
pub mod github;
pub mod history;
pub mod repo;
pub mod review;
pub mod search;
pub mod settings;
pub mod sync;
pub mod system;
pub mod tags;
pub mod terminal;
pub mod updater;
pub mod worktree;

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Run blocking git2 work that opens a repo from `path` on a blocking thread,
/// so it never executes on the main/UI thread (issue #88). Centralizes the
/// `spawn_blocking` + panic-mapping boilerplate shared by the git status
/// commands.
pub(crate) async fn run_git_blocking<F, T>(path: PathBuf, f: F) -> AppResult<T>
where
    F: FnOnce(&Path) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(&path))
        .await
        .map_err(|e| AppError::Other(format!("git task panicked: {e}")))?
}
