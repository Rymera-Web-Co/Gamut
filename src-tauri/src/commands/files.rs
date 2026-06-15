use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::commands::history::{open_repo, repo_path};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Files larger than this aren't loaded into the editor — we surface a
/// placeholder instead of streaming megabytes into Monaco.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// One entry in a directory listing, for the working-tree file browser.
#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    /// "dir" or "file".
    pub kind: String,
    pub is_symlink: bool,
    /// Ignored by `.gitignore` / core excludes — listed but flagged so the UI
    /// can dim it.
    pub is_ignored: bool,
}

/// A working-tree file's contents for the editor. `text` is `None` when the
/// file is binary, too large, or not valid UTF-8 — the UI shows a placeholder
/// in those cases rather than risk corrupting the file on save.
#[derive(Serialize)]
pub struct FileContent {
    pub text: Option<String>,
    pub is_binary: bool,
    pub too_large: bool,
    /// Set when the file isn't valid UTF-8 (e.g. Latin-1, UTF-16). Editing
    /// would lossily re-encode it, so it's presented read-only.
    pub encoding_error: bool,
}

/// Resolve a repo-relative path against the repo root, rejecting traversal
/// (`..`) and symlink escapes. Returns an absolute path guaranteed to live
/// inside `root`. For paths that don't exist yet (new file writes) the parent
/// directory is validated instead.
fn safe_join(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let escape = || AppError::Other("path escapes the repository root".into());

    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(AppError::Other(
            "path must be relative to the repo root".into(),
        ));
    }
    // Reject any `..` or root/prefix components up front — only plain names and
    // `.` are allowed.
    for comp in rel_path.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(escape()),
        }
    }

    let canon_root = root
        .canonicalize()
        .map_err(|e| AppError::Other(format!("repo root unavailable: {e}")))?;
    let candidate = canon_root.join(rel_path);

    match candidate.canonicalize() {
        // Exists: the canonical path (symlinks resolved) must stay inside root.
        Ok(canon) => {
            if canon.starts_with(&canon_root) {
                Ok(canon)
            } else {
                Err(escape())
            }
        }
        // Doesn't exist (e.g. saving a brand-new file): validate the parent dir
        // resolves inside root, then re-attach the final segment.
        Err(_) => {
            let parent = candidate.parent().ok_or_else(escape)?;
            let name = candidate.file_name().ok_or_else(escape)?;
            let canon_parent = parent.canonicalize().map_err(|_| escape())?;
            if !canon_parent.starts_with(&canon_root) {
                return Err(escape());
            }
            Ok(canon_parent.join(name))
        }
    }
}

/// List one level of the working tree, rooted at `rel_path` (empty string for
/// the repo root). Skips `.git/`; entries ignored by `.gitignore` are flagged
/// (`is_ignored`) rather than hidden. Directories sort before files,
/// alphabetically (case-insensitive).
#[tauri::command]
pub fn list_dir(
    state: State<AppState>,
    repo_id: i64,
    rel_path: String,
) -> AppResult<Vec<DirEntry>> {
    let repo = open_repo(&state, repo_id)?;
    let root = repo
        .workdir()
        .ok_or_else(|| AppError::Other("bare repository has no working tree".into()))?
        .to_path_buf();

    let dir = safe_join(&root, &rel_path)?;
    if !dir.is_dir() {
        return Err(AppError::Other("not a directory".into()));
    }

    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        // The `.git` directory is never browsable.
        if name == ".git" {
            continue;
        }

        let rel = if rel_path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_path.trim_end_matches('/'), name)
        };
        // Honor .gitignore (and core excludes) — but list ignored entries
        // (dimmed in the UI) rather than hiding them. `is_path_ignored` is cheap.
        let is_ignored = repo.is_path_ignored(&rel).unwrap_or(false);

        let file_type = entry.file_type()?;
        let is_symlink = file_type.is_symlink();
        // Classify symlinks by their target so a link to a dir expands.
        let is_dir = if is_symlink {
            fs::metadata(entry.path())
                .map(|m| m.is_dir())
                .unwrap_or(false)
        } else {
            file_type.is_dir()
        };

        entries.push(DirEntry {
            name,
            kind: if is_dir { "dir" } else { "file" }.into(),
            is_symlink,
            is_ignored,
        });
    }

    entries.sort_by(|a, b| {
        let a_dir = a.kind == "dir";
        let b_dir = b.kind == "dir";
        if a_dir != b_dir {
            return if a_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    Ok(entries)
}

/// Read a working-tree file for editing. Distinct from the blob reads in
/// `history`/`worktree` (which come from the index/HEAD) — this is the file as
/// it sits on disk. Binary, oversized, or non-UTF-8 files return `text: None`.
#[tauri::command]
pub fn read_file(state: State<AppState>, repo_id: i64, rel_path: String) -> AppResult<FileContent> {
    let root = repo_path(&state, repo_id)?;
    let path = safe_join(&root, &rel_path)?;

    let meta = fs::metadata(&path)?;
    if !meta.is_file() {
        return Err(AppError::Other("not a file".into()));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Ok(FileContent {
            text: None,
            is_binary: false,
            too_large: true,
            encoding_error: false,
        });
    }

    let bytes = fs::read(&path)?;
    // A NUL byte in the first chunk is git's heuristic for "binary".
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return Ok(FileContent {
            text: None,
            is_binary: true,
            too_large: false,
            encoding_error: false,
        });
    }

    // Only present a file as editable if it's valid UTF-8. Lossily decoding
    // (e.g. Latin-1/UTF-16) would silently corrupt it the moment it's saved.
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContent {
            text: Some(text),
            is_binary: false,
            too_large: false,
            encoding_error: false,
        }),
        Err(_) => Ok(FileContent {
            text: None,
            is_binary: false,
            too_large: false,
            encoding_error: true,
        }),
    }
}

