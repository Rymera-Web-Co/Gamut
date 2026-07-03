//! Filesystem watcher over each registered repo's working tree, so changes made
//! outside the app — a branch switch or commit in a terminal, *and* a file
//! edited in another editor/IDE — are reflected live. A non-bare repo's working
//! tree is watched recursively (which also covers its `.git`); a debounced
//! batch emits a single `repos-changed` event to the frontend, carrying the ids
//! of the repos whose watched directory actually contained a changed path (or
//! `None` when the affected repos can't be narrowed down, e.g. a folder-bound
//! group just added new repos) so the frontend can scope its refetch instead of
//! re-scanning every repo (#206). Events are filtered so `.git` object/log
//! churn doesn't trigger needless refreshes — only working-tree files and the
//! refs/HEAD/index that reflect repo state count. Bare repos have no work
//! tree, so we watch only their `refs/` and top-level git-state files, never
//! the object store.

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

/// Resolves a batch of changed paths to the ids of the repos whose watched
/// directory contains them, by longest-match-agnostic prefix membership
/// against `watched` (repo root dir -> repo id). Returns `None` when no
/// changed path matches a known repo dir — a scope that can't be resolved
/// (e.g. a stale watch during a resync race) falls back to a full
/// invalidation rather than silently dropping the refresh.
fn resolve_changed_repo_ids(
    paths: &[&PathBuf],
    watched: &HashMap<PathBuf, i64>,
) -> Option<Vec<i64>> {
    let mut ids: Vec<i64> = Vec::new();
    for path in paths {
        for (dir, id) in watched {
            if path.starts_with(dir) && !ids.contains(id) {
                ids.push(*id);
            }
        }
    }
    if ids.is_empty() {
        None
    } else {
        Some(ids)
    }
}

impl RepoWatcher {
    pub fn new(app: AppHandle, debounce_ms: u64) -> Result<Self, Box<dyn std::error::Error>> {
        let debouncer = new_debouncer(
            Duration::from_millis(debounce_ms),
            move |res: DebounceEventResult| {
                let Ok(events) = res else { return };
                let state = app.state::<AppState>();

                // If a batch touched anything under a folder-bound group, a new
                // repo may have appeared — run an add-only sync. Bound folders
                // are watched recursively, so newly-added repos are already
                // covered; no watcher resync is needed here. The added repos
                // aren't in `watched_repo_dirs` yet, so scope is unknown.
                let bound: Vec<PathBuf> = state
                    .bound_folders
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let under_bound = !bound.is_empty()
                    && events
                        .iter()
                        .any(|e| bound.iter().any(|b| e.path.starts_with(b)));
                if under_bound {
                    let added = crate::commands::repo::sync_all_bound_groups(&state);
                    if added > 0 {
                        let _ = app.emit(REPOS_CHANGED, Option::<Vec<i64>>::None);
                        return;
                    }
                }

                // Otherwise emit only when the batch touched something worth a
                // refresh (a working-tree file or a git-state ref), not on
                // internal `.git` object/log noise — and resolve which repo(s)
                // the changed paths belong to so the frontend can scope its
                // refetch to just those repos.
                let interesting: Vec<&PathBuf> = events
                    .iter()
                    .map(|e| &e.path)
                    .filter(|p| is_interesting(p))
                    .collect();
                if interesting.is_empty() {
                    return;
                }

                let watched = state
                    .watched_repo_dirs
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let _ = app.emit(
                    REPOS_CHANGED,
                    resolve_changed_repo_ids(&interesting, &watched),
                );
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
    let (repos, bound): (Vec<(i64, String)>, Vec<String>) = {
        let Ok(conn) = state.db.lock() else { return };
        let repos = conn
            .prepare("SELECT id, path FROM repos")
            .and_then(|mut stmt| {
                stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                    .map(|it| it.filter_map(Result::ok).collect::<Vec<_>>())
            })
            .unwrap_or_default();
        let bound = conn
            .prepare("SELECT folder_path FROM groups WHERE folder_path IS NOT NULL AND folder_path != ''")
            .and_then(|mut stmt| {
                stmt.query_map([], |r| r.get::<_, String>(0))
                    .map(|it| it.filter_map(Result::ok).collect::<Vec<_>>())
            })
            .unwrap_or_default();
        (repos, bound)
    };

    let mut desired: HashMap<PathBuf, RecursiveMode> = HashMap::new();
    // Watched repo root directory -> repo id, so the debounced callback can
    // resolve a changed path back to the repo(s) it belongs to (#206).
    let mut repo_dirs: HashMap<PathBuf, i64> = HashMap::new();
    for (id, path) in &repos {
        let Ok(repo) = git::open(Path::new(path)) else {
            continue;
        };
        if let Some(work) = repo.workdir() {
            // Non-bare: watch the whole working tree (also covers its `.git`).
            desired.insert(work.to_path_buf(), RecursiveMode::Recursive);
            repo_dirs.insert(work.to_path_buf(), *id);
        } else {
            // Bare: no work tree. Watch `refs/` (recursive) for branch/tag
            // changes and the git dir non-recursively for HEAD/packed-refs/
            // index — but NOT the object store, which would flood on every
            // loose object written during a fetch.
            let git_dir = repo.path().to_path_buf();
            desired.insert(git_dir.join("refs"), RecursiveMode::Recursive);
            desired.insert(git_dir.clone(), RecursiveMode::NonRecursive);
            repo_dirs.insert(git_dir, *id);
        }
    }
    if let Ok(mut g) = state.watched_repo_dirs.lock() {
        *g = repo_dirs;
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

    #[test]
    fn resolves_single_repo() {
        let watched = HashMap::from([(PathBuf::from("/repos/a"), 1)]);
        let path = PathBuf::from("/repos/a/.git/refs/heads/main");
        assert_eq!(resolve_changed_repo_ids(&[&path], &watched), Some(vec![1]));
    }

    #[test]
    fn resolves_multiple_distinct_repos_without_duplicates() {
        let watched = HashMap::from([
            (PathBuf::from("/repos/a"), 1),
            (PathBuf::from("/repos/b"), 2),
        ]);
        let a1 = PathBuf::from("/repos/a/file.txt");
        let a2 = PathBuf::from("/repos/a/.git/HEAD");
        let b1 = PathBuf::from("/repos/b/file.txt");
        let mut ids = resolve_changed_repo_ids(&[&a1, &a2, &b1], &watched).unwrap();
        ids.sort();
        assert_eq!(ids, vec![1, 2]);
    }

    #[test]
    fn falls_back_to_none_when_no_repo_matches() {
        let watched = HashMap::from([(PathBuf::from("/repos/a"), 1)]);
        let path = PathBuf::from("/somewhere/else/file.txt");
        assert_eq!(resolve_changed_repo_ids(&[&path], &watched), None);
    }

    #[test]
    fn matches_bare_repo_refs_dir_under_git_dir() {
        // Bare repos are keyed by their git dir; `refs/` is a subpath of it.
        let watched = HashMap::from([(PathBuf::from("/repos/bare.git"), 7)]);
        let path = PathBuf::from("/repos/bare.git/refs/heads/main");
        assert_eq!(resolve_changed_repo_ids(&[&path], &watched), Some(vec![7]));
    }
}
