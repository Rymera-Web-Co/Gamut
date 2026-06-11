//! Filesystem watcher over each registered repo's `.git`, so changes made
//! outside the app (branch switch in a terminal, commits, fetches) are
//! reflected live. Relevant paths (`HEAD`, `refs/`, `packed-refs`) are watched;
//! a debounced batch emits a single `repos-changed` event to the frontend.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use tauri::{AppHandle, Emitter};

use crate::git;
use crate::state::AppState;

/// Event name emitted when any watched repo's git state changes.
pub const REPOS_CHANGED: &str = "repos-changed";

pub struct RepoWatcher {
    debouncer: Debouncer<RecommendedWatcher>,
    /// The git directories currently watched (e.g. `…/repo/.git`).
    watched: HashSet<PathBuf>,
}

/// The paths inside a git dir worth watching for branch/ref changes.
/// The git dir itself (non-recursive) catches `HEAD`/`packed-refs` being swapped
/// on a branch switch; `refs/` (recursive) catches commits and fetched refs.
fn watch_targets(git_dir: &Path) -> [(PathBuf, RecursiveMode); 2] {
    [
        (git_dir.to_path_buf(), RecursiveMode::NonRecursive),
        (git_dir.join("refs"), RecursiveMode::Recursive),
    ]
}

impl RepoWatcher {
    pub fn new(app: AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let debouncer = new_debouncer(
            Duration::from_millis(400),
            move |res: DebounceEventResult| {
                // Any debounced batch of changes -> tell the UI to refetch.
                if res.is_ok() {
                    let _ = app.emit(REPOS_CHANGED, ());
                }
            },
        )?;
        Ok(Self {
            debouncer,
            watched: HashSet::new(),
        })
    }

    /// Watch exactly the given set of git directories (add new, drop removed).
    pub fn sync(&mut self, desired: HashSet<PathBuf>) {
        let watcher = self.debouncer.watcher();
        for git_dir in desired.difference(&self.watched) {
            for (target, mode) in watch_targets(git_dir) {
                let _ = watcher.watch(&target, mode);
            }
        }
        for git_dir in self.watched.difference(&desired) {
            for (target, _) in watch_targets(git_dir) {
                let _ = watcher.unwatch(&target);
            }
        }
        self.watched = desired;
    }
}

/// Recompute the set of repo git dirs from the DB and update the watcher.
pub fn resync(state: &AppState) {
    let paths: Vec<String> = {
        let Ok(conn) = state.db.lock() else { return };
        let Ok(mut stmt) = conn.prepare("SELECT path FROM repos") else {
            return;
        };
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map(|it| it.filter_map(Result::ok).collect::<Vec<_>>())
            .unwrap_or_default();
        rows
    };

    let desired: HashSet<PathBuf> = paths
        .iter()
        .filter_map(|p| git::open(Path::new(p)).ok())
        .map(|repo| repo.path().to_path_buf())
        .collect();

    if let Ok(mut guard) = state.watcher.lock() {
        if let Some(w) = guard.as_mut() {
            w.sync(desired);
        }
    }
}