/// Write edited contents back to a working-tree file.
#[tauri::command]
pub fn write_file(
    state: State<AppState>,
    repo_id: i64,
    rel_path: String,
    contents: String,
) -> AppResult<()> {
    let root = repo_path(&state, repo_id)?;
    let path = safe_join(&root, &rel_path)?;
    fs::write(&path, contents)?;
    Ok(())
}

/// Create an empty file at `rel_path`. Fails (rather than overwriting) if a
/// file or directory already exists there. Used by the Files-tab "New File…"
/// action.
#[tauri::command]
pub fn create_file(state: State<AppState>, repo_id: i64, rel_path: String) -> AppResult<()> {
    let root = repo_path(&state, repo_id)?;
    let path = safe_join(&root, &rel_path)?;
    if path.exists() {
        return Err(AppError::Other(
            "a file or folder with that name already exists".into(),
        ));
    }
    // `create_new` makes this atomic: it errors if the path appears between the
    // check above and the write, so we never clobber an existing file.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    Ok(())
}

/// Create a directory at `rel_path`. Fails (rather than reusing) if anything
/// already exists there. Used by the Files-tab "New Folder…" action.
#[tauri::command]
pub fn create_dir(state: State<AppState>, repo_id: i64, rel_path: String) -> AppResult<()> {
    let root = repo_path(&state, repo_id)?;
    let path = safe_join(&root, &rel_path)?;
    if path.exists() {
        return Err(AppError::Other(
            "a file or folder with that name already exists".into(),
        ));
    }
    fs::create_dir(&path)?;
    Ok(())
}

/// Resolve a repo-relative tree path to its absolute filesystem path. Used by
/// the Files-tab "Copy Path" action (Copy Relative Path uses the tree path
/// directly and needs no backend round-trip).
#[tauri::command]
pub fn resolve_path(state: State<AppState>, repo_id: i64, rel_path: String) -> AppResult<String> {
    let root = repo_path(&state, repo_id)?;
    let path = safe_join(&root, &rel_path)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Reveal the repo (or a file within it) in the OS file manager — Finder on
/// macOS, Explorer on Windows, the default manager on Linux.
#[tauri::command]
pub fn reveal_in_file_manager(
    state: State<AppState>,
    repo_id: i64,
    rel_path: Option<String>,
) -> AppResult<()> {
    let root = repo_path(&state, repo_id)?;
    let target = match rel_path {
        Some(rel) if !rel.is_empty() => safe_join(&root, &rel)?,
        _ => root
            .canonicalize()
            .map_err(|e| AppError::Other(format!("repo root unavailable: {e}")))?,
    };
    tauri_plugin_opener::reveal_item_in_dir(&target)
        .map_err(|e| AppError::Other(format!("could not reveal in file manager: {e}")))
}
