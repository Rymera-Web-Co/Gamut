use git2::{DiffOptions, Oid, Repository};
use serde::Serialize;
use tauri::State;

use crate::commands::history::{blob_text, files_from_diff, repo_path, FileChange, FileDiff};
use crate::commands::settings;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Branch names tried (in order) to resolve a "branch vs base" review base.
const DEFAULT_BASE_PRECEDENCE: &[&str] = &["trunk", "main", "master"];

/// The configured base-branch precedence, or the built-in default.
fn base_precedence(state: &AppState) -> Vec<String> {
    settings::csv_or(
        state,
        "pref.baseBranchPrecedence",
        DEFAULT_BASE_PRECEDENCE
            .iter()
            .map(|s| s.to_string())
            .collect(),
    )
}

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
/// local branch then its `origin/` counterpart. An explicit `base` overrides —
/// it too prefers a local branch of that name, then its `origin/` counterpart,
/// so a PR base branch present only as a remote-tracking ref (e.g. the head is
/// checked out but `playwright` itself never was) still resolves instead of
/// erroring (#281).
fn resolve_base(
    repo: &Repository,
    base: Option<&str>,
    precedence: &[String],
) -> AppResult<(Oid, String)> {
    // The names to try, in order: an explicit override, else the precedence list.
    let names: Vec<String> = match base {
        Some(name) => vec![name.to_string()],
        None => precedence.to_vec(),
    };

    for name in &names {
        for cand in [name.clone(), format!("origin/{name}")] {
            if let Ok(commit) = repo.revparse_single(&cand).and_then(|o| o.peel_to_commit()) {
                return Ok((commit.id(), cand));
            }
        }
    }

    Err(AppError::Other(match base {
        Some(name) => format!("base branch not found: {name}"),
        None => format!("no base branch found (expected {})", precedence.join(", ")),
    }))
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
    // Read the base-branch precedence (a settings lookup) before crossing the
    // thread boundary — the closure can't borrow `State` (#133).
    let precedence = base_precedence(&state);
    let dir = repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(dir, move |p| {
        let repo = crate::git::open(p)?;
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
                let (base_oid, base_label) = resolve_base(&repo, base.as_deref(), &precedence)?;
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
    })
    .await
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
    // Settings lookup before the thread boundary — the closure can't borrow
    // `State` (#133).
    let precedence = base_precedence(&state);
    let dir = repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(dir, move |p| {
        let repo = crate::git::open(p)?;
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
                let (base_oid, _) = resolve_base(&repo, base.as_deref(), &precedence)?;
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
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Commit a file so the repo has a HEAD, returning the new commit's oid.
    fn commit_file(repo: &Repository, name: &str, contents: &str) -> Oid {
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
            .unwrap()
    }

    fn temp_repo(suffix: &str) -> (std::path::PathBuf, Repository) {
        let root = std::env::temp_dir().join(format!(
            "gamut_resolve_base_{}_{}",
            std::process::id(),
            suffix
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = Repository::init(&root).unwrap();
        (root, repo)
    }

    /// The default `["trunk","main","master"]` precedence used in these tests.
    fn precedence() -> Vec<String> {
        DEFAULT_BASE_PRECEDENCE
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn explicit_base_resolves_a_local_branch_by_name() {
        let (root, repo) = temp_repo("local");
        let base = commit_file(&repo, "a.txt", "hello\n");
        repo.branch("playwright", &repo.find_commit(base).unwrap(), false)
            .unwrap();

        let (oid, label) = resolve_base(&repo, Some("playwright"), &precedence()).unwrap();
        assert_eq!(oid, base);
        assert_eq!(label, "playwright");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn explicit_base_falls_back_to_origin_remote_ref() {
        let (root, repo) = temp_repo("remote");
        let base = commit_file(&repo, "a.txt", "hello\n");
        // The PR base branch exists only as a remote-tracking ref — the head was
        // checked out but `playwright` itself never was (the #281 scenario).
        repo.reference("refs/remotes/origin/playwright", base, true, "test")
            .unwrap();

        let (oid, label) = resolve_base(&repo, Some("playwright"), &precedence()).unwrap();
        assert_eq!(oid, base);
        assert_eq!(label, "origin/playwright");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn no_base_falls_back_to_precedence() {
        let (root, repo) = temp_repo("precedence");
        let base = commit_file(&repo, "a.txt", "hello\n");
        repo.branch("main", &repo.find_commit(base).unwrap(), false)
            .unwrap();

        let (oid, label) = resolve_base(&repo, None, &precedence()).unwrap();
        assert_eq!(oid, base);
        assert_eq!(label, "main");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_explicit_base_errors() {
        let (root, repo) = temp_repo("missing");
        commit_file(&repo, "a.txt", "hello\n");

        assert!(resolve_base(&repo, Some("nope"), &precedence()).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }
}
