use std::collections::HashMap;
use std::path::{Path, PathBuf};

use git2::{Delta, Oid, Patch, Repository, Sort, Tree};
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::{self, graph};
use crate::state::AppState;

// ---- Serializable types ----

#[derive(Serialize)]
pub struct RefLabel {
    pub name: String,
    pub kind: String, // "head" | "branch" | "remote" | "tag"
}

#[derive(Serialize)]
pub struct CommitRow {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub subject: String,
    pub refs: Vec<RefLabel>,
    // graph layout
    pub node_col: usize,
    pub color: usize,
    pub paths: Vec<graph::GraphPath>,
}

#[derive(Serialize)]
pub struct LogPage {
    pub commits: Vec<CommitRow>,
    pub width: usize,
    pub has_more: bool,
}

#[derive(Serialize)]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Serialize)]
pub struct CommitDetail {
    pub sha: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub message: String,
    pub files: Vec<FileChange>,
}

#[derive(Serialize)]
pub struct FileDiff {
    pub path: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub is_binary: bool,
}

#[derive(Serialize)]
pub struct BlameHunk {
    pub start_line: usize,
    pub line_count: usize,
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub timestamp: i64,
}

// ---- Helpers ----

pub(crate) fn repo_path(state: &AppState, repo_id: i64) -> AppResult<PathBuf> {
    let conn = state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))?;
    let path: String = conn.query_row("SELECT path FROM repos WHERE id = ?1", [repo_id], |r| {
        r.get(0)
    })?;
    Ok(PathBuf::from(path))
}

pub(crate) fn open_repo(state: &State<AppState>, repo_id: i64) -> AppResult<Repository> {
    let path = repo_path(state, repo_id)?;
    git::open(&path)
}

/// Map every commit oid to the refs that point at it.
fn ref_labels(repo: &Repository) -> HashMap<Oid, Vec<RefLabel>> {
    let mut map: HashMap<Oid, Vec<RefLabel>> = HashMap::new();
    let head_target = repo.head().ok().and_then(|h| h.target());

    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            let Some(name) = r.name() else { continue };
            let Some(oid) = r.peel_to_commit().ok().map(|c| c.id()) else {
                continue;
            };

            let (label, kind) = if let Some(b) = name.strip_prefix("refs/heads/") {
                let is_head = head_target == Some(oid)
                    && repo.head().ok().and_then(|h| h.shorthand().map(|s| s == b)) == Some(true);
                (b.to_string(), if is_head { "head" } else { "branch" })
            } else if let Some(b) = name.strip_prefix("refs/remotes/") {
                (b.to_string(), "remote")
            } else if let Some(b) = name.strip_prefix("refs/tags/") {
                (b.to_string(), "tag")
            } else {
                continue;
            };

            map.entry(oid).or_default().push(RefLabel {
                name: label,
                kind: kind.to_string(),
            });
        }
    }
    map
}

fn delta_status(status: Delta) -> &'static str {
    match status {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Modified => "modified",
        Delta::Renamed => "renamed",
        Delta::Copied => "copied",
        Delta::Typechange => "typechange",
        _ => "modified",
    }
}

/// Build the list of changed files (with line stats) from a prepared diff.
pub(crate) fn files_from_diff(diff: &git2::Diff) -> AppResult<Vec<FileChange>> {
    let mut files = Vec::new();
    for i in 0..diff.deltas().len() {
        let delta = diff.get_delta(i).unwrap();
        let (additions, deletions) = match Patch::from_diff(diff, i) {
            Ok(Some(patch)) => {
                let (_, adds, dels) = patch.line_stats()?;
                (adds, dels)
            }
            _ => (0, 0),
        };
        let new_path = delta
            .new_file()
            .path()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let old_raw = delta.old_file().path().map(|p| p.display().to_string());
        // Only surface old_path when it's a genuine rename/copy source.
        let old_path = match delta.status() {
            Delta::Renamed | Delta::Copied => old_raw.filter(|o| *o != new_path),
            _ => None,
        };
        files.push(FileChange {
            path: new_path,
            old_path,
            status: delta_status(delta.status()).to_string(),
            additions,
            deletions,
        });
    }
    Ok(files)
}

