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
    /// Lossy UTF-8 text of each side; `None` when that side does not exist
    /// (added/deleted). Empty for binary sides — the diff editor never shows
    /// those, so their bytes are not shipped over IPC.
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub is_binary: bool,
    /// `data:` URL of each side when the file is a supported image type within
    /// the preview size cap, so the UI can render an image diff instead of the
    /// generic "binary file" placeholder. `None` when the side is missing, the
    /// file is not an image, or it is too large to preview.
    pub old_image: Option<String>,
    pub new_image: Option<String>,
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

/// Read a path's blob bytes from a tree; `None` when the path is absent (or
/// not a blob).
pub(crate) fn blob_bytes(repo: &Repository, tree: &Tree, path: &str) -> Option<Vec<u8>> {
    let entry = tree.get_path(Path::new(path)).ok()?;
    let obj = entry.to_object(repo).ok()?;
    let blob = obj.as_blob()?;
    Some(blob.content().to_vec())
}

/// Binary heuristic: any NUL byte in the content. The bytes are already in
/// memory, so a full scan is cheap, and applying it uniformly to blobs and
/// on-disk files means the two sides of a diff cannot disagree.
pub(crate) fn bytes_are_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

/// Assemble a [`FileDiff`] from the raw bytes of each side (`None` = the side
/// does not exist). Text sides are decoded lossily for the diff editor; binary
/// sides ship empty text, and supported image types additionally get a `data:`
/// URL per side so the UI can show the old and new pictures. `old_path` is the
/// pre-rename path (defaults to `path`) — the old side's image type follows it.
pub(crate) fn build_file_diff(
    path: String,
    old_path: Option<&str>,
    old: Option<Vec<u8>>,
    new: Option<Vec<u8>>,
) -> FileDiff {
    let is_binary = old.as_deref().is_some_and(bytes_are_binary)
        || new.as_deref().is_some_and(bytes_are_binary);
    let text = |bytes: &Vec<u8>| {
        if is_binary {
            String::new()
        } else {
            String::from_utf8_lossy(bytes).into_owned()
        }
    };
    let image = |side_path: &str, bytes: &Vec<u8>| {
        if is_binary {
            crate::commands::files::image_data_url(side_path, bytes)
        } else {
            // Text images (SVG) go through the code diff editor.
            None
        }
    };
    let old_side_path = old_path.unwrap_or(&path);
    FileDiff {
        old_text: old.as_ref().map(text),
        new_text: new.as_ref().map(text),
        old_image: old.as_ref().and_then(|b| image(old_side_path, b)),
        new_image: new.as_ref().and_then(|b| image(&path, b)),
        is_binary,
        path,
    }
}

// ---- Commands ----

/// Paginated commit log across all refs, with graph layout.
///
/// `revspec` selects which ref's ancestry to walk — any branch, tag, or sha
/// git2 can `revparse_single` (matching how `compare.rs`/`review.rs` resolve
/// refs). It is a read-only "peek": nothing is checked out, so `HEAD` and the
/// working tree are untouched. When it is `None` (or fails to resolve) the walk
/// falls back to `HEAD`, preserving the current-branch default (#254).
#[tauri::command]
pub async fn log(
    state: State<'_, AppState>,
    repo_id: i64,
    offset: usize,
    limit: usize,
    revspec: Option<String>,
) -> AppResult<LogPage> {
    let path = repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(path, move |p| {
        let repo = git::open(p)?;
        let labels = ref_labels(&repo);

        let mut walk = repo.revwalk()?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
        // Walk the selected ref's ancestry, or the current branch (HEAD) when no
        // ref is chosen. A revspec that resolves is pushed by oid; anything else
        // falls back to HEAD so a stale/invalid pick degrades to the default
        // rather than erroring the view.
        let pushed = match revspec.as_deref() {
            Some(rev) => repo
                .revparse_single(rev)
                .and_then(|o| o.peel_to_commit())
                .map(|c| walk.push(c.id()))
                .unwrap_or_else(|_| walk.push_head()),
            None => walk.push_head(),
        };
        if pushed.is_err() {
            // Unborn branch / empty repo — nothing to show.
            return Ok(LogPage {
                commits: Vec::new(),
                width: 1,
                has_more: false,
            });
        }

        let take = offset + limit + 1; // +1 to detect has_more

        // Collect the window's oids first, then build only what each stage
        // needs: lightweight graph nodes for the *whole* window (the layout
        // needs the full ancestry up to `offset`), but the expensive CommitRow
        // metadata — string allocs, ref-label clones — only for the page that's
        // actually returned. A fully incremental layout is hard (it needs
        // ancestry context), but there's no reason to stringify thousands of
        // rows a deep page immediately discards (#134).
        let oids: Vec<Oid> = walk.take(take).collect::<Result<_, _>>()?;
        let has_more = oids.len() > offset + limit;

        let mut nodes: Vec<graph::CommitNode> = Vec::with_capacity(oids.len());
        for &oid in &oids {
            let parents: Vec<Oid> = repo.find_commit(oid)?.parent_ids().collect();
            nodes.push(graph::CommitNode { oid, parents });
        }

        let (mut graph_rows, width) = graph::layout(&nodes);

        let mut commits: Vec<CommitRow> = Vec::new();
        for (i, &oid) in oids.iter().enumerate().skip(offset).take(limit) {
            let commit = repo.find_commit(oid)?;
            let author = commit.author();
            let row = &mut graph_rows[i];
            commits.push(CommitRow {
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
                node_col: row.node_col,
                color: row.color,
                paths: std::mem::take(&mut row.paths),
            });
        }

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

        let new = blob_bytes(&repo, &tree, &path);
        let old = if commit.parent_count() > 0 {
            let parent_tree = commit.parent(0)?.tree()?;
            let op = old_path.as_deref().unwrap_or(&path);
            blob_bytes(&repo, &parent_tree, op)
        } else {
            None
        };

        Ok(build_file_diff(path, old_path.as_deref(), old, new))
    })
    .await
}

