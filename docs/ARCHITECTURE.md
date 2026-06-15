<!-- See the [documentation hub](README.md) for per-feature docs. -->

# Architecture

Gamut is a [Tauri 2](https://tauri.app/) desktop app: a Rust backend that owns all
privileged work (git, the GitHub API, persistence, secrets) and a React + TypeScript
frontend that renders the UI and talks to the backend exclusively over Tauri's IPC.

```
┌─────────────────────────────────────────────┐
│  Frontend (React 19 + TS + Vite)            │
│  features/ · components/ · store/ · lib/    │
│                                             │
│            src/lib/ipc.ts                   │  typed invoke() wrappers
└──────────────────────┬──────────────────────┘
                       │  Tauri IPC (commands)
┌──────────────────────┴──────────────────────┐
│  Backend (Rust / Tauri)                     │
│  commands/  →  git/ (git2 + git CLI)        │
│             →  db/  (SQLite via rusqlite)   │
│             →  GitHub REST (reqwest/rustls) │
│             →  keychain (keyring)           │
│  watch.rs   →  filesystem watcher           │
└─────────────────────────────────────────────┘
```

## Why this split

The frontend never touches a token or the filesystem directly. Every git operation,
GitHub API call, database read/write, and secret access happens in Rust. This keeps the
trust boundary clear: the WebView renders data and issues intent; the native side is the
only thing with real privileges.

## Backend (`src-tauri/`)

| Module | Responsibility |
| --- | --- |
| `src/lib.rs` | App setup — opens the SQLite DB, manages `AppState`, registers commands, starts the repo watcher |
| `src/commands/` | Tauri command handlers, grouped by feature: `repo`, `history`, `review`, `github`, `sync`, `tags`, `worktree`, `files`, `system` |
| `src/commands/files.rs` | Working-tree file browser/editor: `list_dir` (lazy, one level, honors `.gitignore` and skips `.git/`), `read_file`, `write_file`, `reveal_in_file_manager`. The one command module that **writes** to the working tree — every path is canonicalized and confirmed to stay inside the repo root, rejecting `..` traversal and symlink escapes |
| `src/git/` | Git operations via `git2` (libgit2, vendored) plus the commit-graph builder; network fetch shells out to the `git` CLI |
| `src/db/` | SQLite access and ordered SQL migrations under `db/migrations/` |
| `src/watch.rs` | Watches each registered repo's `.git` so external branch switches and commits reflect live in the UI |
| `src/state.rs` | `AppState`: the DB connection, the in-memory GitHub token handle, and the watcher |
| `src/error.rs` | Shared error type returned across the IPC boundary |

Notable dependency choices (see `src-tauri/Cargo.toml`):

- **`git2`** is built with default features off — no OpenSSL/libssh2. Local git work is
  done through libgit2; network fetch goes through the `git` CLI.
- **`keyring`** stores the GitHub token in the OS keychain (Keychain / Credential
  Manager / Secret Service), not in the database.
- **`reqwest`** uses `rustls` rather than the system TLS stack.
- **`notify`** + `notify-debouncer-mini` power the live filesystem watcher.

### Persistence

SQLite lives in the platform app-data directory (e.g.
`~/Library/Application Support/com.rymera.gamut/gamut.db` on macOS) and is created on
first run. Schema changes are additive SQL migrations in `src-tauri/src/db/migrations/`,
applied in filename order; the applied set is surfaced through the `db_health` command
and shown in the status bar.

## Frontend (`src/`)

| Directory | Responsibility |
| --- | --- |
| `features/` | The main feature areas — `repos`, `history`, `review`, `github`, `sync` — each with its own `api.ts` and view components |
| `components/` | Shared UI: `layout/` (top tabs), `ui/` (shadcn/ui primitives), plus `FileTree`, `Markdown`, `ErrorBoundary` |
| `lib/` | The `ipc.ts` IPC bridge, the TanStack Query client, theme, formatting, language/icon helpers, and hooks (`useGitWatch`, `useKeyboardShortcuts`) |
| `store/` | Zustand stores for UI state (`ui`), review drafts (`reviewDrafts`), and toasts (`toast`) |

Key libraries: **React 19**, **TanStack Query** for server-state/caching of IPC results,
**Zustand** for local UI state, **Tailwind v4** + **shadcn/ui** for styling, and
**Monaco** for diff/code rendering.

### The IPC bridge

`src/lib/ipc.ts` is the single chokepoint between the two halves. Every backend command
gets a typed wrapper there so the rest of the app calls strongly-typed functions instead
of stringly-typed `invoke("...")`. Adding a feature usually means:

1. Add a handler in `src-tauri/src/commands/<area>.rs` and register it in `lib.rs`.
2. Add a typed wrapper (and any interfaces) in `src/lib/ipc.ts`.
3. Wrap the call in a TanStack Query hook within the relevant `features/<area>/api.ts`.

### Live updates

`watch.rs` debounces filesystem events on each repo's `.git` and notifies the frontend,
where `useGitWatch` invalidates the affected queries. The result is that branch switches
or commits made outside Gamut (in a terminal, another tool) show up without a manual
refresh.

---

See also: [documentation hub](README.md) · [Keyboard shortcuts](keyboard-shortcuts.md)
