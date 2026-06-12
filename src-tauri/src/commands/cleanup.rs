use git2::BranchType;
use serde::Serialize;
use tauri::State;

use crate::commands::history::{open_repo, repo_path};
use crate::commands::sync::run_git;
use crate::error::AppResult;
use crate::state::AppState;

/// Local branches we never delete, even if their upstream is gone.
const PROTECTED: &[&str] = &["main", "master"];

#[derive(Serialize)]
pub struct StaleBranch {
    pub name: String,
    /// The configured upstream that no longer exists (e.g. "origin/feature-x").
    pub upstream: Option<String>,
    pub last_commit_sha: Option<String>,
    pub last_commit_subject: Option<String>,
    pub last_commit_time: Option<i64>,
}

/// True when `branch` has an upstream configured but that upstream ref no longer
/// resolves — equivalent to `%(upstream:track)` == `[gone]`.
fn upstream_is_gone(repo: &git2::Repository, branch: &git2::Branch) -> bool {
    let Some(refname) = branch.get().name() else {
        return false;
    };
    // No upstream configured at all → leave the branch alone.
    if repo.branch_upstream_name(refname).is_err() {
        return false;
    }
    // Configured, but the remote-tracking ref is gone → stale.
    branch.upstream().is_err()
}

/// Run a prune fetch, then list local branches whose upstream tracking ref is
/// gone — i.e. the PR was merged and the remote branch deleted. Mirrors
/// `git fetch -p` followed by selecting refs where `%(upstream:track)` is
/// `[gone]`. The current branch and protected branches (main/master) are never
/// reported, and branches with a live upstream or no upstream are left untouched.
#[tauri::command]
pub async fn list_stale_branches(
    state: State<'_, AppState>,
    repo_id: i64,
) -> AppResult<Vec<StaleBranch>> {
    // Prune fetch so remote-tracking refs are current before we evaluate.
    let dir = repo_path(&state, repo_id)?;
    run_git(&dir.to_string_lossy(), &["fetch", "--all", "--prune"]).await?;

    let repo = open_repo(&state, repo_id)?;
    let current = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let mut out = Vec::new();
    for b in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = b?;
        let Some(name) = branch.name()?.map(|s| s.to_string()) else {
            continue;
        };
        if Some(&name) == current.as_ref() || PROTECTED.contains(&name.as_str()) {
            continue;
        }
        if !upstream_is_gone(&repo, &branch) {
            continue;
        }

        // The configured (now-missing) upstream, trimmed for display.
        let upstream = branch
            .get()
            .name()
            .and_then(|r| repo.branch_upstream_name(r).ok())
            .and_then(|buf| buf.as_str().map(|s| s.to_string()))
            .map(|u| u.strip_prefix("refs/remotes/").unwrap_or(&u).to_string());

        let commit = branch.get().peel_to_commit().ok();
        out.push(StaleBranch {
            name,
            upstream,
            last_commit_sha: commit.as_ref().map(|c| {
                let s = c.id().to_string();
                s[..7.min(s.len())].to_string()
            }),
            last_commit_subject: commit
                .as_ref()
                .and_then(|c| c.summary().map(|s| s.to_string())),
            last_commit_time: commit.as_ref().map(|c| c.time().seconds()),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(Serialize)]
pub struct DeleteResult {
    pub name: String,
    pub deleted: bool,
    pub error: Option<String>,
}

/// Force-delete the named local branches (equivalent to `git branch -D`, since
/// `-d` refuses gone-but-unmerged branches). Protected and current branches are
/// skipped with an error so a stale frontend selection can't remove them.
#[tauri::command]
pub async fn delete_branches(
    state: State<'_, AppState>,
    repo_id: i64,
    names: Vec<String>,
) -> AppResult<Vec<DeleteResult>> {
    let repo = open_repo(&state, repo_id)?;
    let current = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let mut results = Vec::with_capacity(names.len());
    for name in names {
        if Some(&name) == current.as_ref() || PROTECTED.contains(&name.as_str()) {
            results.push(DeleteResult {
                name,
                deleted: false,
                error: Some("protected or current branch".into()),
            });
            continue;
        }
        let outcome = match repo.find_branch(&name, BranchType::Local) {
            Ok(mut branch) => branch.delete(),
            // Already gone (e.g. deleted by a prior/concurrent run) — that's the
            // desired end state for a cleanup op, so treat it as success rather
            // than surfacing a confusing "cannot locate local branch" error.
            Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(()),
            Err(e) => Err(e),
        };
        match outcome {
            Ok(()) => results.push(DeleteResult {
                name,
                deleted: true,
                error: None,
            }),
            Err(e) => results.push(DeleteResult {
                name,
                deleted: false,
                error: Some(e.message().to_string()),
            }),
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .status()
            .expect("git runs");
        assert!(status.success(), "git {args:?} failed");
    }

    /// After a remote branch is deleted and pruned, the local branch that
    /// tracked it is detected as gone while live and unconfigured branches
    /// are not.
    #[test]
    fn detects_only_gone_upstreams() {
        let root = std::env::temp_dir().join("gamut_cleanup_test");
        let _ = std::fs::remove_dir_all(&root);
        let remote = root.join("remote.git");
        let local = root.join("local");
        std::fs::create_dir_all(&root).unwrap();

        // Bare remote with an initial commit on main and two feature branches.
        Command::new("git")
            .args(["init", "--bare", "-b", "main"])
            .arg(&remote)
            .status()
            .unwrap();
        let seed = root.join("seed");
        git(&root, &["clone", remote.to_str().unwrap(), seed.to_str().unwrap()]);
        std::fs::write(seed.join("a.txt"), "a").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-m", "init"]);
        git(&seed, &["push", "origin", "main"]);
        git(&seed, &["checkout", "-b", "feature-gone"]);
        git(&seed, &["push", "-u", "origin", "feature-gone"]);
        git(&seed, &["checkout", "-b", "feature-live"]);
        git(&seed, &["push", "-u", "origin", "feature-live"]);

        // Fresh clone that tracks all three remote branches.
        git(&root, &["clone", remote.to_str().unwrap(), local.to_str().unwrap()]);
        git(&local, &["checkout", "feature-gone"]);
        git(&local, &["checkout", "feature-live"]);
        git(&local, &["checkout", "-b", "local-only"]); // no upstream
        git(&local, &["checkout", "main"]);

        // Delete one feature on the remote, then prune.
        git(&seed, &["push", "origin", "--delete", "feature-gone"]);
        git(&local, &["fetch", "--all", "--prune"]);

        let repo = git2::Repository::open(&local).unwrap();
        let is_gone = |name: &str| {
            let b = repo.find_branch(name, BranchType::Local).unwrap();
            upstream_is_gone(&repo, &b)
        };

        assert!(is_gone("feature-gone"), "pruned upstream → gone");
        assert!(!is_gone("feature-live"), "live upstream → not gone");
        assert!(!is_gone("local-only"), "no upstream → not gone");
        assert!(!is_gone("main"), "live upstream → not gone");

        std::fs::remove_dir_all(&root).unwrap();
    }
}
