//! Filesystem watcher over each registered repo's working tree, so changes made
//! outside the app — a branch switch or commit in a terminal, *and* a file
//! edited in another editor/IDE — are reflected live. Each repo's working tree
//! is watched recursively (which also covers its `.git`); a debounced batch
//! emits a single `repos-changed` event to the frontend. Events are filtered so
//! `.git` object/log churn doesn't trigger needless refreshes — only working-
//! tree files and the refs/HEAD/index that reflect repo state count.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
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
    /// The directories currently watched recursively (each repo's working tree,
    /// or its git dir for bare repos).
    watched: HashSet<PathBuf>,
}

/// Whether a changed path warrants a UI refresh. Working-tree files always
/// count. Inside `.git`, only the entries that reflect repo state do — `HEAD`,
/// `refs/`, `packed-refs`, `index` — so object/log churn (which fires
/// constantly during fetches and gc) doesn't spam the frontend.
fn is_interesting(path: &Path) -> bool {
    let comps: Vec<Component> = path.components().collect();
    let git_at = comps.iter().position(|c| match c {
        Component::Normal(name) => *name == OsStr::new(".git"),
        _ => false,
    });
    let Some(i) = git_at else {
        return true; // no `.git` component -> a working-tree file
    };
    match comps.get(i + 1) {
        // `.git` itself (HEAD/packed-refs swapped on a branch switch).
        None => true,
        Some(Component::Normal(name)) => matches!(
            name.to_str(),
            Some("HEAD" | "ORIG_HEAD" | "MERGE_HEAD" | "packed-refs" | "index" | "refs")
        ),
        Some(_) => false,
    }
}

impl RepoWatcher {
    pub fn new(app: AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let debouncer = new_debouncer(
            Duration::from_millis(400),
            move |res: DebounceEventResult| {
                // Emit only when a debounced batch touched something worth a
                // refresh (a working-tree file or a git-state ref), not on
                // internal `.git` object/log noise.
                if let Ok(events) = res {
                    if events.iter().any(|e| is_interesting(&e.path)) {
                        let _ = app.emit(REPOS_CHANGED, ());
                    }
                }
            },
        )?;
        Ok(Self {
            debouncer,
            watched: HashSet::new(),
        })
    }

    /// Watch exactly the given set of directories recursively (add new, drop
    /// removed).
    pub fn sync(&mut self, desired: HashSet<PathBuf>) {
        let watcher = self.debouncer.watcher();
        for dir in desired.difference(&self.watched) {
            let _ = watcher.watch(dir, RecursiveMode::Recursive);
        }
        for dir in self.watched.difference(&desired) {
            let _ = watcher.unwatch(dir);
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

    // Watch each repo's working tree (recursive watch also covers its `.git`).
    // Bare repos have no work tree — fall back to watching the git dir.
    let desired: HashSet<PathBuf> = paths
        .iter()
        .filter_map(|p| git::open(Path::new(p)).ok())
        .map(|repo| {
            repo.workdir()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| repo.path().to_path_buf())
        })
        .collect();

    if let Ok(mut guard) = state.watcher.lock() {
        if let Some(w) = guard.as_mut() {
            w.sync(desired);
        }
    }
}
