# Contributing to Gamut

Thanks for your interest in improving Gamut! This guide covers everything you need to
get a development build running and to land a change.

## Prerequisites

Gamut is a [Tauri 2](https://tauri.app/) app, so you need both a JavaScript and a Rust
toolchain installed.

- **Rust** (stable) — install via [rustup](https://rustup.rs/).
- **Node.js** 18+ and **pnpm** — `npm install -g pnpm` (or use Corepack).
- **Platform build dependencies** for Tauri — follow the
  [Tauri prerequisites guide](https://tauri.app/start/prerequisites/) for your OS
  (e.g. WebView2 on Windows, `webkit2gtk`/`libsoup` on Linux; macOS needs Xcode CLT).

## Getting started

```bash
git clone https://github.com/Rymera-Web-Co/Gamut.git
cd Gamut
pnpm install
pnpm tauri dev      # launches the desktop app with hot reload
```

The first run creates a SQLite database in your platform app-data directory
(e.g. `~/Library/Application Support/com.rymera.gamut/gamut.db` on macOS). Deleting
that file resets all registered repos, groups, and tags.

## Useful commands

| Command | What it does |
| --- | --- |
| `pnpm tauri dev` | Run the full desktop app (frontend + Rust backend) with HMR |
| `pnpm dev` | Run only the Vite frontend in a browser (no Tauri APIs) |
| `pnpm build` | Typecheck and build the frontend bundle |
| `pnpm typecheck` | `tsc --noEmit` — type errors only |
| `pnpm tauri build` | Produce a release `Gamut.app` / `.dmg` / installer |
| `cd src-tauri && cargo check` | Type-check the Rust backend |
| `cd src-tauri && cargo fmt` | Format Rust code |
| `cd src-tauri && cargo clippy` | Lint the Rust backend |

## Project layout

```
src/                     React + TypeScript frontend
  components/            Shared UI (layout, shadcn/ui primitives, file tree, markdown)
  features/              Feature areas: repos, history, review, github, sync
  lib/                   IPC bridge, query client, theme, formatting, hooks
  store/                 Zustand stores
src-tauri/               Rust / Tauri backend
  src/commands/          Tauri command handlers (repo, history, review, github, …)
  src/git/               git2 / git CLI operations and the commit graph
  src/db/                SQLite access + migrations
  src/watch.rs           Filesystem watcher that keeps repo state live
```

The frontend never touches a token or the filesystem directly — **all** git operations,
GitHub API calls, persistence, and secret storage live in the Rust backend and are
reached over Tauri's IPC (`src/lib/ipc.ts`). New capabilities generally mean adding a
command in `src-tauri/src/commands/` and a typed wrapper on the frontend.

## Coding conventions

- **TypeScript** runs in `strict` mode with `noUnusedLocals`/`noUnusedParameters`.
  Keep `pnpm typecheck` clean.
- **Rust**: run `cargo fmt` and keep `cargo clippy` warning-free before pushing.
- Match the style of the surrounding code — naming, comment density, and idioms.
- Prefer small, focused commits with clear messages (see history for the house style).

## Submitting a change

1. Fork the repo and create a branch off `main`.
2. Make your change; ensure `pnpm typecheck`, `cargo check`, `cargo fmt --check`, and
   `cargo clippy` all pass.
3. Open a pull request using the template. Describe **what** changed and **why**, and
   include screenshots/screen recordings for UI changes.
4. Link any related issue (`Closes #123`).

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/Rymera-Web-Co/Gamut/issues/new/choose). For
bugs, include your OS, how you installed/built Gamut, and clear reproduction steps.

## Security

Please do **not** open public issues for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for how to report them privately.
