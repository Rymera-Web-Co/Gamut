# Terminal

Gamut has an integrated terminal pane backed by real PTYs. Sessions are organised
per group and survive tab/group switches — a long-running build or `tail -f` keeps going
while the terminal is hidden.

## Opening & toggling

- Toggle the pane with <code>⌘/Ctrl+&#96;</code> or the terminal icon in the group rail.
  Its open/closed state is remembered per group.
- **New tab** — the **+** in the tab bar. The working directory defaults to the group's
  bound folder, or the first repo in the group; the title defaults to the group or repo
  name.
- **From a repo** — `⌘/Ctrl+click` a repo name (or its hover terminal icon) opens a
  terminal at that repo.
- **From a group** — the terminal icon in the sidebar header opens one at a folder-bound
  group's folder.

## Maximize & restore

- **Maximize** the pane with the ⤢ button in the tab-bar controls (or
  <code>⌘/Ctrl+⇧+&#96;</code>). The terminal grows to fill the whole content area —
  the repository sidebar and the active view collapse, leaving only the top tab bar so
  you can still switch views or unmaximize.
- **Restore** with the same button (now ⤡) or shortcut to return the pane to its
  previous height.
- Maximize is independent of open/close: restoring keeps the terminal open, and hiding
  the pane (the **×** or <code>⌘/Ctrl+&#96;</code>) clears the maximized state so it
  reopens at its normal split height. The maximized state is not persisted across
  restarts.

## Tabs & splits

- Each group keeps its own set of tabs. Click a tab to activate it.
- **Split** the active tab to show panes side-by-side; close a split with its **×**
  (shown only when a tab has more than one pane). A tab's title shows a pane count when
  split (e.g. `repo ×2`).
- Close a tab with the **×** on the tab.

## Shell & behaviour

- Spawns your login shell (`$SHELL` on Unix, `cmd.exe` on Windows) with
  `TERM=xterm-256color`, so colors and full-screen apps work.
- Rendered with [xterm.js](https://xtermjs.org/): 256-color, copy/paste, selection, 5000
  lines of scrollback, and theme-aware colors.
- Panes are kept alive across tab/group switches, so running processes aren't
  interrupted. When a shell exits, the pane shows **[process exited]** with a **Restart**
  button. All sessions are killed on app close.

When a group has no terminals: *"No terminals open in this group"* (or a prompt to add a
repo / bind a folder first).

## Behind the scenes

`src/features/terminal/TerminalPane.tsx` talks to the terminal commands in the Rust
backend. IPC commands: `terminalSpawn`, `terminalWrite`, `terminalResize`,
`terminalKill`; the backend emits a `terminal-exit` event when a shell exits. PTYs are
read on a dedicated thread and tracked in `AppState` (see
[Architecture](../ARCHITECTURE.md)).

---

See also: [Repositories](repositories.md) · [Keyboard shortcuts](../keyboard-shortcuts.md) · [documentation hub](../README.md)
