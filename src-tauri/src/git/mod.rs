pub mod graph;

use std::path::{Path, PathBuf};

use git2::Repository;

use crate::error::{AppError, AppResult};

/// Open a git repository at `path`, validating that it is one.
pub fn open(path: &Path) -> AppResult<Repository> {
    Repository::open(path).map_err(|_| AppError::NotARepo(path.display().to_string()))
}

/// Derive a display name from a repo path (its final path component).
pub fn repo_name(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("repository")
        .to_string()
}

/// The repo's current HEAD branch shorthand, if on a branch.
pub fn current_branch(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if head.is_branch() {
        head.shorthand().map(|s| s.to_string())
    } else {
        None
    }
}

/// An entry discovered while scanning a directory tree: either a git repo or a
/// repo-free leaf folder (a directory with no git repos at or beneath it).
pub struct Discovered {
    pub path: PathBuf,
    pub name: String,
    pub default_branch: Option<String>,
    /// `true` for a git repo, `false` for a plain (non-git) folder.
    pub is_git_repo: bool,
}

const PRUNE: &[&str] = &[
    "node_modules",
    "vendor",
    "target",
    ".git",
    "dist",
    "build",
    ".next",
    ".cache",
];

/// The built-in directory names skipped during discovery, as owned strings.
/// Used as the default when no `pref.pruneDirs` override is configured.
pub fn default_prune_dirs() -> Vec<String> {
    PRUNE.iter().map(|s| s.to_string()).collect()
}

/// macOS package/library bundle suffixes. Directories whose name ends in one of
/// these are opaque bundles (Photos/Music/TV libraries, Final Cut bundles, apps,
/// …), not source trees. Descending into them serves no purpose and, for the
/// media libraries, triggers a macOS TCC permission prompt (e.g. "Gamut would
/// like to access your Photos"). They are always treated as leaves regardless of
/// the configurable prune list, which only matches exact names.
const BUNDLE_SUFFIXES: &[&str] = &[
    ".photoslibrary",
    ".musiclibrary",
    ".tvlibrary",
    ".fcpbundle",
    ".app",
    ".bundle",
    ".framework",
];

/// Whether `name` is a macOS package/library bundle that should not be descended
/// into. The match is case-insensitive since the filesystem treats these
/// extensions case-insensitively.
fn is_macos_bundle(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    BUNDLE_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix))
}

/// Outcome of walking a directory subtree, used to decide which non-git folders
/// to surface.
enum Walk {
    /// This directory, or some descendant within the scan depth, is a git repo.
    HasRepo,
    /// No git repo at or beneath this directory within the scan depth.
    /// `has_files` is whether the subtree holds any non-hidden regular file: an
    /// empty (or `.DS_Store`-only) folder, e.g. a stray "untitled folder", has
    /// nothing to browse and isn't worth surfacing.
    RepoFree { has_files: bool },
}

