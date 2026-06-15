# Files

The **Files** tab (`⌘/Ctrl+1`) is a full working-tree browser and editor for the selected
repository. Browse the directory tree, open any text file with syntax highlighting, edit
it, and save in place — plus create, rename, delete, and reveal files.

## Layout

A resizable two-panel view:

- **Left** — the working-tree directory tree.
- **Right** — a [Monaco](https://microsoft.github.io/monaco-editor/) editor for the
  selected file. Before you pick a file it reads *"Select a file to open it."*

With no repository selected, the view prompts you to choose one from the sidebar.

## Browsing the tree

- **Lazy loading** — folders load their contents only when expanded, so large repos open
  fast.
- **Sorting** — directories first, then files, each alphabetically (case-insensitive).
- **`.gitignore` handling** — ignored files and folders are still listed but **dimmed**;
  the `.git/` directory is never shown.
- **Change badges** — files with uncommitted changes show a one-letter status badge:
  **A**dded (green), **M**odified (orange), **D**eleted (red), **R**enamed (blue). A
  folder containing changes shows a small amber dot.
- **Persistence** — the last-opened file is remembered per repository, so switching back
  to a repo reopens where you left off.

## Editing & saving

- Text files open with language-aware syntax highlighting that follows your theme.
- An unsaved file shows a **•** next to its path in the header. Switching away from
  unsaved edits prompts *"Discard unsaved changes?"*
- Save with the **Save** button or `⌘/Ctrl+S` (works even when the editor isn't focused).
  A toast confirms *"Saved <filename>"*.

Some files are read-only on purpose:

| Condition | Message |
| --- | --- |
| Larger than 2 MB | *File is too large to edit here (over 2 MB).* |
| Binary | *Binary file — not shown.* |
| Not valid UTF-8 | *Not a UTF-8 text file — not shown to avoid corrupting it on save.* |

## Context menu

Right-click any tree entry:

- **New File…** / **New Folder…** — opens an inline input row at that location. Press
  `Enter` to create, `Escape` to cancel. Names can't contain `/`, and a clash with an
  existing entry is rejected. Creating a file opens it immediately.
- **Copy Path** — copies the absolute filesystem path.
- **Copy Relative Path** — copies the repo-relative path (e.g. `src/main.rs`).
- **Delete** — confirms first, then removes the file (or a folder and everything inside
  it). The repository root can't be deleted.

## Header actions

- **View changes** — jumps to the [Review](review.md) tab in working-tree mode.
- **Reveal** — opens the selected file (or the repo root) in Finder / Explorer.
- **Save** — see above.

## Behind the scenes

`src/features/files/` (frontend) talks to `src-tauri/src/commands/files.rs`. The backend
is the only module that **writes** to the working tree, and every path is canonicalized
and confirmed to stay inside the repo root — rejecting `..` traversal and symlink escapes.

Key IPC commands: `list_dir`, `read_file`, `write_file`, `create_file`, `create_dir`,
`delete_path`, `resolve_path`, `reveal_in_file_manager`, `worktree_status`.

---

See also: [Keyboard shortcuts](../keyboard-shortcuts.md) · [Review](review.md) · [documentation hub](../README.md)
