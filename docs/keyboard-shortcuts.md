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
| `⌘/Ctrl+⇧+F` | Open repo-wide search in the **Files** view |
| `⌘/Ctrl+J` | Toggle light / dark theme |
| <code>⌘/Ctrl+&#96;</code> | Toggle the integrated terminal |
| <code>⌘/Ctrl+⇧+&#96;</code> | Maximize / restore the integrated terminal |
| `⌘/Ctrl+⇧+P` | **Pull** the active repository |
| `⌘/Ctrl+⇧+K` | **Push** the active repository |
| `⌘/Ctrl+⌥+F` | **Fetch** all repositories in the active group |
| `Ctrl+Tab` / `Ctrl+⇧+Tab` | Cycle to the next / previous repository in the active group (Control on all platforms) |

These are registered globally — see [`useKeyboardShortcuts`](../src/lib/useKeyboardShortcuts.ts).

> The pull / push / fetch / repo-cycle shortcuts are suppressed while you're
> typing (in the editor, terminal, or any text input) so they never clash with
> editor bindings such as Monaco's `⌘/Ctrl+⇧+K` (delete line).

## Files

| Shortcut | Action |
| --- | --- |
| `⌘/Ctrl+S` | Save the open file (works even when the editor isn't focused) |
| `⌘/Ctrl+F` | Find in the open file (Monaco's find widget) |
| `⌘/Ctrl+H` | Find & replace in the open file |
| `⌘/Ctrl+⇧+F` | Switch the sidebar to repo-wide search |

See [Files](features/files.md).

## Review (working tree)

| Shortcut | Action |
| --- | --- |
| `⌘/Ctrl+Enter` | Commit staged changes (requires a commit message and staged files) |

See [Review](features/review.md).

## Terminal

`⌘/Ctrl+T` works anywhere; the rest apply while the integrated terminal has focus.

| Shortcut | Action |
| --- | --- |
| `⌘/Ctrl+T` | Open a new terminal tab (reveals the terminal if hidden) |
| `⌘/Ctrl+W` | Close the active terminal tab |
| `⌘/Ctrl+⇧+]` / `⌘/Ctrl+⇧+[` | Switch to the next / previous terminal tab |
| `⌘/Ctrl+⌥+1`…`9` | Jump to terminal tab N (`9` jumps to the last tab) |
| `⌘/Ctrl+D` | Split the active terminal tab (side-by-side) |

See [Terminal](features/terminal.md).

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
