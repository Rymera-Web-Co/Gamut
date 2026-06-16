# Files

The **Files** tab (`⌘/Ctrl+1`) is a full working-tree browser and editor for the selected
repository. Browse the directory tree, open any text file with syntax highlighting, edit
it, and save in place — plus create, rename, delete, and reveal files.

## Layout

A resizable two-panel view:

- **Left** — a sidebar that toggles between two modes via the icons at its top: the
  working-tree **directory tree** and repo-wide **search** (see [Find & replace](#find--replace)).
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

## Find & replace

### In the open file

Monaco's native find/replace widget works on the file in the editor:

- `⌘/Ctrl+F` opens **find**; `⌘/Ctrl+H` opens **find & replace**. Both work even when
  focus is in the tree or search panel (but not while you're typing in the search panel's
  own inputs).
- The widget's **case-sensitive**, **whole-word**, and **regex** toggles all work.
- Replacements land in the editor buffer like any other edit — save them with `⌘/Ctrl+S`.

### Across the repository

Switch the left sidebar to **search** mode (the magnifier icon, or `⌘/Ctrl+⇧+F`) to search
the **active repo's** file contents:

- **Query + replace inputs**, each with **case-sensitive** (`Aa`), **whole-word**, and
  **regex** (`.*`) toggles. Toggle state and glob filters persist across sessions, and
  recent queries autocomplete.
- **Filters** (behind the *Filters* link) — **include** / **exclude** globs (e.g. `src/**`,
  `*.rs`) and an **Include .gitignore'd files** checkbox. `.gitignore` is respected by
  default.
- **Results** are grouped by file, each line showing its number and a context snippet with
  matches highlighted. Click a result to open the file and jump to the match. Long lines
  and very large result sets are capped (shown as *"(capped)"*) so the UI stays responsive;
  binary, oversized (>2 MB), and non-UTF-8 files are skipped.
- **Replace All** — with a replacement entered, each file and line gets a checkbox so you
  can opt matches out, then *Replace All* previews the count and asks for confirmation
  before editing files on disk. In regex mode the replacement supports `$1` / `${name}`
  capture references; in literal mode `$` is taken verbatim. Skipped files are reported.

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

Repo-wide search lives in `src-tauri/src/commands/search.rs` (`search_repo`,
`replace_in_files`), a ripgrep-style walk via the [`ignore`](https://docs.rs/ignore) crate
with [`regex`](https://docs.rs/regex) matching. It honors `.gitignore` and the glob filters,
caps results, and skips binary/oversized/non-UTF-8 files. Per-file find is handled entirely
by Monaco on the frontend.

---

See also: [Keyboard shortcuts](../keyboard-shortcuts.md) · [Review](review.md) · [documentation hub](../README.md)
