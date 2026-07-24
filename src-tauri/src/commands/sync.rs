use std::path::PathBuf;
use std::sync::Arc;

use git2::BranchType;
use serde::Serialize;
use tauri::State;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::commands::diagnostics::OpTiming;
use crate::commands::history::{open_repo, repo_path};
use crate::error::{AppError, AppResult};
use crate::process::NoWindow;
use crate::state::AppState;

/// Run a git CLI command in `dir`, returning stdout (or stderr on failure).
/// Network operations go through the CLI so they reuse the user's existing
/// credentials (ssh agent, credential helpers).
pub(crate) async fn run_git(dir: &str, args: &[&str]) -> AppResult<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .no_window()
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
///
/// Runs the git2 work on a blocking thread so it never executes on the main/UI
/// thread (issue #88).
#[tauri::command]
pub async fn git_sync_status(state: State<'_, AppState>, repo_id: i64) -> AppResult<SyncStatus> {
    let path = repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(path, sync_status_at).await
}

/// Blocking core of [`git_sync_status`]; opens the repo from `path`.
fn sync_status_at(path: &std::path::Path) -> AppResult<SyncStatus> {
    let repo = crate::git::open(path)?;
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

/// Outcome of fetching one repo within a batch `git_fetch_many` call.
#[derive(Serialize)]
pub struct FetchResult {
    pub repo_id: i64,
    pub ok: bool,
    pub error: Option<String>,
}

/// Maximum number of repo fetches allowed to run at once inside
/// [`git_fetch_many`]. The group-fetch button and the background auto-fetch both
/// fetch a whole fleet; doing so strictly one-at-a-time keeps the network + a
/// `git` subprocess busy for minutes on a large fleet — a sustained "trickle,"
/// the worst shape for battery. A small concurrency ceiling lets the fetch burst
/// "race to idle": it finishes far sooner, then the CPU/radio sleep for the rest
/// of the interval, while staying modest enough not to hammer the network.
/// See issue #274.
const FETCH_CONCURRENCY: usize = 5;

/// Run `op` over every `item` with at most `limit` invocations in flight at once,
/// yielding each result as it completes (completion order). A small generic
/// bounded-concurrency map: it keeps the fetch fan-out unit-testable (a test can
/// drive it with an instrumented op and observe how many run at once), and a
/// panicked task is dropped rather than aborting the whole batch.
async fn bounded_map<T, R, F, Fut>(items: Vec<T>, limit: usize, op: F) -> Vec<R>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = R> + Send + 'static,
{
    let sem = Arc::new(Semaphore::new(limit.max(1)));
    let op = Arc::new(op);
    let mut set = JoinSet::new();
    for item in items {
        let sem = Arc::clone(&sem);
        let op = Arc::clone(&op);
        set.spawn(async move {
            // Hold a permit for this item's whole run so at most `limit` overlap.
            // Acquiring before `op` means the op's own timing starts after the
            // queue wait, not before it.
            let _permit = sem
                .acquire_owned()
                .await
                .expect("fetch semaphore is never closed");
            op(item).await
        });
    }
    let mut results = Vec::new();
    while let Some(joined) = set.join_next().await {
        // A panicked task surfaces as `Err(JoinError)`; drop it so every other
        // item still completes. The fetch op never panics (it composes
        // error-returning futures), so this is only a safety net.
        if let Ok(r) = joined {
            results.push(r);
        }
    }
    results
}

/// Fetch one repo and build its result + diagnostics timing. The timer starts
/// here (after the caller's concurrency permit is held), so a queued repo's
/// recorded `git_fetch` duration measures only its fetch, not its wait.
async fn fetch_one(repo_id: i64, dir: PathBuf) -> (FetchResult, OpTiming) {
    let started = std::time::Instant::now();
    let fetched = run_git(&dir.to_string_lossy(), &["fetch", "--all", "--prune"]).await;
    let timing = OpTiming::finished(
        "git_fetch",
        Some(repo_id),
        started,
        fetched.is_ok(),
        fetched.as_ref().err().map(|e| e.to_string()),
    );
    let result = match fetched {
        Ok(_) => FetchResult {
            repo_id,
            ok: true,
            error: None,
        },
        Err(e) => FetchResult {
            repo_id,
            ok: false,
            error: Some(e.to_string()),
        },
    };
    (result, timing)
}

/// Fetch many repos in one call — backs the group-level fetch button and the
/// background auto-fetch. Each repo is fetched independently: one failure (or a
/// repo whose folder is gone) is recorded and the batch carries on rather than
/// aborting. Fetches run with bounded concurrency ([`FETCH_CONCURRENCY`] at once)
/// so a large fleet's fetch burst races to idle instead of trickling one repo at
/// a time (issue #274).
#[tauri::command]
pub async fn git_fetch_many(
    state: State<'_, AppState>,
    repo_ids: Vec<i64>,
) -> AppResult<Vec<FetchResult>> {
    // Resolve every repo's directory up front — this needs `state`, which can't
    // cross into the concurrent tasks. Repos that can't be resolved, or whose
    // folder is gone, are recorded as failures here and never fetched (matching
    // the prior behavior; these skips record no diagnostics).
    let mut resolved: Vec<FetchResult> = Vec::new();
    let mut pending: Vec<(i64, PathBuf)> = Vec::new();
    for &repo_id in &repo_ids {
        match repo_path(&state, repo_id) {
            Ok(dir) if dir.exists() => pending.push((repo_id, dir)),
            // Skip repos whose folder no longer exists — fetching would just error.
            Ok(_) => resolved.push(FetchResult {
                repo_id,
                ok: false,
                error: Some("folder no longer exists on disk".to_string()),
            }),
            Err(e) => resolved.push(FetchResult {
                repo_id,
                ok: false,
                error: Some(e.to_string()),
            }),
        }
    }

    // Fetch the resolvable repos concurrently, then record each timing back in
    // this task (diagnostics needs `state`). The timing was captured inside
    // `fetch_one` at fetch completion, so recording it here doesn't inflate it.
    let fetched = bounded_map(pending, FETCH_CONCURRENCY, |(repo_id, dir)| {
        fetch_one(repo_id, dir)
    })
    .await;
    for (result, timing) in fetched {
        crate::commands::diagnostics::record(&state, timing);
        resolved.push(result);
    }

    // Reassemble in the original input order so the observable output is
    // identical to the prior sequential implementation. Callers pass unique ids
    // (a fleet / a group's repos); a duplicated id would collapse to one result.
    let mut by_id: std::collections::HashMap<i64, FetchResult> =
        resolved.into_iter().map(|r| (r.repo_id, r)).collect();
    let results = repo_ids
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect();
    Ok(results)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Build a `git` command insulated from the developer's global/system config
    /// (a global `commit.gpgsign` or pre-commit hook would otherwise flake these
    /// tests).
    fn git_cmd(dir: &Path) -> Command {
        let mut cmd = Command::new("git");
        cmd.arg("-C")
            .arg(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com");
        cmd
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = git_cmd(dir).args(args).status().expect("git runs");
        assert!(status.success(), "git {args:?} failed");
    }

    /// `bounded_map` never runs more than `limit` ops at once, yet genuinely
    /// overlaps them (max-in-flight > 1) — this is what distinguishes the new
    /// bounded-concurrency fetch from the old strictly-sequential loop, where the
    /// observed maximum would be 1. It also returns one result per input.
    #[tokio::test]
    async fn bounded_map_overlaps_but_stays_within_the_limit() {
        let limit = 3;
        let items: Vec<usize> = (0..8).collect();
        let current = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let cur = Arc::clone(&current);
        let max = Arc::clone(&max_seen);
        let results = bounded_map(items, limit, move |i: usize| {
            let cur = Arc::clone(&cur);
            let max = Arc::clone(&max);
            async move {
                let now = cur.fetch_add(1, Ordering::SeqCst) + 1;
                max.fetch_max(now, Ordering::SeqCst);
                // Hold the permit long enough that sibling tasks overlap.
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                cur.fetch_sub(1, Ordering::SeqCst);
                i
            }
        })
        .await;

        assert_eq!(results.len(), 8, "every item yields exactly one result");
        let peak = max_seen.load(Ordering::SeqCst);
        assert!(
            peak > 1,
            "ops must overlap (not sequential); peak was {peak}"
        );
        assert!(peak <= limit, "peak {peak} exceeded the limit {limit}");
    }

    /// A batch fetch over real repos: every input yields exactly one result, a
    /// non-git folder fails without aborting the batch, and the good repos all
    /// fetch — exercised through the same `bounded_map` + `fetch_one` path
    /// `git_fetch_many` uses.
    #[tokio::test]
    async fn batch_fetch_isolates_failures_and_covers_every_input() {
        // Unique per process so concurrent `cargo test` runs don't collide.
        let root =
            std::env::temp_dir().join(format!("gamut_fetch_many_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // Bare remote with one commit, then three clones that can fetch from it.
        let remote = root.join("remote.git");
        git_cmd(&root)
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

        let mut pending: Vec<(i64, PathBuf)> = Vec::new();
        for i in 0..3 {
            let clone = root.join(format!("clone{i}"));
            git(
                &root,
                &["clone", remote.to_str().unwrap(), clone.to_str().unwrap()],
            );
            pending.push((i as i64, clone));
        }
        // A plain (non-git) folder — `git fetch` here fails, but must not abort
        // the batch.
        let not_git = root.join("plain");
        std::fs::create_dir_all(&not_git).unwrap();
        pending.push((99, not_git));

        let out = bounded_map(pending, FETCH_CONCURRENCY, |(id, dir)| fetch_one(id, dir)).await;

        assert_eq!(out.len(), 4, "one result per input, batch not aborted");
        let ids: std::collections::HashSet<i64> = out.iter().map(|(r, _)| r.repo_id).collect();
        assert_eq!(ids, std::collections::HashSet::from([0, 1, 2, 99]));
        for (r, _) in &out {
            if r.repo_id == 99 {
                assert!(!r.ok, "non-git folder must fail");
                assert!(r.error.is_some());
            } else {
                assert!(r.ok, "clone {} should fetch, got {:?}", r.repo_id, r.error);
            }
        }

        let _ = std::fs::remove_dir_all(&root);
    }
}
