use std::path::Path;

use git2::{DiffOptions, Index, Repository};
use serde::Serialize;
use tauri::State;

use crate::commands::history::{
    blob_text, files_from_diff, open_repo, repo_path, FileChange, FileDiff,
};
use crate::commands::sync::run_git;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The working tree split the way a staging UI needs it: what's staged for the
/// next commit (HEAD → index) vs what's still unstaged (index → working tree).
#[derive(Serialize)]
pub struct WorktreeStatus {
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
}

/// Read a path's blob from the index (stage 0) as UTF-8 text, plus binary flag.
fn index_blob_text(repo: &Repository, index: &Index, path: &str) -> Option<(String, bool)> {
    let entry = index.get_path(Path::new(path), 0)?;
    let blob = repo.find_blob(entry.id).ok()?;
    let is_binary = blob.is_binary();
    Some((
        String::from_utf8_lossy(blob.content()).into_owned(),
        is_binary,
    ))
}

/// Staged + unstaged changes for the working tree. Untracked files show up as
/// unstaged additions. HEAD may be unborn (a fresh repo) — then everything in
/// the index is a staged addition.
///
/// The unstaged diff is a full working-tree scan that recurses into untracked
/// directories. It runs under the git-status gate and on a blocking thread so a
/// burst of per-repo refreshes can't stampede into a libiconv lock convoy
/// (issue #89).
#[tauri::command]
pub async fn git_worktree_status(
    state: State<'_, AppState>,
    repo_id: i64,
) -> AppResult<WorktreeStatus> {
    let path = repo_path(&state, repo_id)?;
    let _permit = state
        .git_gate
        .acquire()
        .await
        .map_err(|e| AppError::Other(format!("git status gate closed: {e}")))?;
    tauri::async_runtime::spawn_blocking(move || worktree_status_at(&path))
        .await
        .map_err(|e| AppError::Other(format!("worktree status task panicked: {e}")))?
}

/// Blocking core of [`git_worktree_status`]; opens the repo from `path` so it
/// holds no `State` borrow and can run on a blocking thread.
fn worktree_status_at(path: &Path) -> AppResult<WorktreeStatus> {
    let repo = crate::git::open(path)?;
    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| c.tree().ok());
    let index = repo.index()?;

    // HEAD → index (what a commit would record). Detect renames for nicer status.
    let mut staged = repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), None)?;
    let _ = staged.find_similar(None);

    // index → working tree (untracked included).
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let unstaged = repo.diff_index_to_workdir(Some(&index), Some(&mut opts))?;

    Ok(WorktreeStatus {
        staged: files_from_diff(&staged)?,
        unstaged: files_from_diff(&unstaged)?,
    })
}

/// Old/new text for one working-tree file. When `staged`, diff HEAD → index;
/// otherwise diff index → working tree (the unstaged hunk).
#[tauri::command]
pub async fn worktree_file_diff(
    state: State<'_, AppState>,
    repo_id: i64,
    path: String,
    staged: bool,
    old_path: Option<String>,
) -> AppResult<FileDiff> {
    let repo = open_repo(&state, repo_id)?;
    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| c.tree().ok());
    let index = repo.index()?;
    let old_lookup = old_path.as_deref().unwrap_or(&path);

    let (old, new) = if staged {
        let old = head_tree
            .as_ref()
            .and_then(|t| blob_text(&repo, t, old_lookup));
        let new = index_blob_text(&repo, &index, &path);
        (old, new)
    } else {
        let old = index_blob_text(&repo, &index, old_lookup);
        // New content is the file on disk; missing means it was deleted.
        let new = repo.workdir().and_then(|wd| {
            std::fs::read(wd.join(&path)).ok().map(|bytes| {
                let is_binary = bytes.contains(&0);
                (String::from_utf8_lossy(&bytes).into_owned(), is_binary)
            })
        });
        (old, new)
    };

    let is_binary = old.as_ref().map(|(_, b)| *b).unwrap_or(false)
        || new.as_ref().map(|(_, b)| *b).unwrap_or(false);

    Ok(FileDiff {
        path,
        old_text: old.map(|(t, _)| t),
        new_text: new.map(|(t, _)| t),
        is_binary,
    })
}

/// Stage paths (`git add` — handles new, modified, and deleted files).
#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    repo_id: i64,
    paths: Vec<String>,
) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let dir = repo_path(&state, repo_id)?.to_string_lossy().to_string();
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    run_git(&dir, &args).await?;
    Ok(())
}

