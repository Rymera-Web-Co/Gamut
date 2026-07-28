# Gamut documentation

Gamut is a desktop app for **reviewing code changes** and **exploring git history**.
This is the documentation hub — every page below explains one part of the app, written
so you don't need to be a git expert to follow along. (Most pages end with a short
*Behind the scenes* section for developers; feel free to skip those.)

## Features

| Doc | What it covers |
| --- | --- |
| [Review](features/review.md) | Checking your own changes before they ship, and reviewing GitHub pull requests — diffs, comments, approvals, merging |
| [History](features/history.md) | The visual commit graph: who changed what and when, per-file diffs, line-by-line blame, switching branches, cleaning up stale ones |
| [Files](features/files.md) | Browsing and editing the files in a repository, with project-wide find & replace |
| [Repositories](features/repositories.md) | Adding your repositories to Gamut and organising them into groups |
| [Sync](features/sync.md) | One-click fetch / pull / push, with live counts of what's ahead or behind |
| [GitHub integration](features/github.md) | Connecting your GitHub account, and how Gamut keeps the token safe |
| [Terminal](features/terminal.md) | The built-in terminal — tabs, splits, session restore, and notifications when background work finishes |
| [Updates](features/updates.md) | How the app keeps itself up to date, and the Stable vs Nightly channels |

## Reference

- [Keyboard shortcuts](keyboard-shortcuts.md) — every shortcut in the app
- [Architecture](ARCHITECTURE.md) — for developers: how the Rust backend and React frontend fit together

## Project

- [Main README](../README.md) — what Gamut is, why it exists, and how to install it
- [Contributing](../CONTRIBUTING.md) — environment setup, project layout, conventions
