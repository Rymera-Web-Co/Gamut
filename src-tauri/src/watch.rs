//! Filesystem watcher over each registered repo's working tree, so changes made
//! outside the app — a branch switch or commit in a terminal, *and* a file
//! edited in another editor/IDE — are reflected live. A non-bare repo's working
//! tree is watched recursively (which also covers its `.git`); a debounced
//! batch emits a single `repos-changed` event to the frontend. Events are
//! filtered so `.git` object/log churn doesn't trigger needless refreshes —
//! only working-tree files and the refs/HEAD/index that reflect repo state
//! count. Bare repos have no work tree, so we watch only their `refs/` and
//! top-level git-state files, never the object store.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::git;
use crate::state::AppState;

/// Event name emitted when any watched repo's git state changes.
pub const REPOS_CHANGED: &str = "repos-changed";

pub struct RepoWatcher {
    debouncer: Debouncer<RecommendedWatcher>,
    /// The directories currently watched, each with its recursion mode (a repo's
    /// working tree recursively, or a bare repo's git-state paths).
    watched: HashMap<PathBuf, RecursiveMode>,
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
    pub fn new(app: AppHandle, debounce_ms: u64) -> Result<Self, Box<dyn std::error::Error>> {
        let debouncer = new_debouncer(
            Duration::from_millis(debounce_ms),
            move |res: DebounceEventResult| {
                let Ok(events) = res else { return };

                // If a batch touched anything under a folder-bound group, a new
                // repo may have appeared — run an add-only sync. Bound folders
                // are watched recursively, so newly-added repos are already
                // covered; no watcher resync is needed here.
                let bound: Vec<PathBuf> = app
                    .state::<AppState>()
                    .bound_folders
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let under_bound = !bound.is_empty()
                    && events
                        .iter()
                        .any(|e| bound.iter().any(|b| e.path.starts_with(b)));
                if under_bound {
                    let added =
                        crate::commands::repo::sync_all_bound_groups(&app.state::<AppState>());
                    if added > 0 {
                        let _ = app.emit(REPOS_CHANGED, ());
                        return;
                    }
                }

                // Otherwise emit only when the batch touched something worth a
                // refresh (a working-tree file or a git-state ref), not on
                // internal `.git` object/log noise.
                if events.iter().any(|e| is_interesting(&e.path)) {
                    let _ = app.emit(REPOS_CHANGED, ());
                }
            },
        )?;
        Ok(Self {
            debouncer,
            watched: HashMap::new(),
        })
    }

    /// Number of directories currently watched (for diagnostics).
    pub fn watched_count(&self) -> usize {
        self.watched.len()
    }

    /// Watch exactly the given set of directories (add new, drop removed), each
    /// with its requested recursion mode.
    pub fn sync(&mut self, desired: HashMap<PathBuf, RecursiveMode>) {
        let watcher = self.debouncer.watcher();
        for (dir, mode) in &desired {
            if !self.watched.contains_key(dir) {
                let _ = watcher.watch(dir, *mode);
            }
        }
        for dir in self.watched.keys() {
            if !desired.contains_key(dir) {
                let _ = watcher.unwatch(dir);
            }
        }
        self.watched = desired;
    }
}

/// Recompute the set of repo git dirs from the DB and update the watcher.
pub fn resync(state: &AppState) {
    let (paths, bound): (Vec<String>, Vec<String>) = {
        let Ok(conn) = state.db.lock() else { return };
        let read = |sql: &str| -> Vec<String> {
            conn.prepare(sql)
                .and_then(|mut stmt| {
                    stmt.query_map([], |r| r.get::<_, String>(0))
                        .map(|it| it.filter_map(Result::ok).collect::<Vec<_>>())
                })
                .unwrap_or_default()
        };
        let paths = read("SELECT path FROM repos");
        let bound = read(
            "SELECT folder_path FROM groups WHERE folder_path IS NOT NULL AND folder_path != ''",
        );
        (paths, bound)
    };

    let mut desired: HashMap<PathBuf, RecursiveMode> = HashMap::new();
    for repo in paths.iter().filter_map(|p| git::open(Path::new(p)).ok()) {
        if let Some(work) = repo.workdir() {
            // Non-bare: watch the whole working tree (also covers its `.git`).
            desired.insert(work.to_path_buf(), RecursiveMode::Recursive);
        } else {
            // Bare: no work tree. Watch `refs/` (recursive) for branch/tag
            // changes and the git dir non-recursively for HEAD/packed-refs/
            // index — but NOT the object store, which would flood on every
            // loose object written during a fetch.
            let git_dir = repo.path().to_path_buf();
            desired.insert(git_dir.join("refs"), RecursiveMode::Recursive);
            desired.insert(git_dir, RecursiveMode::NonRecursive);
        }
    }

    // Watch each folder-bound group's folder recursively so newly-cloned repos
    // anywhere beneath it are detected. The prune list is honored at scan time,
    // not here, so heavy dirs (node_modules, …) are skipped when we re-discover.
    let mut bound_canonical: Vec<PathBuf> = Vec::new();
    for folder in &bound {
        let pb = PathBuf::from(folder);
        if !pb.is_dir() {
            continue;
        }
        let canonical = pb.canonicalize().unwrap_or_else(|_| pb.clone());
        desired.insert(canonical.clone(), RecursiveMode::Recursive);
        bound_canonical.push(canonical);
    }
    if let Ok(mut g) = state.bound_folders.lock() {
        *g = bound_canonical;
    }

    if let Ok(mut guard) = state.watcher.lock() {
        if let Some(w) = guard.as_mut() {
            w.sync(desired);
        }
    }
}
