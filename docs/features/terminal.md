# Terminal

Gamut has a terminal built into the app, so you can run commands right next to your
code instead of switching to a separate terminal window. Each pane is backed by a real
PTY — a genuine terminal session, not just a box that echoes command output — so colors
and full-screen programs behave exactly as they would in your regular terminal app.
Sessions are organised per group and survive tab/group switches — a long-running build
or `tail -f` keeps going while the terminal is hidden.

## Opening & toggling

- Toggle the pane with <code>⌘/Ctrl+&#96;</code> or the terminal icon in the group rail.
  Its open/closed state is remembered per group.
- **New tab** — the **+** in the tab bar or `⌘/Ctrl+T`. The working directory is the repo
  selected in the active group; when none is selected it falls back to the **New terminal
  directory** setting (**Settings → Terminal**) — the first repo (default) or the group's
  bound folder. The title defaults to the repo or group name.
- **From a repo** — `⌘/Ctrl+click` a repo name (or its hover terminal icon) opens a
  terminal at that repo.
- **From a group** — the terminal icon in the sidebar header opens a terminal at a
  folder-bound group's own folder.

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

- Each group keeps its own set of tabs. Click a tab to activate it, or cycle through
  every group's terminals with `⌘/Ctrl+⇧+]` / `⌘/Ctrl+⇧+[`. While the terminal is focused, `Ctrl+Tab` /
  `Ctrl+⇧+Tab` also cycle to the next / previous terminal (with two or more terminals).
  Both bindings walk **every** terminal in **every** group, in sidebar order: past the
  last tab of a group they step into the first tab of the next group (and make that group
  active), and the order wraps from the very last terminal back to the very first.
  `⌘/Ctrl+⌥+1`…`9` stays an index into the active group's own tab strip.
- **Reorder** — drag a tab and drop it before/after another tab in the strip; an
  insertion line shows where it'll land. Reordering stays within the group and
  doesn't change which tab is active or disturb running panes.
- **Split** the active tab to show panes side-by-side; close a split with its **×**
  (shown only when a tab has more than one pane). A tab's title shows a pane count when
  split (e.g. `repo ×2`).
- Close a tab with the **×** on the tab.

## Shell & behaviour

- Opens your normal login shell — the same one you'd get from Terminal.app or your
  usual terminal (`$SHELL` on Unix, `cmd.exe` on Windows) — with `TERM=xterm-256color`
  set, so colors and full-screen apps work correctly.
- Rendered with [xterm.js](https://xtermjs.org/), the same terminal library many other
  apps use: 256-color support, copy/paste, text selection, 5000 lines of scrollback
  (the history of earlier output you can scroll up to revisit), and colors that adapt
  to your theme.
- Panes are kept alive across tab/group switches, so running processes aren't
  interrupted. When a shell exits, the pane shows **[process exited]** with a **Restart**
  button. All sessions are killed on app close.

When a group has no terminals: *"No terminals open in this group"* (or a prompt to add a
repo / bind a folder first).

## Session restore

The terminal **layout** — each group's tabs, splits, working directories and titles — is
saved as you work and reopened on the next launch, so a quit or crash doesn't mean
rebuilding your workspace by hand. On launch each pane respawns a **fresh** shell in its
saved directory (the previous shells are gone, so this is a re-open, not a literal process
resume).

- **Scrollback and running processes are not restored** — respawned panes start empty.
- **Moved/deleted directories** fall back gracefully: a pane whose saved directory no
  longer exists opens in your home directory instead of failing.
- Toggle it under **Settings → Terminal → Restore sessions on launch** (on by default).
  Turn it off to start every launch with a clean slate.

## Activity indicator

Because hidden panes keep running, Gamut surfaces background activity so you don't have to
hunt for it. A pane is flagged with unseen activity when — *while you're not looking at it*
— it prints output, rings the terminal bell (the beep some programs trigger, `\a`), or its
shell process exits. The flag shows as a small dot:

- on the pane's **tab**, while that tab is inactive;
- on each **split pane** that changed, so a split tab shows *which* pane has activity;
- on the **group rail** entry for any other group with terminal activity;
- on the **terminal toggle** icon when the panel is collapsed and the active group has
  activity.

The dot is colored by the most salient event: blue for output, amber for a bell, red for a
process exit. It clears the moment the pane comes into view (its group and tab are selected,
the panel is open, and it's the focused pane). The pane you're currently viewing never
badges itself.

## Notifications

On top of the visual dot, a background pane can also pull you back with a **sound** and an
optional **desktop notification** — useful when Gamut is in another tab, another group, or
behind another app. These fire only on the two *discrete* events — a **process exit** and a
**terminal bell** — never on plain output, so a chatty background process can't spam you
(bursts are coalesced into at most one cue every 400 ms). The pane you're currently looking
at is suppressed (you can already see it), while its visual activity dot is unaffected.

Configure it under **Settings → Notifications** (⌘,):

- **Play sound on terminal events** — master toggle for the audible cue (on by default).
- **Notify on process exit** / **Notify on terminal bell** — pick which events fire.
- **Sound** — choose from the built-in tones (Chime, Ping, Blip, Knock, Alert) or pick
  **Custom…** to use your own audio file (`.wav`, `.mp3`, `.ogg`, `.m4a`, `.aac`, `.flac`).
  A **Test** button previews the current choice. Built-in tones are synthesized in-app;
  a custom file is read on demand and capped at 8 MB.
- **Show desktop notification** — also post a native OS notification (off by default). It
  asks for notification permission when enabled and respects the OS Do-Not-Disturb state;
  clicking the notification focuses Gamut and reveals the originating group, tab and pane.

## Behind the scenes

*For contributors — where this feature lives in the code.*

`src/features/terminal/TerminalPane.tsx` talks to the terminal commands in the Rust
backend. IPC commands: `terminalSpawn`, `terminalWrite`, `terminalResize`,
`terminalKill`; the backend emits a `terminal-exit` event when a shell exits. PTYs are
read on a dedicated thread and tracked in `AppState` (see
[Architecture](../ARCHITECTURE.md)). Per-pane unseen-activity flags live in the UI store
(`termActivity` in `src/store/ui.ts`) and drive the activity dots in the tab bar and
group rail (`src/features/terminal/activity.tsx`).

The same bell/exit events drive notifications via `src/features/terminal/notify.ts`:
built-in sounds are synthesized with the Web Audio API (no bundled assets), while a custom
sound file is read through the `read_audio_file` command (`src-tauri/src/commands/files.rs`,
which rejects non-audio extensions and caps the size) and decoded with the Web Audio API —
so no asset-protocol scope is needed. Desktop notifications go
through [`tauri-plugin-notification`](https://v2.tauri.app/plugin/notification/) (registered
in `src-tauri/src/lib.rs` with the `notification:default` capability). Preferences live in
`src/lib/settings.ts` (`terminalNotify*` keys) and are edited in the **Notifications** pane
of the Settings dialog.

---

See also: [Repositories](repositories.md) · [Keyboard shortcuts](../keyboard-shortcuts.md) · [documentation hub](../README.md)
