//! File Compare (#130): diff two arbitrary files, or one repo file across two
//! refs / against the working tree. The result feeds Gamut's existing diff
//! viewer — this module only produces the two sides' text plus labels.

use std::path::Path;

use git2::Repository;
use serde::Serialize;
use tauri::State;

use crate::commands::files::safe_join;
use crate::commands::history::repo_path;
use crate::error::{AppError, AppResult};
use crate::git;
use crate::state::AppState;

/// The two sides of a comparison, ready for the diff viewer. `*_text` is `None`
/// when that side is binary or unreadable (the UI shows a binary indicator).
#[derive(Serialize)]
pub struct CompareResult {
    pub left_text: Option<String>,
    pub right_text: Option<String>,
    /// Human label for each side, e.g. an absolute path or `<path> @ <ref>`.
    pub left_label: String,
    pub right_label: String,
    /// True if either side is binary — the UI shows "content differs/identical"
    /// rather than a garbled text diff.
    pub is_binary: bool,
    /// True when both sides are byte-for-byte identical.
    pub identical: bool,
}

/// Classify raw bytes as UTF-8 text or binary, using git's NUL-in-first-8KiB
/// heuristic (matching `files::read_file`). Binary → `None` text.
fn classify(bytes: &[u8]) -> (Option<String>, bool) {
    let is_binary = bytes[..bytes.len().min(8192)].contains(&0);
    if is_binary {
        (None, true)
    } else {
        (Some(String::from_utf8_lossy(bytes).into_owned()), false)
    }
}

/// Write `content` back to an absolute file path. Backs editing a side of a
/// two-files comparison (#130) — those sides are real on-disk files (unlike the
/// git-ref sides, which aren't writable). The path is the same one that was read
/// for the comparison, so this is a user-intended save, not arbitrary traversal.
///
/// Defense-in-depth (#276): confirm the target's parent directory still exists
/// before writing, so a stale path surfaces a clear, actionable error rather than
/// a raw `os error 2` from the underlying `write`.
#[tauri::command]
pub fn write_compare_file(path: String, content: String) -> AppResult<()> {
    let parent = Path::new(&path).parent();
    if let Some(dir) = parent {
        if !dir.as_os_str().is_empty() && !dir.is_dir() {
            return Err(AppError::Other(format!(
                "cannot save {path}: its folder {} no longer exists",
                dir.display()
            )));
        }
    }
    std::fs::write(&path, content).map_err(|e| AppError::Other(format!("writing {path}: {e}")))
}

/// Diff two arbitrary files anywhere on disk (mode 1). No git involvement — the
/// two paths need not be in the same repo, or any repo at all.
#[tauri::command]
pub fn compare_files(left_path: String, right_path: String) -> AppResult<CompareResult> {
    let left = std::fs::read(&left_path)
        .map_err(|e| AppError::Other(format!("reading {left_path}: {e}")))?;
    let right = std::fs::read(&right_path)
        .map_err(|e| AppError::Other(format!("reading {right_path}: {e}")))?;
    let identical = left == right;
    let (left_text, lbin) = classify(&left);
    let (right_text, rbin) = classify(&right);
    Ok(CompareResult {
        left_text,
        right_text,
        left_label: left_path,
        right_label: right_path,
        is_binary: lbin || rbin,
        identical,
    })
}

/// Read `path`'s bytes at `git_ref` (any revparse target: branch/tag/sha), or
/// from the working tree when `git_ref` is `None`. Returns the bytes and a label
/// for that side.
fn read_side(
    repo: &Repository,
    workdir: &Path,
    git_ref: Option<&str>,
    path: &str,
) -> AppResult<(Vec<u8>, String)> {
    match git_ref {
        // Working tree: the file as it sits on disk (safe-joined to the workdir).
        None => {
            let full = safe_join(workdir, path)?;
            let bytes = std::fs::read(&full)
                .map_err(|e| AppError::Other(format!("reading working-tree {path}: {e}")))?;
            Ok((bytes, "Working tree".to_string()))
        }
        Some(r) => {
            let tree = repo
                .revparse_single(r)
                .map_err(|_| AppError::Other(format!("no such ref: {r}")))?
                .peel_to_tree()
                .map_err(|_| AppError::Other(format!("{r} does not resolve to a tree")))?;
            let entry = tree
                .get_path(Path::new(path))
                .map_err(|_| AppError::Other(format!("{path} not found at {r}")))?;
            let blob = repo.find_blob(entry.id())?;
            Ok((blob.content().to_vec(), r.to_string()))
        }
    }
}