/// Read a path's blob from a tree as UTF-8 text, plus whether it's binary.
pub(crate) fn blob_text(repo: &Repository, tree: &Tree, path: &str) -> Option<(String, bool)> {
    let entry = tree.get_path(Path::new(path)).ok()?;
    let obj = entry.to_object(repo).ok()?;
    let blob = obj.as_blob()?;
    let is_binary = blob.is_binary();
    let text = String::from_utf8_lossy(blob.content()).into_owned();
    Some((text, is_binary))
}

// ---- Commands ----

/// Paginated commit log across all refs, with graph layout.
#[tauri::command]
pub async fn log(
    state: State<'_, AppState>,
    repo_id: i64,
    offset: usize,
    limit: usize,
) -> AppResult<LogPage> {
    let path = repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(path, move |p| {
        let repo = git::open(p)?;
        let labels = ref_labels(&repo);

        let mut walk = repo.revwalk()?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
        // History of the current branch only (HEAD's ancestry).
        if walk.push_head().is_err() {
            // Unborn branch / empty repo — nothing to show.
            return Ok(LogPage {
                commits: Vec::new(),
                width: 1,
                has_more: false,
            });
        }

        let take = offset + limit + 1; // +1 to detect has_more
        let mut nodes: Vec<graph::CommitNode> = Vec::new();
        let mut metas: Vec<CommitRow> = Vec::new();

        for oid in walk.take(take) {
            let oid = oid?;
            let commit = repo.find_commit(oid)?;
            let parents: Vec<Oid> = commit.parent_ids().collect();
            let author = commit.author();

            nodes.push(graph::CommitNode {
                oid,
                parents: parents.clone(),
            });
            metas.push(CommitRow {
                sha: oid.to_string(),
                short_sha: oid.to_string()[..8].to_string(),
                parents: parents.iter().map(|p| p.to_string()).collect(),
                author_name: author.name().unwrap_or("").to_string(),
                author_email: author.email().unwrap_or("").to_string(),
                timestamp: commit.time().seconds(),
                subject: commit.summary().unwrap_or("").to_string(),
                refs: labels
                    .get(&oid)
                    .map(|v| clone_labels(v))
                    .unwrap_or_default(),
                node_col: 0,
                color: 0,
                paths: Vec::new(),
            });
        }

        let has_more = metas.len() > offset + limit;
        let (graph_rows, width) = graph::layout(&nodes);

        // Attach graph layout to each commit.
        for (meta, row) in metas.iter_mut().zip(graph_rows) {
            meta.node_col = row.node_col;
            meta.color = row.color;
            meta.paths = row.paths;
        }

        let commits = metas.into_iter().skip(offset).take(limit).collect();
        Ok(LogPage {
            commits,
            width,
            has_more,
        })
    })
    .await
}

fn clone_labels(labels: &[RefLabel]) -> Vec<RefLabel> {
    labels
        .iter()
        .map(|l| RefLabel {
            name: l.name.clone(),
            kind: l.kind.clone(),
        })
        .collect()
}

/// Files changed by a commit (diffed against its first parent), with line stats.
#[tauri::command]
pub async fn commit_detail(
    state: State<'_, AppState>,
    repo_id: i64,
    sha: String,
) -> AppResult<CommitDetail> {
    let path = repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(path, move |p| {
        let repo = git::open(p)?;
        let oid = Oid::from_str(&sha)?;
        let commit = repo.find_commit(oid)?;
        let tree = commit.tree()?;
        let parent_tree = if commit.parent_count() > 0 {
            Some(commit.parent(0)?.tree()?)
        } else {
            None
        };

        let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;
        let files = files_from_diff(&diff)?;

        let author = commit.author();
        Ok(CommitDetail {
            sha,
            author_name: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            timestamp: commit.time().seconds(),
            message: commit.message().unwrap_or("").to_string(),
            files,
        })
    })
    .await
}

