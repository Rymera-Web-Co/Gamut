use std::path::PathBuf;

use git2::BranchType;
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::commands::history::open_repo;
use crate::commands::settings;
use crate::error::{AppError, AppResult};
use crate::git;
use crate::state::AppState;

#[derive(Serialize)]
pub struct Repo {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub last_opened: Option<String>,
    pub created_at: String,
    pub tag_ids: Vec<i64>,
    pub group_ids: Vec<i64>,
    /// True when the repo's directory no longer exists on disk (e.g. it was
    /// deleted or moved out of a bound folder). Surfaced as a "missing" flag in
    /// the UI; folder sync never auto-removes such repos.
    pub missing: bool,
}

#[derive(Serialize)]
pub struct DiscoveredRepo {
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub already_registered: bool,
}

fn lock(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
    state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))
}

fn ids_for(conn: &Connection, sql: &str, repo_id: i64) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(sql)?;
    let ids = stmt
        .query_map([repo_id], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

fn load_repo(conn: &Connection, id: i64) -> AppResult<Repo> {
    let (path, name, default_branch, last_opened, created_at) = conn.query_row(
        "SELECT path, name, default_branch, last_opened, created_at FROM repos WHERE id = ?1",
        [id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        },
    )?;

    let missing = !std::path::Path::new(&path).exists();

    Ok(Repo {
        id,
        path,
        name,
        default_branch,
        last_opened,
        created_at,
        tag_ids: ids_for(conn, "SELECT tag_id FROM repo_tags WHERE repo_id = ?1", id)?,
        group_ids: ids_for(
            conn,
            "SELECT group_id FROM repo_groups WHERE repo_id = ?1",
            id,
        )?,
        missing,
    })
}

/// Register a repo path into the DB (idempotent). Returns its row id and whether
/// the row was newly inserted (false = it already existed). Shared by the manual
/// `register_repo` command and folder auto-sync. Errors if not a git repo.
fn register_path(conn: &Connection, path: &std::path::Path) -> AppResult<(i64, bool)> {
    let repo = git::open(path)?;
    let name = git::repo_name(path);
    let branch = git::current_branch(&repo);
    let canonical = path
        .canonicalize()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.display().to_string());
    let existed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM repos WHERE path = ?1)",
        [&canonical],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO repos (path, name, default_branch) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, default_branch = excluded.default_branch",
        rusqlite::params![canonical, name, branch],
    )?;
    let id = conn.query_row("SELECT id FROM repos WHERE path = ?1", [&canonical], |r| {
        r.get(0)
    })?;
    Ok((id, !existed))
}

/// Default recursion depth for folder discovery (matches the manual scan).
const SYNC_DEPTH: usize = 6;

/// Discovery depth + prune list, applying any `pref.` overrides. Reads from a
/// held connection so it's safe to call while the db lock is taken.
fn discovery_opts(conn: &Connection) -> (usize, Vec<String>) {
    let depth = settings::parsed_conn(conn, "pref.scanDepth", SYNC_DEPTH);
    let prune = settings::get_conn(conn, "pref.pruneDirs")
        .map(|raw| settings::parse_csv(&raw))
        .filter(|list| !list.is_empty())
        .unwrap_or_else(git::default_prune_dirs);
    (depth, prune)
}

