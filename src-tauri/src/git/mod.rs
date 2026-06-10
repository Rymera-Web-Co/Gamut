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

/// Recursively scan `root` (up to `max_depth`) for git working repositories.
/// A directory containing a `.git` entry is treated as a repo and is not
/// descended into; common heavy directories are pruned for speed.
pub fn discover(root: &Path, max_depth: usize) -> Vec<Discovered> {
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
            if name.starts_with('.') || PRUNE.contains(&name.as_ref()) {
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

        let found = discover(&root, 6);
        let names: Vec<&str> = found.iter().map(|d| d.name.as_str()).collect();

        assert_eq!(found.len(), 2, "should find exactly a and b");
        assert!(names.contains(&"a"));
        assert!(names.contains(&"b"));
        assert!(!names.contains(&"c"), "node_modules should be pruned");

        std::fs::remove_dir_all(&root).unwrap();
    }
}
