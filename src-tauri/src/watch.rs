//! Filesystem watcher over each registered repo's working tree, so changes made
//! outside the app — a branch switch or commit in a terminal, *and* a file
//! edited in another editor/IDE — are reflected live. A non-bare repo's working
//! tree is watched directory-by-directory (non-recursively), skipping heavy or
//! ignored directories (`node_modules`, `target`, `.git`, …) so build/install
//! churn inside them never reaches the OS watch layer; newly created
//! directories are picked up as they appear. Its `.git` is watched the same way
//! bare repos are — `refs/` and top-level git-state files, never the object
//! store. A debounced batch emits a single `repos-changed` event to the
//! frontend, carrying the ids of the repos whose watched directory actually
//! contained a changed path (or `None` when the affected repos can't be
//! narrowed down, e.g. a folder-bound group just added new repos) so the
//! frontend can scope its refetch instead of re-scanning every repo (#206).
//! Events are further filtered so `.git` log churn doesn't trigger needless
//! refreshes — only working-tree files and the refs/HEAD/index that reflect
//! repo state count.

use std::collections::{HashMap, HashSet};
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
            // `worktrees/` holds linked-worktree metadata — entries appearing or
            // disappearing there is how `git worktree add/remove` shows up.
            Some(
                "HEAD"
                    | "ORIG_HEAD"
                    | "MERGE_HEAD"
                    | "packed-refs"
                    | "index"
                    | "refs"
                    | "worktrees"
            )
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

                // A watched directory is non-recursive, so a subdirectory
                // created inside it needs its own explicit watch to keep
                // picking up further changes (and any of its own
                // subdirectories already created alongside it, e.g. via
                // `mkdir -p`).
                let prune = crate::commands::repo::watch_prune_dirs(&state);
                if let Ok(mut guard) = state.watcher.lock() {
                    if let Some(w) = guard.as_mut() {
                        let candidates: Vec<PathBuf> =
                            events.iter().map(|e| e.path.clone()).collect();
                        w.learn_new_dirs(&candidates, &prune);
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
/// Uses `symlink_metadata` (never follows symlinks) so a symlink cycle inside
/// the tree (e.g. `ln -s .. sub/link`) can't send this walk into unbounded
/// recursion the way the previous `RecursiveMode::Recursive` OS watch, whose
/// cycle handling this replaced, did not need to worry about.
fn new_watchable_dirs(
    candidates: &[PathBuf],
    already_watched: &HashMap<PathBuf, RecursiveMode>,
    prune: &[String],
) -> Vec<PathBuf> {
    let mut found: HashSet<PathBuf> = HashSet::new();
    let mut queue: Vec<PathBuf> = candidates.to_vec();
    while let Some(dir) = queue.pop() {
        if already_watched.contains_key(&dir) || found.contains(&dir) {
            continue;
        }
        let is_dir = std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir());
        if !is_dir {
            continue;
        }
        let name = dir.file_name().map(|n| n.to_string_lossy().into_owned());
        if name.as_deref() == Some(".git") || name.is_some_and(|n| git::is_pruned_dir(&n, prune)) {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            queue.extend(
                entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())),
            );
        }
        found.insert(dir);
    }
    found.into_iter().collect()
}

/// Directories to watch non-recursively within a non-bare repo's working tree:
/// the tree root plus every subdirectory, skipping `.git` (watched separately
/// via git-state paths, like a bare repo) and heavy/ignored directories from
/// `prune` — so build/install churn inside e.g. `node_modules` never reaches
/// the OS watch layer. Uses `symlink_metadata` (never follows symlinks) so a
/// symlink cycle inside the tree can't send this walk into unbounded recursion.
fn workdir_watch_dirs(work: &Path, prune: &[String]) -> Vec<PathBuf> {
    let mut dirs = vec![work.to_path_buf()];
    let mut queue = vec![work.to_path_buf()];
    while let Some(dir) = queue.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dir = std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
            if !is_dir {
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
///
/// Walking each repo's working tree and registering a watch per directory is
/// not cheap — on macOS in particular, every individual `watch()` call does a
/// full `FSEventStreamCreate`, so a large repo fleet can take a long time to
/// resync (#225). `resync` runs from the synchronous `.setup()` hook and from
/// synchronous `#[tauri::command]`s, both of which execute on Tauri's
/// main/UI thread, so the entire rebuild — including the DB read — runs on a
/// blocking thread instead of inline, the same hazard `git_worktree_status`
/// had before #88. `resync_lock` serializes overlapping rebuilds (e.g. two
/// repos added in quick succession) and, because the DB is re-read fresh only
/// after the lock is acquired, whichever rebuild runs last always reflects
/// the current DB state — so an out-of-order finish can no longer clobber a
/// newer rebuild with stale data (#226).
pub fn resync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            let _guard = state.resync_lock.lock().unwrap_or_else(|e| e.into_inner());
            resync_locked(&state);
        })
        .await;
        if let Err(e) = result {
            eprintln!("watcher resync task panicked: {e}");
        }
    });
}

