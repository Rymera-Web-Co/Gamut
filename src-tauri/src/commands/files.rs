use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::commands::history::repo_path;
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
pub(crate) fn safe_join(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let escape = || AppError::PathEscapesRoot;

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
///
/// Works for plain (non-git) folders too: the root falls back to the registered
/// path and nothing is flagged ignored (there's no repo to ask).
#[tauri::command]
pub fn list_dir(
    state: State<AppState>,
    repo_id: i64,
    rel_path: String,
) -> AppResult<Vec<DirEntry>> {
    let root = repo_path(&state, repo_id)?;
    // A git repo gives us .gitignore-aware listings; a plain folder has no repo
    // to consult, so entries are simply never flagged ignored.
    let repo = crate::git::open(&root).ok();
    let root = match repo.as_ref().and_then(|r| r.workdir()) {
        Some(work) => work.to_path_buf(),
        None => root,
    };

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
        // Non-git folders have no repo, so nothing is flagged ignored.
        let is_ignored = repo
            .as_ref()
            .map(|r| r.is_path_ignored(&rel).unwrap_or(false))
            .unwrap_or(false);

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
    read_file_at(&root, &rel_path)
}

/// Read a repo-relative working-tree file for display, given a repo root and
/// relative path: applies the traversal guard, size cap, and binary/encoding
/// detection. Split out of [`read_file`] so the path-based core is testable.
fn read_file_at(root: &Path, rel_path: &str) -> AppResult<FileContent> {
    let path = safe_join(root, rel_path)?;

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

/// Largest image we'll load into the editor's inline preview. Generously above
/// any reasonable repo asset while bounding the base64 payload handed to the
/// webview.
const MAX_IMAGE_PREVIEW_BYTES: u64 = 10 * 1024 * 1024;

/// Image extensions the file editor can preview inline. Mirrors
/// `IMAGE_EXTENSIONS` in `src/lib/images.ts`; kept here as the *authoritative*
/// guard since the frontend's extension check is UI-only.
const ALLOWED_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"];

/// A working-tree image rendered as a `data:` URL the webview can drop straight
/// into an `<img>`. `read_file` reports these as `is_binary`; this command is
/// the dedicated path that actually loads them for preview.
#[derive(Serialize)]
pub struct ImageContent {
    /// `data:<mime>;base64,<…>` — safe to use as an `<img>` src.
    pub data_url: String,
    /// Raw byte length, for a size caption in the UI.
    pub byte_len: u64,
}

/// Map a (lowercased) image extension to its MIME type.
fn image_mime(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// Read a working-tree image for inline preview, returning it as a `data:` URL.
///
/// Deliberately separate from `read_file` (which flags images as binary and
/// declines to load them): this only serves image preview, so it rejects
/// anything without an allowed image extension and caps the size, mirroring the
/// hardening on the custom-sound path. Rendering the result in an `<img>` is safe
/// even for SVG — `<img>` never executes embedded scripts.
#[tauri::command]
pub fn read_image_file(
    state: State<AppState>,
    repo_id: i64,
    rel_path: String,
) -> AppResult<ImageContent> {
    let root = repo_path(&state, repo_id)?;
    let path = safe_join(&root, &rel_path)?;

    let ext = Path::new(&rel_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(AppError::Other("unsupported image file type".into()));
    }

    let meta = fs::metadata(&path)?;
    if !meta.is_file() {
        return Err(AppError::Other("not a file".into()));
    }
    if meta.len() > MAX_IMAGE_PREVIEW_BYTES {
        return Err(AppError::Other(format!(
            "image is too large to preview ({} MB)",
            meta.len() / (1024 * 1024)
        )));
    }

    let bytes = fs::read(&path)?;
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(ImageContent {
        data_url: format!("data:{};base64,{}", image_mime(&ext), encoded),
        byte_len: meta.len(),
    })
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

/// Delete a file or directory at `rel_path`; directories are removed
/// recursively. Refuses to delete the working-tree root. Used by the Files-tab
/// "Delete" action.
#[tauri::command]
pub fn delete_path(state: State<AppState>, repo_id: i64, rel_path: String) -> AppResult<()> {
    if rel_path.trim().is_empty() {
        return Err(AppError::Other(
            "refusing to delete the repository root".into(),
        ));
    }
    let root = repo_path(&state, repo_id)?;
    let path = safe_join(&root, &rel_path)?;
    // `safe_join` resolves symlinks, so `path` is the real target and is
    // guaranteed to live inside the repo root.
    let meta = fs::symlink_metadata(&path)?;
    if meta.is_dir() {
        fs::remove_dir_all(&path)?;
    } else {
        fs::remove_file(&path)?;
    }
    Ok(())
}

/// Rename or move a working-tree entry from `from_rel` to `to_rel`, both
/// repo-relative. Both ends are sandboxed by [`safe_join`]. Refuses to touch the
/// repo root, and won't clobber a *different* entry already at the destination.
/// Used by the Files-tab "Rename" action.
#[tauri::command]
pub fn rename_path(
    state: State<AppState>,
    repo_id: i64,
    from_path: String,
    to_path: String,
) -> AppResult<()> {
    let root = repo_path(&state, repo_id)?;
    rename_at(&root, &from_path, &to_path)
}

/// Path-based core of [`rename_path`], split out so it's testable without app
/// state.
fn rename_at(root: &Path, from_rel: &str, to_rel: &str) -> AppResult<()> {
    if from_rel.trim().is_empty() {
        return Err(AppError::Other(
            "refusing to rename the repository root".into(),
        ));
    }
    if to_rel.trim().is_empty() {
        return Err(AppError::Other("a destination name is required".into()));
    }

    let from = safe_join(root, from_rel)?;
    // The empty-string check above only catches the literal root path; a relative
    // path like `.` also resolves through `safe_join` back to the root. Reject
    // anything that canonicalizes to the repo root so we never rename it.
    // `safe_join` only canonicalizes paths that already exist; for a source that
    // resolves to a non-canonical form we canonicalize here so the comparison
    // matches the stated intent rather than a raw path spelling.
    let canon_root = root
        .canonicalize()
        .map_err(|e| AppError::Other(format!("repo root unavailable: {e}")))?;
    let canon_from = from
        .canonicalize()
        .map_err(|e| AppError::Other(format!("source path unavailable: {e}")))?;
    if canon_from == canon_root {
        return Err(AppError::Other(
            "refusing to rename the repository root".into(),
        ));
    }
    let to = safe_join(root, to_rel)?;
    // Don't clobber a *different* entry. On a case-insensitive filesystem a
    // case-only rename (`Foo` → `foo`) resolves `to` back to `from` via
    // `safe_join`'s canonicalization, so treat that as "same entry" and allow it.
    if to.exists() && to != from {
        return Err(AppError::Other(
            "a file or folder with that name already exists".into(),
        ));
    }

    // Rename to the *requested* spelling: `safe_join` canonicalizes paths that
    // already exist, which would otherwise swallow a case-only rename on a
    // case-insensitive filesystem. `to`'s parent is validated + canonical; we
    // just re-attach the caller's chosen final segment.
    let name = Path::new(to_rel)
        .file_name()
        .ok_or_else(|| AppError::Other("invalid destination name".into()))?;
    let parent = to
        .parent()
        .ok_or_else(|| AppError::Other("invalid destination path".into()))?;
    fs::rename(&from, parent.join(name))?;
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

/// A terminal-output path resolved against the tracked repos, for the
/// integrated terminal's clickable file paths (issue #255). `repo_id` /
/// `rel_path` are `Some` when the resolved path falls under a tracked repo's
/// root, so the click can open it in the in-app editor; otherwise they're `None`
/// and the caller opens `abs_path` with the OS default app. The whole result is
/// `None` when the candidate doesn't resolve to something that exists on disk —
/// terminal path detection is heuristic, so a non-existent candidate is inert.
#[derive(Serialize)]
pub struct ResolvedTermPath {
    /// Canonical absolute path (symlinks resolved).
    pub abs_path: String,
    pub is_dir: bool,
    pub repo_id: Option<i64>,
    /// Repo-relative, `/`-separated path, set alongside `repo_id`.
    pub rel_path: Option<String>,
}

/// Expand a leading `~` (bare, or `~/…`) to the user's home directory, mirroring
/// what the shell already did before printing the path. Anything else — including
/// `~user` forms, which need passwd lookups we don't do — is returned unchanged.
fn expand_tilde(path: &str) -> PathBuf {
    let home = || std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    if path == "~" {
        if let Some(h) = home() {
            return PathBuf::from(h);
        }
    } else if let Some(rest) = path.strip_prefix("~/") {
        if let Some(h) = home() {
            return PathBuf::from(h).join(rest);
        }
    }
    PathBuf::from(path)
}

/// Resolve a file path seen in terminal output to an absolute path and, when it
/// lives inside a tracked repo, that repo + its repo-relative path (issue #255).
/// Expands `~`, resolves relative paths against the pane's working directory, and
/// canonicalizes — which both normalizes `..`/symlinks and confirms the path
/// exists. When several tracked repos contain the path (nested repos / worktrees)
/// the deepest (longest-root) match wins, so the file maps to the most specific
/// repo.
#[tauri::command]
pub fn resolve_terminal_path(
    state: State<AppState>,
    path: String,
    cwd: String,
) -> AppResult<Option<ResolvedTermPath>> {
    let expanded = expand_tilde(&path);
    let joined = if expanded.is_absolute() {
        expanded
    } else {
        Path::new(&cwd).join(expanded)
    };
    // Canonicalize doubles as an existence check: a candidate that doesn't
    // resolve is inert, so the heuristic linkifier never opens a bogus path.
    let Ok(abs) = joined.canonicalize() else {
        return Ok(None);
    };
    let is_dir = abs.is_dir();

    let repos: Vec<(i64, String)> = {
        let conn = state
            .db
            .lock()
            .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))?;
        let mut stmt = conn.prepare("SELECT id, path FROM repos")?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    let (repo_id, rel_path) = match repo_for_path(&abs, &repos) {
        Some((id, rel)) => (Some(id), Some(rel)),
        None => (None, None),
    };
    Ok(Some(ResolvedTermPath {
        abs_path: abs.to_string_lossy().into_owned(),
        is_dir,
        repo_id,
        rel_path,
    }))
}

/// Find the tracked repo whose (canonical) root contains `abs`, returning its id
/// and the repo-relative, `/`-separated path. When several repos match (nested
/// repos / worktrees) the deepest — longest-root — one wins, so the file maps to
/// the most specific repo. Roots that don't exist on disk are skipped.
fn repo_for_path(abs: &Path, repos: &[(i64, String)]) -> Option<(i64, String)> {
    let mut best: Option<(i64, PathBuf, String)> = None;
    for (id, root) in repos {
        let Ok(canon_root) = Path::new(root).canonicalize() else {
            continue;
        };
        let Ok(rel) = abs.strip_prefix(&canon_root) else {
            continue;
        };
        let deeper = best
            .as_ref()
            .is_none_or(|(_, r, _)| canon_root.as_os_str().len() > r.as_os_str().len());
        if deeper {
            // Repo-relative tree paths are `/`-separated app-wide (see `safe_join`).
            let rel_str = rel
                .components()
                .filter_map(|c| match c {
                    Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/");
            best = Some((*id, canon_root, rel_str));
        }
    }
    best.map(|(id, _, rel)| (id, rel))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_mime_maps_known_extensions() {
        assert_eq!(image_mime("png"), "image/png");
        assert_eq!(image_mime("jpg"), "image/jpeg");
        assert_eq!(image_mime("jpeg"), "image/jpeg");
        assert_eq!(image_mime("svg"), "image/svg+xml");
        assert_eq!(image_mime("ico"), "image/x-icon");
    }

    #[test]
    fn image_mime_falls_back_for_unknown_extensions() {
        assert_eq!(image_mime("txt"), "application/octet-stream");
        assert_eq!(image_mime(""), "application/octet-stream");
        // The match is case-sensitive and expects already-lowercased input.
        assert_eq!(image_mime("PNG"), "application/octet-stream");
    }

    /// A fresh, empty temp directory unique to this test run, cleaned first.
    fn scratch(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("gamut_rename_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn rename_moves_a_file_within_the_tree() {
        let root = scratch("file");
        fs::write(root.join("a.txt"), "hi").unwrap();

        rename_at(&root, "a.txt", "b.txt").unwrap();
        assert!(!root.join("a.txt").exists(), "old name is gone");
        assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "hi");

        // Into an existing subdirectory (a move, not just a rename).
        fs::create_dir(root.join("sub")).unwrap();
        rename_at(&root, "b.txt", "sub/c.txt").unwrap();
        assert!(!root.join("b.txt").exists());
        assert_eq!(fs::read_to_string(root.join("sub/c.txt")).unwrap(), "hi");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn expand_tilde_resolves_home() {
        std::env::set_var("HOME", "/home/tester");
        assert_eq!(expand_tilde("~"), PathBuf::from("/home/tester"));
        assert_eq!(
            expand_tilde("~/src/foo.ts"),
            PathBuf::from("/home/tester/src/foo.ts")
        );
        // Non-tilde and `~user` forms are returned unchanged.
        assert_eq!(expand_tilde("/etc/hosts"), PathBuf::from("/etc/hosts"));
        assert_eq!(expand_tilde("src/foo.ts"), PathBuf::from("src/foo.ts"));
        assert_eq!(expand_tilde("~other/x"), PathBuf::from("~other/x"));
    }

    #[test]
    fn repo_for_path_maps_in_repo_files_and_skips_outsiders() {
        let root = scratch("repo_map");
        let repo_a = root.join("repo_a");
        let outside = root.join("outside");
        fs::create_dir_all(repo_a.join("src")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(repo_a.join("src/foo.ts"), "x").unwrap();
        fs::write(outside.join("bar.ts"), "y").unwrap();

        let repos = vec![(1, repo_a.to_string_lossy().into_owned())];
        let in_repo = repo_a.join("src/foo.ts").canonicalize().unwrap();
        assert_eq!(
            repo_for_path(&in_repo, &repos),
            Some((1, "src/foo.ts".to_string()))
        );

        let out = outside.join("bar.ts").canonicalize().unwrap();
        assert_eq!(repo_for_path(&out, &repos), None);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn repo_for_path_prefers_the_deepest_repo() {
        // A repo nested inside another (or a worktree) — the file must map to the
        // innermost repo, not the outer one.
        let root = scratch("repo_nested");
        let outer = root.join("outer");
        let inner = outer.join("packages/inner");
        fs::create_dir_all(inner.join("src")).unwrap();
        fs::write(inner.join("src/app.rs"), "z").unwrap();

        let repos = vec![
            (1, outer.to_string_lossy().into_owned()),
            (2, inner.to_string_lossy().into_owned()),
        ];
        let file = inner.join("src/app.rs").canonicalize().unwrap();
        assert_eq!(
            repo_for_path(&file, &repos),
            Some((2, "src/app.rs".to_string()))
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rename_moves_a_directory() {
        let root = scratch("dir");
        fs::create_dir(root.join("old")).unwrap();
        fs::write(root.join("old/inner.txt"), "x").unwrap();

        rename_at(&root, "old", "new").unwrap();
        assert!(!root.join("old").exists());
        assert_eq!(fs::read_to_string(root.join("new/inner.txt")).unwrap(), "x");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rename_refuses_to_clobber_a_different_entry() {
        let root = scratch("clobber");
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();

        assert!(rename_at(&root, "a.txt", "b.txt").is_err());
        // Both survive untouched.
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "a");
        assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "b");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rename_rejects_root_and_traversal() {
        let root = scratch("guard");
        fs::write(root.join("a.txt"), "a").unwrap();

        assert!(
            rename_at(&root, "", "b.txt").is_err(),
            "empty source is root"
        );
        assert!(
            rename_at(&root, ".", "b.txt").is_err(),
            "'.' resolves to root"
        );
        assert!(rename_at(&root, "a.txt", "").is_err(), "empty destination");
        assert!(
            rename_at(&root, "a.txt", "../escape.txt").is_err(),
            "destination escapes root"
        );
        assert!(
            rename_at(&root, "../etc/passwd", "a.txt").is_err(),
            "source escapes root"
        );
        assert!(root.join("a.txt").exists(), "guarded file is untouched");

        fs::remove_dir_all(&root).unwrap();
    }
}
