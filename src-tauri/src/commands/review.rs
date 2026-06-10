use git2::{DiffOptions, Oid, Repository};
use serde::Serialize;
use tauri::State;

use crate::commands::history::{blob_text, files_from_diff, open_repo, FileChange, FileDiff};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Which set of local changes to review.
#[derive(serde::Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ReviewSource {
    /// Uncommitted work: working tree + index vs HEAD.
    Working,
    /// The current branch vs its base (merge-base with upstream/default).
    Branch,
}

#[derive(Serialize)]
pub struct ReviewDiff {
    pub base_label: String,
    pub head_label: String,
    pub files: Vec<FileChange>,
}

/// Resolve the base commit + a human label for a "branch" review.
/// The base is always trunk, main, or master (in that order), preferring a
/// local branch then its `origin/` counterpart. An explicit `base` overrides.
fn resolve_base(repo: &Repository, base: Option<&str>) -> AppResult<(Oid, String)> {
    if let Some(name) = base {
        let commit = repo.revparse_single(name)?.peel_to_commit()?;
        return Ok((commit.id(), name.to_string()));
    }

    for name in ["trunk", "main", "master"] {
        for cand in [name.to_string(), format!("origin/{name}")] {
            if let Ok(commit) = repo
                .revparse_single(&cand)
                .and_then(|o| o.peel_to_commit())
            {
                return Ok((commit.id(), cand));
            }
        }
    }

    Err(AppError::Other(
        "no base branch found (expected trunk, main, or master)".into(),
    ))
}

fn head_branch_label(repo: &Repository) -> String {
    repo.head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "HEAD".to_string())
}

/// List files changed in a local review (working tree or branch-vs-base).
#[tauri::command]
pub async fn review_files(
    state: State<'_, AppState>,
    repo_id: i64,
    source: ReviewSource,
    base: Option<String>,
) -> AppResult<ReviewDiff> {
    let repo = open_repo(&state, repo_id)?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let head_tree = head_commit.tree()?;

    match source {
        ReviewSource::Working => {
            let mut opts = DiffOptions::new();
            opts.include_untracked(true).recurse_untracked_dirs(true);
            let diff =
                repo.diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut opts))?;
            Ok(ReviewDiff {
                base_label: "HEAD".to_string(),
                head_label: "Working tree".to_string(),
                files: files_from_diff(&diff)?,
            })
        }
        ReviewSource::Branch => {
            let (base_oid, base_label) = resolve_base(&repo, base.as_deref())?;
            let merge_base = repo.merge_base(head_commit.id(), base_oid)?;
            let base_tree = repo.find_commit(merge_base)?.tree()?;
            let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)?;
            Ok(ReviewDiff {
                base_label,
                head_label: head_branch_label(&repo),
                files: files_from_diff(&diff)?,
            })
        }
    }
}

/// Old/new text for one file in a local review, for the diff editor.
#[tauri::command]
pub async fn review_file_diff(
    state: State<'_, AppState>,
    repo_id: i64,
    source: ReviewSource,
    path: String,
    base: Option<String>,
    old_path: Option<String>,
) -> AppResult<FileDiff> {
    let repo = open_repo(&state, repo_id)?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let head_tree = head_commit.tree()?;
    let old_lookup = old_path.as_deref().unwrap_or(&path);

    let (old, new) = match source {
        ReviewSource::Working => {
            let old = blob_text(&repo, &head_tree, old_lookup);
            // New content is the file on disk; missing means deleted.
            let new = repo.workdir().and_then(|wd| {
                let full = wd.join(&path);
                std::fs::read(&full).ok().map(|bytes| {
                    let is_binary = bytes.contains(&0);
                    (String::from_utf8_lossy(&bytes).into_owned(), is_binary)
                })
            });
            (old, new)
        }
        ReviewSource::Branch => {
            let (base_oid, _) = resolve_base(&repo, base.as_deref())?;
            let merge_base = repo.merge_base(head_commit.id(), base_oid)?;
            let base_tree = repo.find_commit(merge_base)?.tree()?;
            let old = blob_text(&repo, &base_tree, old_lookup);
            let new = blob_text(&repo, &head_tree, &path);
            (old, new)
        }
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