/// Recursively scan `root` (up to `max_depth`) for git working repositories and
/// repo-free leaf folders. A directory containing a `.git` entry is treated as a
/// repo and is not descended into. A non-git directory is surfaced as a folder
/// entry only when no git repo lives at or beneath it AND its subtree actually
/// contains files — so a pure container of repos (e.g. `repos/`) is omitted while
/// its repos surface individually, a repo-free subtree (e.g. `docs/`) collapses
/// to a single top-level folder entry rather than listing every nested subfolder,
/// and empty/file-less folders (a stray "untitled folder") are skipped entirely.
/// Directories named in `prune` (plus dotfile dirs and macOS bundles) are skipped
/// for speed.
pub fn discover(root: &Path, max_depth: usize, prune: &[String]) -> Vec<Discovered> {
    let mut out = Vec::new();
    walk(root, 0, max_depth, prune, &mut out);
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn walk(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    prune: &[String],
    out: &mut Vec<Discovered>,
) -> Walk {
    if dir.join(".git").exists() {
        // It's a repo — record it and don't descend further.
        if let Ok(repo) = open(dir) {
            out.push(Discovered {
                name: repo_name(dir),
                default_branch: current_branch(&repo),
                path: dir.to_path_buf(),
                is_git_repo: true,
            });
            return Walk::HasRepo;
        }
        // A `.git` that won't open isn't a usable repo; treat it as a repo-free
        // leaf and don't descend into it.
        return Walk::RepoFree { has_files: false };
    }

    if depth >= max_depth {
        // Can't look deeper — treat as a repo-free leaf.
        return Walk::RepoFree { has_files: false };
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return Walk::RepoFree { has_files: false };
    };

    let mut child_has_repo = false;
    // A non-hidden regular file directly in this dir makes it worth browsing.
    let mut dir_has_file = false;
    // (path, has_files) for each repo-free child subtree.
    let mut repo_free_children: Vec<(PathBuf, bool)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            // Ignore hidden files (e.g. .DS_Store) so a folder holding only those
            // still counts as empty.
            let name = entry.file_name();
            if !name.to_string_lossy().starts_with('.') {
                dir_has_file = true;
            }
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.')
            || is_macos_bundle(&name)
            || prune.iter().any(|p| p == name.as_ref())
        {
            continue;
        }
        match walk(&path, depth + 1, max_depth, prune, out) {
            Walk::HasRepo => child_has_repo = true,
            Walk::RepoFree { has_files } => repo_free_children.push((path, has_files)),
        }
    }

    if child_has_repo {
        // A container that holds repos: surface each repo-free subfolder that has
        // something to browse (the top of each non-empty repo-free subtree).
        for (path, has_files) in repo_free_children {
            if has_files {
                out.push(Discovered {
                    name: repo_name(&path),
                    default_branch: None,
                    path,
                    is_git_repo: false,
                });
            }
        }
        Walk::HasRepo
    } else {
        // Whole subtree is repo-free: bubble up so the parent emits this dir as a
        // single folder entry (or, at the root, the caller registers it). It's
        // worth surfacing only if it (or a descendant) actually holds files.
        let has_files = dir_has_file || repo_free_children.iter().any(|(_, f)| *f);
        Walk::RepoFree { has_files }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_nested_repos_and_prunes() {
        let root = std::env::temp_dir().join("gamut_discover_test");
        let _ = std::fs::remove_dir_all(&root);

        // A top-level repo, a nested repo, and one buried in node_modules (pruned).
        Repository::init(root.join("a")).unwrap();
        Repository::init(root.join("sub/b")).unwrap();
        Repository::init(root.join("node_modules/c")).unwrap();
        // A repo-free folder (with a file) and a nested repo-free subfolder: it
        // should collapse to a single `plain` entry (not also `plain/inner`).
        std::fs::create_dir_all(root.join("plain/inner")).unwrap();
        std::fs::write(root.join("plain/note.txt"), "x").unwrap();
        // A truly empty folder (a stray "untitled folder") has nothing to browse.
        std::fs::create_dir_all(root.join("empty")).unwrap();

        let found = discover(&root, 6, &default_prune_dirs());
        let by_name: std::collections::HashMap<&str, &Discovered> =
            found.iter().map(|d| (d.name.as_str(), d)).collect();

        // a + b (git) and plain (non-git folder); sub is a pure container so it is
        // omitted, node_modules is pruned, and empty/inner carry no files.
        assert_eq!(found.len(), 3, "should find a, b, and plain");
        assert!(by_name["a"].is_git_repo);
        assert!(by_name["b"].is_git_repo);
        assert!(
            !by_name["plain"].is_git_repo,
            "repo-free folder should surface as a non-git entry"
        );
        assert!(
            !by_name.contains_key("sub"),
            "pure repo container is omitted"
        );
        assert!(
            !by_name.contains_key("inner"),
            "repo-free subtree collapses to its top"
        );
        assert!(
            !by_name.contains_key("empty"),
            "an empty folder has nothing to browse and is skipped"
        );
        assert!(!by_name.contains_key("c"), "node_modules should be pruned");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn skips_macos_package_bundles() {
        let root = std::env::temp_dir().join("gamut_discover_bundle_test");
        let _ = std::fs::remove_dir_all(&root);

        // A normal nested repo should still be discovered.
        Repository::init(root.join("normal")).unwrap();

        // Repos buried inside macOS package/library bundles must never be
        // descended into — walking into these is what triggers the spurious
        // Photos/Media TCC permission prompt.
        Repository::init(root.join("Photos Library.photoslibrary/inner")).unwrap();
        Repository::init(root.join("Tunes.musiclibrary/inner")).unwrap();
        Repository::init(root.join("Shows.tvlibrary/inner")).unwrap();
        Repository::init(root.join("Project.fcpbundle/inner")).unwrap();
        Repository::init(root.join("Some.app/Contents/inner")).unwrap();

        let found = discover(&root, 6, &default_prune_dirs());
        let names: Vec<&str> = found.iter().map(|d| d.name.as_str()).collect();

        assert_eq!(found.len(), 1, "only the normal repo should be discovered");
        assert!(names.contains(&"normal"));
        assert!(
            !names.contains(&"inner"),
            "repos inside macOS bundles must not be discovered"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn is_macos_bundle_matches_known_suffixes() {
        assert!(is_macos_bundle("Photos Library.photoslibrary"));
        assert!(is_macos_bundle("Foo.PhotosLibrary")); // case-insensitive
        assert!(is_macos_bundle("Bar.app"));
        assert!(is_macos_bundle("Clip.fcpbundle"));
        assert!(!is_macos_bundle("photoslibrary")); // no dot, not a bundle
        assert!(!is_macos_bundle("my-project"));
        assert!(!is_macos_bundle("src"));
    }
}
