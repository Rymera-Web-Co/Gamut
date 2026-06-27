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

/// A repository discovered while scanning a directory tree.
pub struct Discovered {
    pub path: PathBuf,
    pub name: String,
    pub default_branch: Option<String>,
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

/// Recursively scan `root` (up to `max_depth`) for git working repositories.
/// A directory containing a `.git` entry is treated as a repo and is not
/// descended into; directories named in `prune` (plus any dotfile dirs) are
/// skipped for speed.
pub fn discover(root: &Path, max_depth: usize, prune: &[String]) -> Vec<Discovered> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        if dir.join(".git").exists() {
            // It's a repo — record it and don't descend further.
            if let Ok(repo) = open(&dir) {
                out.push(Discovered {
                    name: repo_name(&dir),
                    default_branch: current_branch(&repo),
                    path: dir,
                });
            }
            continue;
        }

        if depth >= max_depth {
            continue;
        }

        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
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
            stack.push((path, depth + 1));
        }
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
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
        // A plain directory with no repo.
        std::fs::create_dir_all(root.join("plain")).unwrap();

        let found = discover(&root, 6, &default_prune_dirs());
        let names: Vec<&str> = found.iter().map(|d| d.name.as_str()).collect();

        assert_eq!(found.len(), 2, "should find exactly a and b");
        assert!(names.contains(&"a"));
        assert!(names.contains(&"b"));
        assert!(!names.contains(&"c"), "node_modules should be pruned");

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