/// Scan a bound group's folder and add (never remove) every discovered repo to
/// the group. Add-only and idempotent: repos already registered/assigned are
/// untouched. Honors the scanner's prune list. Stamps `last_scan_at`.
///
/// The default group is special: it surfaces *ungrouped* repos (no explicit
/// membership), so binding it auto-registers discovered repos without creating
/// `repo_groups` rows — registration alone makes them appear there. For any
/// other group, discovered repos are added as explicit members.
///
/// Returns the count of newly-surfaced repos (new memberships for a normal
/// group; newly-registered repos for the default group).
pub fn sync_folder_group(conn: &Connection, group_id: i64, folder: &str) -> AppResult<usize> {
    let is_default: bool = conn
        .query_row(
            "SELECT is_default FROM groups WHERE id = ?1",
            [group_id],
            |r| r.get::<_, i64>(0),
        )
        .map(|v| v != 0)
        .unwrap_or(false);

    let (depth, prune) = discovery_opts(conn);
    let mut added = 0usize;
    for d in git::discover(&PathBuf::from(folder), depth, &prune) {
        let Ok((repo_id, inserted)) = register_path(conn, &d.path) else {
            continue;
        };
        if is_default {
            if inserted {
                added += 1;
            }
        } else {
            added += conn.execute(
                "INSERT OR IGNORE INTO repo_groups (repo_id, group_id) VALUES (?1, ?2)",
                rusqlite::params![repo_id, group_id],
            )?;
        }
    }
    conn.execute(
        "UPDATE groups SET last_scan_at = datetime('now') WHERE id = ?1",
        [group_id],
    )?;
    Ok(added)
}

/// Sync every folder-bound group. Used by the filesystem watcher when a change
/// is seen under a bound folder. Returns the total number of new memberships
/// added across all groups. Does not resync the watcher — bound folders are
/// already watched recursively, so any new repo under them is already covered.
pub fn sync_all_bound_groups(state: &AppState) -> usize {
    let Ok(conn) = state.db.lock() else {
        return 0;
    };
    let bound: Vec<(i64, String)> = {
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, folder_path FROM groups
             WHERE folder_path IS NOT NULL AND folder_path != ''",
        ) else {
            return 0;
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default()
    };
    let mut total = 0;
    for (id, folder) in bound {
        total += sync_folder_group(&conn, id, &folder).unwrap_or(0);
    }
    total
}

/// Scan a single folder-bound group's folder now and add any new repos. Used
/// for the initial scan on bind and the "Rescan now" button. Returns the count
/// of newly-added repos.
#[tauri::command]
pub fn sync_group_folder(state: State<AppState>, group_id: i64) -> AppResult<usize> {
    let added = {
        let conn = lock(&state)?;
        let folder: Option<String> = conn.query_row(
            "SELECT folder_path FROM groups WHERE id = ?1",
            [group_id],
            |r| r.get(0),
        )?;
        match folder.filter(|p| !p.trim().is_empty()) {
            Some(folder) => sync_folder_group(&conn, group_id, &folder)?,
            None => return Ok(0),
        }
    };
    // Pick up newly-registered repos (and the folder itself) for watching.
    crate::watch::resync(&state);
    Ok(added)
}

#[tauri::command]
pub fn list_repos(state: State<AppState>) -> AppResult<Vec<Repo>> {
    let conn = lock(&state)?;
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM repos ORDER BY sort, name COLLATE NOCASE")?;
        let ids = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    };
    ids.into_iter().map(|id| load_repo(&conn, id)).collect()
}

/// Register a repo by path. Validates it's a git repo, derives name and
/// current branch. If the path is already registered, returns the existing row.
#[tauri::command]
pub fn register_repo(state: State<AppState>, path: String) -> AppResult<Repo> {
    let conn = lock(&state)?;
    let (id, _) = register_path(&conn, &PathBuf::from(&path))?;
    let repo = load_repo(&conn, id)?;
    drop(conn); // release the DB lock before resync re-reads it
    crate::watch::resync(&state);
    Ok(repo)
}

#[tauri::command]
pub fn remove_repo(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM repos WHERE id = ?1", [id])?;
    drop(conn); // release the DB lock before resync re-reads it
    crate::watch::resync(&state);
    Ok(())
}

