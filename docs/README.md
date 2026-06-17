# Gamut documentation

Gamut is a local git desktop app for **reviewing changes** and **browsing history**,
built with Tauri 2 (Rust) + React + TypeScript. This is the documentation hub — start
here, then dive into a feature.

## Features

| Doc | What it covers |
| --- | --- |
| [Files](features/files.md) | Browse the working tree, open/edit files with syntax highlighting, create/rename/delete, reveal in Finder/Explorer |
| [History](features/history.md) | The commit graph, ref labels, commit details, per-file diffs, file history, blame, branch switching, stale-branch cleanup |
| [Review](features/review.md) | Local self-review (working tree + branch-vs-base), staging/committing/stashing, and full GitHub pull-request review |
| [Repositories](features/repositories.md) | Register repos, auto-discover under a folder, organise with groups and folder-bound groups |
| [Sync](features/sync.md) | One-click fetch / pull / push with live ahead/behind counts |
| [GitHub integration](features/github.md) | Connect a GitHub account (OAuth device flow or PAT), token storage in the OS keychain |
| [Terminal](features/terminal.md) | The integrated, per-group terminal with tabs and splits |
| [Updates](features/updates.md) | In-app auto-update — check on launch, download, install, relaunch; signing keys and releasing |

## Reference

- [Keyboard shortcuts](keyboard-shortcuts.md) — every shortcut in the app
- [Architecture](ARCHITECTURE.md) — how the Rust backend and React frontend fit together

## Project

- [Main README](../README.md) — install, develop, and build
- [Contributing](../CONTRIBUTING.md) — environment setup, project layout, conventions
