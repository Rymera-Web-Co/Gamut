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
    /// The branch a push would **publish** — set only when HEAD is a branch with
    /// no upstream, in which case the push creates it on `origin`. `None` when
    /// the branch already tracks, or HEAD is detached: both push plainly. It is
    /// [`branch_needing_upstream`], the same value [`push_target`] acts on, so
    /// the UI's "publish this branch?" confirmation (#300) can never disagree
    /// with what the push then does.
    pub unpublished_branch: Option<String>,
}

/// The branch a push must set an upstream for, or `None` when a plain
/// `git push` is right — i.e. the branch already tracks, or HEAD is detached.
/// The single definition of "this push would publish a new branch", read both
/// by the push itself ([`push_target`]) and by the status the UI confirms
/// against ([`sync_status_at`]).
fn branch_needing_upstream(repo: &git2::Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if !head.is_branch() {
        return None;
    }
    let name = head.shorthand()?.to_string();
    let tracks = repo
        .find_branch(&name, BranchType::Local)
        .ok()
        .and_then(|b| b.upstream().ok())
        .is_some();
    (!tracks).then_some(name)
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
    let unpublished_branch = branch_needing_upstream(&repo);
    let none = SyncStatus {
        upstream: None,
        ahead: 0,
        behind: 0,
        unpublished_branch,
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
        // Reaching here means the branch tracks, so it is already published.
        unpublished_branch: None,
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

/// Outcome of one repo's pull or push within a batch [`git_pull_many`] /
/// [`git_push_many`] call. Deliberately a separate type from [`FetchResult`]
/// despite the identical shape: these are two independent wire contracts, and
/// sharing one would mean a field added for the fetch batch silently becomes
/// part of the sync batch's API too.
#[derive(Serialize)]
pub struct SyncResult {
    pub repo_id: i64,
    pub ok: bool,
    pub error: Option<String>,
}

/// Concurrency ceiling for a batch pull/push. Same reasoning as
/// [`FETCH_CONCURRENCY`]: these are network round trips plus a `git` subprocess
/// each, so a bounded burst finishes far sooner than a one-at-a-time trickle
/// while staying modest enough not to hammer the remote.
const SYNC_CONCURRENCY: usize = 5;

/// Resolve each requested repo to a directory that exists, recording the ones
/// that can't be as failures. Shared by [`git_pull_many`] and [`git_push_many`]
/// so the two batches skip and report unusable repos identically.
fn resolve_sync_targets(
    state: &State<'_, AppState>,
    repo_ids: &[i64],
) -> (Vec<SyncResult>, Vec<(i64, PathBuf)>) {
    let mut failed: Vec<SyncResult> = Vec::new();
    let mut pending: Vec<(i64, PathBuf)> = Vec::new();
    for &repo_id in repo_ids {
        match repo_path(state, repo_id) {
            Ok(dir) if dir.exists() => pending.push((repo_id, dir)),
            // A folder that's gone can't be pulled or pushed — record, don't run.
            Ok(_) => failed.push(SyncResult {
                repo_id,
                ok: false,
                error: Some("folder no longer exists on disk".to_string()),
            }),
            Err(e) => failed.push(SyncResult {
                repo_id,
                ok: false,
                error: Some(e.to_string()),
            }),
        }
    }
    (failed, pending)
}

/// Reassemble batch results into the caller's input order, so the observable
/// output lines up with the ids that were passed in.
fn in_input_order(results: Vec<SyncResult>, repo_ids: Vec<i64>) -> Vec<SyncResult> {
    let mut by_id: std::collections::HashMap<i64, SyncResult> =
        results.into_iter().map(|r| (r.repo_id, r)).collect();
    repo_ids
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect()
}

/// Pull one repo and build its result + diagnostics timing. Mirrors
/// [`fetch_one`]: the timer starts after the caller's concurrency permit is held,
/// so a queued repo's recorded duration measures only its pull, not its wait.
async fn pull_one(repo_id: i64, dir: PathBuf) -> (SyncResult, OpTiming) {
    let started = std::time::Instant::now();
    let out = run_git(&dir.to_string_lossy(), &["pull"]).await;
    let timing = OpTiming::finished(
        "git_pull",
        Some(repo_id),
        started,
        out.is_ok(),
        out.as_ref().err().map(|e| e.to_string()),
    );
    let result = SyncResult {
        repo_id,
        ok: out.is_ok(),
        error: out.err().map(|e| e.to_string()),
    };
    (result, timing)
}

/// Push one repo and build its result + diagnostics timing. `set_upstream_for`
/// carries the branch that still needs an upstream (see [`push_target`]); `None`
/// means a plain `git push`.
async fn push_one(
    repo_id: i64,
    dir: PathBuf,
    set_upstream_for: Option<String>,
) -> (SyncResult, OpTiming) {
    let dir = dir.to_string_lossy().to_string();
    let started = std::time::Instant::now();
    let out = match &set_upstream_for {
        Some(branch) => run_git(&dir, &["push", "--set-upstream", "origin", branch]).await,
        None => run_git(&dir, &["push"]).await,
    };
    let timing = OpTiming::finished(
        "git_push",
        Some(repo_id),
        started,
        out.is_ok(),
        out.as_ref().err().map(|e| e.to_string()),
    );
    let result = SyncResult {
        repo_id,
        ok: out.is_ok(),
        error: out.err().map(|e| e.to_string()),
    };
    (result, timing)
}

/// Pull many repos in one call — backs the repo sidebar's bulk-action bar. Each
/// repo is pulled independently: one failure (a conflict, a missing upstream, a
/// folder that's gone) is recorded and the batch carries on rather than aborting,
/// so a single problem repo can't strand the rest half-done. Runs with bounded
/// concurrency ([`SYNC_CONCURRENCY`]).
///
/// This is a full `git pull`, matching what the per-repo pull button does — not
/// the fast-forward-only, opt-in-gated [`git_pull_ff_many`] that backs background
/// auto-pull.
#[tauri::command]
pub async fn git_pull_many(
    state: State<'_, AppState>,
    repo_ids: Vec<i64>,
) -> AppResult<Vec<SyncResult>> {
    let (mut resolved, pending) = resolve_sync_targets(&state, &repo_ids);
    let pulled = bounded_map(pending, SYNC_CONCURRENCY, |(repo_id, dir)| {
        pull_one(repo_id, dir)
    })
    .await;
    for (result, timing) in pulled {
        crate::commands::diagnostics::record(&state, timing);
        resolved.push(result);
    }
    Ok(in_input_order(resolved, repo_ids))
}

/// Push many repos in one call — the bulk-action bar's counterpart to
/// [`git_pull_many`], with the same independent-per-repo semantics and the same
/// first-push upstream handling as the single-repo [`git_push`]: a branch with no
/// upstream gets one set on its first push.
#[tauri::command]
pub async fn git_push_many(
    state: State<'_, AppState>,
    repo_ids: Vec<i64>,
) -> AppResult<Vec<SyncResult>> {
    let (mut resolved, pending) = resolve_sync_targets(&state, &repo_ids);

    // Resolve each repo's branch/upstream up front: it needs `state` (and a
    // non-Send git2 Repository), neither of which can cross into the concurrent
    // tasks below.
    let mut targets: Vec<(i64, PathBuf, Option<String>)> = Vec::new();
    for (repo_id, dir) in pending {
        let branch_without_upstream = match push_target(&state, repo_id) {
            Ok(b) => b,
            Err(e) => {
                resolved.push(SyncResult {
                    repo_id,
                    ok: false,
                    error: Some(e.to_string()),
                });
                continue;
            }
        };
        targets.push((repo_id, dir, branch_without_upstream));
    }

    let pushed = bounded_map(
        targets,
        SYNC_CONCURRENCY,
        |(repo_id, dir, set_upstream_for)| push_one(repo_id, dir, set_upstream_for),
    )
    .await;
    for (result, timing) in pushed {
        crate::commands::diagnostics::record(&state, timing);
        resolved.push(result);
    }
    Ok(in_input_order(resolved, repo_ids))
}

/// What auto-pull did (or deliberately didn't do) to one repo. Serialised in
/// kebab-case so the frontend switches on stable string literals.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AutoPullStatus {
    /// Fast-forwarded to the upstream commit.
    Pulled,
    /// Nothing to pull — not behind. A no-op, *not* something to warn about,
    /// even if the working tree happens to be dirty.
    UpToDate,
    /// Behind, but the working tree has uncommitted changes. Skipped: auto-pull
    /// never stashes.
    SkippedDirty,
    /// Behind *and* ahead — the branch has diverged, so a pull would merge or
    /// rebase. Skipped: auto-pull never creates a merge commit.
    SkippedDiverged,
    /// No upstream to pull from (also covers a detached HEAD, which the shared
    /// `sync_status_at` reports the same way).
    SkippedNoUpstream,
    /// There is nothing here to pull: the repo's folder is gone, the row isn't
    /// opted in, or it isn't readable as a git repo. Distinct from
    /// `SkippedNoUpstream` so the UI doesn't tell the user a *missing folder* has
    /// "no upstream branch"; nothing is surfaced for this at all.
    SkippedUnavailable,
    /// The repo was eligible but `git pull --ff-only` failed (e.g. the network is
    /// down, or the upstream moved on and diverged after the eligibility check).
    Failed,
}

/// Outcome of auto-pulling one repo within a batch [`git_pull_ff_many`] call.
#[derive(Serialize)]
pub struct AutoPullResult {
    pub repo_id: i64,
    pub status: AutoPullStatus,
    /// Raw `git pull` stdout for a `Pulled` repo, so the frontend can condense it
    /// with the existing `summarizePull` (#76) instead of inventing its own copy.
    pub output: Option<String>,
    /// Why a `Failed` repo failed (git's stderr). Skips carry their reason in
    /// `status` instead.
    pub error: Option<String>,
}

/// Decide whether `path` may be auto-pulled right now, reusing the very same
/// ahead/behind + upstream logic as [`git_sync_status`] and the same dirty check
/// as the sidebar's dirty dot. Returns `None` when the repo is eligible for a
/// fast-forward, or `Some(status)` for the outcome to report instead.
///
/// Order matters: "not behind" is decided **before** cleanliness, so a repo with
/// local edits and nothing to pull reports `UpToDate` rather than `SkippedDirty`.
/// Otherwise every fetch cycle would warn about a dirty repo that had nothing to
/// pull anyway — the common case for a repo you're actively working in.
fn auto_pull_eligibility(path: &std::path::Path) -> Option<AutoPullStatus> {
    let status = match sync_status_at(path) {
        Ok(s) => s,
        // Not readable as a git repo at all — nothing to pull, and not something
        // to describe to the user as an upstream problem.
        Err(_) => return Some(AutoPullStatus::SkippedUnavailable),
    };
    if status.upstream.is_none() {
        return Some(AutoPullStatus::SkippedNoUpstream);
    }
    if status.behind == 0 {
        return Some(AutoPullStatus::UpToDate);
    }
    if status.ahead > 0 {
        return Some(AutoPullStatus::SkippedDiverged);
    }
    match crate::git::open(path) {
        Ok(repo) if crate::commands::repo::has_uncommitted_changes(&repo) => {
            Some(AutoPullStatus::SkippedDirty)
        }
        Ok(_) => None,
        // Only reachable if the repo went away between the two reads above.
        Err(_) => Some(AutoPullStatus::SkippedUnavailable),
    }
}

/// Fast-forward one repo if — and only if — it is eligible. The eligibility read
/// runs on a blocking thread (git2, like every other status read here), and the
/// pull itself is `--ff-only`: that flag, not the pre-check, is what makes the
/// "never merge, never rebase" guarantee hold even if the upstream diverges in
/// the window between the two.
async fn auto_pull_one(repo_id: i64, dir: PathBuf) -> (AutoPullResult, Option<OpTiming>) {
    let probe = dir.clone();
    let skip = tokio::task::spawn_blocking(move || auto_pull_eligibility(&probe))
        .await
        // A panicked probe is treated as "don't touch this repo".
        .unwrap_or(Some(AutoPullStatus::Failed));
    if let Some(status) = skip {
        return (
            AutoPullResult {
                repo_id,
                status,
                output: None,
                error: None,
            },
            None,
        );
    }

    let started = std::time::Instant::now();
    let pulled = pull_ff_only(&dir).await;
    let timing = OpTiming::finished(
        "git_auto_pull",
        Some(repo_id),
        started,
        pulled.is_ok(),
        pulled.as_ref().err().map(|e| e.to_string()),
    );
    let result = match pulled {
        Ok(out) => AutoPullResult {
            repo_id,
            status: AutoPullStatus::Pulled,
            output: Some(out),
            error: None,
        },
        Err(e) => AutoPullResult {
            repo_id,
            status: AutoPullStatus::Failed,
            output: None,
            error: Some(e.to_string()),
        },
    };
    (result, Some(timing))
}

/// The one place auto-pull actually touches a working tree, and the only place
/// the "never touch local work" promise is actually enforced. `--ff-only` makes
/// git refuse anything but a fast-forward, so this can never produce a merge
/// commit or a rebase no matter what the repo's state turned out to be —
/// including the case where the upstream diverged *after*
/// [`auto_pull_eligibility`] looked, and including a user whose config sets
/// `pull.rebase = true` (the explicit flag wins and git aborts).
///
/// The `-c` overrides are not belt-and-braces, they close real holes in a
/// *background* pull, because parts of a pull are still config-driven:
///
/// - **`merge.autoStash` / `rebase.autoStash`** — with either set (a common
///   developer config), `git pull --ff-only` will stash the working tree, fast-
///   forward, and pop. When the pop conflicts it leaves **conflict markers in the
///   user's files** and a dangling `autostash` entry. That is precisely the "never
///   stashes, never touches local work" guarantee this feature makes, and the
///   eligibility pre-check cannot prevent it: the tree only has to become dirty
///   during the pull's own network fetch (an editor save, a watcher, a build, or a
///   Gamut terminal running something) for the window to open.
/// - **`submodule.recurse`** — with it set, the pull also checks out submodules.
///   A dirty submodule then makes git exit non-zero *after* the parent has
///   fast-forwarded, and submodules are deliberately excluded from the
///   cleanliness check (see `repo::has_uncommitted_changes`), so auto-pull would
///   half-update a repo it believed to be clean. Submodule updates stay the user's
///   explicit action.
///
/// It is a `pull`, not a `merge` against already-fetched refs, on purpose: the
/// pull's own fetch is what makes the launch/focus rounds act on current remote
/// state rather than on whatever the last session happened to have fetched. The
/// cost is that a repo which the batch fetch just visited is fetched once more —
/// only ever a repo that is genuinely behind and opted in, and it is what closes
/// the window between the eligibility read and the fast-forward.
async fn pull_ff_only(dir: &std::path::Path) -> AppResult<String> {
    run_git(
        &dir.to_string_lossy(),
        &[
            "-c",
            "merge.autoStash=false",
            "-c",
            "rebase.autoStash=false",
            "pull",
            "--ff-only",
            "--no-recurse-submodules",
        ],
    )
    .await
}

/// Split `repo_ids` into the repos an auto-pull round may touch (opted in, folder
/// present) and the ones it must report untouched — the query half of
/// [`git_pull_ff_many`], over a plain `&Connection` so it is testable without a
/// Tauri `State`.
///
/// **The `auto_pull = 1` filter is here, in the backend, on purpose.** The
/// frontend already only asks about opted-in repos, but this command modifies
/// working trees: a caller that got the filtering wrong would fast-forward
/// branches the user never opted in. A repo that isn't opted in (or no longer
/// exists as a row) is reported `SkippedUnavailable` rather than trusted.
fn resolve_auto_pull_targets(
    conn: &rusqlite::Connection,
    repo_ids: &[i64],
) -> (Vec<AutoPullResult>, Vec<(i64, PathBuf)>) {
    let mut skipped: Vec<AutoPullResult> = Vec::new();
    let mut pending: Vec<(i64, PathBuf)> = Vec::new();
    for &repo_id in repo_ids {
        let path: Option<String> = conn
            .query_row(
                "SELECT path FROM repos WHERE id = ?1 AND auto_pull = 1 AND is_git_repo != 0",
                [repo_id],
                |row| row.get(0),
            )
            .ok();
        match path.map(PathBuf::from) {
            Some(dir) if dir.exists() => pending.push((repo_id, dir)),
            // Not opted in, not a git repo, no such row, or the folder is gone:
            // nothing to pull, and nothing worth telling the user about.
            _ => skipped.push(AutoPullResult {
                repo_id,
                status: AutoPullStatus::SkippedUnavailable,
                output: None,
                error: None,
            }),
        }
    }
    (skipped, pending)
}

/// Fast-forward every eligible repo among `repo_ids` — the batch behind the
/// per-repo auto-pull opt-in (#299). This command owns both halves of the safety
/// decision: the **opt-in** check (see [`resolve_auto_pull_targets`]) and the
/// **fast-forward eligibility** check, so an ineligible repo comes back with a
/// `Skipped*` status rather than being touched.
///
/// Like [`git_fetch_many`], one repo's failure never aborts the batch and results
/// are returned in input order, and the fan-out reuses [`FETCH_CONCURRENCY`]: an
/// auto-pull round follows a fetch round over the same fleet, so the same
/// "race to idle rather than trickle" reasoning applies (#274).
#[tauri::command]
pub async fn git_pull_ff_many(
    state: State<'_, AppState>,
    repo_ids: Vec<i64>,
) -> AppResult<Vec<AutoPullResult>> {
    // Resolve paths up front — `state` can't cross into the concurrent tasks.
    let (mut resolved, pending) = {
        let conn = crate::commands::repo::lock(&state)?;
        resolve_auto_pull_targets(&conn, &repo_ids)
    };

    let pulled = bounded_map(pending, FETCH_CONCURRENCY, |(repo_id, dir)| {
        auto_pull_one(repo_id, dir)
    })
    .await;
    for (result, timing) in pulled {
        // Only repos that actually ran a pull recorded a timing.
        if let Some(timing) = timing {
            crate::commands::diagnostics::record(&state, timing);
        }
        resolved.push(result);
    }

    let mut by_id: std::collections::HashMap<i64, AutoPullResult> =
        resolved.into_iter().map(|r| (r.repo_id, r)).collect();
    Ok(repo_ids
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect())
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

/// The branch a push must set an upstream for, or `None` when a plain
/// `git push` is right (the branch already tracks, or HEAD is detached). Shared
/// by [`git_push`] and [`git_push_many`] so both handle a first push the same
/// way. Kept separate from the push itself because the git2 `Repository` it
/// reads is not `Send` and must be dropped before any await.
fn push_target(state: &State<'_, AppState>, repo_id: i64) -> AppResult<Option<String>> {
    let repo = open_repo(state, repo_id)?;
    Ok(branch_needing_upstream(&repo))
}

#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, repo_id: i64) -> AppResult<String> {
    let dir = repo_path(&state, repo_id)?;
    let set_upstream_for = push_target(&state, repo_id)?;

    let dir = dir.to_string_lossy().to_string();
    match set_upstream_for {
        // No upstream yet — set it on first push (git push -u origin <branch>).
        Some(branch) => run_git(&dir, &["push", "--set-upstream", "origin", &branch]).await,
        None => run_git(&dir, &["push"]).await,
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

    // ---------------------------------------------------------------------
    // Auto-pull (#299). These run against real temp repos rather than a mocked
    // git, because the whole feature is a safety promise about what git is and
    // isn't allowed to do to a working tree — a stubbed git would assert only
    // that we call ourselves correctly.
    // ---------------------------------------------------------------------

    /// A scratch root unique per test *and* per process, so cases can't collide.
    fn scratch(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("gamut_auto_pull_{label}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// Bare remote + a seed clone holding one commit on `main`. The seed is how a
    /// test advances the remote ("someone else pushed").
    fn remote_with_seed(root: &Path) -> (PathBuf, PathBuf) {
        let remote = root.join("remote.git");
        git_cmd(root)
            .args(["init", "--bare", "-b", "main"])
            .arg(&remote)
            .status()
            .unwrap();
        let seed = root.join("seed");
        git(
            root,
            &["clone", remote.to_str().unwrap(), seed.to_str().unwrap()],
        );
        std::fs::write(seed.join("a.txt"), "one\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-m", "init"]);
        git(&seed, &["push", "origin", "main"]);
        (remote, seed)
    }

    /// Push another commit to the remote via the seed clone.
    fn advance_remote(seed: &Path, contents: &str) {
        std::fs::write(seed.join("a.txt"), contents).unwrap();
        git(seed, &["commit", "-am", "upstream commit"]);
        git(seed, &["push", "origin", "main"]);
    }

    /// A clone that knows it is one commit behind: cloned, then the remote moved
    /// on, then fetched (so `refs/remotes/origin/main` is ahead of local `main`).
    fn clone_that_is_behind(root: &Path, remote: &Path, seed: &Path, name: &str) -> PathBuf {
        let clone = root.join(name);
        git(
            root,
            &["clone", remote.to_str().unwrap(), clone.to_str().unwrap()],
        );
        advance_remote(seed, "one\ntwo\n");
        git(&clone, &["fetch", "origin"]);
        clone
    }

    /// Read a working-tree file with line endings normalised to `\n`. A checkout
    /// goes through git's `core.autocrlf`, which on Windows rewrites `\n` to
    /// `\r\n` — so a byte-for-byte comparison against a literal would assert the
    /// platform's newline convention rather than the content that was pulled.
    fn read_normalized(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap().replace("\r\n", "\n")
    }

    fn rev(dir: &Path, spec: &str) -> String {
        let out = git_cmd(dir)
            .args(["rev-parse", spec])
            .output()
            .expect("git runs");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit_count(dir: &Path) -> String {
        let out = git_cmd(dir)
            .args(["rev-list", "--count", "HEAD"])
            .output()
            .expect("git runs");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A9-adjacent: a clean, behind-only repo with an upstream is fast-forwarded,
    /// its branch really lands on the upstream commit, and the result carries the
    /// raw git output the frontend's `summarizePull` is built to condense.
    #[tokio::test]
    async fn auto_pull_fast_forwards_a_clean_behind_repo() {
        let root = scratch("ff");
        let (remote, seed) = remote_with_seed(&root);
        let clone = clone_that_is_behind(&root, &remote, &seed, "clone");

        assert_eq!(
            auto_pull_eligibility(&clone),
            None,
            "clean + behind-only + upstream must be eligible"
        );

        let (result, timing) = auto_pull_one(1, clone.clone()).await;
        assert_eq!(result.status, AutoPullStatus::Pulled);
        assert_eq!(
            rev(&clone, "HEAD"),
            rev(&clone, "refs/remotes/origin/main"),
            "the branch must actually land on the upstream commit"
        );
        assert_eq!(
            read_normalized(&clone.join("a.txt")),
            "one\ntwo\n",
            "the working tree must carry the upstream content"
        );
        let out = result.output.expect("a pulled repo carries git's output");
        assert!(!out.trim().is_empty(), "output must not be empty");
        assert!(
            out.contains("Fast-forward")
                || out.contains("file changed")
                || out.contains("Updating"),
            "output must be the shape summarizePull parses, got: {out}"
        );
        assert!(timing.is_some(), "a real pull records a diagnostics timing");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Every flavour of "dirty" blocks the pull: unstaged tracked edit, staged
    /// change, and untracked-only. Untracked-only is the interesting one — plain
    /// `git merge --ff-only` would happily proceed, but auto-pull reuses the same
    /// cleanliness predicate as the sidebar's dirty dot, so what the user sees as
    /// dirty is what auto-pull refuses to touch.
    #[tokio::test]
    async fn auto_pull_skips_a_dirty_tree_in_every_flavour() {
        let root = scratch("dirty");
        let (remote, seed) = remote_with_seed(&root);

        for (name, dirty) in [("unstaged", 0usize), ("staged", 1), ("untracked", 2)] {
            let clone = root.join(name);
            git(
                &root,
                &["clone", remote.to_str().unwrap(), clone.to_str().unwrap()],
            );
            advance_remote(&seed, &format!("one\n{name}\n"));
            git(&clone, &["fetch", "origin"]);

            match dirty {
                0 => std::fs::write(clone.join("a.txt"), "local edit\n").unwrap(),
                1 => {
                    std::fs::write(clone.join("a.txt"), "staged edit\n").unwrap();
                    git(&clone, &["add", "a.txt"]);
                }
                _ => std::fs::write(clone.join("untracked.txt"), "new\n").unwrap(),
            }

            let head_before = rev(&clone, "HEAD");
            let tree_before = std::fs::read_to_string(clone.join("a.txt")).unwrap();

            let (result, timing) = auto_pull_one(7, clone.clone()).await;
            assert_eq!(
                result.status,
                AutoPullStatus::SkippedDirty,
                "{name}: a dirty tree that is behind must be skipped, not pulled"
            );
            assert_eq!(
                rev(&clone, "HEAD"),
                head_before,
                "{name}: HEAD must not move"
            );
            assert_eq!(
                std::fs::read_to_string(clone.join("a.txt")).unwrap(),
                tree_before,
                "{name}: local work must be untouched"
            );
            assert!(timing.is_none(), "{name}: no pull ran, so no timing");
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A diverged branch is skipped by the pre-check…
    #[tokio::test]
    async fn auto_pull_skips_a_diverged_branch() {
        let root = scratch("diverged");
        let (remote, seed) = remote_with_seed(&root);
        let clone = clone_that_is_behind(&root, &remote, &seed, "clone");
        // A local commit on top makes it ahead as well as behind.
        std::fs::write(clone.join("local.txt"), "mine\n").unwrap();
        git(&clone, &["add", "."]);
        git(&clone, &["commit", "-m", "local work"]);

        let head_before = rev(&clone, "HEAD");
        let (result, _) = auto_pull_one(3, clone.clone()).await;

        assert_eq!(result.status, AutoPullStatus::SkippedDiverged);
        assert_eq!(rev(&clone, "HEAD"), head_before, "HEAD must not move");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// …and even if the pre-check is bypassed — which is what a repo that diverges
    /// in the window between the eligibility read and the pull looks like — the
    /// pull itself still refuses, because it is `--ff-only`. This is the assertion
    /// that makes "never a merge commit" a property of the command rather than of
    /// the check's timing.
    #[tokio::test]
    async fn pull_ff_only_refuses_to_merge_a_diverged_branch() {
        let root = scratch("ffonly");
        let (remote, seed) = remote_with_seed(&root);
        let clone = clone_that_is_behind(&root, &remote, &seed, "clone");
        std::fs::write(clone.join("local.txt"), "mine\n").unwrap();
        git(&clone, &["add", "."]);
        git(&clone, &["commit", "-m", "local work"]);

        let before = commit_count(&clone);
        let err = pull_ff_only(&clone).await;

        assert!(err.is_err(), "a diverged pull must fail, not merge");
        assert_eq!(
            commit_count(&clone),
            before,
            "no merge commit may be created"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// No upstream (and its sibling, a detached HEAD) is a skip, never a pull.
    #[tokio::test]
    async fn auto_pull_skips_when_there_is_no_upstream() {
        let root = scratch("noupstream");

        // A standalone repo with a branch that tracks nothing.
        let solo = root.join("solo");
        std::fs::create_dir_all(&solo).unwrap();
        git(&solo, &["init", "-b", "main"]);
        std::fs::write(solo.join("a.txt"), "one\n").unwrap();
        git(&solo, &["add", "."]);
        git(&solo, &["commit", "-m", "init"]);
        assert_eq!(
            auto_pull_eligibility(&solo),
            Some(AutoPullStatus::SkippedNoUpstream)
        );

        // A clone parked on a detached HEAD, which `sync_status_at` reports the
        // same way (no upstream to compare against).
        let (remote, seed) = remote_with_seed(&root);
        let detached = clone_that_is_behind(&root, &remote, &seed, "detached");
        git(&detached, &["checkout", "--detach", "HEAD"]);
        let head_before = rev(&detached, "HEAD");
        let (result, timing) = auto_pull_one(4, detached.clone()).await;
        assert_eq!(result.status, AutoPullStatus::SkippedNoUpstream);
        assert_eq!(rev(&detached, "HEAD"), head_before);
        assert!(timing.is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Nothing to pull is `up-to-date`, **including when the tree is dirty** —
    /// the case that would otherwise raise a "skipped, you have local changes"
    /// warning on every single fetch cycle for a repo you're working in.
    #[tokio::test]
    async fn auto_pull_reports_up_to_date_when_not_behind() {
        let root = scratch("uptodate");
        let (remote, _seed) = remote_with_seed(&root);

        let clean = root.join("clean");
        git(
            &root,
            &["clone", remote.to_str().unwrap(), clean.to_str().unwrap()],
        );
        assert_eq!(
            auto_pull_eligibility(&clean),
            Some(AutoPullStatus::UpToDate),
            "a current repo is a no-op"
        );

        let dirty = root.join("dirty");
        git(
            &root,
            &["clone", remote.to_str().unwrap(), dirty.to_str().unwrap()],
        );
        std::fs::write(dirty.join("a.txt"), "local edit\n").unwrap();
        assert_eq!(
            auto_pull_eligibility(&dirty),
            Some(AutoPullStatus::UpToDate),
            "dirty but not behind must be up-to-date, never skipped-dirty"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The safety promise has to survive a *hostile local config*, not just the
    /// happy path. With `merge.autoStash`/`rebase.autoStash` set — a common
    /// developer setting — a plain `git pull --ff-only` stashes the working tree,
    /// fast-forwards, and pops; a conflicting pop then leaves conflict markers in
    /// the user's files and a dangling autostash. This drives the exact race the
    /// eligibility check cannot cover (the tree becomes dirty *after* the check,
    /// as it would if an editor or a build wrote during the pull's fetch) and
    /// asserts the pull refuses instead.
    #[tokio::test]
    async fn pull_ff_only_never_stashes_even_with_autostash_configured() {
        let root = scratch("autostash");
        let (remote, seed) = remote_with_seed(&root);
        let clone = clone_that_is_behind(&root, &remote, &seed, "clone");
        // Hostile config, set locally so the test is hermetic either way.
        git(&clone, &["config", "merge.autoStash", "true"]);
        git(&clone, &["config", "rebase.autoStash", "true"]);
        // Dirty *after* the eligibility read — the window the pre-check can't close.
        assert_eq!(auto_pull_eligibility(&clone), None, "clean at check time");
        std::fs::write(clone.join("a.txt"), "LOCAL WORK\n").unwrap();

        let outcome = pull_ff_only(&clone).await;

        assert!(
            outcome.is_err(),
            "the pull must refuse a dirty tree, not stash it: {outcome:?}"
        );
        assert_eq!(
            std::fs::read_to_string(clone.join("a.txt")).unwrap(),
            "LOCAL WORK\n",
            "local work must be exactly as the user left it — no merged content, no markers"
        );
        let stashes = git_cmd(&clone)
            .args(["stash", "list"])
            .output()
            .expect("git runs");
        assert!(
            String::from_utf8_lossy(&stashes.stdout).trim().is_empty(),
            "auto-pull must never create a stash"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The batch is failure-isolating like the fetch batch: a pullable repo, a
    /// skipped one, and a folder that isn't a git repo all yield exactly one
    /// result each, and the pullable one still pulls.
    #[tokio::test]
    async fn auto_pull_batch_isolates_failures_and_covers_every_input() {
        let root = scratch("batch");
        let (remote, seed) = remote_with_seed(&root);

        let good = clone_that_is_behind(&root, &remote, &seed, "good");
        let dirty = root.join("dirty");
        git(
            &root,
            &["clone", remote.to_str().unwrap(), dirty.to_str().unwrap()],
        );
        advance_remote(&seed, "one\ntwo\nthree\n");
        git(&dirty, &["fetch", "origin"]);
        std::fs::write(dirty.join("a.txt"), "local edit\n").unwrap();
        let not_git = root.join("plain");
        std::fs::create_dir_all(&not_git).unwrap();

        let pending: Vec<(i64, PathBuf)> = vec![(1, good), (2, dirty), (3, not_git)];
        let out = bounded_map(pending, FETCH_CONCURRENCY, |(id, dir)| {
            auto_pull_one(id, dir)
        })
        .await;

        assert_eq!(out.len(), 3, "one result per input, batch not aborted");
        let by_id: std::collections::HashMap<i64, AutoPullStatus> =
            out.iter().map(|(r, _)| (r.repo_id, r.status)).collect();
        assert_eq!(by_id[&1], AutoPullStatus::Pulled);
        assert_eq!(by_id[&2], AutoPullStatus::SkippedDirty);
        assert_eq!(
            by_id[&3],
            AutoPullStatus::SkippedUnavailable,
            "a non-git folder is unavailable, not a failure and not an upstream problem"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A batch pull over real repos (#294's bulk-action bar): every input yields
    /// exactly one result, the behind clones actually advance, and a non-git
    /// folder fails without aborting the batch — through the same
    /// `bounded_map` + `pull_one` path `git_pull_many` uses.
    #[tokio::test]
    async fn batch_pull_advances_every_repo_and_isolates_failures() {
        let root = scratch("pull_many");
        let (remote, seed) = remote_with_seed(&root);

        // Two clones that are each one commit behind the remote.
        let a = clone_that_is_behind(&root, &remote, &seed, "a");
        let b = root.join("b");
        git(
            &root,
            &["clone", remote.to_str().unwrap(), b.to_str().unwrap()],
        );

        // A plain folder — `git pull` here fails, but must not abort the batch.
        let not_git = root.join("plain");
        std::fs::create_dir_all(&not_git).unwrap();

        let pending: Vec<(i64, PathBuf)> = vec![(1, a.clone()), (2, b.clone()), (99, not_git)];
        let out = bounded_map(pending, SYNC_CONCURRENCY, |(id, dir)| pull_one(id, dir)).await;

        assert_eq!(out.len(), 3, "one result per input, batch not aborted");
        for (r, _) in &out {
            if r.repo_id == 99 {
                assert!(!r.ok, "non-git folder must fail");
                assert!(r.error.is_some());
            } else {
                assert!(r.ok, "repo {} should pull, got {:?}", r.repo_id, r.error);
            }
        }
        // The pull really happened, not just reported success.
        assert_eq!(read_normalized(&a.join("a.txt")), "one\ntwo\n");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A batch push over real repos: every input yields exactly one result, the
    /// commits land on the remote, and a non-git folder fails without aborting
    /// the batch. Also pins the first-push arm — a branch with no upstream gets
    /// one set, which is what `push_target`'s `Some(branch)` carries.
    #[tokio::test]
    async fn batch_push_lands_commits_and_isolates_failures() {
        let root = scratch("push_many");
        let (remote, _seed) = remote_with_seed(&root);

        // A clone with a local commit to push on an already-tracking branch.
        let tracking = root.join("tracking");
        git(
            &root,
            &[
                "clone",
                remote.to_str().unwrap(),
                tracking.to_str().unwrap(),
            ],
        );
        std::fs::write(tracking.join("tracked.txt"), "t").unwrap();
        git(&tracking, &["add", "."]);
        git(&tracking, &["commit", "-m", "tracked change"]);

        // A clone on a brand-new branch that has no upstream yet.
        let fresh = root.join("fresh");
        git(
            &root,
            &["clone", remote.to_str().unwrap(), fresh.to_str().unwrap()],
        );
        git(&fresh, &["switch", "-c", "feature-x"]);
        std::fs::write(fresh.join("new.txt"), "n").unwrap();
        git(&fresh, &["add", "."]);
        git(&fresh, &["commit", "-m", "new branch"]);

        let not_git = root.join("plain");
        std::fs::create_dir_all(&not_git).unwrap();

        let targets: Vec<(i64, PathBuf, Option<String>)> = vec![
            (1, tracking.clone(), None),
            // No upstream yet → the first-push arm sets one.
            (2, fresh.clone(), Some("feature-x".to_string())),
            (99, not_git, None),
        ];
        let out = bounded_map(targets, SYNC_CONCURRENCY, |(id, dir, up)| {
            push_one(id, dir, up)
        })
        .await;

        assert_eq!(out.len(), 3, "one result per input, batch not aborted");
        for (r, _) in &out {
            if r.repo_id == 99 {
                assert!(!r.ok, "non-git folder must fail");
                assert!(r.error.is_some());
            } else {
                assert!(r.ok, "repo {} should push, got {:?}", r.repo_id, r.error);
            }
        }

        // Both pushes actually landed on the remote.
        let refs = std::process::Command::new("git")
            .arg("-C")
            .arg(&remote)
            .args(["for-each-ref", "--format=%(refname:short)"])
            .output()
            .unwrap();
        let refs = String::from_utf8_lossy(&refs.stdout);
        assert!(refs.contains("main"), "tracking push landed: {refs}");
        assert!(
            refs.contains("feature-x"),
            "first push created the branch: {refs}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Batch results come back in the caller's input order regardless of the
    /// order they completed in (`bounded_map` yields by completion), and an id
    /// with no result is dropped rather than shifting the rest.
    #[test]
    fn in_input_order_restores_the_callers_order() {
        let out_of_order = vec![
            SyncResult {
                repo_id: 3,
                ok: true,
                error: None,
            },
            SyncResult {
                repo_id: 1,
                ok: false,
                error: Some("boom".to_string()),
            },
            SyncResult {
                repo_id: 2,
                ok: true,
                error: None,
            },
        ];

        let ordered = in_input_order(out_of_order, vec![1, 2, 3]);
        assert_eq!(
            ordered.iter().map(|r| r.repo_id).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        // The per-repo outcome travels with its id, not its position.
        assert!(!ordered[0].ok, "id 1 keeps its failure");
        assert_eq!(ordered[0].error.as_deref(), Some("boom"));

        // An id nobody reported on is simply absent.
        let ordered = in_input_order(
            vec![SyncResult {
                repo_id: 2,
                ok: true,
                error: None,
            }],
            vec![1, 2, 3],
        );
        assert_eq!(
            ordered.iter().map(|r| r.repo_id).collect::<Vec<_>>(),
            vec![2]
        );
    }

    /// The opt-in is enforced **in the backend**, not just by the caller: a repo
    /// that is registered but not opted in is never handed to the pull step, no
    /// matter what ids the frontend asks about. Also covers the two other arms
    /// that produce a user-visible outcome — folder gone, and an unknown id.
    #[test]
    fn resolve_auto_pull_targets_honours_the_opt_in() {
        let root = scratch("targets");
        let db_path = root.join("gamut.db");
        let conn = crate::db::open(&db_path).unwrap();

        // Two real directories, so "exists on disk" isn't what distinguishes them.
        let opted = root.join("opted");
        let not_opted = root.join("not-opted");
        std::fs::create_dir_all(&opted).unwrap();
        std::fs::create_dir_all(&not_opted).unwrap();

        conn.execute(
            "INSERT INTO repos (id, path, name, auto_pull) VALUES (1, ?1, 'opted', 1)",
            [opted.to_str().unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO repos (id, path, name, auto_pull) VALUES (2, ?1, 'not-opted', 0)",
            [not_opted.to_str().unwrap()],
        )
        .unwrap();
        // Opted in, but its folder no longer exists.
        conn.execute(
            "INSERT INTO repos (id, path, name, auto_pull) VALUES (3, '/nope/gone', 'gone', 1)",
            [],
        )
        .unwrap();

        let (skipped, pending) = resolve_auto_pull_targets(&conn, &[1, 2, 3, 404]);

        assert_eq!(
            pending.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![1],
            "only the opted-in, present repo may be pulled"
        );
        let statuses: std::collections::HashMap<i64, AutoPullStatus> =
            skipped.iter().map(|r| (r.repo_id, r.status)).collect();
        assert_eq!(statuses[&2], AutoPullStatus::SkippedUnavailable);
        assert_eq!(statuses[&3], AutoPullStatus::SkippedUnavailable);
        assert_eq!(
            statuses[&404],
            AutoPullStatus::SkippedUnavailable,
            "an unknown id must not error the batch"
        );
        assert_eq!(
            skipped.len() + pending.len(),
            4,
            "every input id yields exactly one outcome"
        );

        drop(conn);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `branch_needing_upstream` is the one rule behind both the push and the
    /// confirmation the UI shows before it (#300), so it is pinned against every
    /// HEAD shape — and, below, against what `git_push` actually runs.
    #[test]
    fn branch_needing_upstream_only_fires_for_an_untracked_branch() {
        let root = scratch("needs_upstream");

        // A local branch that tracks nothing — the next push publishes it.
        let solo = root.join("solo");
        std::fs::create_dir_all(&solo).unwrap();
        git(&solo, &["init", "-b", "main"]);
        std::fs::write(solo.join("a.txt"), "one\n").unwrap();
        git(&solo, &["add", "."]);
        git(&solo, &["commit", "-m", "init"]);
        assert_eq!(
            branch_needing_upstream(&crate::git::open(&solo).unwrap()),
            Some("main".to_string())
        );

        // A branch created off the first one, also untracked: the name reported
        // is the branch that would be published, not the repo's default.
        git(&solo, &["switch", "-c", "feat/x"]);
        assert_eq!(
            branch_needing_upstream(&crate::git::open(&solo).unwrap()),
            Some("feat/x".to_string()),
            "the branch a push would create, slashes and all"
        );

        // An unborn HEAD (initialised, never committed) has nothing to push.
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        git(&empty, &["init", "-b", "main"]);
        assert_eq!(
            branch_needing_upstream(&crate::git::open(&empty).unwrap()),
            None
        );

        // A clone's branch already tracks, and a detached HEAD pushes plainly.
        let (remote, seed) = remote_with_seed(&root);
        let clone = clone_that_is_behind(&root, &remote, &seed, "clone");
        assert_eq!(
            branch_needing_upstream(&crate::git::open(&clone).unwrap()),
            None
        );
        git(&clone, &["checkout", "--detach", "HEAD"]);
        assert_eq!(
            branch_needing_upstream(&crate::git::open(&clone).unwrap()),
            None,
            "a detached HEAD must not be offered as a branch to publish"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The flag the UI confirms against and the branch `git_push` sets an
    /// upstream for are the *same* value — the confirmation can't promise
    /// something the push then doesn't do.
    #[test]
    fn sync_status_reports_the_branch_the_push_would_publish() {
        let root = scratch("status_publish");

        let solo = root.join("solo");
        std::fs::create_dir_all(&solo).unwrap();
        git(&solo, &["init", "-b", "main"]);
        std::fs::write(solo.join("a.txt"), "one\n").unwrap();
        git(&solo, &["add", "."]);
        git(&solo, &["commit", "-m", "init"]);
        let status = sync_status_at(&solo).unwrap();
        assert_eq!(status.unpublished_branch, Some("main".to_string()));
        assert_eq!(status.upstream, None);
        // `push_target` is `branch_needing_upstream` behind a repo lookup, so the
        // value the push acts on is the one the status just reported.
        assert_eq!(
            branch_needing_upstream(&crate::git::open(&solo).unwrap()),
            status.unpublished_branch
        );

        let (remote, seed) = remote_with_seed(&root);
        let clone = clone_that_is_behind(&root, &remote, &seed, "clone");
        let status = sync_status_at(&clone).unwrap();
        assert_eq!(
            status.unpublished_branch, None,
            "a tracking branch is already published — nothing to confirm"
        );
        assert!(status.upstream.is_some());

        let _ = std::fs::remove_dir_all(&root);
    }
}
