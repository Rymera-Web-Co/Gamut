# Files

The **Files** tab (`⌘/Ctrl+1`) is where you browse and edit the files in your project,
like a file manager built into the app — handy for making a quick edit, checking what a
file contains, or tidying up the project structure without leaving Gamut. It's a browser
and editor for the selected repository's working tree — the actual files on disk, as
opposed to what's been saved into git's history: browse the directory tree, open any text
file with syntax highlighting, edit it, and save in place — plus create, rename, delete,
and reveal files.

## Layout

A resizable two-panel view:

- **Left** — a sidebar that toggles between two modes via the icons at its top: the
  **directory tree** (your project's folders and files) and repo-wide **search** (see
  [Find & replace](#find--replace)).
- **Right** — a [Monaco](https://microsoft.github.io/monaco-editor/) editor (the same
  editor component that powers VS Code) for the selected file. Before you pick a file it
  reads *"Select a file to open it."*

With no repository selected, the view prompts you to choose one from the sidebar.

## Browsing the tree

- **Lazy loading** — folders only load their contents when you expand them, so large
  projects open fast.
- **Sorting** — directories first, then files, each in alphabetical order
  (case-insensitive).
- **`.gitignore` handling** — files and folders your project has marked to ignore are
  still listed, but **dimmed**; the `.git/` directory (git's own internal data) is never
  shown.
- **Change badges** — files with changes you haven't yet committed (saved into the
  project's history) show a one-letter status badge: **A**dded (green), **M**odified
  (orange), **D**eleted (red), **R**enamed (blue). A folder containing changes shows a
  small amber dot.
- **Persistence** — the last file you had open is remembered per repository, so switching
  back to a repo reopens where you left off.

## Editing & saving

- Text files open with syntax highlighting that recognizes the file's language and
  follows your theme.
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

The editor's built-in find/replace tool works on the file that's currently open:

- `⌘/Ctrl+F` opens **find**; `⌘/Ctrl+H` opens **find & replace**. Both work even when
  focus is in the tree or search panel (but not while you're typing in the search panel's
  own inputs).
- The tool's **case-sensitive**, **whole-word**, and **regex** (pattern-matching) toggles
  all work.
- Replacements land in the file as edits, just like typing — save them with `⌘/Ctrl+S`.

### Across the repository

Switch the left sidebar to **search** mode (the magnifier icon, or `⌘/Ctrl+⇧+F`) to search
the contents of every file in the **active repo**, not just the one that's open:

- **Query + replace inputs**, each with **case-sensitive** (`Aa`), **whole-word**, and
  **regex** (`.*`) toggles. Toggle state and filter settings persist across sessions, and
  recent queries autocomplete.
- **Filters** (behind the *Filters* link) — **include** / **exclude** patterns for file
  paths (e.g. `src/**`, `*.rs`) and an **Include .gitignore'd files** checkbox, for files
  your project normally hides from git. `.gitignore` is respected by default.
- **Results** are grouped by file, each line showing its line number and a context snippet
  with matches highlighted. Click a result to open the file and jump to the match. Long
  lines and very large result sets are capped (shown as *"(capped)"*) so the UI stays
  responsive; binary, oversized (>2 MB), and non-UTF-8 files are skipped.
- **Replace All** — with a replacement entered, each file and line gets a checkbox so you
  can opt matches out, then *Replace All* previews the count and asks for confirmation
  before editing files on disk. In regex mode the replacement supports `$1` / `${name}`
  capture references (reusing parts of the matched text); in literal mode `$` is taken
  verbatim. Skipped files are reported.

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

- **View changes** — jumps to the [Review](review.md) tab in working-tree mode (showing
  your current uncommitted changes, rather than a specific past commit).
- **Reveal** — opens the selected file (or the repo root) in Finder / Explorer.
- **Save** — see above.

## Behind the scenes

*For contributors — where this feature lives in the code.*

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
