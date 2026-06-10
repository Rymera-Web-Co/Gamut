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

/// Check out a pull request branch. If a local branch with the PR's head ref
/// already exists, just switch to it; otherwise fetch `pull/<n>/head` into a
/// local branch (works for same-repo and fork PRs) and switch to it.
#[tauri::command]
pub async fn git_checkout_pr(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
    head_ref: String,
) -> AppResult<String> {
    let dir = repo_path(&state, repo_id)?;
    let has_local = {
        let repo = open_repo(&state, repo_id)?;
        let exists = repo.find_branch(&head_ref, BranchType::Local).is_ok();
        exists
    };
    let dir = dir.to_string_lossy().to_string();

    if has_local {
        return run_git(&dir, &["switch", &head_ref]).await;
    }

    let refspec = format!("pull/{number}/head:{head_ref}");
    run_git(&dir, &["fetch", "origin", &refspec]).await?;
    run_git(&dir, &["switch", &head_ref]).await
}

#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, repo_id: i64) -> AppResult<String> {
    let dir = repo_path(&state, repo_id)?;

    // Determine the current branch and whether it has an upstream. The git2
    // Repository is scoped to this block so it's dropped before the await.
    let (branch, has_upstream) = {
        let repo = open_repo(&state, repo_id)?;
        let head = repo.head().ok();
        let branch = head
            .as_ref()
            .filter(|h| h.is_branch())
            .and_then(|h| h.shorthand().map(|s| s.to_string()));
        let has_upstream = match &branch {
            Some(b) => repo
                .find_branch(b, BranchType::Local)
                .ok()
                .and_then(|br| br.upstream().ok())
                .is_some(),
            None => false,
        };
        (branch, has_upstream)
    };

    let dir = dir.to_string_lossy().to_string();
    match (has_upstream, branch) {
        // No upstream yet — set it on first push (git push -u origin <branch>).
        (false, Some(branch)) => {
            run_git(&dir, &["push", "--set-upstream", "origin", &branch]).await
        }
        _ => run_git(&dir, &["push"]).await,
    }
}
