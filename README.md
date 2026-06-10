# Gamut

A local git desktop app for **reviewing changes** and **browsing history**, built with Tauri 2 (Rust) + React + TypeScript.

## What it does

- **Code review** — self-review the current branch's local changes (working tree + branch-vs-base diff) and review GitHub pull requests, with inline diffs and comments.
- **History** — browse the commit graph with branch/tag refs, inspect commits, view per-file diffs, file history, and blame.
- **Repositories** — register local repos, auto-detect repos under a directory, and organise them with groups and tags.

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

- `⌘/Ctrl+1` History · `⌘/Ctrl+2` Review · `⌘/Ctrl+J` toggle theme

## Status

Milestones: **M0 scaffold** ✅ · **M1 repos** ✅ · **M2 history** ✅ · **M3 review** ✅ · **M4 polish** ✅
