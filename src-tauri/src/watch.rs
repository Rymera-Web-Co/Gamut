//! Filesystem watcher over each registered repo's working tree, so changes made
//! outside the app — a branch switch or commit in a terminal, *and* a file
//! edited in another editor/IDE — are reflected live.
//!
//! A non-bare repo's working tree is watched *top-level hybrid*: the tree root
//! non-recursively (root files, and to notice new top-level directories) plus
//! each non-pruned top-level subdirectory recursively. Registered plain
//! folders (a docs dir, a workspace, a bound group's root entry) are watched
//! the same way — they have Files tabs whose open file and dir listings must
//! stay live too — except top-level children that are registered entries
//! themselves are skipped, since those get their own watches and attribution.
//! `.git` and heavy or generated directories (`node_modules`, `target`,
//! `dist`, …) are left out of the OS watch entirely, so their churn never
//! reaches the process — rather than being watched and then discarded, which
//! wakes the process constantly (a background fetch writes loose objects
//! across the fleet; a dev server rewrites `node_modules`/`dist`). The git dir
//! and `refs/` are watched separately (never the object store) so
//! branch/commit state is still seen, and so is a repo whose git dir lives
//! outside its working tree. Bare repos have no work tree, so only their
//! `refs/` and top-level git-state files are watched.
//!
//! This keeps the number of OS watches bounded — a repo's top-level fan-out,
//! not one-per-directory. A large fleet spread over tens of thousands of
//! directories would otherwise blow past the per-process filesystem-watch
//! limit, and the excess registrations fail silently, leaving most repos
//! unwatched (see `sync`, `RepoWatcher::failed`). New top-level directories are
//! given their own recursive watch as they appear (`learn_new_dirs`).
//!
//! Folder-bound groups are watched non-recursively (their immediate children)
//! for the same reason: a recursive watch of a group folder would re-cover
//! every repo's `node_modules`/`.git` under it. A repo cloned directly into a
//! group folder is detected live: an event under a bound folder that no
//! registered repo accounts for (`suggests_new_repo`) triggers an add-only
//! discovery sync, followed by a watcher resync so the new repo's tree gets
//! its own watches. A repo cloned into a deeper subdirectory is picked up on
//! the next discovery sync rather than instantly.
//!
//! A debounced batch emits a single `repos-changed` event to the frontend,
//! carrying the ids of the repos whose watched directory actually contained a
//! changed path (or `None` when the affected repos can't be narrowed down, e.g.
//! a folder-bound group just added new repos) so the frontend can scope its
//! refetch instead of re-scanning every repo (#206). Events are filtered
//! (`is_interesting`) so what little churn still reaches the process — a
//! working-tree file under a pruned dir, `.git` object/log noise — doesn't
//! trigger needless refreshes.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::git;
use crate::state::{AppState, WatchedDir};

/// Event name emitted when any watched repo's git state changes.
pub const REPOS_CHANGED: &str = "repos-changed";

pub struct RepoWatcher {
    debouncer: Debouncer<RecommendedWatcher>,
    /// The directories the OS watch layer actually accepted, each with its
    /// recursion mode: a repo's git-state paths, its working-tree root
    /// (non-recursive) and non-pruned top-level subdirectories (recursive), and
    /// each folder-bound group (non-recursive). Only successful `watch()` calls
    /// land here — see `sync`.
    watched: HashMap<PathBuf, RecursiveMode>,
    /// How many `watch()` calls the last `sync` could not register (e.g. the
    /// per-process filesystem-watch limit). Surfaced in diagnostics so a silent
    /// registration failure is visible rather than masquerading as a healthy
    /// watch count.
    failed: usize,
}

