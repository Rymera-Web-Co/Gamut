# GitHub integration

Connect your GitHub account so Gamut can browse and review pull requests on your
behalf, without you needing to switch to a browser. Once connected you can list PRs,
read diffs and conversations, submit reviews, resolve threads, and merge. See
[Review](review.md) for the PR workflow itself.

## Connecting

Click the **GitHub** button at the bottom of the group rail to open the connection
dialog. It shows your status and, when connected, the signed-in login.

Two ways to authenticate:

- **OAuth device flow** (when a client ID is configured) — GitHub's code-based sign-in:
  instead of typing a password into Gamut, you enter a short code on a page at
  github.com. Click *Connect with GitHub*, GitHub's device page opens (or use *Open
  GitHub* if it doesn't), and it shows a **user code** to enter there. Gamut checks in
  the background until you approve the request or the code expires (~15 min), then
  stores the token and shows *Signed in as <login>*.
- **Personal access token** (fallback) — a personal access token, or PAT, is a
  password-like key you create on GitHub instead of using your real password. Paste one
  in with `repo` and `read:org` scopes (these define what the token is allowed to do).
  It's checked against GitHub's `/user` endpoint, then stored. Press `Enter` to submit.

## Token storage

- **Release builds** — the finished app you download and install — keep the token in
  your operating system's secure credential store (**Keychain** on macOS, **Credential
  Manager** on Windows, **Secret Service** on Linux) under the `com.rymera.gamut`
  service — never in Gamut's own database.
- **Dev/unsigned builds** — versions used while working on Gamut itself — fall back to
  the SQLite settings table instead, because unsigned binaries would otherwise prompt
  for permission on every keychain access.
- The login name (not a secret) is stored in settings too, so Gamut can show who's
  connected on startup without needing to touch the keychain just for that.

**Disconnect** with the sign-out action; it clears the token from the keychain/settings
and the in-memory cache.

## Behind the scenes

*For contributors — where this feature lives in the code.*

`src/features/github/GitHubConnect.tsx` talks to `src-tauri/src/commands/github.rs`. Auth
IPC commands: `githubOauthAvailable`, `githubDeviceStart`, `githubDevicePoll`,
`githubSetToken`, `githubAuthStatus`, `githubLogout`. The PR/review commands are listed in
[Review](review.md). The frontend never sees the raw token — every GitHub call is made
from Rust (see [Architecture](../ARCHITECTURE.md)).

---

See also: [Review](review.md) · [Repositories](repositories.md) · [documentation hub](../README.md)