/// The actual rebuild, run while `AppState::resync_lock` is held (see
/// `resync`).
fn resync_locked(state: &AppState) {
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
    let prune = crate::commands::repo::watch_prune_dirs(state);

    let mut desired: HashMap<PathBuf, RecursiveMode> = HashMap::new();
    // Watched repo root directory -> repo id, so the debounced callback can
    // resolve a changed path back to the repo(s) it belongs to (#206).
    let mut repo_dirs: HashMap<PathBuf, i64> = HashMap::new();
    for (id, path) in &repos {
        let Ok(repo) = git::open(Path::new(path)) else {
            continue;
        };

        // Watch `refs/` (recursive) for branch/tag changes and the git dir
        // non-recursively for HEAD/packed-refs/index — but NOT the object
        // store, which would flood on every loose object written during a
        // fetch. Applies to both bare repos and a non-bare repo's `.git`.
        let git_dir = repo.path().to_path_buf();
        desired.insert(git_dir.join("refs"), RecursiveMode::Recursive);
        desired.insert(git_dir.clone(), RecursiveMode::NonRecursive);

        // Linked-worktree metadata lives in `<git_dir>/worktrees/<name>/`;
        // watching that directory catches worktrees being added or removed.
        // When it doesn't exist yet, its own creation fires on the
        // non-recursive `git_dir` watch above and `learn_new_dirs` picks the
        // new directory up from that event.
        let worktrees_dir = git_dir.join("worktrees");
        if worktrees_dir.is_dir() {
            desired.insert(worktrees_dir, RecursiveMode::NonRecursive);
        }

        // Non-bare: also watch the working tree directory-by-directory,
        // skipping heavy/ignored dirs so build/install churn inside e.g.
        // `node_modules` never reaches the OS watch layer.
        match repo.workdir() {
            Some(work) => {
                for dir in workdir_watch_dirs(work, &prune) {
                    desired.insert(dir, RecursiveMode::NonRecursive);
                }
                repo_dirs.insert(work.to_path_buf(), *id);
            }
            None => {
                repo_dirs.insert(git_dir, *id);
            }
        }
    }
    if let Ok(mut g) = state.watched_repo_dirs.lock() {
        *g = repo_dirs;
    }

    // Watch each folder-bound group's folder recursively so newly-cloned
    // repos anywhere beneath it are detected. The prune list is honored at
    // scan time, not here, so heavy dirs (node_modules, …) are skipped
    // when we re-discover.
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
    };
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
        assert!(is_interesting(Path::new("/repo/.git/worktrees")));
        assert!(is_interesting(Path::new("/repo/.git/worktrees/feat-1")));
    }

    #[test]
    fn is_interesting_ignores_git_object_and_log_churn() {
        assert!(!is_interesting(Path::new("/repo/.git/objects/ab/cdef1234")));
        assert!(!is_interesting(Path::new("/repo/.git/logs/HEAD")));
    }

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

    #[cfg(unix)]
    #[test]
    fn workdir_watch_dirs_does_not_follow_symlink_cycle() {
        let work = temp_root("gamut_watch_symlink_cycle_test");
        touch_dir(&work.join("sub"));
        std::os::unix::fs::symlink(&work, work.join("sub/link")).unwrap();

        let dirs = workdir_watch_dirs(&work, &[]);

        assert!(dirs.contains(&work));
        assert!(dirs.contains(&work.join("sub")));
        assert!(!dirs.iter().any(|d| d.starts_with(work.join("sub/link"))));

        std::fs::remove_dir_all(&work).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn new_watchable_dirs_does_not_follow_symlink_cycle() {
        let work = temp_root("gamut_watch_new_dirs_symlink_cycle_test");
        touch_dir(&work.join("sub"));
        std::os::unix::fs::symlink(&work, work.join("sub/link")).unwrap();

        let found = new_watchable_dirs(std::slice::from_ref(&work), &HashMap::new(), &[]);

        assert!(found.contains(&work));
        assert!(found.contains(&work.join("sub")));
        assert!(!found.iter().any(|d| d.starts_with(work.join("sub/link"))));

        std::fs::remove_dir_all(&work).unwrap();
    }
}