/// Whether a changed path warrants a UI refresh. A working-tree file counts
/// unless it sits under a pruned directory (`node_modules`, `target`, a
/// dotfile dir, …): under a recursive watch, build/install churn reaches the
/// OS layer, so it is discarded here instead of by not watching it. Inside
/// `.git`, only the entries that reflect repo state count — `HEAD`, `refs/`,
/// `packed-refs`, `index`, `worktrees` — so object/log churn (which fires
/// constantly during fetches and gc) doesn't spam the frontend.
fn is_interesting(path: &Path, prune: &[String]) -> bool {
    let comps: Vec<Component> = path.components().collect();
    let git_at = comps.iter().position(|c| match c {
        Component::Normal(name) => *name == OsStr::new(".git"),
        _ => false,
    });
    let Some(i) = git_at else {
        // No `.git` component -> a working-tree path. Drop it when an ancestor
        // directory is pruned so churn inside heavy/ignored trees is ignored.
        // Only ancestors are checked, never the final component — otherwise a
        // tracked root dotfile (`.gitignore`, `.env`) would be dropped, since
        // `is_pruned_dir` treats any dot-prefixed name as pruned.
        let ancestors = comps.len().saturating_sub(1);
        return !comps.iter().take(ancestors).any(|c| match c {
            Component::Normal(name) => git::is_pruned_dir(&name.to_string_lossy(), prune),
            _ => false,
        });
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

/// Resolves a batch of changed paths to the ids of the entries (repos and
/// plain folders) whose watched directory contains them, by prefix membership
/// against `watched` (entry root dir -> entry). Nested entries all match — a
/// path inside a folder that itself sits inside another registered folder
/// belongs to both. Returns `None` when no changed path matches a known
/// entry — a scope that can't be resolved (e.g. a stale watch during a resync
/// race) falls back to a full invalidation rather than silently dropping the
/// refresh.
fn resolve_changed_repo_ids(
    paths: &[&PathBuf],
    watched: &HashMap<PathBuf, WatchedDir>,
) -> Option<Vec<i64>> {
    let mut ids: Vec<i64> = Vec::new();
    for path in paths {
        for (dir, entry) in watched {
            if path.starts_with(dir) && !ids.contains(&entry.id) {
                ids.push(entry.id);
            }
        }
    }
    if ids.is_empty() {
        None
    } else {
        Some(ids)
    }
}

/// Minimum interval between watcher-triggered bound-folder discovery syncs
/// (`sync_all_bound_groups`) — each one is a full disk walk of every bound
/// tree. The trigger is already scoped to paths no registered repo accounts
/// for, so this only backstops pathological cases (e.g. sustained writes into
/// a non-repo folder that lives under a bound group folder).
const BOUND_DISCOVERY_MIN_INTERVAL: Duration = Duration::from_secs(15);

/// Whether a changed path might be a brand-new repo appearing under a bound
/// group folder: a *directory* under a bound folder that can't be attributed
/// to any registered *git* repo and isn't a pruned/hidden name (Finder's
/// `.DS_Store`, `node_modules`, …). The attribution check is what keeps this
/// trigger rare — every registered repo's working tree (or git dir, for a
/// bare repo) also lives under the bound folder, and their churn arrives
/// constantly from build tools and editors; without it, every batch would
/// re-walk the entire bound tree and peg a core. Only git entries mask:
/// registered plain folders are containers (a workspace, the bound root
/// entry) that a new repo can legitimately be cloned into. The directory
/// requirement keeps file churn inside those folders (someone editing docs)
/// from re-triggering the walk — a file can't be a repo.
fn suggests_new_repo(
    path: &Path,
    bound: &[PathBuf],
    watched: &HashMap<PathBuf, WatchedDir>,
    prune: &[String],
) -> bool {
    if !bound.iter().any(|b| path.starts_with(b)) {
        return false;
    }
    if watched
        .iter()
        .any(|(dir, entry)| entry.is_git && path.starts_with(dir))
    {
        return false;
    }
    if path
        .file_name()
        .is_some_and(|n| git::is_pruned_dir(&n.to_string_lossy(), prune))
    {
        return false;
    }
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

impl RepoWatcher {
    pub fn new(app: AppHandle, debounce_ms: u64) -> Result<Self, Box<dyn std::error::Error>> {
        // Last watcher-triggered bound-folder discovery sync, for the throttle
        // below. Only ever touched from the debouncer callback.
        let mut last_bound_discovery: Option<Instant> = None;
        let debouncer = new_debouncer(
            Duration::from_millis(debounce_ms),
            move |res: DebounceEventResult| {
                let Ok(events) = res else { return };
                let state = app.state::<AppState>();

                let prune = crate::commands::repo::watch_prune_dirs(&state);
                let watched = state
                    .watched_entry_dirs
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let bound: Vec<PathBuf> = state
                    .bound_folders
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();

                // A path under a bound folder that no registered repo accounts
                // for may be a new clone — run an add-only discovery sync (see
                // `suggests_new_repo` for why attribution, plus the interval
                // throttle, gate it). The added repos aren't in
                // `watched_entry_dirs` yet, so scope is unknown; and since bound
                // folders are watched non-recursively, nothing covers a new
                // repo's tree until the resync lands.
                let maybe_new_repo = events
                    .iter()
                    .any(|e| suggests_new_repo(&e.path, &bound, &watched, &prune));
                let throttled = last_bound_discovery
                    .is_some_and(|t| t.elapsed() < BOUND_DISCOVERY_MIN_INTERVAL);
                if maybe_new_repo && !throttled {
                    last_bound_discovery = Some(Instant::now());
                    let added = crate::commands::repo::sync_all_bound_groups(&state);
                    if added > 0 {
                        resync(&app);
                        let _ = app.emit(REPOS_CHANGED, Option::<Vec<i64>>::None);
                        return;
                    }
                }

                // A repo root is watched non-recursively, so a new top-level
                // directory created directly under it needs its own recursive
                // watch to pick up changes inside it. Anything deeper is already
                // covered by its top-level ancestor's recursive watch.
                let candidates: Vec<&PathBuf> = events.iter().map(|e| &e.path).collect();
                let repo_roots: HashSet<PathBuf> = watched.keys().cloned().collect();
                if let Ok(mut guard) = state.watcher.lock() {
                    if let Some(w) = guard.as_mut() {
                        w.learn_new_dirs(&candidates, &repo_roots, &prune);
                    }
                }

                // Emit only when the batch touched something worth a refresh (a
                // working-tree file outside a pruned dir, or a git-state ref),
                // not build/install churn or internal `.git` object/log noise —
                // and resolve which repo(s) the changed paths belong to so the
                // frontend can scope its refetch to just those repos.
                let interesting: Vec<&PathBuf> = candidates
                    .into_iter()
                    .filter(|p| is_interesting(p, &prune))
                    .collect();
                if interesting.is_empty() {
                    return;
                }
                let _ = app.emit(
                    REPOS_CHANGED,
                    resolve_changed_repo_ids(&interesting, &watched),
                );
            },
        )?;
        Ok(Self {
            debouncer,
            watched: HashMap::new(),
            failed: 0,
        })
    }

    /// Number of directories the OS watch layer is actually watching.
    pub fn watched_count(&self) -> usize {
        self.watched.len()
    }

    /// Number of `watch()` calls the last `sync` could not register.
    pub fn failed_count(&self) -> usize {
        self.failed
    }

    /// Watch exactly the given set of directories (add new, drop removed), each
    /// with its requested recursion mode. Only registrations the OS accepts are
    /// retained; failures are counted (`failed_count`) rather than silently
    /// treated as watched, so a registration cap surfaces in diagnostics.
    pub fn sync(&mut self, desired: HashMap<PathBuf, RecursiveMode>) {
        let watcher = self.debouncer.watcher();
        let mut next: HashMap<PathBuf, RecursiveMode> = HashMap::new();
        let mut failed = 0usize;
        for (dir, mode) in &desired {
            // Already watched with the same mode -> keep as-is, no re-register.
            if self.watched.get(dir) == Some(mode) {
                next.insert(dir.clone(), *mode);
                continue;
            }
            // A mode change re-registers; unwatch the stale entry first.
            if self.watched.contains_key(dir) {
                let _ = watcher.unwatch(dir);
            }
            match watcher.watch(dir, *mode) {
                Ok(()) => {
                    next.insert(dir.clone(), *mode);
                }
                Err(_) => failed += 1,
            }
        }
        for dir in self.watched.keys() {
            if !desired.contains_key(dir) {
                let _ = watcher.unwatch(dir);
            }
        }
        self.watched = next;
        self.failed = failed;
    }

    /// Give any newly-created top-level directory (a direct child of a watched
    /// repo root) its own recursive watch, so edits inside it are seen without
    /// waiting for the next full resync. `.git` and pruned dirs are skipped,
    /// matching `workdir_watch_dirs`; directories deeper than top level are
    /// already covered by their ancestor's recursive watch and are ignored.
    pub fn learn_new_dirs(
        &mut self,
        candidates: &[&PathBuf],
        repo_roots: &HashSet<PathBuf>,
        prune: &[String],
    ) {
        for dir in new_top_level_dirs(candidates, &self.watched, repo_roots, prune) {
            if self
                .debouncer
                .watcher()
                .watch(&dir, RecursiveMode::Recursive)
                .is_ok()
            {
                self.watched.insert(dir, RecursiveMode::Recursive);
            }
        }
    }
}

/// The watches for an entry's tree (a non-bare repo's working tree, or a
/// registered plain folder): the root (non-recursive, for root-level files
/// and to notice new top-level dirs) plus each top-level subdirectory
/// recursively, skipping `.git` (watched via git-state paths), pruned dirs
/// (`node_modules`, `target`, …), and top-level children in `skip` (other
/// registered entries — nested repos and folders get their own watches and
/// attribution, so re-covering them here would only duplicate events). Heavy
/// or generated trees are kept out of the OS watch entirely so their churn
/// never reaches the process, while the watch count stays bounded to the
/// entry's top-level fan-out. `symlink_metadata` never follows symlinks, so a
/// symlinked top-level entry isn't descended into.
fn workdir_watch_dirs(
    work: &Path,
    prune: &[String],
    skip: &HashSet<PathBuf>,
) -> Vec<(PathBuf, RecursiveMode)> {
    let mut out = vec![(work.to_path_buf(), RecursiveMode::NonRecursive)];
    let Ok(entries) = std::fs::read_dir(work) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == ".git" || git::is_pruned_dir(&name, prune) || skip.contains(&path) {
            continue;
        }
        out.push((path, RecursiveMode::Recursive));
    }
    out
}

/// Among `candidates` (paths touched by a debounced batch), the new top-level
/// directories that should start being watched recursively: a direct child of
/// a watched repo root, not already watched, still a directory, and not `.git`
/// or pruned. Uses `symlink_metadata` so a symlinked entry isn't followed.
fn new_top_level_dirs(
    candidates: &[&PathBuf],
    already_watched: &HashMap<PathBuf, RecursiveMode>,
    repo_roots: &HashSet<PathBuf>,
    prune: &[String],
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for path in candidates {
        if already_watched.contains_key(*path) || out.contains(*path) {
            continue;
        }
        // Only a direct child of a repo root — anything deeper is already
        // covered by its top-level ancestor's recursive watch.
        if !path.parent().is_some_and(|p| repo_roots.contains(p)) {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if name == ".git" || git::is_pruned_dir(&name, prune) {
            continue;
        }
        if !std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        out.push((*path).clone());
    }
    out
}

/// Recompute the set of repo git dirs from the DB and update the watcher.
///
/// Registering a recursive `watch()` per repo is not free — on macOS each call
/// does a full `FSEventStreamCreate`, so a large repo fleet can take a while to
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
    // Every registered entry's path, so an entry's tree walk can skip
    // top-level children that are entries themselves (see workdir_watch_dirs).
    let registered: HashSet<PathBuf> = repos.iter().map(|(_, p)| PathBuf::from(p)).collect();
    let mut desired: HashMap<PathBuf, RecursiveMode> = HashMap::new();
    // Watched entry root directory -> entry, so the debounced callback can
    // resolve a changed path back to the entries it belongs to (#206).
    let mut repo_dirs: HashMap<PathBuf, WatchedDir> = HashMap::new();
    for (id, path) in &repos {
        let Ok(repo) = git::open(Path::new(path)) else {
            // Not a git repo — a registered plain folder (a docs dir, a
            // workspace, a bound group's root entry). Watch its tree like a
            // working tree so the Files tab's open file and dir listings stay
            // live when files change outside the app. `is_dir` also filters
            // out registered single-file entries and missing paths.
            let folder = Path::new(path);
            if folder.is_dir() {
                for (dir, mode) in workdir_watch_dirs(folder, &prune, &registered) {
                    desired.insert(dir, mode);
                }
                repo_dirs.insert(
                    folder.to_path_buf(),
                    WatchedDir {
                        id: *id,
                        is_git: false,
                    },
                );
            }
            continue;
        };

        // Watch `refs/` (recursive) for branch/tag changes and the git dir
        // non-recursively for HEAD/packed-refs/index/worktrees — but NOT the
        // object store, which would flood on every loose object written during
        // a fetch. This covers bare repos and a repo whose git dir lives
        // outside its working tree (a separate git dir, a linked worktree);
        // for an in-tree `.git` it overlaps the recursive workdir watch below,
        // which is harmless (the debouncer coalesces).
        let git_dir = repo.path().to_path_buf();
        desired.insert(git_dir.join("refs"), RecursiveMode::Recursive);
        desired.insert(git_dir.clone(), RecursiveMode::NonRecursive);

        // Linked-worktree metadata lives in `<git_dir>/worktrees/<name>/`;
        // watching that directory non-recursively catches worktrees being added
        // or removed (each `<name>` is a direct child), which keeps a repo's
        // `has_worktrees` flag and worktree list live. The first worktree, which
        // creates `worktrees/` itself, is caught by the non-recursive git-dir
        // watch above.
        let worktrees_dir = git_dir.join("worktrees");
        if worktrees_dir.is_dir() {
            desired.insert(worktrees_dir, RecursiveMode::NonRecursive);
        }

        // Non-bare: watch the working tree top-level hybrid — root
        // non-recursively plus each non-pruned top-level subdirectory
        // recursively — so `.git` and heavy/generated dirs stay out of the OS
        // watch and their churn never reaches the process, while the watch
        // count stays bounded to the repo's top-level fan-out.
        match repo.workdir() {
            Some(work) => {
                for (dir, mode) in workdir_watch_dirs(work, &prune, &registered) {
                    desired.insert(dir, mode);
                }
                repo_dirs.insert(
                    work.to_path_buf(),
                    WatchedDir {
                        id: *id,
                        is_git: true,
                    },
                );
            }
            None => {
                repo_dirs.insert(
                    git_dir,
                    WatchedDir {
                        id: *id,
                        is_git: true,
                    },
                );
            }
        }
    }
    if let Ok(mut g) = state.watched_entry_dirs.lock() {
        *g = repo_dirs;
    }

    // Watch each folder-bound group's folder non-recursively, so a repo cloned
    // directly into it is detected without recursively watching the whole tree
    // beneath it — which would re-cover every repo's `node_modules`/`.git` and
    // flood the process with churn. A repo cloned into a deeper subdirectory is
    // picked up on the next resync rather than instantly.
    let mut bound_canonical: Vec<PathBuf> = Vec::new();
    for folder in &bound {
        let pb = PathBuf::from(folder);
        if !pb.is_dir() {
            continue;
        }
        let canonical = pb.canonicalize().unwrap_or_else(|_| pb.clone());
        desired.insert(canonical.clone(), RecursiveMode::NonRecursive);
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

    #[test]
    fn is_interesting_flags_working_tree_files_and_git_state() {
        let prune: &[String] = &[];
        assert!(is_interesting(Path::new("/repo/src/main.rs"), prune));
        assert!(is_interesting(Path::new("/repo/.git/HEAD"), prune));
        assert!(is_interesting(
            Path::new("/repo/.git/refs/heads/main"),
            prune
        ));
        assert!(is_interesting(Path::new("/repo/.git"), prune));
        assert!(is_interesting(Path::new("/repo/.git/worktrees"), prune));
        assert!(is_interesting(
            Path::new("/repo/.git/worktrees/feat-1"),
            prune
        ));
    }

    #[test]
    fn is_interesting_ignores_git_object_and_log_churn() {
        let prune: &[String] = &[];
        assert!(!is_interesting(
            Path::new("/repo/.git/objects/ab/cdef1234"),
            prune
        ));
        assert!(!is_interesting(Path::new("/repo/.git/logs/HEAD"), prune));
    }

    #[test]
    fn is_interesting_ignores_pruned_working_tree_churn() {
        // Top-level heavy dirs are left unwatched, but churn under a nested
        // pruned dir (e.g. a monorepo's packages/*/node_modules) still reaches
        // the process, so it must also be dropped at the event filter.
        let prune = vec!["node_modules".to_string(), "target".to_string()];
        assert!(!is_interesting(
            Path::new("/repo/node_modules/pkg/index.js"),
            &prune
        ));
        assert!(!is_interesting(Path::new("/repo/target/debug/foo"), &prune));
        // Dotfile dirs are pruned regardless of the configured list.
        assert!(!is_interesting(Path::new("/repo/.venv/lib/x.py"), &prune));
        // A real source edit still counts.
        assert!(is_interesting(Path::new("/repo/src/lib.rs"), &prune));
        // A tracked root dotfile is NOT pruned — only ancestor dirs are checked,
        // never the changed file itself.
        assert!(is_interesting(Path::new("/repo/.gitignore"), &prune));
        assert!(is_interesting(Path::new("/repo/.env"), &prune));
        // `.git` state is unaffected by the working-tree prune filter.
        assert!(is_interesting(Path::new("/repo/.git/HEAD"), &prune));
    }

    fn git_entry(id: i64) -> WatchedDir {
        WatchedDir { id, is_git: true }
    }

    fn folder_entry(id: i64) -> WatchedDir {
        WatchedDir { id, is_git: false }
    }

    #[test]
    fn resolves_single_repo() {
        let watched = HashMap::from([(PathBuf::from("/repos/a"), git_entry(1))]);
        let path = PathBuf::from("/repos/a/.git/refs/heads/main");
        assert_eq!(resolve_changed_repo_ids(&[&path], &watched), Some(vec![1]));
    }

    #[test]
    fn resolves_multiple_distinct_repos_without_duplicates() {
        let watched = HashMap::from([
            (PathBuf::from("/repos/a"), git_entry(1)),
            (PathBuf::from("/repos/b"), git_entry(2)),
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
        let watched = HashMap::from([(PathBuf::from("/repos/a"), git_entry(1))]);
        let path = PathBuf::from("/somewhere/else/file.txt");
        assert_eq!(resolve_changed_repo_ids(&[&path], &watched), None);
    }

    #[test]
    fn matches_bare_repo_refs_dir_under_git_dir() {
        // Bare repos are keyed by their git dir; `refs/` is a subpath of it.
        let watched = HashMap::from([(PathBuf::from("/repos/bare.git"), git_entry(7))]);
        let path = PathBuf::from("/repos/bare.git/refs/heads/main");
        assert_eq!(resolve_changed_repo_ids(&[&path], &watched), Some(vec![7]));
    }

    #[test]
    fn resolves_plain_folder_entries_and_nested_entries() {
        // A registered plain folder resolves like a repo; a path inside a
        // nested entry belongs to both the entry and its containing folder.
        let watched = HashMap::from([
            (PathBuf::from("/work/space"), folder_entry(3)),
            (PathBuf::from("/work/space/app"), git_entry(4)),
        ]);
        let doc = PathBuf::from("/work/space/notes.md");
        assert_eq!(resolve_changed_repo_ids(&[&doc], &watched), Some(vec![3]));
        let nested = PathBuf::from("/work/space/app/src/main.rs");
        let mut ids = resolve_changed_repo_ids(&[&nested], &watched).unwrap();
        ids.sort();
        assert_eq!(ids, vec![3, 4]);
    }

    #[test]
    fn suggests_new_repo_only_for_unattributed_dirs_under_bound_folders() {
        let root = temp_root("gamut_watch_suggests_new_repo_test");
        let repo = root.join("app");
        let folder = root.join("workspace");
        let clone_in_folder = folder.join("fresh-clone");
        let fresh = root.join("new-clone");
        let pruned = root.join("node_modules");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::create_dir_all(&clone_in_folder).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::create_dir_all(&pruned).unwrap();
        let doc = folder.join("notes.md");
        std::fs::write(&doc, "x").unwrap();

        let bound = vec![root.clone()];
        let watched = HashMap::from([
            (repo.clone(), git_entry(1)),
            (folder.clone(), folder_entry(2)),
        ]);
        let prune = vec!["node_modules".to_string()];

        // A new dir under the bound folder that no git repo accounts for.
        assert!(suggests_new_repo(&fresh, &bound, &watched, &prune));
        // A new dir inside a registered *plain folder* still counts — folders
        // are containers a repo can be cloned into, so they don't mask.
        assert!(suggests_new_repo(
            &clone_in_folder,
            &bound,
            &watched,
            &prune
        ));
        // Anything under a git repo is attributed, never a walk trigger.
        assert!(!suggests_new_repo(
            &repo.join("src"),
            &bound,
            &watched,
            &prune
        ));
        assert!(!suggests_new_repo(&repo, &bound, &watched, &prune));
        // A file is never a new repo — doc edits in a folder don't walk.
        assert!(!suggests_new_repo(&doc, &bound, &watched, &prune));
        // Pruned names and paths outside any bound folder don't trigger.
        assert!(!suggests_new_repo(&pruned, &bound, &watched, &prune));
        assert!(!suggests_new_repo(
            Path::new("/elsewhere/thing"),
            &bound,
            &watched,
            &prune
        ));

        std::fs::remove_dir_all(&root).unwrap();
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    #[test]
    fn workdir_watch_dirs_is_top_level_and_skips_pruned_git_and_registered() {
        let work = temp_root("gamut_watch_workdir_toplevel_test");
        std::fs::create_dir_all(work.join("src/nested")).unwrap();
        std::fs::create_dir_all(work.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(work.join("target/debug")).unwrap();
        std::fs::create_dir_all(work.join(".git/objects")).unwrap();
        std::fs::create_dir_all(work.join("vendored-repo")).unwrap();

        let prune = vec!["node_modules".to_string(), "target".to_string()];
        // A top-level child that is a registered entry itself gets its own
        // watches and attribution — its parent must not re-cover it.
        let registered = HashSet::from([work.join("vendored-repo")]);
        let dirs = workdir_watch_dirs(&work, &prune, &registered);

        // Root watched non-recursively.
        assert!(dirs.contains(&(work.clone(), RecursiveMode::NonRecursive)));
        // Top-level source dir watched recursively (its nested dir is covered by
        // that recursive watch, not listed separately).
        assert!(dirs.contains(&(work.join("src"), RecursiveMode::Recursive)));
        assert!(!dirs.iter().any(|(d, _)| *d == work.join("src/nested")));
        // Heavy/generated dirs, `.git`, and registered children are left out of
        // the OS watch entirely.
        assert!(!dirs
            .iter()
            .any(|(d, _)| d.starts_with(work.join("node_modules"))));
        assert!(!dirs.iter().any(|(d, _)| d.starts_with(work.join("target"))));
        assert!(!dirs.iter().any(|(d, _)| d.starts_with(work.join(".git"))));
        assert!(!dirs
            .iter()
            .any(|(d, _)| d.starts_with(work.join("vendored-repo"))));

        std::fs::remove_dir_all(&work).unwrap();
    }

    #[test]
    fn new_top_level_dirs_learns_only_direct_children_of_a_repo_root() {
        let root = temp_root("gamut_watch_new_toplevel_test");
        let fresh = root.join("feature");
        let deep = root.join("src/deep");
        let pruned = root.join("node_modules");
        let already = root.join("docs");
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(&pruned).unwrap();
        std::fs::create_dir_all(&already).unwrap();

        let repo_roots: HashSet<PathBuf> = HashSet::from([root.clone()]);
        let mut watched = HashMap::new();
        watched.insert(already.clone(), RecursiveMode::Recursive);
        let prune = vec!["node_modules".to_string()];

        let candidates = vec![&fresh, &deep, &pruned, &already];
        let found = new_top_level_dirs(&candidates, &watched, &repo_roots, &prune);

        // A new top-level dir directly under the repo root is learned.
        assert!(found.contains(&fresh));
        // A dir deeper than top level (parent isn't the repo root) is not.
        assert!(!found.contains(&deep));
        // Pruned and already-watched dirs are not.
        assert!(!found.contains(&pruned));
        assert!(!found.contains(&already));

        std::fs::remove_dir_all(&root).unwrap();
    }
}
