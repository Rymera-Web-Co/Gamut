use git2::BranchType;
use serde::Serialize;
use tauri::State;

use crate::commands::history::{open_repo, repo_path};
use crate::commands::settings;
use crate::commands::sync::run_git;
use crate::error::{AppError, AppResult};
use crate::git;
use crate::state::AppState;

/// Local branches we never delete by default, even if their upstream is gone.
const DEFAULT_PROTECTED: &[&str] = &["main", "master"];

/// The configured protected branches, or the built-in default.
fn protected_branches(state: &AppState) -> Vec<String> {
    settings::csv_or(
        state,
        "pref.protectedBranches",
        DEFAULT_PROTECTED.iter().map(|s| s.to_string()).collect(),
    )
}

/// A branch we must never report or delete: a protected branch, or the branch
/// currently checked out.
fn is_protected(name: &str, current: Option<&str>, protected: &[String]) -> bool {
    Some(name) == current || protected.iter().any(|p| p == name)
}

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
    let current = git::current_branch(&repo);
    let protected = protected_branches(&state);

    let mut out = Vec::new();
    for b in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = b?;
        let Some(name) = branch.name()?.map(|s| s.to_string()) else {
            continue;
        };
        if is_protected(&name, current.as_deref(), &protected) {
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
    let current = git::current_branch(&repo);
    let protected = protected_branches(&state);

    let mut results = Vec::with_capacity(names.len());
    for name in names {
        if is_protected(&name, current.as_deref(), &protected) {
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

/// Delete one local branch — `git branch -d`/`-D` for a single row in the
/// Repo settings "Branches" section, distinct from [`delete_branches`] (which
/// is force-only and has its own consumers: `CleanupStaleDialog`,
/// `useAbandonPr`). Always refuses a protected branch and the currently
/// checked-out branch, the same way [`delete_branches`] does; without `force`
/// also refuses a branch not fully merged into HEAD or its upstream, mirroring
/// `git branch -d`'s safety check — libgit2's `Branch::delete` has no such
/// distinction of its own (it always force-deletes). Local-only either way: no
/// remote-tracking ref is ever touched.
#[tauri::command]
pub async fn delete_local_branch(
    state: State<'_, AppState>,
    repo_id: i64,
    name: String,
    force: bool,
) -> AppResult<()> {
    let repo = open_repo(&state, repo_id)?;
    let protected = protected_branches(&state);
    delete_local_branch_at(&repo, &name, force, &protected)
}

/// Core of [`delete_local_branch`], taking an already-open repo (and the
/// caller's already-resolved protected list) so tests can drive it without a
/// `State<AppState>`. The protected/current-branch refusal (A8) is
/// unconditional — checked before the merge state even matters, since `force`
/// is meant to override "not merged", not "protected" or "currently checked
/// out" (same rule [`delete_branches`] applies).
fn delete_local_branch_at(
    repo: &git2::Repository,
    name: &str,
    force: bool,
    protected: &[String],
) -> AppResult<()> {
    let current = git::current_branch(repo);
    if is_protected(name, current.as_deref(), protected) {
        return Err(AppError::Other(format!(
            "branch \"{name}\" is protected or the currently checked out branch"
        )));
    }
    let mut branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(|_| AppError::Other(format!("branch \"{name}\" not found")))?;
    if !force {
        let head_oid = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| c.id());
        if !crate::commands::config::branch_is_merged(repo, &branch, head_oid) {
            return Err(AppError::Other(format!(
                "branch \"{name}\" is not fully merged"
            )));
        }
    }
    branch.delete()?;
    Ok(())
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
        // Unique per process so concurrent `cargo test` runs don't collide.
        let root = std::env::temp_dir().join(format!("gamut_cleanup_test_{}", std::process::id()));
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
        git(
            &root,
            &["clone", remote.to_str().unwrap(), seed.to_str().unwrap()],
        );
        std::fs::write(seed.join("a.txt"), "a").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-m", "init"]);
        git(&seed, &["push", "origin", "main"]);
        git(&seed, &["checkout", "-b", "feature-gone"]);
        git(&seed, &["push", "-u", "origin", "feature-gone"]);
        git(&seed, &["checkout", "-b", "feature-live"]);
        git(&seed, &["push", "-u", "origin", "feature-live"]);

        // Fresh clone that tracks all three remote branches.
        git(
            &root,
            &["clone", remote.to_str().unwrap(), local.to_str().unwrap()],
        );
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

    // ---- delete_local_branch (A6/A7/A8/A9) ----

    /// A repo with `main` at one commit, a remote `origin` tracking branch
    /// `origin/main` at the same commit (so A9 has something to prove stays
    /// intact), and a fresh non-bare setup — used by every delete test below.
    fn repo_with_origin_main(root: &Path) -> git2::Repository {
        let repo = git2::Repository::init(root).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        {
            let tree_id = repo.index().unwrap().write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }
        repo.remote("origin", "https://example.com/x.git").unwrap();
        let head_oid = repo.head().unwrap().target().unwrap();
        repo.reference("refs/remotes/origin/main", head_oid, true, "test")
            .unwrap();
        repo
    }

    #[test]
    fn delete_local_branch_merged_without_force_deletes() {
        let root =
            std::env::temp_dir().join(format!("gamut_delete_branch_a6_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = repo_with_origin_main(&root);
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        // At HEAD's own tip — trivially merged.
        repo.branch("feature", &head_commit, false).unwrap();

        delete_local_branch_at(&repo, "feature", false, &[]).unwrap();

        assert!(repo.find_branch("feature", BranchType::Local).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn delete_local_branch_unmerged_without_force_is_refused_with_force_deletes() {
        let root =
            std::env::temp_dir().join(format!("gamut_delete_branch_a7_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = repo_with_origin_main(&root);
        let head_oid = repo.head().unwrap().target().unwrap();
        // A commit HEAD doesn't have — unmerged.
        let wd = repo.workdir().unwrap();
        std::fs::write(wd.join("feature.txt"), "diverged").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("feature.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.find_commit(head_oid).unwrap();
        let unmerged_oid = repo
            .commit(None, &sig, &sig, "diverged", &tree, &[&parent])
            .unwrap();
        repo.branch("feature", &repo.find_commit(unmerged_oid).unwrap(), false)
            .unwrap();

        let err = delete_local_branch_at(&repo, "feature", false, &[]).unwrap_err();
        assert!(
            err.to_string().contains("not fully merged"),
            "error should mention 'not fully merged', got: {err}"
        );
        assert!(
            repo.find_branch("feature", BranchType::Local).is_ok(),
            "refused delete left the branch in place"
        );

        delete_local_branch_at(&repo, "feature", true, &[]).unwrap();
        assert!(
            repo.find_branch("feature", BranchType::Local).is_err(),
            "force deletes the unmerged branch"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A8: the checked-out branch is refused, even with `force` — the current-
    /// branch guard runs before the merge check, since `force` overrides "not
    /// merged", not "currently checked out".
    #[test]
    fn delete_local_branch_refuses_the_checked_out_branch() {
        let root =
            std::env::temp_dir().join(format!("gamut_delete_branch_a8_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = repo_with_origin_main(&root);
        let current = git::current_branch(&repo).unwrap();

        assert!(delete_local_branch_at(&repo, &current, false, &[]).is_err());
        assert!(
            delete_local_branch_at(&repo, &current, true, &[]).is_err(),
            "force does not override the checked-out-branch refusal"
        );
        assert!(repo.find_branch(&current, BranchType::Local).is_ok());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// M1: a protected branch is refused regardless of `force`, the same way
    /// [`delete_branches`] treats protection — `force` overrides "not merged",
    /// never "protected".
    #[test]
    fn delete_local_branch_refuses_protected_branch_regardless_of_force() {
        let root = std::env::temp_dir().join(format!(
            "gamut_delete_branch_protected_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = repo_with_origin_main(&root);
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        // Trivially merged into HEAD (and thus deletable without force were it
        // not protected) — protection must still refuse it either way.
        repo.branch("release", &head_commit, false).unwrap();
        let protected = vec!["release".to_string()];

        assert!(delete_local_branch_at(&repo, "release", false, &protected).is_err());
        assert!(
            delete_local_branch_at(&repo, "release", true, &protected).is_err(),
            "force does not override protection"
        );
        assert!(repo.find_branch("release", BranchType::Local).is_ok());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// M2: `git branch -d` also permits deleting a branch merged into its own
    /// upstream, not only into HEAD. Here HEAD hasn't advanced past the base
    /// commit, so "feature" is unmerged into HEAD, but its upstream is one
    /// commit ahead of feature's own tip — so a non-forced delete succeeds.
    #[test]
    fn delete_local_branch_merged_only_into_upstream_without_force_deletes() {
        let root = std::env::temp_dir().join(format!(
            "gamut_delete_branch_upstream_merge_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = repo_with_origin_main(&root);
        let head_oid = repo.head().unwrap().target().unwrap();

        // A commit HEAD doesn't have — "feature" diverges from HEAD.
        let wd = repo.workdir().unwrap();
        std::fs::write(wd.join("feature.txt"), "diverged").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("feature.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.find_commit(head_oid).unwrap();
        let feature_oid = repo
            .commit(None, &sig, &sig, "feature", &tree, &[&parent])
            .unwrap();
        repo.branch("feature", &repo.find_commit(feature_oid).unwrap(), false)
            .unwrap();

        // The upstream is one commit further along than "feature"'s own tip —
        // everything on "feature" already lives in the upstream.
        std::fs::write(wd.join("more.txt"), "more").unwrap();
        let mut index2 = repo.index().unwrap();
        index2.add_path(Path::new("more.txt")).unwrap();
        index2.write().unwrap();
        let tree2 = repo.find_tree(index2.write_tree().unwrap()).unwrap();
        let feature_commit = repo.find_commit(feature_oid).unwrap();
        let upstream_ahead_oid = repo
            .commit(None, &sig, &sig, "more", &tree2, &[&feature_commit])
            .unwrap();
        repo.reference(
            "refs/remotes/origin/feature",
            upstream_ahead_oid,
            true,
            "test",
        )
        .unwrap();
        repo.find_branch("feature", BranchType::Local)
            .unwrap()
            .set_upstream(Some("origin/feature"))
            .unwrap();

        delete_local_branch_at(&repo, "feature", false, &[]).unwrap();
        assert!(repo.find_branch("feature", BranchType::Local).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A9: deleting a local branch never touches its remote-tracking ref.
    #[test]
    fn delete_local_branch_leaves_remote_tracking_ref_intact() {
        let root =
            std::env::temp_dir().join(format!("gamut_delete_branch_a9_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = repo_with_origin_main(&root);
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("main-copy", &head_commit, false).unwrap();
        repo.find_branch("main-copy", BranchType::Local)
            .unwrap()
            .set_upstream(Some("origin/main"))
            .unwrap();

        delete_local_branch_at(&repo, "main-copy", false, &[]).unwrap();

        assert!(repo.find_branch("main-copy", BranchType::Local).is_err());
        assert!(
            repo.find_reference("refs/remotes/origin/main").is_ok(),
            "the remote-tracking ref must survive deleting the local branch"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }
}