/// Old/new text for one file in a commit, for the diff editor.
#[tauri::command]
pub async fn file_diff(
    state: State<'_, AppState>,
    repo_id: i64,
    sha: String,
    path: String,
    old_path: Option<String>,
) -> AppResult<FileDiff> {
    let repo_dir = repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(repo_dir, move |p| {
        let repo = git::open(p)?;
        let oid = Oid::from_str(&sha)?;
        let commit = repo.find_commit(oid)?;
        let tree = commit.tree()?;

        let new = blob_text(&repo, &tree, &path);
        let old = if commit.parent_count() > 0 {
            let parent_tree = commit.parent(0)?.tree()?;
            let op = old_path.as_deref().unwrap_or(&path);
            blob_text(&repo, &parent_tree, op)
        } else {
            None
        };

        let is_binary = new.as_ref().map(|(_, b)| *b).unwrap_or(false)
            || old.as_ref().map(|(_, b)| *b).unwrap_or(false);

        Ok(FileDiff {
            path,
            old_text: old.map(|(t, _)| t),
            new_text: new.map(|(t, _)| t),
            is_binary,
        })
    })
    .await
}

/// Commits that touched a given path (newest first).
#[tauri::command]
pub async fn file_history(
    state: State<'_, AppState>,
    repo_id: i64,
    path: String,
    limit: usize,
) -> AppResult<Vec<CommitRow>> {
    let repo_dir = repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(repo_dir, move |p| {
        let repo = git::open(p)?;
        let labels = ref_labels(&repo);
        let target = Path::new(&path);

        let mut walk = repo.revwalk()?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
        walk.push_head()?;

        let mut out = Vec::new();
        for oid in walk {
            if out.len() >= limit {
                break;
            }
            let oid = oid?;
            let commit = repo.find_commit(oid)?;
            let tree = commit.tree()?;
            let new_entry = tree.get_path(target).ok().map(|e| e.id());

            let changed = if commit.parent_count() == 0 {
                new_entry.is_some()
            } else {
                let parent_tree = commit.parent(0)?.tree()?;
                let old_entry = parent_tree.get_path(target).ok().map(|e| e.id());
                new_entry != old_entry
            };

            if changed {
                let author = commit.author();
                out.push(CommitRow {
                    sha: oid.to_string(),
                    short_sha: oid.to_string()[..8].to_string(),
                    parents: commit.parent_ids().map(|p| p.to_string()).collect(),
                    author_name: author.name().unwrap_or("").to_string(),
                    author_email: author.email().unwrap_or("").to_string(),
                    timestamp: commit.time().seconds(),
                    subject: commit.summary().unwrap_or("").to_string(),
                    refs: labels
                        .get(&oid)
                        .map(|v| clone_labels(v))
                        .unwrap_or_default(),
                    node_col: 0,
                    color: 0,
                    paths: Vec::new(),
                });
            }
        }
        Ok(out)
    })
    .await
}

/// Per-line blame for a file at a given commit.
#[tauri::command]
pub async fn blame(
    state: State<'_, AppState>,
    repo_id: i64,
    sha: String,
    path: String,
) -> AppResult<Vec<BlameHunk>> {
    let repo_dir = repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(repo_dir, move |p| {
        let repo = git::open(p)?;
        let oid = Oid::from_str(&sha)?;

        let mut opts = git2::BlameOptions::new();
        opts.newest_commit(oid);
        let blame = repo.blame_file(Path::new(&path), Some(&mut opts))?;

        let mut hunks = Vec::new();
        for h in blame.iter() {
            let commit_id = h.final_commit_id();
            let (author, timestamp) = repo
                .find_commit(commit_id)
                .map(|c| {
                    (
                        c.author().name().unwrap_or("").to_string(),
                        c.time().seconds(),
                    )
                })
                .unwrap_or_default();
            hunks.push(BlameHunk {
                start_line: h.final_start_line(),
                line_count: h.lines_in_hunk(),
                sha: commit_id.to_string(),
                short_sha: commit_id.to_string()[..8].to_string(),
                author,
                timestamp,
            });
        }
        Ok(hunks)
    })
    .await
}
