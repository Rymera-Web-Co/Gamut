use git2::BranchType;
use serde::Serialize;
use tauri::State;
use tokio::process::Command;

use crate::commands::history::{open_repo, repo_path};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Run a git CLI command in `dir`, returning stdout (or stderr on failure).
/// Network operations go through the CLI so they reuse the user's existing
/// credentials (ssh agent, credential helpers).
async fn run_git(dir: &str, args: &[&str]) -> AppResult<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .await
        .map_err(|e| AppError::Other(format!("failed to run git: {e}")))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let msg = String::from_utf8_lossy(&output.stderr);
        Err(AppError::Other(msg.trim().to_string()))
    }
}

#[derive(Serialize)]
pub struct SyncStatus {
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

/// Ahead/behind counts of the current branch vs its upstream (local-only; run
/// after a fetch to refresh the numbers).
#[tauri::command]
pub fn git_sync_status(state: State<AppState>, repo_id: i64) -> AppResult<SyncStatus> {
    let repo = open_repo(&state, repo_id)?;
    let none = SyncStatus {
        upstream: None,
        ahead: 0,
        behind: 0,
    };

    let head = match repo.head() {
        Ok(h) if h.is_branch() => h,
        _ => return Ok(none),
    };
    let Some(shorthand) = head.shorthand() else {
        return Ok(none);
    };
    let branch = repo.find_branch(shorthand, BranchType::Local)?;
    let upstream = match branch.upstream() {
        Ok(u) => u,
        Err(_) => return Ok(none),
    };

    let local_oid = branch.get().target();
    let up_oid = upstream.get().target();
    let (ahead, behind) = match (local_oid, up_oid) {
        (Some(l), Some(u)) => repo.graph_ahead_behind(l, u)?,
        _ => (0, 0),
    };

    Ok(SyncStatus {
        upstream: upstream.name().ok().flatten().map(|s| s.to_string()),
        ahead,
        behind,
    })
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, repo_id: i64) -> AppResult<String> {
    let dir = repo_path(&state, repo_id)?;
    run_git(&dir.to_string_lossy(), &["fetch", "--all", "--prune"]).await
}

#[tauri::command]
pub async fn git_pull(state: State<'_, AppState>, repo_id: i64) -> AppResult<String> {
    let dir = repo_path(&state, repo_id)?;
    run_git(&dir.to_string_lossy(), &["pull"]).await
}

#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, repo_id: i64) -> AppResult<String> {
    let dir = repo_path(&state, repo_id)?;
    run_git(&dir.to_string_lossy(), &["push"]).await
}