/// Unstage paths (`git reset HEAD -- <paths>`), keeping the working-tree changes.
#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    repo_id: i64,
    paths: Vec<String>,
) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let dir = repo_path(&state, repo_id)?.to_string_lossy().to_string();
    let mut args: Vec<&str> = vec!["reset", "-q", "HEAD", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    run_git(&dir, &args).await?;
    Ok(())
}

/// Commit the staged changes. Goes through the git CLI so hooks, signing, and
/// the user's identity config all apply. Returns git's summary line.
#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    repo_id: i64,
    message: String,
) -> AppResult<String> {
    let dir = repo_path(&state, repo_id)?.to_string_lossy().to_string();
    run_git(&dir, &["commit", "-m", &message]).await
}

/// Discard unstaged working-tree changes for paths: tracked files are restored
/// to their staged/HEAD content, untracked files are deleted. Irreversible.
#[tauri::command]
pub async fn git_discard(
    state: State<'_, AppState>,
    repo_id: i64,
    paths: Vec<String>,
) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    // Split paths into tracked vs untracked before touching the CLI (the git2
    // repo handle must drop before any await).
    let (tracked, untracked): (Vec<String>, Vec<String>) = {
        let repo = open_repo(&state, repo_id)?;
        let mut tracked = Vec::new();
        let mut untracked = Vec::new();
        for p in paths {
            let status = repo.status_file(Path::new(&p)).ok();
            let is_untracked = status
                .map(|s| s.contains(git2::Status::WT_NEW) && !s.contains(git2::Status::INDEX_NEW))
                .unwrap_or(false);
            if is_untracked {
                untracked.push(p);
            } else {
                tracked.push(p);
            }
        }
        (tracked, untracked)
    };

    let dir = repo_path(&state, repo_id)?.to_string_lossy().to_string();
    if !tracked.is_empty() {
        let mut args: Vec<&str> = vec!["restore", "--"];
        args.extend(tracked.iter().map(|s| s.as_str()));
        run_git(&dir, &args).await?;
    }
    if !untracked.is_empty() {
        let mut args: Vec<&str> = vec!["clean", "-fd", "--"];
        args.extend(untracked.iter().map(|s| s.as_str()));
        run_git(&dir, &args).await?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
}

/// The stash stack, newest first (index 0 == `stash@{0}`).
#[tauri::command]
pub async fn git_stash_list(
    state: State<'_, AppState>,
    repo_id: i64,
) -> AppResult<Vec<StashEntry>> {
    let dir = repo_path(&state, repo_id)?.to_string_lossy().to_string();
    // %gd = selector (stash@{N}), %gs = subject; \x1f separates the two.
    let out = run_git(&dir, &["stash", "list", "--format=%gd%x1f%gs"]).await?;
    let mut entries = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, '\u{1f}');
        let selector = parts.next().unwrap_or("");
        let message = parts.next().unwrap_or("").to_string();
        let index = selector
            .split('{')
            .nth(1)
            .and_then(|s| s.split('}').next())
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        entries.push(StashEntry { index, message });
    }
    Ok(entries)
}

/// Stash the working tree (`git stash push`), optionally with a message and
/// including untracked files.
#[tauri::command]
pub async fn git_stash_push(
    state: State<'_, AppState>,
    repo_id: i64,
    message: Option<String>,
    include_untracked: bool,
) -> AppResult<String> {
    let dir = repo_path(&state, repo_id)?.to_string_lossy().to_string();
    let mut args: Vec<String> = vec!["stash".into(), "push".into()];
    if include_untracked {
        args.push("--include-untracked".into());
    }
    if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
        args.push("-m".into());
        args.push(m);
    }
    let argref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git(&dir, &argref).await
}

async fn stash_action(
    state: &State<'_, AppState>,
    repo_id: i64,
    action: &str,
    index: usize,
) -> AppResult<String> {
    let dir = repo_path(state, repo_id)?.to_string_lossy().to_string();
    let selector = format!("stash@{{{index}}}");
    run_git(&dir, &["stash", action, &selector]).await
}

/// Apply a stash and drop it from the stack.
#[tauri::command]
pub async fn git_stash_pop(
    state: State<'_, AppState>,
    repo_id: i64,
    index: usize,
) -> AppResult<String> {
    stash_action(&state, repo_id, "pop", index).await
}

/// Apply a stash, leaving it on the stack.
#[tauri::command]
pub async fn git_stash_apply(
    state: State<'_, AppState>,
    repo_id: i64,
    index: usize,
) -> AppResult<String> {
    stash_action(&state, repo_id, "apply", index).await
}

/// Delete a stash without applying it.
#[tauri::command]
pub async fn git_stash_drop(
    state: State<'_, AppState>,
    repo_id: i64,
    index: usize,
) -> AppResult<String> {
    stash_action(&state, repo_id, "drop", index).await
}
