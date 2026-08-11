# Repo config

Every repository's git config is really a stack of layers — system-wide, your own global
`~/.gitconfig`, and the repository's own `.git/config` — and git quietly resolves them into
one effective value per key. That's convenient until something looks wrong: an email address
that isn't what you expected, or a remote URL that seems to have come from nowhere. **Repo
config** (Settings → **Repo config**) shows every layer for the currently selected repository,
not just the value that wins, and lets you edit a small curated set of fields directly.

## Opening it

Select a git repository in the sidebar, then open **Settings** (`⌘/Ctrl+,`) → **Repo config**
in the category list. Selecting a plain (non-git) folder, or having nothing selected, shows an
empty state instead — there's no config to show.

Two shortcuts jump straight to the panel for a given repo, skipping the category list:

- Hover a git repo's row in the sidebar and click its gear icon (next to the terminal and
  remove buttons).
- Right-click a git repo's row and choose **Repo settings…**.

Either one makes the repo active and opens Settings already scoped to **Repo config**. Both
are hidden for plain (non-git) folders and for repos whose folder is missing on disk — there's
nothing to configure in either case.

## What you can edit

Only a curated subset — never an arbitrary key — and every edit is written to **local scope**
(this repository's own `.git/config`), never to your global or system config:

- **Identity** — `user.name` and `user.email`. Each field shows where its current value comes
  from (set here, or inherited from global/system); **Clear** removes the local override so
  the inherited value takes over again.
- **Remotes** — one URL field per configured remote. Saving a remote's URL updates only that
  remote; editing `origin`'s URL also refreshes Gamut's cached GitHub repository so PRs, reviews,
  and checks immediately point at the right place. If a remote has a separate push URL
  configured, a note under its field says where pushes actually go — that URL is shown for
  reference only and isn't editable here.
- **Branch upstream** — pick a local branch, then pick its upstream from the repository's
  remote-tracking branches (or **None** to unlink it). Because this panel never pushes, it won't
  let you set an upstream that doesn't already exist as a remote-tracking branch — that would
  silently break the "publish this branch" prompt, auto-pull, and stale-branch cleanup, all of
  which trust `branch.<name>.remote`/`.merge`.

## The effective config table

Below the editors, a **Key / Value / Source** table lists every config entry Gamut can see —
one row per occurrence, not just the winner. If `user.email` is set both globally and in this
repository, you'll see both rows, with the one git actually uses marked **current**. Entries
that look like they carry a credential — a URL's embedded username/password (in either the key
or the value), an `http.*.extraheader`, a key named `password`/`token`, or a value shaped like
one — are masked in this table on a best-effort basis; it isn't an exhaustive credential
scanner, so don't treat it as your only safeguard. The remote URL fields above are never
redacted, since you need the real value to edit it.

The table only updates on demand — click **Refresh** after changing config outside Gamut (a
terminal, another tool). It isn't kept live automatically, unlike most of the rest of the app.

## Behind the scenes

*For contributors — where this feature lives in the code.*

`src/features/settings/panels/RepoConfigPanel.tsx` talks to
`src-tauri/src/commands/config.rs`. Key IPC commands: `gitConfigOverview`,
`gitConfigSetIdentity`, `gitConfigSetRemoteUrl`, `gitConfigSetBranchUpstream`. Reads go through
git2's `Config::entries` (one row per occurrence, source-annotated); writes always target
`Config::open_level(ConfigLevel::Local)` and are validated before anything touches disk, so a
curated field can never inject a new section/key into `.git/config`. `.git/config` isn't
watched by the filesystem watcher (see [Architecture](../ARCHITECTURE.md)), which is why this
panel has its own manual Refresh rather than updating live.

---

See also: [Repositories](repositories.md) · [Sync](sync.md) · [GitHub integration](github.md) ·
[documentation hub](../README.md)
