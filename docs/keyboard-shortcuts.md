# Keyboard shortcuts

Shortcuts use **⌘** on macOS and **Ctrl** on Windows/Linux. Global shortcuts work
anywhere in the app; the rest apply within a specific view or input.

## Global

| Shortcut | Action |
| --- | --- |
| `⌘/Ctrl+1` | Switch to **Files** |
| `⌘/Ctrl+2` | Switch to **History** |
| `⌘/Ctrl+3` | Switch to **Review** |
| `⌘/Ctrl+4` | Switch to **Pull Requests** |
| `⌘/Ctrl+B` | Toggle the repository sidebar |
| `⌘/Ctrl+J` | Toggle light / dark theme |
| <code>⌘/Ctrl+&#96;</code> | Toggle the integrated terminal |

These are registered globally — see [`useKeyboardShortcuts`](../src/lib/useKeyboardShortcuts.ts).

## Files

| Shortcut | Action |
| --- | --- |
| `⌘/Ctrl+S` | Save the open file (works even when the editor isn't focused) |

See [Files](features/files.md).

## Review (working tree)

| Shortcut | Action |
| --- | --- |
| `⌘/Ctrl+Enter` | Commit staged changes (requires a commit message and staged files) |

See [Review](features/review.md).

## Inline inputs & editors

These apply inside text inputs and composers throughout the app.

| Shortcut | Action |
| --- | --- |
| `Enter` | Submit — confirms inline file/folder name (Files tree), group name (group dialog), or token (GitHub connect) |
| `Escape` | Cancel — closes an inline create/rename row, a context menu, or a comment composer |
| `@` | In a comment/review composer, start an @-mention and autocomplete against repo collaborators |
| `↑` / `↓` | Move through the @-mention suggestion list |
| `Tab` / `Enter` | Accept the highlighted @-mention suggestion |

## Mouse interactions worth knowing

| Action | Result |
| --- | --- |
| Right-click a file-tree entry | Open the context menu (New File, New Folder, Copy Path, Copy Relative Path, Delete) |
| Hover a line in a PR diff | A `+` appears in the gutter — click to add an inline comment |
| `⌘/Ctrl+click` a repo name | Open a terminal at that repo |
| Drag a repo onto a group | Assign it to that group |

---

See also: [documentation hub](README.md).
