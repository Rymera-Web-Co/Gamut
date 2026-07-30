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
- Markdown (`.md`) and HTML (`.html` / `.htm`) files get an **Edit / Preview** switch in
  the header — see [Previewing markdown and HTML](#previewing-markdown-and-html).
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

## Previewing markdown and HTML

For the two file types that are meant to be *looked at* rather than only read as source,
the header shows an **Edit / Preview** switch:

- **Markdown** (`.md`) — *Preview* renders it the same way the [Review](review.md) tab
  renders a pull-request description.
- **HTML** (`.html` / `.htm`) — *Preview* renders the page itself, as a browser would.

Both previews show the file **as it currently stands in the editor**, including edits you
haven't saved yet, so you can flip to Preview to check a change before saving. The switch
is per file: pick *Preview* for one file and the next file you open still follows your
default. Which side a file opens on is set in Settings → Appearance → *Open markdown in
preview* and *Open HTML in preview* (both off by default, so files open in the editor).

Only these two types have a preview — every other file opens in the editor.

### How the HTML preview is isolated

A previewed page is real HTML with real scripts, and it may well have come from somewhere
you don't control, so it is rendered in a locked-down frame rather than as part of the app:

- It runs in its own **sandbox** with only scripting enabled, on an anonymous origin of its
  own. It gets no cookies or site storage, cannot read or touch anything in Gamut itself,
  and has no access to the app's own internals — so a previewed page can't reach your
  repositories, settings or files.
- It **cannot get out of its pane** — it can't replace the Gamut window, open pop-ups, or
  submit forms out of the frame. It *can* try to load a different page into itself, but
  Gamut's own content policy allows only the preview's origin inside a frame, so there is
  nowhere for it to go: it can't pull in a page from the web, and it can't load Gamut's
  own interface either.
- **Links behave sensibly.** An in-page `#anchor` link scrolls within the preview. A normal
  `http`/`https` link opens in your real web browser (the same as clicking a link in the
  markdown preview), never inside the app.
- Nothing is written to disk to make the preview work — the page's current text is handed
  straight to the frame.
- **It can still reach the network, though.** The point of the preview is that the page
  renders for real, scripts and all, so — exactly like a browser tab — it can load remote
  images, fonts and scripts, and send requests out. The sandbox stops it reaching *Gamut*,
  not the internet. Treat previewing HTML you don't trust the way you'd treat opening it in
  your browser.
- **Only the file itself is rendered.** A preview is one self-contained document, so a page
  that pulls in its own separate assets (`<img src="logo.png">`, a linked stylesheet) will
  show those as missing — nothing on disk is served to the frame. Pages that carry their
  styles and scripts inline, which is what most standalone HTML does, render in full.

You don't type in the preview — the editor lives on the *Edit* side — but the preview does
follow the file: whenever its text changes underneath you (it was edited on disk outside
Gamut, for instance), the page is re-rendered from scratch a moment later rather than
patched, so a preview never carries anything over from the previous version. If the preview
ever fails to start, the pane says so instead of sitting blank — switch to *Edit* to see the
source.

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

- **Word wrap** — wraps long lines at the viewport edge instead of scrolling sideways,
  handy for a minified file or a long single-line log. It's the same global preference as
  Settings → Appearance → *Editor word wrap* and the wrap button in the
  [Review](review.md) tab, so flipping it here changes all of them and the choice sticks
  across restarts. Off by default. Only shown while a file is open in the editor — not for
  the markdown or HTML preview, images, or files that can't be edited here.
- **Edit / Preview** — for markdown and HTML files only; see
  [Previewing markdown and HTML](#previewing-markdown-and-html).
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

The HTML preview is `src/features/files/HtmlPreview.tsx` plus
`src-tauri/src/preview.rs`, which serves a fixed bootstrap document on a dedicated
`gamut-preview://` URI scheme. The custom scheme is what gives the frame its own empty
policy container: a `srcdoc` / `blob:` / `data:` frame would inherit the app window's CSP,
and the app's `script-src 'self'` would then refuse the previewed page's own inline
scripts — silently, and only in a shipped build, since `devCsp` allows inline script. The
frame is sandboxed `allow-scripts` only (no `allow-same-origin`, no popup tokens), and the
buffer reaches it over `postMessage`; both directions validate source identity plus a
per-load token, and the external-link bridge additionally requires an `http(s)` URL before
calling `openUrl`.

Repo-wide search lives in `src-tauri/src/commands/search.rs` (`search_repo`,
`replace_in_files`), a ripgrep-style walk via the [`ignore`](https://docs.rs/ignore) crate
with [`regex`](https://docs.rs/regex) matching. It honors `.gitignore` and the glob filters,
caps results, and skips binary/oversized/non-UTF-8 files. Per-file find is handled entirely
by Monaco on the frontend.

---

See also: [Keyboard shortcuts](../keyboard-shortcuts.md) · [Review](review.md) · [documentation hub](../README.md)