/// Diff one repo file between two refs (mode 2), or against the working tree /
/// HEAD (mode 3). A `None` ref means the working tree, so:
///   - across refs:     left=Some("v1.0"),   right=Some("v1.1")
///   - with revision:   left=None|Some("HEAD"), right=Some("<rev>")
#[tauri::command]
pub fn compare_refs(
    state: State<AppState>,
    repo_id: i64,
    path: String,
    left_ref: Option<String>,
    right_ref: Option<String>,
) -> AppResult<CompareResult> {
    let root = repo_path(&state, repo_id)?;
    let repo = git::open(&root)?;
    let workdir = repo.workdir().unwrap_or(&root).to_path_buf();

    let (left, lref) = read_side(&repo, &workdir, left_ref.as_deref(), &path)?;
    let (right, rref) = read_side(&repo, &workdir, right_ref.as_deref(), &path)?;
    let identical = left == right;
    let (left_text, lbin) = classify(&left);
    let (right_text, rbin) = classify(&right);
    Ok(CompareResult {
        left_text,
        right_text,
        left_label: format!("{path} @ {lref}"),
        right_label: format!("{path} @ {rref}"),
        is_binary: lbin || rbin,
        identical,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path as StdPath;

    fn commit_file(repo: &Repository, name: &str, contents: &str) {
        let wd = repo.workdir().unwrap();
        std::fs::write(wd.join(name), contents).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(StdPath::new(name)).unwrap();
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
            .unwrap();
    }

    #[test]
    fn reads_a_file_across_refs_and_worktree() {
        let root = std::env::temp_dir().join(format!("gamut_compare_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = Repository::init(&root).unwrap();

        commit_file(&repo, "a.txt", "v1\n");
        let first = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string();
        commit_file(&repo, "a.txt", "v2\n");

        let workdir = repo.workdir().unwrap().to_path_buf();

        // Old ref vs HEAD.
        let (old, _) = read_side(&repo, &workdir, Some(&first), "a.txt").unwrap();
        let (head, _) = read_side(&repo, &workdir, Some("HEAD"), "a.txt").unwrap();
        assert_eq!(old, b"v1\n");
        assert_eq!(head, b"v2\n");

        // Working tree picks up an uncommitted edit.
        std::fs::write(workdir.join("a.txt"), "v3\n").unwrap();
        let (wt, label) = read_side(&repo, &workdir, None, "a.txt").unwrap();
        assert_eq!(wt, b"v3\n");
        assert_eq!(label, "Working tree");

        // A missing ref is a clear error, not a panic.
        assert!(read_side(&repo, &workdir, Some("nope"), "a.txt").is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn compare_files_flags_identical_and_binary() {
        let dir = std::env::temp_dir().join(format!("gamut_compare_files_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a");
        let b = dir.join("b");
        let bin = dir.join("bin");
        std::fs::write(&a, "same\n").unwrap();
        std::fs::write(&b, "same\n").unwrap();
        std::fs::write(&bin, [0u8, 1, 2, 3]).unwrap();

        let same = compare_files(
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert!(same.identical);
        assert!(!same.is_binary);

        let binary = compare_files(
            a.to_string_lossy().into_owned(),
            bin.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert!(binary.is_binary);
        assert!(!binary.identical);
        assert!(binary.right_text.is_none());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_compare_file_rejects_a_missing_parent_and_writes_a_valid_path() {
        let dir = std::env::temp_dir().join(format!("gamut_write_compare_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // A valid path round-trips the content.
        let ok = dir.join("out.txt");
        write_compare_file(ok.to_string_lossy().into_owned(), "hello\n".to_string()).unwrap();
        assert_eq!(std::fs::read_to_string(&ok).unwrap(), "hello\n");

        // A path whose parent folder no longer exists (#276: a stale comparison
        // path) fails with a clear, path-naming error, not a raw `os error 2`.
        let stale = dir.join("gone").join("readme.txt");
        let err = write_compare_file(stale.to_string_lossy().into_owned(), "x".to_string())
            .unwrap_err()
            .to_string();
        assert!(err.contains("no longer exists"), "unexpected error: {err}");
        assert!(!err.contains("os error"), "leaked raw os error: {err}");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
