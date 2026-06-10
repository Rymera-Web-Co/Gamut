use std::path::PathBuf;

use git2::BranchType;
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::commands::history::open_repo;
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

    Ok(Repo {
        id,
        path,
        name,
        default_branch,
        last_opened,
        created_at,
        tag_ids: ids_for(conn, "SELECT tag_id FROM repo_tags WHERE repo_id = ?1", id)?,
        group_ids: ids_for(conn, "SELECT group_id FROM repo_groups WHERE repo_id = ?1", id)?,
    })
}

#[tauri::command]
pub fn list_repos(state: State<AppState>) -> AppResult<Vec<Repo>> {
    let conn = lock(&state)?;
    let ids: Vec<i64> = {
        let mut stmt =
            conn.prepare("SELECT id FROM repos ORDER BY sort, name COLLATE NOCASE")?;
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
    let pb = PathBuf::from(&path);
    let repo = git::open(&pb)?;
    let name = git::repo_name(&pb);
    let branch = git::current_branch(&repo);

    let conn = lock(&state)?;
    let canonical = pb
        .canonicalize()
        .map(|p| p.display().to_string())
        .unwrap_or(path);

    conn.execute(
        "INSERT INTO repos (path, name, default_branch) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, default_branch = excluded.default_branch",
        rusqlite::params![canonical, name, branch],
    )?;
    let id: i64 = conn.query_row("SELECT id FROM repos WHERE path = ?1", [&canonical], |r| {
        r.get(0)
    })?;
    load_repo(&conn, id)
}

#[tauri::command]
pub fn remove_repo(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM repos WHERE id = ?1", [id])?;
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
}

/// Per-repo current branch and ahead/behind vs its upstream (local-only; the
/// behind count reflects the last fetch — "new commits available" after fetching).
#[tauri::command]
pub fn repo_statuses(state: State<AppState>) -> AppResult<Vec<RepoStatus>> {
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

    let mut out = Vec::with_capacity(rows.len());
    for (id, path) in rows {
        let mut status = RepoStatus {
            id,
            branch: None,
            ahead: 0,
            behind: 0,
        };
        if let Ok(repo) = git::open(std::path::Path::new(&path)) {
            if let Ok(head) = repo.head() {
                status.branch = head.shorthand().map(|s| s.to_string());
                if head.is_branch() {
                    if let Some(b) = &status.branch {
                        if let Ok(local) = repo.find_branch(b, BranchType::Local) {
                            if let Ok(up) = local.upstream() {
                                if let (Some(l), Some(u)) =
                                    (local.get().target(), up.get().target())
                                {
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
        out.push(status);
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
}

/// List local and remote branches; the current branch is flagged `is_head`.
#[tauri::command]
pub fn list_branches(state: State<AppState>, repo_id: i64) -> AppResult<Vec<BranchInfo>> {
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
pub fn list_git_tags(state: State<AppState>, repo_id: i64) -> AppResult<Vec<String>> {
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
#[tauri::command]
pub fn checkout_branch(state: State<AppState>, repo_id: i64, name: String) -> AppResult<()> {
    let repo = open_repo(&state, repo_id)?;
    let obj = repo.revparse_single(&name)?;
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
    let found = git::discover(&PathBuf::from(&root), max_depth.unwrap_or(6));
    let conn = lock(&state)?;

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