/// Persist a new ordering for repos (drag-and-drop). `repo_ids` is the desired
/// order; each repo's `sort` is set to its index.
#[tauri::command]
pub fn reorder_repos(state: State<AppState>, repo_ids: Vec<i64>) -> AppResult<()> {
    let mut conn = lock(&state)?;
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE repos SET sort = ?1 WHERE id = ?2")?;
        for (idx, id) in repo_ids.iter().enumerate() {
            stmt.execute(rusqlite::params![idx as i64, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn touch_repo(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock(&state)?;
    conn.execute(
        "UPDATE repos SET last_opened = datetime('now') WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

#[derive(Serialize)]
pub struct RepoStatus {
    pub id: i64,
    pub branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    /// True when the working tree has staged, unstaged, or untracked changes.
    /// Surfaced as a dirty indicator in the sidebar.
    pub has_uncommitted_changes: bool,
}

/// Whether the repo's working tree has any uncommitted changes — staged,
/// unstaged, or untracked. Mirrors the dirty-tree detection in
/// `git_worktree_status` (HEAD → index plus index → working tree, untracked
/// included). HEAD may be unborn (a fresh repo) — then the index alone counts.
fn has_uncommitted_changes(repo: &git2::Repository) -> bool {
    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| c.tree().ok());
    let Ok(index) = repo.index() else {
        return false;
    };

    let staged_dirty = repo
        .diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
        .map(|d| d.deltas().len() > 0)
        .unwrap_or(false);
    if staged_dirty {
        return true;
    }

    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    repo.diff_index_to_workdir(Some(&index), Some(&mut opts))
        .map(|d| d.deltas().len() > 0)
        .unwrap_or(false)
}

/// Per-repo current branch and ahead/behind vs its upstream (local-only; the
/// behind count reflects the last fetch — "new commits available" after fetching).
#[tauri::command]
pub async fn repo_statuses(state: State<'_, AppState>) -> AppResult<Vec<RepoStatus>> {
    let started = std::time::Instant::now();
    let rows: Vec<(i64, String)> = {
        let conn = lock(&state)?;
        let mut stmt = conn.prepare("SELECT id, path FROM repos")?;
        let r = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        r
    };

    // Bound concurrency and get the blocking git2 work off the async runtime's
    // worker threads. This whole scan holds a single git-status permit, so it
    // can't stampede alongside per-repo worktree-status calls and trigger the
    // libiconv lock convoy (issue #89).
    let result = crate::commands::run_git_gated(&state, move || compute_repo_statuses(rows)).await;
    crate::commands::diagnostics::record(
        &state,
        crate::commands::diagnostics::OpTiming::finished(
            "repo_statuses",
            None,
            started,
            result.is_ok(),
            Some(
                result
                    .as_ref()
                    .map(|v| format!("{} repos", v.len()))
                    .unwrap_or_else(|e| e.to_string()),
            ),
        ),
    );
    result
}

/// Blocking core of [`repo_statuses`]: compute each repo's status from its path.
fn compute_repo_statuses(rows: Vec<(i64, String)>) -> AppResult<Vec<RepoStatus>> {
    Ok(rows
        .into_iter()
        .map(|(id, path)| compute_repo_status(id, &path))
        .collect())
}

/// Compute a single repo's branch and ahead/behind from its path. Never errors:
/// an unreadable repo just yields a zeroed status (matching the batch scan).
fn compute_repo_status(id: i64, path: &str) -> RepoStatus {
    let mut status = RepoStatus {
        id,
        branch: None,
        ahead: 0,
        behind: 0,
        has_uncommitted_changes: false,
    };
    if let Ok(repo) = git::open(std::path::Path::new(path)) {
        status.has_uncommitted_changes = has_uncommitted_changes(&repo);
        if let Ok(head) = repo.head() {
            status.branch = head.shorthand().map(|s| s.to_string());
            if head.is_branch() {
                if let Some(b) = &status.branch {
                    if let Ok(local) = repo.find_branch(b, BranchType::Local) {
                        if let Ok(up) = local.upstream() {
                            if let (Some(l), Some(u)) = (local.get().target(), up.get().target()) {
                                if let Ok((a, behind)) = repo.graph_ahead_behind(l, u) {
                                    status.ahead = a;
                                    status.behind = behind;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    status
}

/// Single-repo variant of [`repo_statuses`] — recompute one repo's branch and
/// ahead/behind without rescanning every registered repo. The frontend calls
/// this right after a pull/push lands new refs so the ahead/behind count updates
/// immediately, instead of waiting on a gated all-repos scan (#101). Still goes
/// through the git-status gate so it can't stampede the libiconv lock (#89).
#[tauri::command]
pub async fn repo_status(state: State<'_, AppState>, repo_id: i64) -> AppResult<RepoStatus> {
    let path = crate::commands::history::repo_path(&state, repo_id)?;
    let path = path.to_string_lossy().into_owned();
    crate::commands::run_git_gated(&state, move || Ok(compute_repo_status(repo_id, &path))).await
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
}

/// List local and remote branches; the current branch is flagged `is_head`.
#[tauri::command]
pub async fn list_branches(state: State<'_, AppState>, repo_id: i64) -> AppResult<Vec<BranchInfo>> {
    let repo = open_repo(&state, repo_id)?;
    let mut out = Vec::new();
    for kind in [BranchType::Local, BranchType::Remote] {
        for b in repo.branches(Some(kind))? {
            let (branch, _) = b?;
            if let Some(name) = branch.name()? {
                out.push(BranchInfo {
                    name: name.to_string(),
                    is_head: branch.is_head(),
                    is_remote: matches!(kind, BranchType::Remote),
                });
            }
        }
    }
    Ok(out)
}

/// List tag names in the repository.
#[tauri::command]
pub async fn list_git_tags(state: State<'_, AppState>, repo_id: i64) -> AppResult<Vec<String>> {
    let repo = open_repo(&state, repo_id)?;
    let mut names: Vec<String> = repo
        .tag_names(None)?
        .iter()
        .flatten()
        .map(|s| s.to_string())
        .collect();
    names.sort();
    Ok(names)
}

/// Check out a branch, tag, or commit (safe checkout — aborts if it would
/// overwrite local edits). Local branches stay attached; tags/commits detach HEAD.
///
/// `checkout_tree` rewrites every working-tree file that differs between the two
/// branches, so this runs on a blocking thread rather than the async runtime's
/// worker pool — otherwise a large checkout would tie up an IPC worker and stall
/// the UI (#100, sibling of #88).
#[tauri::command]
pub async fn checkout_branch(
    state: State<'_, AppState>,
    repo_id: i64,
    name: String,
) -> AppResult<()> {
    let path = crate::commands::history::repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(path, move |p| checkout_at(p, &name)).await
}

/// Blocking core of [`checkout_branch`]; opens the repo from `path`.
fn checkout_at(path: &std::path::Path, name: &str) -> AppResult<()> {
    let repo = git::open(path)?;
    let obj = repo.revparse_single(name)?;
    // Peel through annotated tags to the underlying commit.
    let commit = obj.peel_to_commit()?;

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.safe();
    repo.checkout_tree(commit.as_object(), Some(&mut checkout))?;

    let local_ref = format!("refs/heads/{name}");
    if repo.find_reference(&local_ref).is_ok() {
        repo.set_head(&local_ref)?;
    } else {
        // Tag / remote / arbitrary revision — detached HEAD.
        repo.set_head_detached(commit.id())?;
    }
    Ok(())
}

/// Scan a directory for git repos, flagging which are already registered.
#[tauri::command]
pub fn discover_repos(
    state: State<AppState>,
    root: String,
    max_depth: Option<usize>,
) -> AppResult<Vec<DiscoveredRepo>> {
    let conn = lock(&state)?;
    // An explicit `max_depth` (from a deeper manual scan) wins; otherwise fall
    // back to the configured discovery depth. The prune list always applies.
    let (depth, prune) = discovery_opts(&conn);
    let found = git::discover(&PathBuf::from(&root), max_depth.unwrap_or(depth), &prune);

    found
        .into_iter()
        .map(|d| {
            let canonical = d
                .path
                .canonicalize()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| d.path.display().to_string());
            let already_registered: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM repos WHERE path = ?1)",
                [&canonical],
                |r| r.get(0),
            )?;
            Ok(DiscoveredRepo {
                path: canonical,
                name: d.name,
                default_branch: d.default_branch,
                already_registered,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::path::Path;

    /// Commit a file so the repo has a HEAD to diff against.
    fn commit_file(repo: &Repository, name: &str, contents: &str) {
        let wd = repo.workdir().unwrap();
        std::fs::write(wd.join(name), contents).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let parents: Vec<git2::Commit> = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .into_iter()
            .collect();
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, "msg", &tree, &parent_refs)
            .unwrap();
    }

    #[test]
    fn detects_dirty_working_trees() {
        let root = std::env::temp_dir().join("gamut_dirty_test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = Repository::init(&root).unwrap();
        commit_file(&repo, "a.txt", "hello\n");

        // Clean working tree.
        assert!(!has_uncommitted_changes(&repo), "clean tree is not dirty");

        // Untracked file.
        std::fs::write(root.join("untracked.txt"), "new\n").unwrap();
        assert!(has_uncommitted_changes(&repo), "untracked file is dirty");
        std::fs::remove_file(root.join("untracked.txt")).unwrap();
        assert!(!has_uncommitted_changes(&repo), "back to clean");

        // Unstaged modification.
        std::fs::write(root.join("a.txt"), "hello world\n").unwrap();
        assert!(has_uncommitted_changes(&repo), "modified file is dirty");

        // Stage it — still dirty (staged change).
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        assert!(has_uncommitted_changes(&repo), "staged change is dirty");

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Minimal schema for exercising folder sync without the full migration runner.
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE repos (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 path TEXT NOT NULL UNIQUE,
                 name TEXT NOT NULL,
                 default_branch TEXT
             );
             CREATE TABLE groups (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL,
                 is_default INTEGER NOT NULL DEFAULT 0,
                 last_scan_at TEXT
             );
             CREATE TABLE repo_groups (
                 repo_id INTEGER NOT NULL,
                 group_id INTEGER NOT NULL,
                 PRIMARY KEY (repo_id, group_id)
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn folder_sync_adds_repos_once_and_is_idempotent() {
        let root = std::env::temp_dir().join("gamut_sync_test");
        let _ = std::fs::remove_dir_all(&root);
        Repository::init(root.join("a")).unwrap();
        Repository::init(root.join("sub/b")).unwrap();
        Repository::init(root.join("node_modules/c")).unwrap(); // pruned

        let conn = test_conn();
        conn.execute("INSERT INTO groups (id, name) VALUES (1, 'G')", [])
            .unwrap();

        let folder = root.to_string_lossy().to_string();
        let added = sync_folder_group(&conn, 1, &folder).unwrap();
        assert_eq!(added, 2, "a and b added; node_modules pruned");

        // Re-running is add-only: nothing new, no duplicates.
        let again = sync_folder_group(&conn, 1, &folder).unwrap();
        assert_eq!(again, 0, "second scan adds nothing");
        let members: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repo_groups WHERE group_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(members, 2);

        // last_scan_at is stamped.
        let stamped: Option<String> = conn
            .query_row("SELECT last_scan_at FROM groups WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(stamped.is_some());

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn default_group_sync_registers_without_membership() {
        let root = std::env::temp_dir().join("gamut_default_sync_test");
        let _ = std::fs::remove_dir_all(&root);
        Repository::init(root.join("a")).unwrap();
        Repository::init(root.join("b")).unwrap();

        let conn = test_conn();
        conn.execute(
            "INSERT INTO groups (id, name, is_default) VALUES (1, 'Default', 1)",
            [],
        )
        .unwrap();

        let folder = root.to_string_lossy().to_string();
        let added = sync_folder_group(&conn, 1, &folder).unwrap();
        assert_eq!(added, 2, "both repos newly registered");

        // Repos are registered...
        let repos: i64 = conn
            .query_row("SELECT COUNT(*) FROM repos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(repos, 2);
        // ...but the default group never gets explicit memberships (they show
        // as ungrouped instead).
        let members: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repo_groups WHERE group_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(members, 0);

        // Re-running surfaces nothing new.
        assert_eq!(sync_folder_group(&conn, 1, &folder).unwrap(), 0);

        std::fs::remove_dir_all(&root).unwrap();
    }
}
