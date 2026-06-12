# Gamut

A local git desktop app for **reviewing changes** and **browsing history**, built with Tauri 2 (Rust) + React + TypeScript.

> **Gamut** comes from the Cebuano word *gamut*, meaning "root of a tree" — a nod to digging through a repository's roots and history.

## What it does

- **Files** — browse the repo's full working tree, open any file in an editor with syntax highlighting, and save edits in place (⌘/Ctrl+S). Reveal files in Finder/Explorer or jump straight to their changes.
- **Code review** — self-review the current branch's local changes (working tree + branch-vs-base diff) and review GitHub pull requests, with inline diffs and comments.
- **History** — browse the commit graph with branch/tag refs, inspect commits, view per-file diffs, file history, and blame.
- **Repositories** — register local repos, auto-detect repos under a directory, and organise them with groups and tags.

## Install (macOS)

### Homebrew (recommended)

```bash
brew install --cask rymera-web-co/gamut/gamut
```

This installs the latest release with **no Gatekeeper prompts**: Homebrew downloads the app without the quarantine flag, so the (unsigned) build launches normally. Upgrade later with `brew upgrade --cask gamut`.

The command above also taps [`Rymera-Web-Co/homebrew-gamut`](https://github.com/Rymera-Web-Co/homebrew-gamut); afterwards you can refer to the cask as just `gamut`. See [`homebrew/README.md`](homebrew/README.md) for how the tap is maintained.

### Manual `.dmg`

Prefer not to use Homebrew? Download the `.dmg` from the [latest release](https://github.com/Rymera-Web-Co/Gamut/releases), open it, and drag **Gamut** to Applications.

The app is not yet signed with an Apple Developer ID or notarized, so a browser download sets the quarantine flag and on first launch macOS may report:

> "Gamut" is damaged and can't be opened. You should move it to the Trash.

This is Gatekeeper reacting to that quarantine flag on an unsigned app — the app is not actually damaged. To run it, remove the flag once after installing:

```bash
xattr -dr com.apple.quarantine /Applications/Gamut.app
```

Then open Gamut normally. (Right-click → Open does **not** work for this "damaged" case on Apple Silicon — the `xattr` command above is required. The Homebrew install avoids this entirely.)

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
- `⌘/Ctrl+S` save the open file (Files tab)
- `⌘/Ctrl+B` toggle repo sidebar · `⌘/Ctrl+J` toggle theme

## Status

Milestones: **M0 scaffold** ✅ · **M1 repos** ✅ · **M2 history** ✅ · **M3 review** ✅ · **M4 polish** ✅

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up
your environment, the project layout, and coding conventions. For a deeper tour of how
the app is wired together, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). © 2026 Rymera.
