//! Filesystem watcher over each registered repo's working tree, so changes made
//! outside the app — a branch switch or commit in a terminal, *and* a file
//! edited in another editor/IDE — are reflected live. A non-bare repo's working
//! tree is watched directory-by-directory (non-recursively), skipping heavy or
//! ignored directories (`node_modules`, `target`, `.git`, …) so build/install
//! churn inside them never reaches the OS watch layer; newly created
//! directories are picked up as they appear. Its `.git` is watched the same way
//! bare repos are — `refs/` and top-level git-state files, never the object
//! store. A debounced batch emits a single `repos-changed` event to the
//! frontend. Events are further filtered so `.git` log churn doesn't trigger
//! needless refreshes — only working-tree files and the refs/HEAD/index that
//! reflect repo state count.

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
    /// The directories currently watched, each with its recursion mode: a
    /// repo's git-state paths, or one entry per (non-pruned) directory in a
    /// non-bare repo's working tree.
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

                // A watched directory is non-recursive, so a subdirectory
                // created inside it needs its own explicit watch to keep
                // picking up further changes (and any of its own
                // subdirectories already created alongside it, e.g. via
                // `mkdir -p`).
                let prune = crate::commands::repo::watch_prune_dirs(&app.state::<AppState>());
                if let Ok(mut guard) = app.state::<AppState>().watcher.lock() {
                    if let Some(w) = guard.as_mut() {
                        let candidates: Vec<PathBuf> =
                            events.iter().map(|e| e.path.clone()).collect();
                        w.learn_new_dirs(&candidates, &prune);
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

    /// Given paths touched by a debounced batch, watch any that are directories
    /// not already watched and aren't pruned — e.g. a directory just created
    /// inside a non-recursively watched working tree.
    pub fn learn_new_dirs(&mut self, candidates: &[PathBuf], prune: &[String]) {
        for dir in new_watchable_dirs(candidates, &self.watched, prune) {
            let _ = self
                .debouncer
                .watcher()
                .watch(&dir, RecursiveMode::NonRecursive);
            self.watched.insert(dir, RecursiveMode::NonRecursive);
        }
    }
}

/// Directories among `candidates` that should start being watched: not already
/// watched, still present as directories, and not pruned (`.git` included).
/// Recurses into each newly-found directory to pick up any subdirectories
/// already present, so `mkdir -p a/b/c` yields `a`, `b`, and `c` in one pass.
fn new_watchable_dirs(
    candidates: &[PathBuf],
    already_watched: &HashMap<PathBuf, RecursiveMode>,
    prune: &[String],
) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut queue: Vec<PathBuf> = candidates.to_vec();
    while let Some(dir) = queue.pop() {
        if already_watched.contains_key(&dir) || found.contains(&dir) || !dir.is_dir() {
            continue;
        }
        let name = dir.file_name().map(|n| n.to_string_lossy().into_owned());
        if name.as_deref() == Some(".git") || name.is_some_and(|n| git::is_pruned_dir(&n, prune)) {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            queue.extend(entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()));
        }
        found.push(dir);
    }
    found
}

/// Directories to watch non-recursively within a non-bare repo's working tree:
/// the tree root plus every subdirectory, skipping `.git` (watched separately
/// via git-state paths, like a bare repo) and heavy/ignored directories from
/// `prune` — so build/install churn inside e.g. `node_modules` never reaches
/// the OS watch layer.
fn workdir_watch_dirs(work: &Path, prune: &[String]) -> Vec<PathBuf> {
    let mut dirs = vec![work.to_path_buf()];
    let mut queue = vec![work.to_path_buf()];
    while let Some(dir) = queue.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == ".git" || git::is_pruned_dir(&name, prune) {
                continue;
            }
            dirs.push(path.clone());
            queue.push(path);
        }
    }
    dirs
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
    let prune = crate::commands::repo::watch_prune_dirs(state);

    let mut desired: HashMap<PathBuf, RecursiveMode> = HashMap::new();
    for repo in paths.iter().filter_map(|p| git::open(Path::new(p)).ok()) {
        // Watch `refs/` (recursive) for branch/tag changes and the git dir
        // non-recursively for HEAD/packed-refs/index — but NOT the object
        // store, which would flood on every loose object written during a
        // fetch. Applies to both bare repos and a non-bare repo's `.git`.
        let git_dir = repo.path().to_path_buf();
        desired.insert(git_dir.join("refs"), RecursiveMode::Recursive);
        desired.insert(git_dir, RecursiveMode::NonRecursive);

        // Non-bare: also watch the working tree directory-by-directory,
        // skipping heavy/ignored dirs so build/install churn inside e.g.
        // `node_modules` never reaches the OS watch layer.
        if let Some(work) = repo.workdir() {
            for dir in workdir_watch_dirs(work, &prune) {
                desired.insert(dir, RecursiveMode::NonRecursive);
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    fn touch_dir(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
    }

    #[test]
    fn is_interesting_flags_working_tree_files_and_git_state() {
        assert!(is_interesting(Path::new("/repo/src/main.rs")));
        assert!(is_interesting(Path::new("/repo/.git/HEAD")));
        assert!(is_interesting(Path::new("/repo/.git/refs/heads/main")));
        assert!(is_interesting(Path::new("/repo/.git")));
    }

    #[test]
    fn is_interesting_ignores_git_object_and_log_churn() {
        assert!(!is_interesting(Path::new("/repo/.git/objects/ab/cdef1234")));
        assert!(!is_interesting(Path::new("/repo/.git/logs/HEAD")));
    }

    #[test]
    fn workdir_watch_dirs_skips_pruned_and_git() {
        let work = temp_root("gamut_watch_workdir_test");
        touch_dir(&work.join("src/nested"));
        touch_dir(&work.join("node_modules/pkg"));
        touch_dir(&work.join(".git/objects"));

        let prune = vec!["node_modules".to_string()];
        let dirs = workdir_watch_dirs(&work, &prune);

        assert!(dirs.contains(&work));
        assert!(dirs.contains(&work.join("src")));
        assert!(dirs.contains(&work.join("src/nested")));
        assert!(!dirs
            .iter()
            .any(|d| d.starts_with(work.join("node_modules"))));
        assert!(!dirs.iter().any(|d| d.starts_with(work.join(".git"))));

        std::fs::remove_dir_all(&work).unwrap();
    }

    #[test]
    fn new_watchable_dirs_skips_already_watched_and_pruned() {
        let work = temp_root("gamut_watch_new_dirs_test");
        let existing = work.join("existing");
        let fresh = work.join("fresh");
        let fresh_nested = fresh.join("nested");
        let pruned = work.join("target");
        touch_dir(&existing);
        touch_dir(&fresh_nested);
        touch_dir(&pruned);

        let mut watched = HashMap::new();
        watched.insert(existing.clone(), RecursiveMode::NonRecursive);

        let prune = vec!["target".to_string()];
        let candidates = vec![existing.clone(), fresh.clone(), pruned.clone()];
        let found = new_watchable_dirs(&candidates, &watched, &prune);

        assert!(!found.contains(&existing));
        assert!(found.contains(&fresh));
        assert!(found.contains(&fresh_nested));
        assert!(!found.contains(&pruned));

        std::fs::remove_dir_all(&work).unwrap();
    }

    #[test]
    fn new_watchable_dirs_ignores_missing_paths() {
        let missing = std::env::temp_dir().join("gamut_watch_missing_dir_test");
        let _ = std::fs::remove_dir_all(&missing);
        let found = new_watchable_dirs(&[missing], &HashMap::new(), &[]);
        assert!(found.is_empty());
    }
}
