# Gamut

A local git desktop app for **reviewing changes** and **browsing history**, built with Tauri 2 (Rust) + React + TypeScript.

> **Gamut** comes from the Cebuano word *gamut*, meaning "root of a tree" — a nod to digging through a repository's roots and history.

## What it does

- **[Files](docs/features/files.md)** — browse the repo's full working tree, open any file in an editor with syntax highlighting, and save edits in place (⌘/Ctrl+S). Reveal files in Finder/Explorer or jump straight to their changes.
- **[Code review](docs/features/review.md)** — self-review the current branch's local changes (working tree + branch-vs-base diff) and review GitHub pull requests, with inline diffs and comments.
- **[History](docs/features/history.md)** — browse the commit graph with branch/tag refs, inspect commits, view per-file diffs, file history, and blame.
- **[Repositories](docs/features/repositories.md)** — register local repos, auto-detect repos under a directory, and organise them with groups and tags.
- **[Sync](docs/features/sync.md)** · **[GitHub](docs/features/github.md)** · **[Terminal](docs/features/terminal.md)** — one-click fetch/pull/push, connect a GitHub account, and an integrated per-group terminal.

Full feature docs live in [`docs/`](docs/README.md).

## Install (macOS)

### Homebrew (recommended)

```bash
brew install --cask rymera-web-co/gamut/gamut
xattr -dr com.apple.quarantine /Applications/Gamut.app
```

The second command is required because Gamut isn't yet signed with an Apple Developer ID or notarized. Homebrew quarantines downloaded apps (Homebrew 6 removed the old `--no-quarantine` opt-out), so on first launch Gatekeeper reports:

> "Gamut" is damaged and can't be opened. You should move it to the Trash.

It isn't damaged — that's just Gatekeeper reacting to the quarantine flag on an unsigned app. The `xattr` command clears it once and the app launches normally. (`brew install` also prints this command as a caveat after installing.) Upgrade later with `brew upgrade --cask gamut`.

The install command also taps [`Rymera-Web-Co/homebrew-gamut`](https://github.com/Rymera-Web-Co/homebrew-gamut); afterwards you can refer to the cask as just `gamut`. See [`homebrew/README.md`](homebrew/README.md) for how the tap is maintained.

> Homebrew is the recommended path for easy upgrades/removal, but on an unsigned build it doesn't avoid the `xattr` step — a notarized build would (see [#3](https://github.com/Rymera-Web-Co/Gamut/issues/3)).

### Manual `.dmg`

Prefer not to use Homebrew? Download the `.dmg` from the [latest release](https://github.com/Rymera-Web-Co/Gamut/releases), open it, and drag **Gamut** to Applications.

Because the build is unsigned, this needs the same one-time step:

```bash
xattr -dr com.apple.quarantine /Applications/Gamut.app
```

Then open Gamut normally. (Right-click → Open does **not** work for this "damaged" case on Apple Silicon — the `xattr` command above is required.)

## Stack

- **Backend:** Rust / Tauri 2 — owns all git operations, the GitHub API, persistence (SQLite via `rusqlite`), and secrets (OS keychain). Frontend never touches a token or the filesystem directly.
- **Frontend:** React 19 + TypeScript + Vite, Tailwind v4 + shadcn/ui, TanStack Query, Zustand.

## Develop

```bash
pnpm install
pnpm tauri dev      # launches the desktop app with HMR
```

Other useful commands:

```bash
pnpm build          # typecheck + build the frontend
pnpm typecheck      # tsc --noEmit
cd src-tauri && cargo build   # compile the Rust backend
```

The SQLite database is created at the platform app-data dir on first run
(e.g. `~/Library/Application Support/com.rymera.gamut/gamut.db` on macOS).

## Build a release

```bash
pnpm tauri build    # produces Gamut.app and a .dmg under src-tauri/target/release/bundle/
```

## Keyboard shortcuts

- `⌘/Ctrl+1` Files · `⌘/Ctrl+2` History · `⌘/Ctrl+3` Review · `⌘/Ctrl+4` Pull Requests
- `⌘/Ctrl+S` save the open file (Files tab) · `⌘/Ctrl+Enter` commit (Review working tree)
- `⌘/Ctrl+B` toggle repo sidebar · `⌘/Ctrl+J` toggle theme · <code>⌘/Ctrl+&#96;</code> toggle terminal

See [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md) for the full list.

## Status

Milestones: **M0 scaffold** ✅ · **M1 repos** ✅ · **M2 history** ✅ · **M3 review** ✅ · **M4 polish** ✅

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up
your environment, the project layout, and coding conventions. For a deeper tour of how
the app is wired together, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and the
[documentation hub](docs/README.md) for per-feature docs.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). © 2026 Rymera.