/// Upper bound on commits examined by [`file_history`]. Without it, a file that
/// changed only a handful of times still walks the *entire* history to confirm
/// there are no older changes — O(total history) for a rarely-touched file in a
/// large repo (#134). The cap bounds that cost; in practice it means the view
/// surfaces a file's changes within its most recent ~`FILE_HISTORY_SCAN_CAP`
/// commits, which is what the incrementally-loaded UI shows anyway.
const FILE_HISTORY_SCAN_CAP: usize = 10_000;

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
        for (scanned, oid) in walk.enumerate() {
            // Stop once the page is full or the scan budget is spent (#134).
            if out.len() >= limit || scanned >= FILE_HISTORY_SCAN_CAP {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The 8-byte PNG signature — has NULs, so it trips the binary heuristic.
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR";

    #[test]
    fn text_diff_keeps_both_sides_and_no_images() {
        let d = build_file_diff(
            "a.txt".into(),
            None,
            Some(b"old".to_vec()),
            Some(b"new".to_vec()),
        );
        assert!(!d.is_binary);
        assert_eq!(d.old_text.as_deref(), Some("old"));
        assert_eq!(d.new_text.as_deref(), Some("new"));
        assert!(d.old_image.is_none() && d.new_image.is_none());
    }

    #[test]
    fn image_diff_carries_a_data_url_per_existing_side() {
        // Modified: both sides present.
        let d = build_file_diff(
            "img/logo.png".into(),
            None,
            Some(PNG.to_vec()),
            Some(PNG.to_vec()),
        );
        assert!(d.is_binary);
        assert_eq!(
            d.old_text.as_deref(),
            Some(""),
            "binary text is not shipped"
        );
        assert!(d
            .old_image
            .as_deref()
            .is_some_and(|u| u.starts_with("data:image/png;base64,")));
        assert!(d.new_image.is_some());

        // Added: only the new side exists.
        let added = build_file_diff("shot.PNG".into(), None, None, Some(PNG.to_vec()));
        assert!(added.old_text.is_none() && added.old_image.is_none());
        assert!(
            added.new_image.is_some(),
            "extension match is case-insensitive"
        );

        // Deleted: only the old side exists.
        let deleted = build_file_diff("shot.webp".into(), None, Some(PNG.to_vec()), None);
        assert!(deleted
            .old_image
            .as_deref()
            .is_some_and(|u| u.starts_with("data:image/webp;")));
        assert!(deleted.new_text.is_none() && deleted.new_image.is_none());
    }

    #[test]
    fn non_image_binary_and_text_svg_get_no_data_url() {
        let bin = build_file_diff("blob.bin".into(), None, None, Some(PNG.to_vec()));
        assert!(bin.is_binary && bin.new_image.is_none());

        // SVG is text: it goes through the code diff editor, not the image pane.
        let svg = build_file_diff("icon.svg".into(), None, None, Some(b"<svg/>".to_vec()));
        assert!(!svg.is_binary && svg.new_image.is_none());
        assert_eq!(svg.new_text.as_deref(), Some("<svg/>"));
    }

    #[test]
    fn rename_across_extensions_types_each_side_by_its_own_path() {
        // hero.png -> hero.webp: the old side is still a PNG.
        let d = build_file_diff(
            "hero.webp".into(),
            Some("hero.png"),
            Some(PNG.to_vec()),
            Some(PNG.to_vec()),
        );
        assert!(d
            .old_image
            .as_deref()
            .is_some_and(|u| u.starts_with("data:image/png;")));
        assert!(d
            .new_image
            .as_deref()
            .is_some_and(|u| u.starts_with("data:image/webp;")));

        // hero.png -> hero.bin: only the old side is previewable.
        let d = build_file_diff(
            "hero.bin".into(),
            Some("hero.png"),
            Some(PNG.to_vec()),
            Some(PNG.to_vec()),
        );
        assert!(d.old_image.is_some() && d.new_image.is_none());
    }

    #[test]
    fn late_nul_still_counts_as_binary() {
        let mut bytes = vec![b'a'; 9000];
        bytes.push(0);
        assert!(bytes_are_binary(&bytes));
        assert!(!bytes_are_binary(b"plain text"));
    }

    #[test]
    fn oversized_image_is_binary_without_a_preview() {
        let mut big = PNG.to_vec();
        big.resize(10 * 1024 * 1024 + 1, 0);
        let d = build_file_diff("huge.png".into(), None, None, Some(big));
        assert!(d.is_binary && d.new_image.is_none());
    }
}
