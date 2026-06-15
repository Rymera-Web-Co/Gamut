# GitHub integration

Connecting a GitHub account unlocks pull-request browsing and review — listing PRs,
reading diffs and conversations, submitting reviews, resolving threads, and merging. See
[Review](review.md) for the PR workflow itself.

## Connecting

Click the **GitHub** button at the bottom of the group rail to open the connection
dialog. It shows your status and, when connected, the signed-in login.

Two ways to authenticate:

- **OAuth device flow** (when a client ID is configured) — click *Connect with GitHub*.
  GitHub's device page opens (or use *Open GitHub*) and shows a **user code** to enter
  there. Gamut polls in the background until you authorise or the flow expires (~15 min),
  then stores the token and shows *Signed in as <login>*.
- **Personal access token** (fallback) — paste a PAT with `repo` and `read:org` scopes.
  It's validated against GitHub's `/user` endpoint, then stored. Press `Enter` to submit.

## Token storage

- **Release builds** keep the token in the **OS keychain** (Keychain / Credential Manager
  / Secret Service) under the `com.rymera.gamut` service — never in the database.
- **Dev/unsigned builds** fall back to the SQLite settings table, because unsigned
  binaries prompt on every keychain access.
- The login name (not a secret) is stored in settings so startup never has to touch the
  keychain just to show who's connected.

**Disconnect** with the sign-out action; it clears the token from the keychain/settings
and the in-memory cache.

## Behind the scenes

`src/features/github/GitHubConnect.tsx` talks to `src-tauri/src/commands/github.rs`. Auth
IPC commands: `githubOauthAvailable`, `githubDeviceStart`, `githubDevicePoll`,
`githubSetToken`, `githubAuthStatus`, `githubLogout`. The PR/review commands are listed in
[Review](review.md). The frontend never sees the raw token — every GitHub call is made
from Rust (see [Architecture](../ARCHITECTURE.md)).

---

See also: [Review](review.md) · [Repositories](repositories.md) · [documentation hub](../README.md)
