use std::path::{Path, PathBuf};

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
    let started = std::time::Instant::now();
    let result = crate::commands::run_git_gated(&state, move || worktree_status_at(&path)).await;
    crate::commands::diagnostics::record(
        &state,
        crate::commands::diagnostics::OpTiming::finished(
            "git_worktree_status",
            Some(repo_id),
            started,
            result.is_ok(),
            result.as_ref().err().map(|e| e.to_string()),
        ),
    );
    result
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
    let repo_dir = repo_path(&state, repo_id)?;
    worktree_file_diff_at(&repo_dir, &path, staged, old_path.as_deref())
}

/// Old/new text for one working-tree file, opening the repo from `repo_dir`.
/// Split out of the [`worktree_file_diff`] command so the diff core is a plain
/// path-based function.
fn worktree_file_diff_at(
    repo_dir: &Path,
    path: &str,
    staged: bool,
    old_path: Option<&str>,
) -> AppResult<FileDiff> {
    let repo = crate::git::open(repo_dir)?;
    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| c.tree().ok());
    let index = repo.index()?;
    let old_lookup = old_path.unwrap_or(path);

    let (old, new) = if staged {
        let old = head_tree
            .as_ref()
            .and_then(|t| blob_text(&repo, t, old_lookup));
        let new = index_blob_text(&repo, &index, path);
        (old, new)
    } else {
        let old = index_blob_text(&repo, &index, old_lookup);
        // New content is the file on disk; missing means it was deleted.
        let new = repo.workdir().and_then(|wd| {
            std::fs::read(wd.join(path)).ok().map(|bytes| {
                let is_binary = bytes.contains(&0);
                (String::from_utf8_lossy(&bytes).into_owned(), is_binary)
            })
        });
        (old, new)
    };

    let is_binary = old.as_ref().map(|(_, b)| *b).unwrap_or(false)
        || new.as_ref().map(|(_, b)| *b).unwrap_or(false);

    Ok(FileDiff {
        path: path.to_string(),
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

/// One entry of `git worktree list` — the main working tree or a linked
/// worktree created with `git worktree add`. Linked worktrees are discovered
/// from git itself (never stored), so trees created by any external tool show
/// up the same way.
#[derive(Serialize)]
pub struct LinkedWorktree {
    pub repo_id: i64,
    /// Absolute path of the working tree checkout.
    pub path: String,
    /// Checked-out branch, without the `refs/heads/` prefix (`None` when
    /// detached or bare).
    pub branch: Option<String>,
    /// Commit id the tree is at (`None` for a bare entry).
    pub head: Option<String>,
    /// Whether this is the repo's main working tree (always listed first).
    pub is_main: bool,
    /// The checkout directory no longer exists on disk (prunable).
    pub missing: bool,
    /// `git worktree lock` was used on this entry — git refuses to prune or
    /// remove it without an explicit override.
    pub locked: bool,
    /// git considers this entry a candidate for `git worktree prune` (its
    /// administrative files reference a checkout git can no longer confirm).
    /// Distinct from `missing`, which this app derives itself by checking the
    /// path on disk — `prunable` is git's own porcelain-reported verdict.
    pub prunable: bool,
    /// Whether this checkout is already a registered sidebar repo. Computed
    /// backend-side by canonicalizing this path and matching it against the
    /// registered repos' (already-canonical) paths — the frontend used to
    /// compare raw path strings, which false-negatived on a `/tmp` vs.
    /// `/private/tmp`-style symlink difference on macOS (#326 LOW-1). A
    /// missing checkout (`missing == true`) can't be canonicalized and always
    /// reads as `false`, which is the right answer either way (nothing to
    /// register).
    pub registered: bool,
}

/// All working trees of a repo — the main checkout plus any linked worktrees —
/// straight from `git worktree list --porcelain`.
#[tauri::command]
pub async fn git_worktree_list(
    state: State<'_, AppState>,
    repo_id: i64,
) -> AppResult<Vec<LinkedWorktree>> {
    let dir = repo_path(&state, repo_id)?.to_string_lossy().to_string();
    // Gated: a group switch mounts one row per repo and each row fetches its
    // worktree list, so without the cap this fans out into one `git` process
    // per repo at once. See `run_git_cli_gated`.
    let out =
        crate::commands::run_git_cli_gated(&state, &dir, &["worktree", "list", "--porcelain"])
            .await?;
    let registered = registered_repo_paths(&state)?;
    Ok(parse_worktree_list(repo_id, &out, &registered))
}

/// Canonicalized absolute paths of every registered repo (#326 LOW-1) — used
/// to decide `LinkedWorktree::registered` by comparing resolved on-disk
/// locations rather than raw path strings, so a repo registered via a
/// different (but equivalent) spelling of the same path still matches. Repos
/// are already stored canonicalized (`repo::register_path`), but this doesn't
/// assume that stays true.
fn registered_repo_paths(state: &State<'_, AppState>) -> AppResult<Vec<PathBuf>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))?;
    let paths = crate::commands::repo::all_repo_paths(&conn)?;
    Ok(paths
        .into_iter()
        .map(|p| {
            let pb = PathBuf::from(&p);
            std::fs::canonicalize(&pb).unwrap_or(pb)
        })
        .collect())
}

/// Parse `git worktree list --porcelain` output: blank-line-separated blocks of
/// `worktree <path>` / `HEAD <sha>` / `branch <ref>` (or `detached` / `bare`)
/// lines, main working tree first. `registered_paths` are the already-
/// canonicalized registered-repo paths to match each worktree's own
/// canonicalized path against, for `LinkedWorktree::registered`.
fn parse_worktree_list(
    repo_id: i64,
    porcelain: &str,
    registered_paths: &[PathBuf],
) -> Vec<LinkedWorktree> {
    let mut out: Vec<LinkedWorktree> = Vec::new();
    for block in porcelain.split("\n\n") {
        let mut path: Option<&str> = None;
        let mut head: Option<&str> = None;
        let mut branch: Option<&str> = None;
        let mut locked = false;
        let mut prunable = false;
        for line in block.lines() {
            if let Some(v) = line.strip_prefix("worktree ") {
                path = Some(v);
            } else if let Some(v) = line.strip_prefix("HEAD ") {
                head = Some(v);
            } else if let Some(v) = line.strip_prefix("branch ") {
                branch = Some(v.strip_prefix("refs/heads/").unwrap_or(v));
            } else if line == "locked" || line.starts_with("locked ") {
                locked = true;
            } else if line == "prunable" || line.starts_with("prunable ") {
                prunable = true;
            }
        }
        let Some(path) = path else { continue };
        // A missing checkout can't be canonicalized (falls back to the raw
        // path, per `unwrap_or_else`), which then won't match any registered
        // (real, canonicalizable) path anyway — `registered: false` for a
        // missing worktree either way, which is the right answer.
        let canonical =
            std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
        out.push(LinkedWorktree {
            repo_id,
            path: path.to_string(),
            branch: branch.map(String::from),
            head: head.map(String::from),
            is_main: out.is_empty(),
            missing: !Path::new(path).is_dir(),
            locked,
            prunable,
            registered: registered_paths.contains(&canonical),
        });
    }
    out
}

/// Add a linked worktree (`git worktree add`). `create_branch` picks between
/// checking out an existing branch (`git worktree add <path> <branch>`) and
/// creating a new one at the new worktree (`git worktree add -b <branch>
/// <path>`, branched from the current HEAD — mirrors plain `git worktree add
/// -b` with no explicit start point).
#[tauri::command]
pub async fn git_worktree_add(
    state: State<'_, AppState>,
    repo_id: i64,
    path: String,
    branch: String,
    create_branch: bool,
) -> AppResult<()> {
    let branch = branch.trim();
    let path = path.trim();
    if branch.is_empty() {
        return Err(AppError::Other("Branch name cannot be empty".into()));
    }
    if path.is_empty() {
        return Err(AppError::Other("Worktree path cannot be empty".into()));
    }
    let dir = repo_path(&state, repo_id)?.to_string_lossy().to_string();
    let args = worktree_add_args(path, branch, create_branch);
    let argref: Vec<&str> = args.iter().map(String::as_str).collect();
    crate::commands::run_git_cli_gated(&state, &dir, &argref).await?;
    Ok(())
}

/// Pure `git worktree add` argument construction — no state/process involved,
/// so a test can pin the exact args for both branch modes without a repo. A
/// `--` marks the end of options right before the `<path>` operand (`git
/// worktree add [-b new] [--] <path> [<commit-ish>]`), so a path or branch
/// name that happens to start with `-` is never misread as a flag.
fn worktree_add_args(path: &str, branch: &str, create_branch: bool) -> Vec<String> {
    if create_branch {
        vec![
            "worktree".into(),
            "add".into(),
            "-b".into(),
            branch.into(),
            "--".into(),
            path.into(),
        ]
    } else {
        vec![
            "worktree".into(),
            "add".into(),
            "--".into(),
            path.into(),
            branch.into(),
        ]
    }
}

/// Whether `a` and `b` refer to the same on-disk location, resolved through
/// symlinks/`..` where possible so a repo root passed with a trailing slash or
/// a different (but equivalent) spelling still matches. Falls back to the
/// unresolved path when canonicalization fails (e.g. the path doesn't exist),
/// so a still-meaningful comparison survives rather than erroring out.
fn is_same_path(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

/// Remove a linked worktree (`git worktree remove`). Refuses the repo's own
/// main working tree outright — that path is never a *linked* worktree, and
/// removing it would blow away the checkout this whole command operates
/// through. `force` skips git's own "worktree is dirty" refusal.
#[tauri::command]
pub async fn git_worktree_remove(
    state: State<'_, AppState>,
    repo_id: i64,
    path: String,
    force: bool,
) -> AppResult<()> {
    let dir = repo_path(&state, repo_id)?;
    if is_same_path(&dir, Path::new(&path)) {
        return Err(AppError::Other(
            "cannot remove the repository's main working tree".into(),
        ));
    }
    let dir = dir.to_string_lossy().to_string();
    let args = worktree_remove_args(&path, force);
    let argref: Vec<&str> = args.iter().map(String::as_str).collect();
    crate::commands::run_git_cli_gated(&state, &dir, &argref).await?;
    Ok(())
}

/// Pure `git worktree remove` argument construction, mirroring
/// [`worktree_add_args`] — the same `--` end-of-options marker goes right
/// before the `<worktree>` path operand.
fn worktree_remove_args(path: &str, force: bool) -> Vec<String> {
    if force {
        vec![
            "worktree".into(),
            "remove".into(),
            "--force".into(),
            "--".into(),
            path.into(),
        ]
    } else {
        vec!["worktree".into(), "remove".into(), "--".into(), path.into()]
    }
}

/// Remove stale linked-worktree administrative entries (`git worktree prune`)
/// — e.g. one whose checkout directory was deleted by hand instead of through
/// `git worktree remove`.
#[tauri::command]
pub async fn git_worktree_prune(state: State<'_, AppState>, repo_id: i64) -> AppResult<()> {
    let dir = repo_path(&state, repo_id)?.to_string_lossy().to_string();
    crate::commands::run_git_cli_gated(&state, &dir, &["worktree", "prune"]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::BranchType;
    use std::path::PathBuf;

    #[test]
    fn parses_main_and_linked_worktrees() {
        let existing = std::env::temp_dir();
        let porcelain = format!(
            "worktree {main}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n\
             worktree /nonexistent/wt-feat\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/feat/thing\n\n\
             worktree /nonexistent/wt-detached\nHEAD 3333333333333333333333333333333333333333\ndetached",
            main = existing.display()
        );
        let wts = parse_worktree_list(7, &porcelain, &[]);
        assert_eq!(wts.len(), 3);

        assert!(wts[0].is_main);
        assert_eq!(wts[0].repo_id, 7);
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert!(!wts[0].missing);

        assert!(!wts[1].is_main);
        assert_eq!(wts[1].branch.as_deref(), Some("feat/thing"));
        assert!(wts[1].missing);

        assert_eq!(wts[2].branch, None);
        assert_eq!(
            wts[2].head.as_deref(),
            Some("3333333333333333333333333333333333333333")
        );
    }

    #[test]
    fn parses_bare_entry_without_head_or_branch() {
        let wts = parse_worktree_list(1, "worktree /repos/bare.git\nbare", &[]);
        assert_eq!(wts.len(), 1);
        assert!(wts[0].is_main);
        assert_eq!(wts[0].head, None);
        assert_eq!(wts[0].branch, None);
    }

    #[test]
    fn empty_output_parses_to_no_entries() {
        assert!(parse_worktree_list(1, "", &[]).is_empty());
    }

    // ---- A12: locked / prunable parsed from the porcelain output ----

    #[test]
    fn parses_locked_and_prunable_entries() {
        let porcelain = "worktree /repos/main\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n\
             worktree /nonexistent/wt-locked\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/locked-branch\nlocked a reason\n\n\
             worktree /nonexistent/wt-prunable\nHEAD 3333333333333333333333333333333333333333\nbranch refs/heads/prunable-branch\nprunable gitdir file points to non-existent location";
        let wts = parse_worktree_list(1, porcelain, &[]);
        assert_eq!(wts.len(), 3);

        assert!(!wts[0].locked, "main worktree is never locked");
        assert!(!wts[0].prunable);

        assert!(wts[1].locked, "'locked <reason>' must set locked");
        assert!(!wts[1].prunable);

        assert!(!wts[2].locked);
        assert!(wts[2].prunable, "'prunable <reason>' must set prunable");
    }

    // ---- LOW-1: registered flag matches by canonicalized path ----

    #[test]
    fn registered_matches_a_canonicalized_path_and_a_missing_worktree_reads_false() {
        let root = std::env::temp_dir().join(format!("gamut_wt_registered_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let registered_dir = root.join("registered");
        std::fs::create_dir_all(&registered_dir).unwrap();
        let canonical_registered = std::fs::canonicalize(&registered_dir).unwrap();

        let porcelain = format!(
            "worktree {registered}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n\
             worktree /nonexistent/wt-unregistered\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/other",
            registered = registered_dir.display()
        );
        let wts = parse_worktree_list(1, &porcelain, &[canonical_registered]);
        assert_eq!(wts.len(), 2);
        assert!(
            wts[0].registered,
            "matches the registered repo's canonicalized path"
        );
        assert!(
            !wts[1].registered,
            "a missing checkout can't be canonicalized and never matches"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- git_worktree_add / remove: pure arg construction ----

    #[test]
    fn worktree_add_args_picks_existing_vs_new_branch_shape() {
        assert_eq!(
            worktree_add_args("/repos/wt", "feature", false),
            vec!["worktree", "add", "--", "/repos/wt", "feature"],
            "existing branch: -- then path then branch, no -b"
        );
        assert_eq!(
            worktree_add_args("/repos/wt", "feature", true),
            vec!["worktree", "add", "-b", "feature", "--", "/repos/wt"],
            "new branch: -b <branch> -- <path>"
        );
    }

    #[test]
    fn worktree_remove_args_adds_force_flag_only_when_forced() {
        assert_eq!(
            worktree_remove_args("/repos/wt", false),
            vec!["worktree", "remove", "--", "/repos/wt"]
        );
        assert_eq!(
            worktree_remove_args("/repos/wt", true),
            vec!["worktree", "remove", "--force", "--", "/repos/wt"]
        );
    }

    // ---- A18: the repo's own root is never treated as a linked worktree ----

    #[test]
    fn is_same_path_matches_the_repo_root_regardless_of_trailing_slash() {
        let root = std::env::temp_dir().join(format!("gamut_wt_samepath_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        assert!(is_same_path(&root, &root));
        // A trailing separator is a different `Path` value but the same
        // location. `Path::join("")` is a no-op, so the trailing slash has to
        // be built by hand via a formatted string.
        let with_slash = PathBuf::from(format!("{}/", root.display()));
        assert!(is_same_path(&root, &with_slash));
        assert!(!is_same_path(&root, &root.join("elsewhere")));

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- git worktree add/remove/prune: real on-disk behaviour ----
    //
    // These run the actual `git` CLI (through the same `run_git` the gated
    // commands call, using the exact args `worktree_add_args`/
    // `worktree_remove_args` build) rather than mocking it — the whole point
    // is proving the args land on the right on-disk state and HEAD, which a
    // stubbed git can't demonstrate.

    fn init_repo(root: &Path) -> Repository {
        let repo = Repository::init(root).unwrap();
        std::fs::write(root.join("a.txt"), "hello\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = git2::Signature::now("Test", "test@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }
        repo
    }

    #[tokio::test]
    async fn worktree_add_existing_branch_checks_it_out_on_disk() {
        let root =
            std::env::temp_dir().join(format!("gamut_wt_add_existing_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &commit, false).unwrap();

        let wt_path = root.join("wt-feature");
        let args = worktree_add_args(wt_path.to_str().unwrap(), "feature", false);
        let argref: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git(root.to_str().unwrap(), &argref).await.unwrap();

        assert!(wt_path.join("a.txt").is_file(), "checkout landed on disk");
        let wt_repo = Repository::open(&wt_path).unwrap();
        assert_eq!(
            crate::git::current_branch(&wt_repo).as_deref(),
            Some("feature")
        );

        let _ = std::process::Command::new("git")
            .args(["worktree", "remove", "--force"])
            .arg(&wt_path)
            .current_dir(&root)
            .output();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn worktree_add_new_branch_creates_it_from_head() {
        let root = std::env::temp_dir().join(format!("gamut_wt_add_new_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let head_oid = repo.head().unwrap().target().unwrap();

        let wt_path = root.join("wt-newbranch");
        let args = worktree_add_args(wt_path.to_str().unwrap(), "brand-new", true);
        let argref: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git(root.to_str().unwrap(), &argref).await.unwrap();

        assert!(repo.find_branch("brand-new", BranchType::Local).is_ok());
        let wt_repo = Repository::open(&wt_path).unwrap();
        assert_eq!(
            crate::git::current_branch(&wt_repo).as_deref(),
            Some("brand-new")
        );
        assert_eq!(wt_repo.head().unwrap().target(), Some(head_oid));

        let _ = std::process::Command::new("git")
            .args(["worktree", "remove", "--force"])
            .arg(&wt_path)
            .current_dir(&root)
            .output();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn worktree_remove_clean_succeeds_dirty_needs_force() {
        let root = std::env::temp_dir().join(format!("gamut_wt_remove_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &commit, false).unwrap();
        let wt_path = root.join("wt-feature");
        run_git(
            root.to_str().unwrap(),
            &worktree_add_args(wt_path.to_str().unwrap(), "feature", false)
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        )
        .await
        .unwrap();

        // Dirty the worktree, then a non-forced remove must be refused.
        std::fs::write(wt_path.join("uncommitted.txt"), "dirty").unwrap();
        let refused_args = worktree_remove_args(wt_path.to_str().unwrap(), false);
        let refused_argref: Vec<&str> = refused_args.iter().map(String::as_str).collect();
        assert!(run_git(root.to_str().unwrap(), &refused_argref)
            .await
            .is_err());
        assert!(
            wt_path.is_dir(),
            "refused remove left the worktree in place"
        );

        // Forced remove succeeds despite the dirty state.
        let force_args = worktree_remove_args(wt_path.to_str().unwrap(), true);
        let force_argref: Vec<&str> = force_args.iter().map(String::as_str).collect();
        run_git(root.to_str().unwrap(), &force_argref)
            .await
            .unwrap();
        assert!(!wt_path.exists(), "forced remove deleted the worktree");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn worktree_prune_removes_a_stale_entry() {
        let root = std::env::temp_dir().join(format!("gamut_wt_prune_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &commit, false).unwrap();
        let wt_path = root.join("wt-feature");
        run_git(
            root.to_str().unwrap(),
            &worktree_add_args(wt_path.to_str().unwrap(), "feature", false)
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        )
        .await
        .unwrap();

        // Delete the checkout directory by hand (not via `worktree remove`),
        // leaving a stale administrative entry for `prune` to clean up.
        std::fs::remove_dir_all(&wt_path).unwrap();
        let before = run_git(root.to_str().unwrap(), &["worktree", "list", "--porcelain"])
            .await
            .unwrap();
        assert!(before.contains("wt-feature"), "sanity: entry still listed");

        run_git(root.to_str().unwrap(), &["worktree", "prune"])
            .await
            .unwrap();

        let after = run_git(root.to_str().unwrap(), &["worktree", "list", "--porcelain"])
            .await
            .unwrap();
        assert!(
            !after.contains("wt-feature"),
            "prune removed the stale entry"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }
}
